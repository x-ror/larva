package lava_runtime

import "base:runtime"
import jsc "lava:pkg/jsc"

// A per-thread pool of JavaScriptCore VMs (context groups). See docs/LARVA.md §2 and
// bench/jsc-vm for the measurements behind it.
//
// Why a pool and not a VM per context: JSGlobalContextCreate makes a fresh VM per
// context, and every VM ever created keeps one timerfd open for the life of the
// process (its WTF::RunLoop timer), even after the last context and the group are
// released and fully collected. Its memory does come back; the fd does not. A warm
// VM also starts a page ~40% faster, because JSC's CodeCache already holds the
// embedded runtime JS. So VMs are created at most `capacity` times per thread and
// reused one context at a time.
//
// Why VMs are never shared by two live contexts: a VM has one heap and one microtask
// queue, drained at every exit from the C API, so a context would run another's
// promise jobs and per-context heap use could not be attributed.
//
// Threading: a pool and its VMs belong to the thread that created them. A VM is only
// ever entered by that thread.

VM :: struct {
	group:          jsc.JSContextGroupRef,
	pool:           ^VM_Pool,
	in_use:         bool,
	// Contexts this VM has hosted, including the current one.
	uses:           int,
	// Set by the watchdog callback when it terminates a script on this VM; cleared on
	// vm_acquire. Lets a caller tell a watchdog kill from an ordinary exception.
	limit_hit:      bool,
	// Seconds per VM entry; 0 = no limit. Kept so vm_release can clear it.
	entry_limit:    f64,
}

VM_Pool :: struct {
	vms:      [dynamic]^VM,
	capacity: int,
	// VMs ever created by this pool. Each one costs a permanent timerfd.
	created:  int,
	allocator: runtime.Allocator,
}

VM_Pool_Error :: enum {
	None,
	Exhausted, // every VM is in use and the pool is at capacity
	Create_Failed,
}

// Default number of VMs a thread's implicit pool may create. One is enough for the
// sequential eval path; pages (#3) size their pools explicitly.
DEFAULT_VM_POOL_CAPACITY :: 16

@(private = "file", thread_local)
g_thread_pool: VM_Pool

@(private = "file", thread_local)
g_thread_pool_ready: bool

// thread_vm_pool returns the calling thread's implicit pool. Its bookkeeping lives on
// the heap allocator for the life of the thread, independent of whichever allocator
// the caller's context carries (the same reasoning as the host-native tables).
thread_vm_pool :: proc() -> ^VM_Pool {
	if !g_thread_pool_ready {
		vm_pool_init(&g_thread_pool, DEFAULT_VM_POOL_CAPACITY, runtime.default_allocator())
		g_thread_pool_ready = true
	}
	return &g_thread_pool
}

vm_pool_init :: proc(pool: ^VM_Pool, capacity: int, allocator := context.allocator) {
	pool^ = {}
	pool.capacity = max(capacity, 1)
	pool.allocator = allocator
	pool.vms = make([dynamic]^VM, 0, pool.capacity, allocator)
}

// vm_acquire hands out an idle VM, creating one if none is idle and the pool is below
// capacity. Idle VMs are reused most-recently-released first, so the warmest
// CodeCache is reused.
vm_acquire :: proc(pool: ^VM_Pool) -> (^VM, VM_Pool_Error) {
	for i := len(pool.vms) - 1; i >= 0; i -= 1 {
		vm := pool.vms[i]
		if !vm.in_use {
			// Move to the end so the next acquire after a release picks the same VM.
			ordered_remove(&pool.vms, i)
			append(&pool.vms, vm)
			vm.in_use = true
			vm.uses += 1
			vm.limit_hit = false
			return vm, .None
		}
	}
	if len(pool.vms) >= pool.capacity do return nil, .Exhausted

	jsc.lava_jsc_init()
	group := jsc.JSContextGroupCreate()
	if group == nil do return nil, .Create_Failed
	vm := new(VM, pool.allocator)
	vm^ = VM {
		group  = group,
		pool   = pool,
		in_use = true,
		uses   = 1,
	}
	append(&pool.vms, vm)
	pool.created += 1
	return vm, .None
}

// vm_release returns a VM to its pool. The caller must have released every context it
// created in this VM. Any execution limit set while it was held is cleared.
vm_release :: proc(vm: ^VM) {
	if vm == nil do return
	if vm.entry_limit > 0 {
		jsc.JSContextGroupClearExecutionTimeLimit(vm.group)
		vm.entry_limit = 0
	}
	vm.in_use = false
}

// vm_create_context creates a global context inside the VM.
vm_create_context :: proc(vm: ^VM, global_class: jsc.JSClassRef) -> jsc.JSGlobalContextRef {
	return jsc.JSGlobalContextCreateInGroup(vm.group, global_class)
}

// vm_set_entry_limit makes the watchdog terminate any single entry into this VM (one
// script evaluation or one callback) that runs longer than `seconds`. It does not
// accumulate across entries: a page burning CPU in many short callbacks needs its
// own cumulative budget on top (see #17).
vm_set_entry_limit :: proc(vm: ^VM, seconds: f64) {
	if seconds <= 0 {
		if vm.entry_limit > 0 do jsc.JSContextGroupClearExecutionTimeLimit(vm.group)
		vm.entry_limit = 0
		return
	}
	vm.entry_limit = seconds
	jsc.JSContextGroupSetExecutionTimeLimit(vm.group, seconds, vm_watchdog_terminate, vm)
}

@(private = "file")
vm_watchdog_terminate :: proc "c" (ctx: jsc.JSContextRef, user_data: rawptr) -> bool {
	vm := cast(^VM)user_data
	// JSC invokes this on the thread running the script (at a VM trap), so a plain
	// store is visible to the caller once the evaluation returns.
	if vm != nil do vm.limit_hit = true
	return true
}

// vm_pool_stats reports how many VMs exist and how many are busy.
vm_pool_stats :: proc(pool: ^VM_Pool) -> (total, busy, created: int) {
	for vm in pool.vms do if vm.in_use do busy += 1
	return len(pool.vms), busy, pool.created
}
