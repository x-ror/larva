package lava_runtime

import "base:runtime"
import jsc "lava:pkg/jsc"

// A per-thread pool of JavaScriptCore VMs (context groups). See docs/LARVA.md §2 and
// bench/jsc-vm for the measurements behind it.
//
// Why a pool and not a VM per context: JSGlobalContextCreate makes a fresh VM per
// context, and a warm VM runs a page in ~41% less time, because JSC's CodeCache
// already holds the embedded runtime JS: bench/jsc-vm scenario C (one warm pooled VM)
// against A (a fresh implicit VM per page), each page evaluating 8 embedded runtime
// modules plus a 200k-iteration loop, mean of 100 pages per launch — medians of 5
// interleaved launches per arm, 7.40 vs 12.61 ms/page (2026-11-13). So VMs are created
// at most `capacity` times per thread, plus one per retirement (VM_RETIRE_AFTER_PAGES),
// and reused one context at a time.
//
// A VM's timer on the thread's WTF::RunLoop holds a timerfd, which used to outlive the
// VM for the life of the thread: the timer's GSource is finalized, and the fd closed,
// only when the RunLoop's GLib context is next iterated, and nothing iterated it. With
// the RunLoop driven (pkg/jsc/runloop_linux.odin) vm_pool_destroy iterates once after
// its releases, and the fd goes with the VM (vm_pool_releases_its_timerfds). On a
// thread with no drive the old cost stands, as before.
//
// The thread's first VM is also where the drive is set up: WTF binds the thread's
// RunLoop when the thread creates its first VM, so vm_acquire's create is the one point
// that pushes the drive's context (runloop_before_vm / runloop_after_vm).
//
// Why VMs are never shared by two live contexts: a VM has one heap and one microtask
// queue, drained at every exit from the C API, so a context would run another's
// promise jobs and per-context heap use could not be attributed.
//
// Threading: a pool and its VMs belong to the thread that created them. A VM is only
// ever entered by that thread. A thread that ends must call thread_vm_pool_destroy,
// or its VMs' heaps outlive it — Odin has no thread-exit hook to do it for us.

VM :: struct {
	group:           jsc.JSContextGroupRef,
	// Owning pool; vm_release reorders it.
	pool:            ^VM_Pool,
	in_use:          bool,
	// Set by the watchdog callback when it terminates a script on this VM; cleared on
	// vm_acquire. Lets a caller tell a watchdog kill from an ordinary exception.
	limit_hit:       bool,
	// Seconds per VM entry; 0 = no limit. Kept so vm_release can clear it.
	entry_limit:     f64,
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
	// Set by vm_request_stop: the holder asked to end (process.exit in a runner page).
	// The watchdog is armed at a token limit so the running script stops at its next
	// trap, and a fire in this state is neither kind of kill.
	stop_requested:  bool,
	// Pages this VM has hosted, counting the current holder: vm_acquire adds one and
	// nothing resets it. The page runner samples a VM's heap on every Nth of its pages
	// (Page_Runner.heap_sample_every), so the cost is spread per VM, not per runner.
	pages_hosted:    int,
	// Set by page_close when a sampled heap was at least HEAP_COLLECT_BYTES: the next
	// page_create on this VM runs a full synchronous collection first (page.odin says
	// why there). Survives vm_release, unlike every per-holder field above.
	collect_pending: bool,
	// The last heap sample page_close took on this VM (Result.heap_bytes), 0 when none
	// was: what vm_release compares against VM_Pool.retire_heap_bytes. Survives
	// vm_release, like collect_pending.
	heap_bytes:      i64,
	// CPU quantum of one page tick (#35), nanoseconds; 0 = none. Set by the page runner
	// (Page_Runner.slice_us) and cleared by vm_acquire, so eval, page_eval and
	// page_run_until never slice. tick_mark_ns is the thread CPU clock at the outermost
	// vm_cpu_enter, which page_checkpoint compares against.
	slice_ns:        i64,
	tick_mark_ns:    i64,
	// The holder's heap limit (vm_set_heap_limit), bytes; 0 = none. Per holder, like the
	// CPU fields: vm_acquire and vm_release clear it.
	heap_limit:      i64,
	// Set by vm_heap_kill when a heap check (page_heap_check, page.odin) found the
	// holder's heap over heap_limit after a full collection. Read by vm_retire_due, so it
	// survives vm_release's clearing; vm_acquire clears it, though a VM that carries it is
	// retired at that release and never acquired again.
	heap_hit:        bool,
	// The heap check's schedule, all on the holder's own CPU clock (cpu_used_ns): the
	// next check is due once cpu_used_ns reaches heap_next_ns; heap_last_bytes and
	// heap_last_ns are the previous check's reading and when it ended, from which the
	// next interval estimates the heap's growth. Per holder; vm_acquire clears them.
	heap_next_ns:    i64,
	heap_last_bytes: i64,
	heap_last_ns:    i64,
}

