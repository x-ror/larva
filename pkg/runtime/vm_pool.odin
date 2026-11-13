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
// VM also runs a page in ~41% less time, because JSC's CodeCache already holds the
// embedded runtime JS: bench/jsc-vm scenario C (one warm pooled VM) against A (a
// fresh implicit VM per page), each page evaluating 8 embedded runtime modules plus
// a 200k-iteration loop, mean of 100 pages per launch — medians of 5 interleaved
// launches per arm, 7.40 vs 12.61 ms/page (2026-11-13). So VMs are created at most
// `capacity` times per thread and reused one context at a time.
//
// Why VMs are never shared by two live contexts: a VM has one heap and one microtask
// queue, drained at every exit from the C API, so a context would run another's
// promise jobs and per-context heap use could not be attributed.
//
// Threading: a pool and its VMs belong to the thread that created them. A VM is only
// ever entered by that thread. A thread that ends must call thread_vm_pool_destroy,
// or its VMs' heaps outlive it — Odin has no thread-exit hook to do it for us.

VM :: struct {
	group:       jsc.JSContextGroupRef,
	// Owning pool; vm_release reorders it.
	pool:        ^VM_Pool,
	in_use:      bool,
	// Set by the watchdog callback when it terminates a script on this VM; cleared on
	// vm_acquire. Lets a caller tell a watchdog kill from an ordinary exception.
	limit_hit:   bool,
	// Seconds per VM entry; 0 = no limit. Kept so vm_release can clear it.
	entry_limit: f64,
}

VM_Pool :: struct {
	// Idle VMs are kept in release order: the last idle entry is the one released
	// most recently.
	vms:       [dynamic]^VM,
	capacity:  int,
	// VMs ever created by this pool. Each one costs a permanent timerfd.
	created:   int,
	allocator: runtime.Allocator,
}

VM_Pool_Error :: enum {
	None,
	Exhausted, // every VM is in use and the pool is at capacity
	Create_Failed,
}

// Upper bound on the VMs a thread's implicit pool may create. VMs are created on
// demand, so the sequential eval path only ever makes one; the headroom is for evals
// nested on one thread (each holds its own VM while it runs). Pages (#3) size their
// pools explicitly.
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

// thread_vm_pool_destroy tears down the calling thread's implicit pool, destroying
// its VMs and reclaiming their heaps (not their timerfds, which JSC never closes). For
// a thread that is about to end; a later thread_vm_pool on the same thread starts a
// fresh pool. Every VM must be idle.
thread_vm_pool_destroy :: proc() {
	if !g_thread_pool_ready do return
	vm_pool_destroy(&g_thread_pool)
	g_thread_pool_ready = false
}

// vm_pool_init prepares an empty pool. `allocator` is required, not defaulted to the
// ambient context.allocator: the pool and its VM records outlive the call, so they
// must be bound to an allocator the caller chose to outlive them (CLAUDE.md §4).
vm_pool_init :: proc(pool: ^VM_Pool, capacity: int, allocator: runtime.Allocator) {
	pool^ = {}
	pool.capacity = max(capacity, 1)
	pool.allocator = allocator
	// Reserved at full capacity, so vm_acquire's append never has to grow it.
	pool.vms = make([dynamic]^VM, 0, pool.capacity, allocator)
}

// vm_pool_destroy releases every VM's context group (destroying the VM once no
// context holds it) and frees the pool's bookkeeping through the pool's allocator.
// Every VM must be idle: a VM still hosting a context would be freed under it.
vm_pool_destroy :: proc(pool: ^VM_Pool) {
	for vm in pool.vms {
		assert(!vm.in_use, "vm_pool_destroy: VM still in use")
		if vm.entry_limit > 0 do jsc.JSContextGroupClearExecutionTimeLimit(vm.group)
		jsc.JSContextGroupRelease(vm.group)
		free(vm, pool.allocator)
	}
	delete(pool.vms)
	pool^ = {}
}

// vm_acquire hands out an idle VM, creating one if none is idle and the pool is below
// capacity. Idle VMs are reused most-recently-released first (vm_release keeps them in
// release order), so the warmest CodeCache is reused.
vm_acquire :: proc(pool: ^VM_Pool) -> (^VM, VM_Pool_Error) {
	for i := len(pool.vms) - 1; i >= 0; i -= 1 {
		vm := pool.vms[i]
		if !vm.in_use {
			vm.in_use = true
			vm.limit_hit = false
			return vm, .None
		}
	}
	if len(pool.vms) >= pool.capacity do return nil, .Exhausted

	jsc.lava_jsc_init()
	group := jsc.JSContextGroupCreate()
	if group == nil do return nil, .Create_Failed
	vm, alloc_err := new(VM, pool.allocator)
	if alloc_err != nil {
		jsc.JSContextGroupRelease(group)
		return nil, .Create_Failed
	}
	vm^ = VM {
		group  = group,
		pool   = pool,
		in_use = true,
	}
	// Cannot grow, so cannot fail: len < capacity was checked above and vm_pool_init
	// reserved `capacity` slots.
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
	// Move it to the end, so the backward scan in vm_acquire finds the most recently
	// released VM first. O(capacity), on a list of a few entries.
	vms := &vm.pool.vms
	for i in 0 ..< len(vms) {
		if vms[i] == vm {
			ordered_remove(vms, i)
			append(vms, vm)
			break
		}
	}
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

// vm_pool_stats reports how many VMs are busy and how many the pool has ever created.
vm_pool_stats :: proc(pool: ^VM_Pool) -> (busy, created: int) {
	for vm in pool.vms do if vm.in_use do busy += 1
	return busy, pool.created
}
