package lava_runtime

import "core:strings"
import jsc "lava:pkg/jsc"
import eventloop "lava:pkg/runtime/eventloop"

// HEAP_COLLECT_BYTES is the sampled heap (Result.heap_bytes, every Nth page per VM) at
// or above which the VM's next page_create runs a full synchronous collection first.
// JSC's GC activity timers are off with the RunLoop drive (pkg/jsc/runloop_linux.odin),
// so this stands in for the collection they would have scheduled, where the heap is
// known to be large; an unsampled VM keeps JSC's allocation-driven collections only,
// which is all it ever had (the timers never fired before the drive either).
//
// 16 MB, measured with bench/pages (`<bin> 10 500 30 1 heavy`: 10 pages in flight on one
// runner thread, 500 pages, every page sampled, each keeping 50k small objects; medians
// of 5 interleaved launches per arm, -o:speed, Ryzen 7 7700X under a foreground game's
// load): master 96 pages/s and 66263 KB of RSS growth per VM; this change with no
// collection 103 and 45358; at 64 MB 103 and 43042 (such a page's heap rarely reaches
// it); at 16 MB 131 and 27396. The collection pays for itself: the next sample walks a
// collected heap.
HEAP_COLLECT_BYTES :: 16 * 1024 * 1024

// A page is one script run in its own global context, in its own pooled VM, with its
// own event loop (docs/LARVA.md decision 2). eval runs one page to completion; the
// page runner (page_runner.odin) interleaves many on one thread. Both drive the same
// three steps:
//
//   page_open   runtime install + the top-level script, charged to the page's limits;
//               itself page_create + page_run_script
//   page_tick   one event-loop tick, charged to the page's limits
//   page_close  the Result, then teardown in the order eval has always used; a loop
//               whose pool worker is still blocked is handed back, not waited for
//
// A caller that keeps the page between those steps (issue #3) has two more, on a
// live page, both charged to the same limits:
//
//   page_eval       one more classic script; a throw fails the call, not the page
//   page_run_until  ticks until a caller condition holds, the loop idles, a deadline
//                   passes, or the page ends
//
// Why one loop per page and not one loop per thread: everything a page registers —
// timers, sockets, fetches, thread-pool jobs — lives on its loop, so closing the page
// destroys the loop and cancels all of it. With a shared loop every handle would need
// a page owner tag, and one missed tag would fire a closed page's timer into the next
// page that reuses the VM (docs/GLOBAL-STATE.md, "The event loop"). The price is the
// loop's descriptors (epoll or io_uring, plus the wakeup pipe), closed with the page.
// Pool jobs are the one thing a page's loop does not own outright: the page runner's
// pages share its worker pool, and a job that is still running when its page closes
// finishes without it (eventloop threadpool.odin, #36).
Page :: struct {
	vm:           ^VM,
	ctx:          jsc.JSGlobalContextRef,
	global_class: jsc.JSClassRef,
	state:        ^Runtime_State,
	// The page's loop; nil for a loop-less eval. Owned (closed by page_close, or
	// handed back by it with a private pool's worker busy) from the moment it is
	// handed to page_open, on every path.
	loop:         ^eventloop.Loop,
	// The top-level completion value, kept for `lava eval`'s echo and GC-protected
	// until page_close, since the loop runs (and can collect) in between.
	completion:   jsc.JSValueRef,
	// The latest page_eval's completion value, GC-protected until the next page_eval or
	// page_close, whichever comes first — one slot, so a caller evaluating in a loop
	// roots one value, not every value it ever asked for.
	eval_value:   jsc.JSValueRef,
	// Fixed by page_create: page_run_script and page_eval follow it.
	surface:      Global_Surface,
	// Set by page_run_script on entry: a page runs one top-level script.
	script_ran:   bool,
	// Set once the Result is decided early (a pre-flight rejection, a top-level throw,
	// a limit kill): no more ticks, and page_close returns `result` as is.
	finished:     bool,
	result:       Result,
}

// Run_Stop is why page_run_until returned.
Run_Stop :: enum {
	// The caller's condition held (possibly before any tick).
	Met,
	// The loop has nothing left that keeps it alive; the page is live and evaluable.
	Idle,
	// The deadline passed first; the page is live and evaluable.
	Deadline,
	// The page ended — a limit kill, a requested stop, a failed or stopped loop — and
	// page_close returns its Result.
	Finished,
}

// Run_Until_Cond is page_run_until's condition. It runs on the loop thread between
// ticks, so it may page_eval the page; a page_eval that kills the page ends the run
// with .Finished.
Run_Until_Cond :: proc(page: ^Page, user_data: rawptr) -> bool