// Page_Limits are the limits a page runs under; 0 = no limit.
//
// entry_limit  Seconds. One synchronous entry into the VM (a script, a callback).
//              Enforced by JSC's watchdog, which measures CPU time since the entry.
// cpu_budget   Seconds. Every entry summed over the page's life, measured on the
//              thread's CPU clock (CLOCK_THREAD_CPUTIME_ID). Also clamps the watchdog
//              to the remaining budget (re-armed once it shrinks by more than a tenth),
//              so one long entry overruns it by at most about 10%. Enforced at JS
//              traps and callback boundaries only: a native call (pbkdf2Sync with a
//              huge iteration count) is not interrupted until it returns.
// heap_bytes   Bytes of JS heap (jsc.heap_size_bytes: the VM's heap capacity) the page
//              may hold after a full collection. Checked between the page's steps — after
//              its install, its top-level script, each page_eval and element script, and
//              each tick (a runner tick ends at its CPU quantum) — on a schedule
//              amortised against the check's own cost (page_heap_check, page.odin,
//              gives the policy and its numbers). A page over it is killed alone
//              (Kill_Reason.Heap_Limit) and its VM retired. Not enforced inside one
//              entry: a single script that allocates without returning is bounded by
//              entry_limit and cpu_budget, not by this.
Page_Limits :: struct {
	entry_limit: f64,
	cpu_budget:  f64,
	heap_bytes:  i64,
}

// Kill_Reason says which limit ended a page, so a caller can tell a kill from an
// ordinary uncaught exception.
Kill_Reason :: enum {
	None,
	Entry_Limit,
	Cpu_Budget,
	// The page's heap, after a full collection, was over Page_Limits.heap_bytes.
	Heap_Limit,
	// Not a limit: the page runner was destroyed while the page was still running.
	Cancelled,
	// Not a limit: the page runner refused the page without opening it, because its
	// closed pages' jobs still running on its worker pool — orphans, blocked pool work —
	// are at their bound (page_runner.odin, Page_Runner.orphan_limit).
	Reaping_Full,
}

