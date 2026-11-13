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
	// Cumulative CPU budget (vm_set_cpu_budget). The watchdog above only sees one
	// entry at a time, so a page burning CPU in thousands of short callbacks never
	// trips it; this sums the thread's CPU time across every entry instead. All of it
	// is per holder: vm_release clears it, so a reused VM starts the next page at zero.
	//
	// Nanoseconds; 0 = no budget.
	cpu_budget_ns:   i64,
	// CPU time spent inside this VM since acquire, summed by vm_cpu_exit.
	cpu_used_ns:     i64,
	// Thread CPU clock at the outermost vm_cpu_enter.
	cpu_mark_ns:     i64,
	// vm_cpu_enter nesting depth: only the outermost enter/exit pair reads the clock,
	// so a nested entry (a callback that re-enters through eval's tick) is not counted
	// twice.
	cpu_depth:       int,
	// Set when the budget, not the entry limit, ended the page: either the watchdog
	// fired while armed for the remaining budget, or vm_cpu_exit found it spent.
	budget_hit:      bool,
	// The limit currently armed in JSC's watchdog (0 = none) and what armed it.
	// Re-arming takes the VM lock, so vm_cpu_enter does it only when the clamp
	// actually tightens — once the remaining budget drops below the entry limit.
	armed_limit:     f64,
	armed_by_budget: bool,
}

// Page_Limits are the CPU limits a page runs under. Seconds; 0 = no limit.
//
// entry_limit  One synchronous entry into the VM (a script, a callback). Enforced by
//              JSC's watchdog, which measures CPU time since the entry.
// cpu_budget   Every entry summed over the page's life, measured on the thread's
//              CPU clock (CLOCK_THREAD_CPUTIME_ID). Also clamps the watchdog to the
//              remaining budget, so one long entry cannot overrun it either.
Page_Limits :: struct {
	entry_limit: f64,
	cpu_budget:  f64,
}