// page_open creates the page's context in a VM from `pool` (the thread's implicit
// pool by default), installs the runtime, and runs the top-level script.
//
// Returns:
//   true when the page has a loop worth ticking. false when it finished already —
//   its Result is decided — or has no loop. Either way the caller ends with
//   page_close, which owns the teardown on every path.
//
// This is eval's body, moved: ordering, error messages and exit codes are eval's,
// pinned by every oracle suite that runs through `lava run`/`lava eval`.
// `runner_page` makes process.exit() end this page instead of the process (the page
// runner hosts siblings on the same thread).
// `surface` (Global_Surface, runtime.odin) picks the global names the script can
// reach. `.Web` runs a classic script only: an `.mjs` source name is refused before
// a context exists, and the entry is neither registered in the module cache nor
// given the top-level nextTick drain. Lava's eval does the same three things.
//
// It is page_create + page_run_script, with the source pre-flight run first: a source
// refused there never costs a VM or a context, as before the split.
page_open :: proc(
	page: ^Page,
	source: string,
	source_name := "<eval>",
	loop: ^eventloop.Loop = nil,
	echo_result := false,
	script_args: []string = nil,
	limits: Page_Limits = {},
	pool: ^VM_Pool = nil,
	runner_page := false,
	surface: Global_Surface = .Node,
) -> bool {
	page^ = {}

	if refusal, refused := page_preflight(source, source_name, surface); refused {
		return page_finish_early(page, loop, refusal)
	}

	if !page_create(page, source_name, loop, script_args, limits, pool, runner_page, surface) {
		return false
	}

	return page_run_script(page, source, source_name, echo_result)
}

// page_create creates the page's context in a VM from `pool` (the thread's implicit
// pool by default) and installs the runtime, running no user source.
//
// Params:
//   source_name  The entry's name: process.argv[1] and, on `.Node`, __filename and
//                __dirname are derived from it at install, so it is the name the
//                top-level script will be run under (page_run_script's source_name).
//   loop         Owned by the page from this call on, on EVERY path: a failure here
//                destroys it, a success hands it to page_close.
// Returns:
//   true when the page is live: its context is installed and page_run_script,
//   page_eval, page_tick and page_run_until may follow. false when it finished
//   already — no VM, no context, limits this platform cannot enforce, or the CPU
//   budget spent during install — with its Result decided. Either way the caller
//   ends with page_close.
// Node:
//   No counterpart (a Larva page step). Its failures are page_open's, with page_open's
//   messages and exit codes, pinned by every suite running through `lava eval`.
//
// The other parameters are page_open's.
page_create :: proc(
	page: ^Page,
	source_name := "<eval>",
	loop: ^eventloop.Loop = nil,
	script_args: []string = nil,
	limits: Page_Limits = {},
	pool: ^VM_Pool = nil,
	runner_page := false,
	surface: Global_Surface = .Node,
) -> bool {
	page^ = {}
	page.surface = surface
	// A JS runtime must survive writes to closed pipes/sockets (Node parity):
	// see signals_posix.odin. Installed per page — the call is idempotent.
	ignore_sigpipe()

	// Configure JSC before the first JSGlobalContextCreate. On Windows this disables
	// the (buggy on this bun-webkit build) baseline JIT tier and runs JSC's proper
	// process bring-up — without it, heavy JS corrupts memory mid-execution
	// (0xC0000409, surfaced as exit 127). See pkg/jsc/jsc_init_windows.cpp for the
	// full rationale. Idempotent; a no-op on Linux/macOS.
	jsc.lava_jsc_init()

	// A custom global class gives the global object a private-data slot, where we
	// stash Runtime_State (loop + module cache) out of reach of user JavaScript.
	global_class := make_global_class()
	vm, ctx, vm_err := create_eval_context(global_class, pool)

	if ctx == nil {
		vm_release(vm)
		jsc.JSClassRelease(global_class)
		// A pool error means JSC is present but this thread has no VM to give: saying
		// "install JavaScriptCoreGTK" there would send the user after the wrong cause.
		switch vm_err {
		case .Exhausted:
			return page_finish_early(
				page,
				loop,
				vm_pool_unavailable("VM pool exhausted: every JavaScriptCore VM on this thread is busy"),
			)
		case .Create_Failed:
			return page_finish_early(
				page,
				loop,
				vm_pool_unavailable("JavaScriptCore could not create a VM (JSContextGroupCreate failed)"),
			)
		case .None:
		}
		return page_finish_early(page, loop, native_runtime_unavailable())
	}

	// Limits live on the VM, so without one (Windows: see create_eval_context) they
	// cannot be enforced. Refuse rather than run the page unlimited. Reached only on
	// Windows, which CI does not run, so this path has no test.
	if limits != {} && vm == nil {
		release_global_context_after_eval(ctx)
		jsc.JSClassRelease(global_class)
		return page_finish_early(
			page,
			loop,
			Result {
				status = .Invalid_Input,
				exit_code = 2,
				message = "page CPU limits need a pooled VM, which this platform does not use",
			},
		)
	}

	page.vm = vm
	page.ctx = ctx
	page.global_class = global_class

	// The collection JSC's GC activity timers used to be able to schedule, now that they
	// are off (pkg/jsc/runloop_linux.odin): a VM whose last sampled heap was large is
	// collected here, before the new page's first entry, so it is paid by no page's
	// budget, and after the previous page's context was released — collected at that
	// page's close, its whole realm would still have been reachable.
	if vm != nil && vm.collect_pending {
		vm.collect_pending = false
		jsc.collect_garbage_now(cast(jsc.JSContextRef)ctx)
	}

	if limits != {} {
		vm_set_entry_limit(vm, limits.entry_limit)
		vm_set_cpu_budget(vm, limits.cpu_budget)
	}

	state := new_runtime_state(loop)
	state.ctx = cast(jsc.JSContextRef)ctx
	state.vm = vm
	state.page_runner = runner_page
	page.state = state
	// From here the loop is torn down by page_close, with the state and context
	// still alive around it.
	page.loop = loop
	// Build Node's process.argv = [execPath, scriptPath, ...userArgs]. argv[0] is
	// the lava binary (absolute, like Node's execPath); argv[1] is the absolute
	// script path (omitted for `lava eval`, where there is no script file). Built in
	// the temp arena, which outlives install_process: nothing resets it before the
	// first loop tick.
	state.script_argv = build_process_argv(source_name, script_args)
	jsc.JSObjectSetPrivate(jsc.JSContextGetGlobalObject(cast(jsc.JSContextRef)ctx), cast(rawptr)state)

	// Snapshot the standard error constructors while globalThis is still pristine —
	// before setup_module_environment's builtin JS and, crucially, before any user
	// code. make_native_error builds native throws from these captured intrinsics, so
	// a script that later overwrites globalThis.RangeError/TypeError/etc. cannot
	// intercept or reshape a native error (matches Node, whose internal errors never
	// route through user-patched globals). See errors.odin.
	capture_error_intrinsics(cast(jsc.JSContextRef)ctx, state)
	// Same window, same reason: the typed-array cell probe learns which view modes
	// have a fixed length by constructing views through the global Uint8Array and
	// ArrayBuffer, so it must run before user code can replace them.
	jsc.prime_view_probe(cast(jsc.JSContextRef)ctx)

	// Runtime install is the first stretch on the page's VM charged to its CPU budget;
	// page_run_script's is the second. Before the split both were one stretch, and a
	// budget spent here was reported by the script's end-of-run check instead — the
	// same kill Result, now decided one step earlier.
	vm_cpu_enter(vm)
	setup_module_environment(cast(jsc.JSContextRef)ctx, source_name, loop, surface)
	vm_cpu_exit(vm)
	// Before any page code: what the install could not replace is not left as the engine's
	// on a thread whose RunLoop is driven (deferred.odin).
	deferred_fail_closed(cast(jsc.JSContextRef)ctx, state)

	if ended, result := page_ended(page); ended {
		return page_fail(page, result)
	}

	return true
}