VM_Pool :: struct {
	// Idle VMs are kept in release order: the last idle entry is the one released
	// most recently.
	vms:                [dynamic]^VM,
	capacity:           int,
	// VMs ever created by this pool.
	created:            int,
	// VMs this pool retired at vm_release (vm_retire_due).
	retired:            int,
	// Retirement thresholds, VM_RETIRE_AFTER_PAGES and VM_RETIRE_HEAP_BYTES unless the
	// owner changes them after vm_pool_init (a page runner's embedder sets them on
	// Page_Runner.pool); 0 turns that trigger off.
	retire_after_pages: int,
	retire_heap_bytes:  i64,
	allocator:          runtime.Allocator,
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

// VM retirement (#3, docs/LARVA.md decision 2): vm_release destroys a VM instead of
// pooling it again once it has hosted VM_RETIRE_AFTER_PAGES pages, or once the last
// heap sample taken on it (Page_Runner.heap_sample_every) was at least
// VM_RETIRE_HEAP_BYTES, whichever comes first; the next vm_acquire creates a fresh VM.
// A long-lived VM's heap keeps what no collection reclaims (JIT code, structures, the
// high-water mark of its blocks), and nothing else bounds it.
//
// What a retirement costs is one cold page: 12.61 vs 7.40 ms/page, bench/jsc-vm
// scenario A vs C (see the top of this file), so ~5.2 ms, or 0.026 ms a page amortised
// over 200. It costs no descriptor: with the RunLoop driven the VM's timerfd closes at
// the retirement (vm_retire). What it buys, measured with a standalone C probe on JSC
// 2.52.6 (session notes "runloop-design" p7: 200 pages on one thread, each a fresh
// context with a JIT-warm loop keeping 50k objects, one drive per page, three runs per
// arm, Ryzen 7 7700X): end RSS growth +94-97 MB never retiring, +69-72 MB retiring
// every 10 pages, +27-29 MB retiring every page at 3.6 against 2.4 ms/page. The heap
// trigger bounds a VM's heap at about the threshold, where the page cap alone does not.
// The Lava-level numbers, retirement on vs off, are bench/pages': docs/LARVA.md
// decision 2. Both thresholds approved by the project owner on 2026-11-26.
VM_RETIRE_AFTER_PAGES :: 200
VM_RETIRE_HEAP_BYTES :: i64(64 * 1024 * 1024)

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
// its VMs and reclaiming their heaps (and, on a thread whose RunLoop is driven, their
// timerfds: vm_pool_destroy). For a thread that is about to end; a later thread_vm_pool on the same thread starts a
// fresh pool. Every VM must be idle.
thread_vm_pool_destroy :: proc() {
	if !g_thread_pool_ready {
		return
	}

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
	pool.retire_after_pages = VM_RETIRE_AFTER_PAGES
	pool.retire_heap_bytes = VM_RETIRE_HEAP_BYTES
	// Reserved at full capacity, so vm_acquire's append never has to grow it.
	pool.vms = make([dynamic]^VM, 0, pool.capacity, allocator)
}

// vm_pool_destroy releases every VM's context group (destroying the VM once no
// context holds it) and frees the pool's bookkeeping through the pool's allocator.
// Every VM must be idle: a VM still hosting a context would be freed under it.
vm_pool_destroy :: proc(pool: ^VM_Pool) {
	for vm in pool.vms {
		assert(!vm.in_use, "vm_pool_destroy: VM still in use")

		if vm.armed_limit > 0 {
			jsc.JSContextGroupClearExecutionTimeLimit(vm.group)
		}

		jsc.JSContextGroupRelease(vm.group)
		free(vm, pool.allocator)
	}

	// A released VM's RunLoop timer source is finalized, and its timerfd closed, only
	// when the thread's context is next iterated; without this the descriptor outlived
	// the VM for the life of the thread (vm_pool_releases_its_timerfds).
	if len(pool.vms) > 0 {
		jsc.runloop_dispatch()
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
			vm.stop_requested = false
			vm.slice_ns = 0
			vm.heap_limit = 0
			vm.heap_hit = false
			vm.heap_next_ns = 0
			vm.heap_last_bytes = 0
			vm.heap_last_ns = 0
			vm.pages_hosted += 1
			return vm, .None
		}
	}

	if len(pool.vms) >= pool.capacity {
		return nil, .Exhausted
	}

	jsc.lava_jsc_init()
	// The thread's first VM binds its WTF::RunLoop for good, so the drive's context is
	// pushed around this create and nowhere else (pkg/jsc/runloop_linux.odin). Later
	// creates on the thread pass straight through.
	pushed := jsc.runloop_before_vm()
	group := jsc.JSContextGroupCreate()
	jsc.runloop_after_vm(pushed, group)

	if group == nil {
		return nil, .Create_Failed
	}

	vm, alloc_err := new(VM, pool.allocator)

	if alloc_err != nil {
		jsc.JSContextGroupRelease(group)
		return nil, .Create_Failed
	}

	vm^ = VM {
		group        = group,
		pool         = pool,
		in_use       = true,
		pages_hosted = 1,
	}
	// Cannot grow, so cannot fail: len < capacity was checked above and vm_pool_init
	// reserved `capacity` slots.
	append(&pool.vms, vm)
	pool.created += 1
	return vm, .None
}