// Kill_Reason says which limit ended a page, so a caller can tell a kill from an
// ordinary uncaught exception.
Kill_Reason :: enum {
	None,
	Entry_Limit,
	Cpu_Budget,
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
		if vm.armed_limit > 0 do jsc.JSContextGroupClearExecutionTimeLimit(vm.group)
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
			vm.budget_hit = false
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
	if vm.armed_limit > 0 do jsc.JSContextGroupClearExecutionTimeLimit(vm.group)
	vm.entry_limit = 0
	vm.armed_limit = 0
	vm.armed_by_budget = false
	vm.cpu_budget_ns = 0
	vm.cpu_used_ns = 0
	vm.cpu_depth = 0
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
// script evaluation or one callback) that runs longer than `seconds` of CPU. It does
// not accumulate across entries: a page burning CPU in many short callbacks is caught
// by vm_set_cpu_budget instead. 0 clears it.
vm_set_entry_limit :: proc(vm: ^VM, seconds: f64) {
	vm.entry_limit = max(seconds, 0)
	vm_arm_watchdog(vm)
}

// vm_set_cpu_budget gives the VM's current holder `seconds` of CPU time in total,
// counted by vm_cpu_enter/vm_cpu_exit. 0 clears it. Time already spent is kept, so
// lowering the budget below it makes the page over budget at once.
vm_set_cpu_budget :: proc(vm: ^VM, seconds: f64) {
	vm.cpu_budget_ns = seconds > 0 ? max(i64(seconds * 1e9), 1) : 0
	vm_arm_watchdog(vm)
}

// vm_cpu_enter marks the start of an entry into the VM for the cumulative budget,
// and tightens the watchdog to the budget that is left. Pair every call with
// vm_cpu_exit. Without a budget it costs nothing but a branch: the clock is read
// only when there is something to charge it to.
vm_cpu_enter :: proc(vm: ^VM) {
	if vm == nil || vm.cpu_budget_ns == 0 do return
	vm.cpu_depth += 1
	if vm.cpu_depth > 1 do return
	vm.cpu_mark_ns = thread_cpu_ns()
	vm_arm_watchdog(vm)
}

// vm_cpu_exit charges the time since the matching vm_cpu_enter to the VM and marks
// the holder over budget once it is spent. vm_kill_reason reports the outcome.
vm_cpu_exit :: proc(vm: ^VM) {
	if vm == nil || vm.cpu_budget_ns == 0 || vm.cpu_depth == 0 do return
	vm.cpu_depth -= 1
	if vm.cpu_depth == 0 {
		vm.cpu_used_ns += max(thread_cpu_ns() - vm.cpu_mark_ns, 0)
	}
	if vm.cpu_used_ns >= vm.cpu_budget_ns do vm.budget_hit = true
}

// vm_cpu_checkpoint charges the time since the last mark without ending the stretch,
// then re-clamps the watchdog to what is left. Called at every callback boundary
// inside a tick (invoke_user_callback, each nextTick drain pass): one tick can fire
// any number of due timers or drain passes, each a fresh JSC entry with a fresh
// watchdog window, so a per-tick check alone lets one tick run far past the budget.
vm_cpu_checkpoint :: proc(vm: ^VM) {
	if vm == nil || vm.cpu_budget_ns == 0 || vm.cpu_depth == 0 do return
	now := thread_cpu_ns()
	vm.cpu_used_ns += max(now - vm.cpu_mark_ns, 0)
	vm.cpu_mark_ns = now
	if vm.cpu_used_ns >= vm.cpu_budget_ns do vm.budget_hit = true
	vm_arm_watchdog(vm)
}

// vm_kill_reason reports which limit, if any, has ended the VM's current holder. The
// budget wins a tie: it is the limit that cannot be reset by the next entry.
vm_kill_reason :: proc(vm: ^VM) -> Kill_Reason {
	if vm == nil do return .None
	if vm.budget_hit do return .Cpu_Budget
	if vm.limit_hit do return .Entry_Limit
	return .None
}

// vm_arm_watchdog sets JSC's watchdog to the tighter of the entry limit and the budget
// left, re-arming only when that changes the armed value: the budget left shrinks
// monotonically, so in a page well under budget this does nothing after the first
// call.
@(private = "file")
vm_arm_watchdog :: proc(vm: ^VM) {
	want := vm.entry_limit
	by_budget := false
	if vm.cpu_budget_ns > 0 {
		left := f64(max(vm.cpu_budget_ns - vm.cpu_used_ns, 0)) / 1e9
		// JSC treats a non-positive limit as "no limit"; a spent budget still has to
		// stop the next entry at once.
		left = max(left, 0.001)
		if want <= 0 || left < want {
			want = left
			by_budget = true
		}
	}
	if want <= 0 {
		if vm.armed_limit > 0 do jsc.JSContextGroupClearExecutionTimeLimit(vm.group)
		vm.armed_limit = 0
		vm.armed_by_budget = false
		return
	}
	// Re-arm when the clamp tightens by more than a tenth of the armed value (or the
	// reason changes, or it loosens — which within one holder only vm_set_* does). The
	// armed value then shrinks geometrically, so a budget B re-arms at most about
	// log(B / 1 ms) / log(1/0.9) times over a page's life — ~98 for B = 30 s — instead
	// of once per tick, and an entry can overrun the budget left by at most that tenth.
	if vm.armed_limit > 0 && by_budget == vm.armed_by_budget && want <= vm.armed_limit &&
	   vm.armed_limit - want < max(0.001, vm.armed_limit * 0.1) {
		return
	}
	vm.armed_limit = want
	vm.armed_by_budget = by_budget
	jsc.JSContextGroupSetExecutionTimeLimit(vm.group, want, vm_watchdog_terminate, vm)
}

@(private = "file")
vm_watchdog_terminate :: proc "c" (ctx: jsc.JSContextRef, user_data: rawptr) -> bool {
	vm := cast(^VM)user_data
	// JSC invokes this on the thread running the script (at a VM trap), so a plain
	// store is visible to the caller once the evaluation returns.
	if vm == nil do return true
	if vm.armed_by_budget {
		vm.budget_hit = true
	} else {
		vm.limit_hit = true
	}
	return true
}

// vm_pool_stats reports how many VMs are busy and how many the pool has ever created.
vm_pool_stats :: proc(pool: ^VM_Pool) -> (busy, created: int) {
	for vm in pool.vms do if vm.in_use do busy += 1
	return busy, pool.created
}