// page_run_script runs `source` as the page's top-level script, on a page
// page_create made live.
//
// Params:
//   source_name  The name page_create was given: the script's source URL, `.mjs`
//                selects the ESM transform, and on `.Node` the entry is registered in
//                the module cache under it.
//   echo_result  Keep the completion value for page_close's Result.message.
// Returns:
//   page_open's contract: true when the page has a loop worth ticking; false when it
//   finished — a refused source, a throw, a limit kill — or has no loop, or was not
//   live, or already ran its top-level script (refused, the page unchanged). The
//   caller ends with page_close either way.
// Node:
//   The top-level run of `lava run`/`lava eval`: a throw is the process's uncaught
//   exception, exit code 1 — pinned by every oracle suite.
page_run_script :: proc(page: ^Page, source: string, source_name := "<eval>", echo_result := false) -> bool {
	// One top-level script per page: a second would take the completion slot the first
	// protected, and register a second entry module. Refused before anything runs; the
	// page is left as it was.
	if page.finished || page.ctx == nil || page.state == nil || page.script_ran {
		return false
	}

	page.script_ran = true
	ctx := page.ctx
	vm := page.vm
	state := page.state
	surface := page.surface

	// Applied again for a page_open caller, who ran it before page_create: string
	// checks, cheaper than a second code path that skips them.
	if refusal, refused := page_preflight(source, source_name, surface); refused {
		return page_fail(page, refusal)
	}

	// The entry body, its promise jobs and its nextTicks are one stretch on the page's
	// VM, charged to its CPU budget. Released on every return; vm_cpu_exit is a no-op
	// once the depth is back at 0.
	vm_cpu_enter(vm)
	defer vm_cpu_exit(vm)

	// ESM entrypoints (.mjs) are rewritten to CommonJS via the same transform the
	// loader applies to imported .mjs modules; script (.js) and `lava eval`
	// sources run unchanged.
	eval_source := source
	mjs_wrapped: string
	mjs_allocated := false
	defer if mjs_allocated {
		delete(mjs_wrapped)
	}

	if strings.has_suffix(source_name, ".mjs") {
		wrap_exception: jsc.JSValueRef
		wrapped, ok := esm_wrap_source(cast(jsc.JSContextRef)ctx, source, source_name, &wrap_exception)

		if !ok {
			return page_fail_with_exception(page, wrap_exception)
		}

		eval_source = wrapped
		mjs_wrapped = wrapped
		mjs_allocated = true
	} else if surface == .Node {
		// Register the CommonJS/script entry in the module cache before it runs, so
		// requiring the entry by path returns the same instance (and an entry-
		// involved require cycle terminates instead of re-executing the entry). The
		// .mjs entry handles this itself via __lava_precache in its transformed body.
		register_entry_module(cast(jsc.JSContextRef)ctx, state, source_name)
	}

	value, exception, alloc_failure := page_evaluate(page, eval_source, source_name)

	if alloc_failure != "" {
		return page_fail(page, Result{status = .Invalid_Input, exit_code = 2, message = alloc_failure})
	}

	if exception != nil {
		return page_fail_with_exception(page, exception)
	}

	// Refresh the cached entry exports: a CommonJS entry body may have reassigned
	// module.exports, so the pre-eval partial registered above is now stale.
	if !mjs_allocated && surface == .Node {
		register_entry_module(cast(jsc.JSContextRef)ctx, state, source_name)
	}

	// Kept for the echo, protected because the loop runs before page_close reads it.
	if echo_result && value != nil && !jsc.JSValueIsUndefined(cast(jsc.JSContextRef)ctx, value) {
		jsc.JSValueProtect(cast(jsc.JSContextRef)ctx, value)
		page.completion = value
	}

	// The drain page_evaluate appended ran nextTicks queued synchronously by the
	// top-level body; this runs the ones queued by the promise jobs JSC auto-drained
	// when JSEvaluateScript returned — so the nextTick queue is empty before the loop's
	// first timer/I/O phase, since Node drains nextTicks ahead of timers. Same
	// after-the-boundary re-drain that invoke_user_callback does per callback.
	drain_next_ticks_settled(cast(jsc.JSContextRef)ctx, state)
	vm_cpu_exit(vm)

	if ended, result := page_ended(page); ended {
		return page_fail(page, result)
	}

	return page.loop != nil
}