// vm_release returns a VM to its pool, or retires it (vm_retire_due). The caller must
// have released every context it created in this VM, and must not use `vm` afterwards:
// a retired VM's record is freed. Any execution limit set while it was held is cleared.
//
// Thread level only, never inside a VM entry: a retirement iterates the thread's
// RunLoop (vm_retire). Its callers, page_close and a failed page_create, run between
// ticks.
vm_release :: proc(vm: ^VM) {
	if vm == nil {
		return
	}

	if vm.armed_limit > 0 {
		jsc.JSContextGroupClearExecutionTimeLimit(vm.group)
	}

	vm.entry_limit = 0
	vm.armed_limit = 0
	vm.armed_by_budget = false
	vm.cpu_budget_ns = 0
	vm.cpu_used_ns = 0
	vm.cpu_depth = 0
	vm.heap_limit = 0
	vm.in_use = false

	if vm_retire_due(vm) {
		vm_retire(vm)
		return
	}

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

// vm_set_heap_limit gives the VM's current holder a heap limit of `bytes`
// (Page_Limits.heap_bytes); 0 or less clears it. Only the limit: the check that enforces
// it reads the heap through the holder's context, so it is the page's (page_heap_check).
// A limit also turns on the CPU metering vm_cpu_enter/vm_cpu_exit do for a budget, since
// the check's schedule runs on the holder's own CPU clock.
vm_set_heap_limit :: proc(vm: ^VM, bytes: i64) {
	vm.heap_limit = max(bytes, 0)
}

// vm_heap_kill ends the VM's current holder for its heap (Kill_Reason.Heap_Limit): the
// kill latches like the budget's, with the watchdog at its floor so whatever JS the
// holder still reaches is cut at once, and vm_release retires the VM (vm_retire_due)
// instead of pooling a heap known to be over a limit.
vm_heap_kill :: proc(vm: ^VM) {
	if vm == nil {
		return
	}

	vm.heap_hit = true
	vm_arm_kill_floor(vm)
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
	if !vm_metered(vm) {
		return
	}

	vm.cpu_depth += 1

	if vm.cpu_depth > 1 {
		return
	}

	vm.cpu_mark_ns = thread_cpu_ns()
	vm.tick_mark_ns = vm.cpu_mark_ns
	vm_arm_watchdog(vm)
}

// vm_cpu_exit charges the time since the matching vm_cpu_enter to the VM and marks
// the holder over budget once it is spent. vm_kill_reason reports the outcome.
vm_cpu_exit :: proc(vm: ^VM) {
	if !vm_metered(vm) || vm.cpu_depth == 0 {
		return
	}

	vm.cpu_depth -= 1

	if vm.cpu_depth == 0 {
		vm.cpu_used_ns += max(thread_cpu_ns() - vm.cpu_mark_ns, 0)
	}

	if vm.cpu_budget_ns > 0 && vm.cpu_used_ns >= vm.cpu_budget_ns {
		vm.budget_hit = true
	}
}

// vm_cpu_checkpoint charges the time since the last mark without ending the stretch,
// then re-clamps the watchdog to what is left. Called at every callback boundary
// inside a tick (invoke_user_callback, each nextTick drain pass): one tick can fire
// any number of due timers or drain passes, each a fresh JSC entry with a fresh
// watchdog window, so a per-tick check alone lets one tick run far past the budget.
vm_cpu_checkpoint :: proc(vm: ^VM) {
	if !vm_metered(vm) || vm.cpu_depth == 0 {
		return
	}

	now := thread_cpu_ns()
	vm.cpu_used_ns += max(now - vm.cpu_mark_ns, 0)
	vm.cpu_mark_ns = now

	if vm.cpu_budget_ns > 0 && vm.cpu_used_ns >= vm.cpu_budget_ns {
		vm.budget_hit = true
	}

	vm_arm_watchdog(vm)
}

// vm_slice_spent reports whether the current tick has spent the VM's CPU quantum
// (slice_ns, #35). It reads the mark vm_cpu_checkpoint just took, so the quantum costs
// one compare per callback and no clock read of its own. False outside a vm_cpu_enter
// stretch, and on a VM without a budget, whose checkpoint reads no clock at all.
vm_slice_spent :: proc(vm: ^VM) -> bool {
	return vm != nil && vm.slice_ns > 0 && vm.cpu_depth > 0 && vm.cpu_mark_ns - vm.tick_mark_ns >= vm.slice_ns
}

// vm_kill_reason reports which limit, if any, has ended the VM's current holder. The
// budget wins a tie: it is the limit that cannot be reset by the next entry.
vm_kill_reason :: proc(vm: ^VM) -> Kill_Reason {
	if vm == nil {
		return .None
	}

	if vm.budget_hit {
		return .Cpu_Budget
	}

	if vm.limit_hit {
		return .Entry_Limit
	}

	if vm.heap_hit {
		return .Heap_Limit
	}

	return .None
}

// vm_metered reports whether the VM's holder has its CPU time summed into cpu_used_ns:
// with a budget, or with a heap limit, whose check runs on that clock. Neither costs a
// clock read otherwise.
@(private = "file")
vm_metered :: proc(vm: ^VM) -> bool {
	return vm != nil && (vm.cpu_budget_ns > 0 || vm.heap_limit > 0)
}

// vm_arm_watchdog sets JSC's watchdog to the tighter of the entry limit and the budget
// left, re-arming only when that changes the armed value: the budget left shrinks
// monotonically, so in a page well under budget this does nothing after the first
// call.
@(private = "file")
vm_arm_watchdog :: proc(vm: ^VM) {
	// A requested stop keeps its token limit until release, and a heap kill its floor:
	// without a budget nothing below would arm one again.
	if vm.stop_requested || vm.heap_hit {
		return
	}

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
		if vm.armed_limit > 0 {
			jsc.JSContextGroupClearExecutionTimeLimit(vm.group)
		}

		vm.armed_limit = 0
		vm.armed_by_budget = false
		return
	}

	// Re-arm when the clamp tightens by more than a tenth of the armed value (or the
	// reason changes, or it loosens — which within one holder only vm_set_* does). The
	// armed value then shrinks geometrically, so a budget B re-arms at most about
	// log(B / 1 ms) / log(1/0.9) times over a page's life — ~98 for B = 30 s — instead
	// of once per tick, and an entry can overrun the budget left by at most that tenth.
	if vm.armed_limit > 0 &&
	   by_budget == vm.armed_by_budget &&
	   want <= vm.armed_limit &&
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
	if vm == nil {
		return true
	}

	// A heap kill keeps its own reason: the floor it armed fires on whatever JS the
	// holder still reaches, and must not relabel the page as a CPU kill.
	if vm.stop_requested || vm.heap_hit {
		return true
	}

	if vm.armed_by_budget {
		vm.budget_hit = true
	} else {
		vm.limit_hit = true
	}

	// Latch the kill. JSC still drains the promise jobs queued before the cut as this
	// entry returns, and each of them would run under the limit armed for the entry it
	// just cut: a page killed at its budget B ran ~2B (measured on JSC 2.52 with a
	// standalone C probe, one run: 0.202 s of CPU for a 0.1 s limit; 0.102 s once the
	// limit is re-armed here). Re-arming from inside the callback is what makes the
	// floor apply to that same drain.
	context = runtime.default_context()
	vm_arm_kill_floor(vm)
	return true
}

