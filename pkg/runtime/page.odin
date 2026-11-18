package lava_runtime

import "core:strings"
import jsc "lava:pkg/jsc"
import eventloop "lava:pkg/runtime/eventloop"

// A page is one script run in its own global context, in its own pooled VM, with its
// own event loop (docs/LARVA.md decision 2). eval runs one page to completion; the
// page runner (page_runner.odin) interleaves many on one thread. Both drive the same
// three steps:
//
//   page_open   runtime install + the top-level script, charged to the page's limits
//   page_tick   one event-loop tick, charged to the page's limits
//   page_close  the Result, then teardown in the order eval has always used; a loop
//               whose pool worker is still blocked is handed back, not waited for
//
// Why one loop per page and not one loop per thread: everything a page registers —
// timers, sockets, fetches, thread-pool jobs — lives on its loop, so closing the page
// destroys the loop and cancels all of it. With a shared loop every handle would need
// a page owner tag, and one missed tag would fire a closed page's timer into the next
// page that reuses the VM (docs/GLOBAL-STATE.md, "The event loop"). The price is the
// loop's descriptors (epoll or io_uring, plus the wakeup pipe), closed with the page —
// the pipe later, if a pool worker is still blocked (page_close).
Page :: struct {
	vm:           ^VM,
	ctx:          jsc.JSGlobalContextRef,
	global_class: jsc.JSClassRef,
	state:        ^Runtime_State,
	// The page's loop; nil for a loop-less eval. Owned (closed by page_close, or
	// handed back by it with a busy worker) from the moment it is handed to
	// page_open, on every path.
	loop:         ^eventloop.Loop,
	// The top-level completion value, kept for `lava eval`'s echo and GC-protected
	// until page_close, since the loop runs (and can collect) in between.
	completion:   jsc.JSValueRef,
	// Set once the Result is decided early (a pre-flight rejection, a top-level throw,
	// a limit kill): no more ticks, and page_close returns `result` as is.
	finished:     bool,
	result:       Result,
}

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
	// The loop is consumed on EVERY path (eval's OWNERSHIP contract). Until the page
	// owns a context it holds no handles, so these early exits destroy it directly.
	finish_early :: proc(page: ^Page, loop: ^eventloop.Loop, result: Result) -> bool {
		if loop != nil {
			eventloop.destroy(loop)
		}

		page.finished = true
		page.result = result
		return false
	}

	if len(source) == 0 {
		return finish_early(
			page,
			loop,
			Result{status = .Invalid_Input, exit_code = 2, message = "empty JavaScript source"},
		)
	}

	if strings.has_prefix(source_name, "node:") {
		return finish_early(
			page,
			loop,
			Result {
				status = .Invalid_Input,
				exit_code = 2,
				message = "node: specifiers are module names, not eval source names",
			},
		)
	}

	// The ESM transform rewrites an `.mjs` entry to CommonJS that calls `require` and
	// `__lava_precache`, neither of which a `.Web` context has; refused here, before a
	// context exists, rather than failing inside the transformed body.
	if surface == .Web && strings.has_suffix(source_name, ".mjs") {
		return finish_early(
			page,
			loop,
			Result {
				status = .Invalid_Input,
				exit_code = 2,
				message = "the web global surface runs classic scripts only; .mjs sources need the node surface",
			},
		)
	}

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
			return finish_early(
				page,
				loop,
				vm_pool_unavailable("VM pool exhausted: every JavaScriptCore VM on this thread is busy"),
			)
		case .Create_Failed:
			return finish_early(
				page,
				loop,
				vm_pool_unavailable("JavaScriptCore could not create a VM (JSContextGroupCreate failed)"),
			)
		case .None:
		}
		return finish_early(page, loop, native_runtime_unavailable())
	}

	// Limits live on the VM, so without one (Windows: see create_eval_context) they
	// cannot be enforced. Refuse rather than run the page unlimited. Reached only on
	// Windows, which CI does not run, so this path has no test.
	if limits != {} && vm == nil {
		release_global_context_after_eval(ctx)
		jsc.JSClassRelease(global_class)
		return finish_early(
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

	if limits != {} {
		vm_set_entry_limit(vm, limits.entry_limit)
		vm_set_cpu_budget(vm, limits.cpu_budget)
	}

	state := new_runtime_state(loop)
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

	// Register the graceful-shutdown drain hook (multi-worker, Linux only): when the supervisor
	// requests a stop, the loop runs net_drain_begin on its own thread to stop accepting and drain
	// in-flight connections. KNOWN DIVERGENCE (design §9): only the multi-worker supervisor blocks
	// SIGINT/SIGTERM and calls request_shutdown, so this hook never fires for a single-worker run
	// (LAVA_WORKERS unset/1) — there SIGTERM still terminates immediately without draining, as it did
	// before Slice 3a. Routing the single-worker path through the same machinery is a follow-up.
	when ODIN_OS == .Linux {
		if loop != nil {
			eventloop.set_shutdown_hook(loop, net_drain_begin, state)
		}
	}

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

	// Everything from here to the loop is one stretch on the page's VM, charged to its
	// CPU budget: runtime install, the entry body, its promise jobs and nextTicks.
	// Released on every return; vm_cpu_exit is a no-op once the depth is back at 0.
	vm_cpu_enter(vm)
	defer vm_cpu_exit(vm)

	setup_module_environment(cast(jsc.JSContextRef)ctx, source_name, loop, surface)

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

	// Drain the top-level turn's process.nextTick queue *before* JSEvaluateScript
	// returns: JSC auto-drains its promise jobs at that boundary, so a nextTick
	// queued at top level would otherwise lose to a promise job queued before it
	// (Node runs nextTick first). There is no native hook between "script body done"
	// and "JSC drains", so we append the drain as a trailing statement — the same
	// role dispatch plays for event-loop callbacks. It is a VariableStatement (empty
	// completion value) so it does not clobber the script's completion value used by
	// `lava eval`'s echo; the leading "\n;" guards a trailing line comment / missing
	// semicolon; typeof keeps it a no-op if the microtask shim failed to install.
	//
	// Not on `.Web`: nothing a `.Web` script can name queues a nextTick, so there is no
	// ordering to keep, and the drain's two globals are deliberately absent there
	// (install_microtasks). The post-evaluation drain_next_ticks_settled below still
	// runs on both surfaces; it goes through Runtime_State, not a global.
	TOP_LEVEL_DRAIN :: "\n;var __lava_tl_drain = (typeof __lavaDrainNextTicks === 'function') && __lavaDrainNextTicks();\n"

	if surface == .Node {
		if combined, concat_err := strings.concatenate({eval_source, TOP_LEVEL_DRAIN}, context.temp_allocator);
		   concat_err == nil {
			eval_source = combined
		}
	}

	script := js_string_from_string(eval_source)

	if script == nil {
		return page_fail(
			page,
			Result{status = .Invalid_Input, exit_code = 2, message = "could not allocate JavaScript source string"},
		)
	}

	defer jsc.JSStringRelease(script)

	c_source_name, c_source_name_err := strings.clone_to_cstring(source_name, context.temp_allocator)

	if c_source_name_err != nil {
		return page_fail(
			page,
			Result{status = .Invalid_Input, exit_code = 2, message = "could not allocate JavaScript source name"},
		)
	}

	source_url := jsc.JSStringCreateWithUTF8CString(c_source_name)

	if source_url == nil {
		return page_fail(
			page,
			Result {
				status = .Invalid_Input,
				exit_code = 2,
				message = "could not allocate JavaScript source URL object",
			},
		)
	}

	defer jsc.JSStringRelease(source_url)

	exception: jsc.JSValueRef
	value := jsc.JSEvaluateScript(cast(jsc.JSContextRef)ctx, script, nil, source_url, 1, &exception)

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

	// The drain appended above ran nextTicks queued synchronously by the top-level
	// body; this runs the ones queued by the promise jobs JSC auto-drained when
	// JSEvaluateScript returned — so the nextTick queue is empty before the loop's
	// first timer/I/O phase, since Node drains nextTicks ahead of timers. Same
	// after-the-boundary re-drain that invoke_user_callback does per callback.
	drain_next_ticks_settled(cast(jsc.JSContextRef)ctx, state)
	vm_cpu_exit(vm)

	if ended, result := page_ended(page); ended {
		return page_fail(page, result)
	}

	return loop != nil
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
//   busy_loop  nil once the page's loop is fully closed, or when it had none. The loop
//              itself when one of its pool workers was still inside a job — a read on
//              a FIFO, a DNS lookup the resolver has not answered — so that closing it
//              would wait for as long as the job blocks (#34). Its JS side is gone and
//              every callback released; what is left is the loop's pool, its async
//              queue and its wakeup pipe, which the caller owns finishing:
//              eventloop.close_finish (eval, which waits), or the page runner's
//              reaping list.
// Node:
//   No observable change: a closing page's callbacks never ran after close before
//   either; only when the thread gets back moves.
//
// Teardown order is eval's, and each step needs the ones after it still alive:
//   1. settle active fetches, close net handles, then eventloop.close_begin — its
//      dispose and cancel hooks unprotect callbacks, so the context must be alive.
//      close_begin settles every pool job (fs, node:dns and fetch's DNS lookups all run
//      on the loop's pool) without waiting for one a worker is still running: that
//      job's JS half is released by its cancel hook here, and its memory goes when the
//      worker exits;
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
//   6. eventloop.close_finish, when no worker was busy: idle workers exit on
//      close_begin's broadcast, so this returns at once, and closes the loop's last
//      descriptor, its wakeup pipe.
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
			// Captured while the loop is still alive: a fatal backend-poll failure means
			// this worker crashed rather than finished/stopped cleanly.
			page.result = Result {
				status         = .Ok,
				exit_code      = exit_code,
				backend_failed = page.loop != nil && page.loop.backend_error,
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
		}
	}

	// Borrowed, not handed over: the caller of page_close still owns page.result.
	if report != nil {
		report(page.result, report_data)
	}

	if page.completion != nil {
		jsc.JSValueUnprotect(ctx, page.completion)
	}

	if page.loop != nil {
		fetch_shutdown_active(page.state)
		net_shutdown_active(page.state)

		if eventloop.close_begin(page.loop) {
			busy_loop = page.loop
		}
	}

	if page.state != nil {
		destroy_runtime_state(ctx, page.state)
	}

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