// page_eval runs `source` as one more classic script on a live page, after its
// top-level script and between its ticks.
//
// Params:
//   source_name  The script's source URL, as stack traces show it.
// Returns:
//   value  The completion value. GC-protected until the next page_eval or page_close,
//          whichever comes first: copy what is needed out of it before either. nil
//          when ok is false. On `.Web` it may be an object of a hostile realm, and
//          converting it natively (JSValueToStringCopy, value_to_string) runs page code
//          — toString, Symbol.toPrimitive — outside the CPU budget and unseen by its
//          kill check. Have the script return the primitive (`String(expr)`), which
//          converts inside the charged call, or convert only primitives.
//   ok     false when the script threw, when a limit or a requested stop ended the
//          page during it, or when the call was refused. A refusal for a finished page
//          or a page with no context enters no JS and releases nothing; one for a
//          source the runtime could not allocate enters no JS but has already released
//          the previous value, like every call that reaches the page.
// Resets:
//   Every call that reaches the page ends with free_all(context.temp_allocator), the
//   calling thread's temp arena, as eval does: temp memory the caller holds across a
//   page_eval is gone when it returns.
// Node:
//   No counterpart (a Larva page step). What the script sees is the page's realm,
//   exactly as a timer callback would.
//
// A throw is the call's failure, not the page's: unlike the top-level script it does
// not decide the Result, so the page goes on ticking and evaluating, and a page that
// only ever threw here still closes .Ok. A limit kill or a requested stop
// (process.exit on a runner page) does end the page — those belong to the page, not
// the call — and page_close returns that Result. The call is charged to the page's
// CPU budget like a tick. On `.Node` it ends with the same nextTick drain as the
// top-level script (the appended drain plus drain_next_ticks_settled), so a nextTick
// it queues runs before the next timer; `.Web` has neither, as for the top-level
// script. No ESM: an `.mjs` source_name only names the script.
page_eval :: proc(page: ^Page, source: string, source_name := "<page_eval>") -> (value: jsc.JSValueRef, ok: bool) {
	if page.finished || page.ctx == nil || page.state == nil {
		return nil, false
	}

	// Per-eval temp arena boundary, as in eval and native_require_cb (CLAUDE.md §4):
	// page_evaluate's scratch (the source name's cstring, on `.Node` the source plus
	// its drain) and whatever the script's natives take would otherwise wait for the
	// next tick's reset — forever on a page with no loop, and a source's size per call
	// for a host evaluating between ticks. free_all rather than a temp guard because a
	// require the script makes runs its own free_all mid-call, which a guard's rewind
	// asserts against. Nothing returned lives in the temp arena: the value is JSC's.
	defer free_all(context.temp_allocator)

	ctx := cast(jsc.JSContextRef)page.ctx

	// The previous value is released before the script runs, not after: the slot is
	// one value, and the script may allocate enough to collect it.
	if page.eval_value != nil {
		jsc.JSValueUnprotect(ctx, page.eval_value)
		page.eval_value = nil
	}

	vm_cpu_enter(page.vm)
	result, exception, alloc_failure := page_evaluate(page, source, source_name)

	// Rooted before the drain, not after: the drain runs page JS (nextTicks and the
	// promise jobs a C-API exit flushes), which can allocate and collect, and a value
	// held only in a native local is live then only by JSC's conservative stack scan
	// (CLAUDE.md §4). page_evaluate leaves `result` nil on a throw.
	if result != nil {
		jsc.JSValueProtect(ctx, result)
		page.eval_value = result
	}

	// A throw leaves the page live, so its queued nextTicks still run ahead of the next
	// timer, as after any callback that threw.
	if alloc_failure == "" {
		drain_next_ticks_settled(ctx, page.state)
	}

	vm_cpu_exit(page.vm)

	if ended, end := page_ended(page); ended {
		// A kill during the drain: the call fails, so the slot holds nothing. The
		// context is still alive; only page_close releases it.
		if page.eval_value != nil {
			jsc.JSValueUnprotect(ctx, page.eval_value)
			page.eval_value = nil
		}

		page_fail(page, end)
		return nil, false
	}

	if alloc_failure != "" || exception != nil {
		return nil, false
	}

	return result, true
}