// vm_arm_kill_floor arms the watchdog at its 1 ms floor for a holder a limit has
// ended, so whatever JS it still reaches is cut at once. vm_release clears it.
@(private = "file")
vm_arm_kill_floor :: proc(vm: ^VM) {
	if vm.armed_limit == KILL_FLOOR {
		return
	}

	vm.armed_limit = KILL_FLOOR
	jsc.JSContextGroupSetExecutionTimeLimit(vm.group, KILL_FLOOR, vm_watchdog_terminate, vm)
}

// KILL_FLOOR is the smallest watchdog limit the budget path already arms for a spent
// budget (vm_arm_watchdog's 1 ms clamp); a killed holder reuses it.
@(private = "file")
KILL_FLOOR :: 0.001

// vm_request_stop ends the VM's current holder from inside one of its natives: every
// later callback is skipped (page_stop_if_killed), and whatever JS still runs stops
// at its next VM trap (the watchdog, armed at a token limit). Not a kill:
// vm_kill_reason stays .None. Cleared when the VM is next acquired.
//
// The token limit only takes if a limit was already armed when the current entry
// began: measured, with none armed a limit set mid-entry never fired (a
// `process.exit(); while (true) {}` page hung). Runner pages always carry a CPU
// budget (page_runner_open refuses one without), which keeps the watchdog armed for
// every entry, so no extra arming is needed for this.
//
// Node:
//   process.exit() in a worker runs no more JS at all (TerminateExecution). The
//   calling script gets the same from JSC's termination exception (process_exit_cb).
// Deviates:
//   Promise jobs queued before the call still start when the entry returns — JSC
//   drains its job queue at every C-API exit, and nothing public skips that — and run
//   until the token limit's trap: bounded, not prevented. Pinned by
//   cmd/lava/page_runner_test.odin, runner_process_exit_bounds_promise_jobs_queued_before_it.
vm_request_stop :: proc(vm: ^VM) {
	if vm == nil {
		return
	}

	vm.stop_requested = true
	// The smallest limit that still arms: JSC treats 0 as "no limit".
	STOP_LIMIT :: 0.0001
	vm.armed_limit = STOP_LIMIT
	vm.armed_by_budget = false
	jsc.JSContextGroupSetExecutionTimeLimit(vm.group, STOP_LIMIT, vm_watchdog_terminate, vm)
}