// page_run_until ticks a live page until `cond` holds, its loop idles, `deadline_ms`
// passes, or the page ends.
//
// Params:
//   cond         Checked once before the first tick — already true is .Met with no
//                tick — and after every tick. It may page_eval the page; it must not
//                close or destroy it (page_close, or anything that frees the loop).
//   user_data    Passed to `cond`.
//   deadline_ms  Bound on the call, measured on the page loop's clock (wall clock
//                for a real_time loop, which every Lava page loop is). 0: no bound.
// Returns:
//   Why it stopped (Run_Stop). After .Met, .Idle and .Deadline the page is live; after
//   .Finished it has ended and page_close returns its Result. A finished page answers
//   .Finished without calling `cond`; a page with no loop answers .Idle after it.
// Node:
//   No counterpart (a Larva page step).
//
// The deadline is decided by the loop's clock after every tick, not by a timer firing:
// page JS can clearTimeout any handle id (clear_timer_cb, globals.odin), the deadline
// timer's included, so a run that waited for the timer would never end once a page
// cancelled it. The timer is only the WAKE-UP: an UNREFFED timer on the page's own loop,
// so a tick blocked in its poll (a far timer, a socket with nothing to read) wakes when
// the deadline is due rather than sleeping through it, while a loop with nothing else
// left still reads as idle — a reffed timer would keep it alive until the deadline.
// Before every tick it is re-armed for the time left if it is no longer live (a map
// lookup, versus a clear plus a heap push and a fresh id on every tick were it simply
// re-set each turn). Residual: a page that clears it DURING a tick can still block that
// one tick's poll until its own next timer or I/O. Cleared on every return — unless
// `cond` broke the contract and the page no longer holds the loop it was armed on. A
// tick is page_tick, limits and all, so a run that crosses many ticks is charged
// exactly like eval's loop. Single page only: the page runner drives its own loop.
page_run_until :: proc(page: ^Page, cond: Run_Until_Cond, user_data: rawptr = nil, deadline_ms: u64 = 0) -> Run_Stop {
	if page_run_over(page) {
		return .Finished
	}

	if cond(page, user_data) {
		return page_run_over(page) ? .Finished : .Met
	}

	loop := page.loop

	if loop == nil {
		return .Idle
	}

	deadline_at := page_loop_now(loop) + deadline_ms
	wake: eventloop.Timer_ID

	defer if wake != 0 && page.loop == loop {
		eventloop.clear_timeout(loop, wake)
	}

	for {
		if deadline_ms > 0 {
			if _, live := loop.timer_index[wake]; !live {
				now := page_loop_now(loop)
				wake = eventloop.set_timeout(loop, page_deadline_wake, deadline_at > now ? deadline_at - now : 0)
				eventloop.timer_unref(loop, wake)
			}
		}

		alive, _ := page_tick(page)

		if page_run_over(page) {
			return .Finished
		}

		met := cond(page, user_data)

		if page_run_over(page) {
			return .Finished
		}

		if met {
			return .Met
		}

		if !alive {
			return .Idle
		}

		if deadline_ms > 0 && page_loop_now(loop) >= deadline_at {
			return .Deadline
		}
	}
}

// page_tick runs one event-loop tick of the page, charged to its limits.
//
// Returns:
//   alive     false once the page has nothing left to run, its backend failed, it
//             was told to stop, or a limit ended it; call page_close.
//   did_work  whether the tick made progress, for a driver deciding to block.
//
// The tick is the outer unit of the CPU budget: a tick's poll blocks without
// advancing the thread's CPU clock, so the whole tick — callbacks plus the native
// work around them — is the page's. Inside it, invoke_user_callback and every
// nextTick drain pass checkpoint the budget too (vm_cpu_checkpoint), since one tick
// can fire any number of entries. force_exit lets page_close reclaim whatever the
// page still had registered. The loop condition mirrors eventloop.run's; a new exit
// condition there belongs here too.
page_tick :: proc(page: ^Page) -> (alive: bool, did_work: bool) {
	loop := page.loop

	if page.finished || loop == nil {
		return false, false
	}

	if !eventloop.has_pending_work(loop) || loop.backend_error || loop.force_exit {
		return false, false
	}

	// JSC's RunLoop is the thread's to drive, and a loop that blocks on its own is the
	// thread's only driver: serviced here, before the tick and outside its CPU window
	// (deferred.odin). The runner's never_block loops leave it to the runner.
	if !loop.never_block {
		deferred_service_page(page.state)
	}

	vm_cpu_enter(page.vm)
	did_work = eventloop.run_next(loop)
	vm_cpu_exit(page.vm)

	if ended, result := page_ended(page); ended {
		loop.force_exit = true
		page_fail(page, result)
		return false, did_work
	}

	return true, did_work
}

// page_close decides the page's Result (unless it already finished) and tears the
// page down. Safe on a page whose page_open failed at any point.
//
// Params:
//   heap_sample_every  Sample the VM's heap into Result.heap_bytes when this page is
//                      the VM's Nth (VM.pages_hosted % N == 0) and no limit or cancel
//                      ended it; 0 (eval's default) never samples.
//   report             eval's Result_Hook (runtime.odin), fired exactly once with the
//                      Result returned here, after the heap sample and BEFORE step 1 of
//                      the teardown: the loop and context are still alive, and nothing
//                      has joined a pool worker yet. nil (the page runner's case: it
//                      reports through on_done) fires nothing.
//   report_data        Passed to `report`.
// Returns:
//   result     The page's Result.
//   busy_loop  nil once the page's loop is fully closed, or when it had none — always
//              for a loop attached to a shared pool (the page runner's): a job still
//              running there is an orphan its worker finishes alone. The loop itself
//              when it owns a private pool (eval) and one of its workers was still
//              inside a job — a read on a FIFO, a DNS lookup the resolver has not
//              answered — so that closing it would wait for as long as the job blocks
//              (#34). Its JS side is gone and every callback released; what is left is
//              the loop's pool, its async queue and its wakeup pipe, which the caller
//              owns finishing with eventloop.close_finish, which waits.
// Node:
//   No observable change: a closing page's callbacks never ran after close before
//   either; only when the thread gets back moves.
//
// Teardown order is eval's, and each step needs the ones after it still alive:
//   1. settle active fetches, close net handles, then eventloop.close_begin — its
//      dispose and cancel hooks unprotect callbacks, so the context must be alive.
//      close_begin settles every pool job (fs, node:dns and fetch's DNS lookups all run
//      on the loop's pool) without waiting for one a worker is still running: that
//      job's JS half is released by its cancel hook here, and its memory goes when its
//      `work` returns;
//   2. destroy_runtime_state — JSValueUnprotect on cached modules needs the context;
//   3. release the context;
//   4. return the VM to its pool, only after its context is gone: a pooled VM never
//      hosts two live contexts. Also what keeps a killed page's leftover promise jobs
//      out of the next page: JSC's job queue is the VM's, and jobs a watchdog cut
//      leaves behind run during the next C-API exits on the VM — steps 1-3 make
//      several on this page's own context, and after those they never run again
//      (pinned by vm_watchdog_cut_job_chain_does_not_outlive_the_next_api_exits and
//      runner_second_page_in_a_reused_vm_sees_nothing_of_a_killed_first);
//   5. release the global class;
//   6. eventloop.close_finish, when no worker was busy: it returns at once (a private
//      pool's idle workers exit on its release; a shared pool is not waited on at all)
//      and closes the loop's last descriptor, its wakeup pipe.
page_close :: proc(
	page: ^Page,
	heap_sample_every := 0,
	report: Result_Hook = nil,
	report_data: rawptr = nil,
) -> (
	result: Result,
	busy_loop: ^eventloop.Loop,
) {
	ctx := cast(jsc.JSContextRef)page.ctx

	if !page.finished && page.state != nil {
		// process.exitCode can be a getter or carry a valueOf: user JS, so charged and
		// checked like any other entry.
		vm_cpu_enter(page.vm)
		exit_code := resolve_exit_code(ctx, page.state)
		vm_cpu_exit(page.vm)

		if ended, result := page_ended(page); ended {
			page.result = result
		} else {
			page.result = Result {
				status    = .Ok,
				exit_code = exit_code,
			}

			if page.completion != nil {
				msg, allocated := value_to_string(ctx, page.completion)
				page.result.message = msg
				page.result.is_allocated = allocated
			}
		}

		page.finished = true
	}

	// The heap sample (Result.heap_bytes), read here because this is the last point
	// where the VM is still this page's and its context is alive. Every Nth page per
	// VM (VM.pages_hosted), so a runner's sampling cost is spread over its VMs. Never a
	// page a limit or a cancel ended: its heap is not a finished page's, and the call's
	// C-API exit would run whatever promise jobs the kill left queued. The call walks
	// the heap (jsc.heap_size_bytes) and is not charged to the page's CPU budget — the
	// page's verdict is already final, so an opted-in embedder pays it outside every
	// budget. Measured with bench/pages (`bench-pages 10 1000 30 <0|1> <shape>`: 10 pages
	// in flight on one runner thread, 1000 pages churned, every page sampled vs none,
	// medians of 7 interleaved launches per arm, -o:speed, 4-core Xeon @ 2.10GHz): a
	// trivial page went from 133 to 109 pages/s (+1.7 ms a page), a page keeping 50k
	// small objects alive (shape `heavy`) from 107 to 54 (+9.2 ms). The call alone, by a
	// standalone probe on the same box (not in the tree; to reproduce: one
	// JSContextGroupCreate + JSGlobalContextCreateInGroup with no class and no Lava
	// runtime, evaluate `globalThis.keep = Array.from({ length: K }, (_, i) => ({ i }))`
	// for K = 0, 10k, 50k, 200k in turn on that one context, and time 7 back-to-back
	// jsc.heap_size_bytes calls after each; median per K, 5 launches, -o:speed): 0.18-
	// 0.28 ms at K = 0, 0.35-0.59 ms at 10k, 1.45-2.38 ms at 50k, 5.2-9.3 ms at 200k —
	// it grows with the heap it walks. Hence every Nth.
	if heap_sample_every > 0 &&
	   page.vm != nil &&
	   page.ctx != nil &&
	   page.vm.pages_hosted % heap_sample_every == 0 &&
	   page.result.kill == .None {
		if bytes, ok := jsc.heap_size_bytes(ctx); ok {
			page.result.heap_bytes = bytes
			page.vm.collect_pending = bytes >= HEAP_COLLECT_BYTES
		}
	}

	// Borrowed, not handed over: the caller of page_close still owns page.result.
	if report != nil {
		report(page.result, report_data)
	}

	if page.completion != nil {
		jsc.JSValueUnprotect(ctx, page.completion)
	}

	if page.eval_value != nil {
		jsc.JSValueUnprotect(ctx, page.eval_value)
	}

	if page.loop != nil {
		deferred_unwatch_loop(page.state)
		fetch_shutdown_active(page.state)

		if eventloop.close_begin(page.loop) {
			busy_loop = page.loop
		}
	}

	if page.state != nil {
		destroy_runtime_state(ctx, page.state)
	}

	// No RunLoop dispatch here, though the design had one (#91: drain what JSC queued for
	// this realm before its context goes). It bought nothing the shim does not already
	// give — a closed page's natives find no Runtime_State, so whatever JSC runs for the
	// realm later posts nowhere (deferred.odin) — and it cost a pinned behaviour: on a
	// page a limit ended, the dispatch entered the VM before vm_release disarmed the
	// kill, and the next page on the VM lost its first callback chain without a kill
	// (cpu_budget_kills_a_next_tick_ping_pong red after cpu_budget_kills_many_timers_in_one_tick,
	// green with only this dispatch removed; measured 2026-11-26).
	if page.ctx != nil {
		release_global_context_after_eval(page.ctx)
	}

	vm_release(page.vm)

	if page.global_class != nil {
		jsc.JSClassRelease(page.global_class)
	}

	if page.loop != nil && busy_loop == nil {
		eventloop.close_finish(page.loop)
	}

	result = page.result
	page^ = {}
	return
}