// vm_pool_stats reports how many VMs are busy, how many the pool has ever created and
// how many of those it retired.
vm_pool_stats :: proc(pool: ^VM_Pool) -> (busy, created, retired: int) {
	for vm in pool.vms {
		if vm.in_use {
			busy += 1
		}
	}
	return busy, pool.created, pool.retired
}

// vm_retire_due reports whether a VM being released has reached one of its pool's
// retirement thresholds (VM_RETIRE_AFTER_PAGES says why they exist), or hosted a page
// its heap limit killed. That one is not a pool setting: such a heap was over a limit
// after a full collection, so whatever the next page would inherit is large, and a
// fresh VM is the only way to give it back. A heap kill retires whatever the pool's
// thresholds say, 0 included (runner_kills_a_page_over_its_heap_limit_alone).
//
// The heap trigger reads the sample page_close already took, and takes no reading of
// its own: the only exported read is jsc.heap_size_bytes, which walks the heap — 0.18-
// 0.28 ms on an empty one, 1.45-2.38 ms at 50k objects, 5.2-9.3 ms at 200k (page.odin
// gives the method) — so a reading here would be a sampling policy of its own, beside
// heap_sample_every, for the same number. A VM whose pages are never sampled is bounded
// by the page cap alone (runner_does_not_retire_on_heap_without_a_sample).
@(private = "file")
vm_retire_due :: proc(vm: ^VM) -> bool {
	pool := vm.pool

	if vm.heap_hit {
		return true
	}

	if pool.retire_after_pages > 0 && vm.pages_hosted >= pool.retire_after_pages {
		return true
	}

	return pool.retire_heap_bytes > 0 && vm.heap_bytes >= pool.retire_heap_bytes
}

// vm_retire destroys an idle VM and drops it from its pool, so the pool's next acquire
// creates a fresh one in its slot. The RunLoop is iterated once after the release, as
// vm_pool_destroy does and for the same reason: the VM's timer source closes its
// timerfd only then, and without it every retirement would leave one descriptor open
// for the life of the thread (vm_retirement_closes_the_retired_vms_timerfd). A thread
// with no drive keeps that old cost, one timerfd per retirement.
//
// The iteration may run RunLoop work other VMs on the thread posted; what it runs is
// what the runner's own between-rounds dispatch would have, routed through the posting
// page's loop by the deferred shim (deferred.odin). Nor can it enter a VM with a kill
// still armed (runloop_dispatch's warning): a page a limit ended is closed in the
// tick that ended it, so the only VM that can carry one here is this one, released.
@(private = "file")
vm_retire :: proc(vm: ^VM) {
	pool := vm.pool
	for i in 0 ..< len(pool.vms) {
		if pool.vms[i] == vm {
			ordered_remove(&pool.vms, i)
			break
		}
	}

	jsc.JSContextGroupRelease(vm.group)
	free(vm, pool.allocator)
	pool.retired += 1
	jsc.runloop_dispatch()
}