// page_fail records an early Result; page_close returns it after the teardown.
@(private = "file")
page_fail :: proc(page: ^Page, result: Result) -> bool {
	page.finished = true
	page.result = result
	return false
}

// page_fail_with_exception records a throw from the top-level script or the .mjs
// wrap — unless a limit killed it, in which case the kill is the result.
@(private = "file")
page_fail_with_exception :: proc(page: ^Page, exception: jsc.JSValueRef) -> bool {
	if ended, result := page_ended(page); ended {
		return page_fail(page, result)
	}

	msg, allocated := value_to_string(cast(jsc.JSContextRef)page.ctx, exception)
	return page_fail(page, Result{status = .Execution_Error, exit_code = 1, message = msg, is_allocated = allocated})
}

// page_ended reports whether a limit or a requested stop has ended the page, with the
// Result that says which. A stop (process.exit in a runner page) is a normal end: .Ok
// with the exit code the page asked for.
@(private = "file")
page_ended :: proc(page: ^Page) -> (bool, Result) {
	if kill := vm_kill_reason(page.vm); kill != .None {
		return true, page_killed(kill)
	}

	if page.vm != nil && page.vm.stop_requested && page.state != nil {
		return true, Result{status = .Ok, exit_code = page.state.page_exit_code}
	}

	return false, {}
}

// page_cancel ends a page that is still running without ticking it further — the
// runner's destroy. Its Result says so rather than reading as a page that finished.
page_cancel :: proc(page: ^Page) {
	if page.finished {
		return
	}

	page_fail(page, page_killed(.Cancelled))
}

// page_killed_result is page_killed for callers outside this file (the runner reports
// a page it refuses during destroy as .Cancelled without opening it).
page_killed_result :: proc(kill: Kill_Reason) -> Result {
	return page_killed(kill)
}

// page_killed builds the Result for a page a limit ended.
//
// Node:
//   No counterpart: Node has no per-script CPU limit, so the messages are Larva's.
// Deviates:
//   n/a (no oracle). Status, Result.kill and the message wording are pinned by
//   cmd/lava/page_cpu_budget_test.odin.
@(private = "file")
page_killed :: proc(kill: Kill_Reason) -> Result {
	msg: string
	switch kill {
	case .Entry_Limit:
		msg = "page killed: a script exceeded the execution time limit"
	case .Cpu_Budget:
		msg = "page killed: CPU budget exceeded"
	case .Cancelled:
		msg = "page cancelled: its runner was destroyed while it ran"
	case .Reaping_Full:
		msg = "page refused: its runner holds too many closed pages still waiting on blocked work"
	case .None:
	}
	return Result{status = .Execution_Error, exit_code = 1, message = msg, kill = kill}
}

// page_finish_early ends a page that holds no context yet. The loop is consumed on
// EVERY path (eval's OWNERSHIP contract), and until the page owns a context it holds
// no handles, so these early exits destroy it directly.
@(private = "file")
page_finish_early :: proc(page: ^Page, loop: ^eventloop.Loop, result: Result) -> bool {
	if loop != nil {
		eventloop.destroy(loop)
	}

	page.finished = true
	page.result = result
	return false
}

// page_preflight is the top-level script's source check, which needs no context:
// page_open runs it before one exists, page_run_script again on a live page.
@(private = "file")
page_preflight :: proc(source, source_name: string, surface: Global_Surface) -> (refusal: Result, refused: bool) {
	invalid_input :: proc(message: string) -> Result {
		return Result{status = .Invalid_Input, exit_code = 2, message = message}
	}

	if len(source) == 0 {
		return invalid_input("empty JavaScript source"), true
	}

	if strings.has_prefix(source_name, "node:") {
		return invalid_input("node: specifiers are module names, not eval source names"), true
	}

	// The ESM transform rewrites an `.mjs` entry to CommonJS that calls `require` and
	// `__lava_precache`, neither of which a `.Web` context has; refused here, before a
	// context exists, rather than failing inside the transformed body.
	if surface == .Web && strings.has_suffix(source_name, ".mjs") {
		refusal = invalid_input("the web global surface runs classic scripts only; .mjs sources need the node surface")
		return refusal, true
	}

	return {}, false
}

// page_evaluate runs `source` as a classic script on the page's context — the part
// the top-level script and page_eval share. The caller holds the CPU stretch.
// `alloc_failure` is the Result message when the source or its name could not be
// handed to JSC (nothing ran); otherwise exactly one of value/exception is the outcome.
@(private = "file")
page_evaluate :: proc(
	page: ^Page,
	source, source_name: string,
) -> (
	value: jsc.JSValueRef,
	exception: jsc.JSValueRef,
	alloc_failure: string,
) {
	eval_source := source

	// Drain the turn's process.nextTick queue *before* JSEvaluateScript returns: JSC
	// auto-drains its promise jobs at that boundary, so a nextTick queued by the body
	// would otherwise lose to a promise job queued before it (Node runs nextTick
	// first). There is no native hook between "script body done" and "JSC drains", so
	// we append the drain as a trailing statement — the same role dispatch plays for
	// event-loop callbacks. It is a VariableStatement (empty completion value) so it
	// does not clobber the script's completion value used by `lava eval`'s echo and
	// page_eval; the leading "\n;" guards a trailing line comment / missing semicolon;
	// typeof keeps it a no-op if the microtask shim failed to install.
	//
	// Not on `.Web`: nothing a `.Web` script can name queues a nextTick, so there is no
	// ordering to keep, and the drain's two globals are deliberately absent there
	// (install_microtasks). The post-evaluation drain_next_ticks_settled the callers run
	// still runs on both surfaces; it goes through Runtime_State, not a global.
	TOP_LEVEL_DRAIN :: "\n;var __lava_tl_drain = (typeof __lavaDrainNextTicks === 'function') && __lavaDrainNextTicks();\n"

	if page.surface == .Node {
		if combined, concat_err := strings.concatenate({eval_source, TOP_LEVEL_DRAIN}, context.temp_allocator);
		   concat_err == nil {
			eval_source = combined
		}
	}

	script := js_string_from_string(eval_source)

	if script == nil {
		return nil, nil, "could not allocate JavaScript source string"
	}

	defer jsc.JSStringRelease(script)

	c_source_name, c_source_name_err := strings.clone_to_cstring(source_name, context.temp_allocator)

	if c_source_name_err != nil {
		return nil, nil, "could not allocate JavaScript source name"
	}

	source_url := jsc.JSStringCreateWithUTF8CString(c_source_name)

	if source_url == nil {
		return nil, nil, "could not allocate JavaScript source URL object"
	}

	defer jsc.JSStringRelease(source_url)

	value = jsc.JSEvaluateScript(cast(jsc.JSContextRef)page.ctx, script, nil, source_url, 1, &exception)

	if exception != nil {
		value = nil
	}

	return
}

// page_run_over reports whether page_run_until must stop with .Finished: the page's
// Result is decided, or its loop can no longer run (a failed backend, a forced exit) —
// the two ways page_tick stops for good rather than for want of work.
@(private = "file")
page_run_over :: proc(page: ^Page) -> bool {
	return page.finished || (page.loop != nil && (page.loop.backend_error || page.loop.force_exit))
}

// page_deadline_wake is page_run_until's wake-up timer. It does nothing: firing is what
// ends a poll blocked past the deadline, and the run reads the clock itself.
@(private = "file")
page_deadline_wake :: proc(loop: ^eventloop.Loop, user_data: rawptr) {}

// page_loop_now reads the clock the loop's timers run on: the monotonic clock for a
// real_time loop (read now, not the loop's last sample, so a deadline is not missed by
// the time since the tick last synced), the loop's own simulated time otherwise.
@(private = "file")
page_loop_now :: proc(loop: ^eventloop.Loop) -> u64 {
	return loop.real_time ? eventloop.real_now_ms(loop) : eventloop.now(loop)
}
