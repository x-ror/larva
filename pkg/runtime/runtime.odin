package lava_runtime

import "core:os"
import "core:strings"
import jsc "lava:pkg/jsc"
import eventloop "lava:pkg/runtime/eventloop"

ENGINE_TARGET :: "JavaScriptCore"

when ODIN_OS == .Linux {
	EVENT_LOOP_TARGET :: "native io_uring/epoll"
} else when ODIN_OS == .Darwin {
	EVENT_LOOP_TARGET :: "native kqueue"
} else when ODIN_OS == .Windows {
	EVENT_LOOP_TARGET :: "native windows-iocp"
} else {
	EVENT_LOOP_TARGET :: "unknown-backend"
}

Status :: enum {
	Ok,
	Native_Runtime_Unavailable,
	Read_Error,
	Invalid_Input,
	Execution_Error,
}

Result :: struct {
	status:         Status,
	exit_code:      int,
	message:        string,
	is_allocated:   bool,
	// Which page limit (eval's `limits`) ended the run, if any. A kill is reported as
	// .Execution_Error, so this is how a caller tells it from an uncaught exception.
	kill:           Kill_Reason,
	// Bytes the page VM's JS heap occupied as the page closed (jsc.heap_size_bytes: its
	// capacity, uncollected garbage included, the VM's earlier pages' too);
	// 0 means "not sampled" — sampling off (Page_Runner.heap_sample_every), not this
	// page's turn, a page a limit or a cancel ended, a Result built without a page, or a
	// JSC without the symbol. A sample is always > 0, so 0 is the only sentinel.
	heap_bytes:     i64,
}

result_destroy :: proc(res: ^Result) {
	if res.is_allocated && len(res.message) > 0 {
		delete(res.message)
	}

	res^ = Result{}
}

// create_eval_context makes eval's global context in a VM from `pool`, or the calling
// thread's implicit pool when nil (vm_pool.odin), so repeated evals reuse a warm VM instead of paying for a new
// one each time. On Windows the context
// is never released (see release_global_context_after_eval), so its VM could never
// be reused: there, eval keeps the one-VM-per-context path and returns a nil VM.
//
// Returns:
//   The VM (nil on Windows, or on error) and the context (nil on error). `err` is
//   the pool's error, so eval can tell a busy pool from a missing runtime; it is
//   .None with a nil context when JSC itself failed to create the context.
// Deviates:
//   Releasing the context no longer destroys its VM, so what the eval left in the
//   heap is reclaimed by the VM's next GC, not at release: Odin-owned no-copy
//   Uint8Array backings stay allocated until another eval on this thread collects
//   them, or until thread_vm_pool_destroy. Bounded by one eval's garbage per idle VM
//   and paid for by the warm-VM speedup measured in vm_pool.odin; a thread that runs
//   one eval and ends (a worker) destroys its pool. A JSValueProtect left unbalanced
//   (a defect under CLAUDE.md §4 regardless) now pins the old global object graph
//   until the pool is destroyed, where VM destruction used to hide it — or until the
//   pool retires the VM (VM_RETIRE_AFTER_PAGES, which eval's thread pool applies too).
create_eval_context :: proc(
	global_class: jsc.JSClassRef,
	pool: ^VM_Pool = nil,
) -> (
	vm: ^VM,
	ctx: jsc.JSGlobalContextRef,
	err: VM_Pool_Error,
) {
	when ODIN_OS == .Windows {
		return nil, jsc.JSGlobalContextCreate(global_class), .None
	} else {
		vm, err = vm_acquire(pool != nil ? pool : thread_vm_pool())

		if err != .None {
			return nil, nil, err
		}

		return vm, vm_create_context(vm, global_class), .None
	}
}

// release_global_context_after_eval frees the JSC global context when eval
// returns — except on Windows. Releasing the context tears down the whole JSC VM
// (JIT/GC threads, ICU); on Windows, doing that right before the CLI's os.exit()
// poisons process teardown — the subsequent ExitProcess DLL-detach fails and the
// process exits 127 (ERROR_PROC_NOT_FOUND) even though the script ran fine.
//
// Today eval is a one-shot-per-process CLI entry, so leaking the VM on Windows is
// harmless (the OS reclaims it on exit, as node/jsc/bun do). If Lava ever grows an
// embedded / repeated-eval Windows use case, this is the policy to revisit: the
// teardown ordering must be fixed rather than skipped.
//
// LINUX, MEASURED 2026-07-29: this release does not reclaim everything. Each
// JSGlobalContext costs one `anon_inode:[timerfd]` that survives it —
// JavaScriptCore's per-VM WTF::RunLoop timer, whose GSource `finalize` does hold
// the matching close, so the fd outlives us because the VM is not finalized
// here, not because JSC forgot to. Confirmed by counting /proc/self/fd around a
// bare JSGlobalContextCreate/Release pair with no loop, no script and no
// Runtime_State: +1 per context, strictly linear over 20 iterations, unchanged
// by a forced JSGarbageCollect, by passing nil instead of our JSClass, or by
// waiting. One context running many scripts costs one fd, so the price is per
// VM, not per eval.
//
// Contexts are now created in pooled VMs (create_eval_context), so the fd is paid
// once per pooled VM, not once per eval: repeated evals on one thread reuse one VM
// and the fd count stays flat. Remeasured in bench/jsc-vm (2026-11-13): the fd
// survived even JSContextGroupRelease and a full GC. The cause, found since (#91): the
// timer's GSource is finalized, and the fd closed, only when the thread's RunLoop
// context is next iterated, and nothing iterated it. With the RunLoop driven
// (pkg/jsc/runloop_linux.odin) a released VM's fd closes at the next iteration, which
// vm_pool_destroy runs (vm_pool_releases_its_timerfds).
release_global_context_after_eval :: proc(ctx: jsc.JSGlobalContextRef) {
	when ODIN_OS != .Windows {
		jsc.JSGlobalContextRelease(ctx)
	}
}

// Pre_Run_Hook fires once per eval, after top-level evaluation has succeeded (listeners bound,
// context up) and BEFORE the event loop starts. It returns whether the loop should run; false
// skips the loop and falls through to the normal teardown. nil (the default) means "just run".
// Lava's multi-worker supervisor used it as its startup barrier; since that went with the Node
// profile its caller is cmd/lava/runloop_drive_test.odin, which collects garbage between the
// top-level script and the first tick.
Pre_Run_Hook :: proc(user_data: rawptr) -> bool

// Result_Hook receives eval's final Result once, BEFORE eval tears down its loop and
// releases its JS context — the `report` parameter of eval and run_file.
//
// Params:
//   result     The Result eval is about to return. Borrowed: eval's caller still owns
//              it (result_destroy), so the hook must neither free nor keep its message.
//   user_data  The `report_data` passed alongside the hook.
// Node:
//   Node writes an uncaught top-level error to stderr before its exit-time teardown
//   joins libuv's worker pool, so a script that throws with a worker blocked (a
//   readFile on a FIFO nobody writes) prints its error and then hangs. Verified on
//   node v26.13.0 (probe case H): fs.readFile on a mkfifo with no writer, a throw
//   once a worker sat in the FIFO open, stderr watched while the process was stuck,
//   then killed. The CLI passes its printer here to keep that
//   order: eval's loop teardown joins the loop's pool workers (in Larva,
//   eventloop.close_finish after page_close), and printing after eval returned left
//   Lava hanging with empty stderr. Pinned by
//   tests/stdio/uncaught-before-teardown.test.mjs and
//   cmd/lava/eval_report_hook_test.odin.
//
// The hook runs on eval's thread while the loop and the context are still alive, but
// must not touch JS or the loop: it is a reporter (the CLI's print_result writes
// through process_write and nothing else). Every return of eval and run_file reports,
// pre-flight rejections included, so a caller that prints only from the hook never
// misses a result; nil (the default) reports nothing, and an embedder that reads the
// returned Result instead sees no change.
Result_Hook :: proc(result: Result, user_data: rawptr)

// reported hands `result` to the report hook, if any, and returns it unchanged — the
// shape of every `return` in eval and run_file, so that none can skip the hook.
@(private = "file")
reported :: proc(result: Result, report: Result_Hook, report_data: rawptr) -> Result {
	if report != nil {
		report(result, report_data)
	}

	return result
}

// echo_result mirrors REPL behavior: when true (the `lava eval` path) the
// script's completion value is returned for printing. `lava run` passes false so
// running a file never echoes a trailing expression value, matching `node file`
// (and avoiding JSC-version-dependent completion values like `[object Promise]`).
//
// OWNERSHIP: a non-nil `loop` is CONSUMED — eval destroys it before returning on
// EVERY path (a pre-flight input rejection, a thrown top-level exception, or a
// clean run), and for any path that created handles it does so while the context
// they are GC-protected against is still alive. Callers must not destroy the loop
// themselves (a double destroy closes fd 0); they only init it and pass it in.
//
// REPORT: a non-nil `report` (Result_Hook) fires exactly once on every return —
// pre-flight rejections included — with the Result being returned, before eval's
// loop teardown and context release run. eval hands it to page_close, which fires it
// once the Result is decided and before its teardown (page.odin); a pre-flight
// rejection page_open makes has destroyed the loop already, as in Lava.
//
// SURFACE: the script runs with the Window globals and nothing of Node's (docs/LARVA.md
// decision 1), as a classic script: an `.mjs` source name is refused up front
// (page.odin page_preflight).
//
// ORIGIN: `origin` is the page's origin as the embedder gives it — a URL or an
// origin; "" (the default) is an opaque origin. Only the Window surface's object URLs
// read it today (`blob:<origin>/<uuid>`, internal/blob.js), until a page has a real
// URL (stage 4). It is borrowed for the install only (Runtime_State.page_origin).
//
// LIMITS: `limits` (Page_Limits, vm_pool.odin) puts the eval under a per-entry CPU
// limit and a cumulative CPU budget on its VM. The budget is charged from runtime
// install to the last loop tick; the first entry or tick that ends over a limit stops
// the loop (force_exit) and eval returns .Execution_Error with Result.kill naming the
// limit. Zero limits (the default) read no clocks. Larva policy with no Node counterpart. Pinned by
// cmd/lava/page_cpu_budget_test.odin.
eval :: proc(
	source: string,
	source_name := "<eval>",
	loop: ^eventloop.Loop = nil,
	echo_result := false,
	pre_run: Pre_Run_Hook = nil,
	pre_run_data: rawptr = nil,
	report: Result_Hook = nil,
	report_data: rawptr = nil,
	limits: Page_Limits = {},
	origin := "",
) -> Result {
	// Per-eval temp arena boundary, mirroring the per-tick reset in
	// eventloop.run_once. It reclaims the scratch allocated around the loop
	// (setup_page_environment, the script/source-name cstrings) — which the per-tick
	// reset covers only when a loop is attached — so embedders calling eval
	// repeatedly without a loop do not accumulate it. Result.message is on
	// context.allocator, so nothing returned escapes through the temp arena.
	defer free_all(context.temp_allocator)

	// eval is one page run to completion on the calling thread (page.odin): open it
	// (runtime install + top-level script), drive its loop, close it. The page runner
	// drives the same three steps for many pages interleaved on one thread.
	page: Page

	if page_open(&page, source, source_name, loop, echo_result, limits, origin = origin) &&
	   loop != nil {
		// nil hook: just run. false: skip the loop; the teardown below still runs.
		if pre_run == nil || pre_run(pre_run_data) {
			for {
				alive, _ := page_tick(&page)

				if !alive {
					break
				}
			}
		}
	}

	// The report fires inside page_close, before its teardown: the Result is final
	// there, and close_finish below is where eval joins a pool worker that is still
	// blocked — a top-level throw must reach stderr before that join, not after it.
	result, busy_loop := page_close(&page, report = report, report_data = report_data)

	// eval owns its thread, so it waits for blocking pool work as it always has; only
	// the page runner, which shares its thread with other pages, must not (#34).
	if busy_loop != nil {
		eventloop.close_finish(busy_loop)
	}

	return result
}

// resolve_exit_code computes the final exit code after the event loop drains: an
// uncaught async exception or an unhandled promise rejection forces 1, otherwise 0.
resolve_exit_code :: proc(ctx: jsc.JSContextRef, state: ^Runtime_State) -> int {
	if state != nil && state.async_failed {
		return 1
	}

	return 0
}

// run_file reads `path` and runs it through eval with echo off, as `lava run` does.
// `origin` is passed through unchanged; the CLI sets it from `lava run --origin=`
// (cmd/lava/main.odin parse_run_args).
run_file :: proc(
	path: string,
	loop: ^eventloop.Loop = nil,
	report: Result_Hook = nil,
	report_data: rawptr = nil,
	origin := "",
) -> Result {
	if len(path) == 0 {
		if loop != nil {
			eventloop.destroy(loop)
		}

		return reported(
			Result{status = .Invalid_Input, exit_code = 2, message = "missing JavaScript file path"},
			report,
			report_data,
		)
	}

	data, err := os.read_entire_file(path, context.allocator)

	if err != os.ERROR_NONE {
		if loop != nil {
			eventloop.destroy(loop)
		}

		return reported(
			Result{status = .Read_Error, exit_code = 1, message = "could not read JavaScript file"},
			report,
			report_data,
		)
	}

	defer delete(data)

	return eval(
		string(data),
		path,
		loop,
		false,
		report = report,
		report_data = report_data,
		origin = origin,
	)
}

native_runtime_unavailable :: proc() -> Result {
	return Result {
		status = .Native_Runtime_Unavailable,
		exit_code = 70,
		message = "native runtime unavailable: install JavaScriptCoreGTK development package",
	}
}

// vm_pool_unavailable reports that the runtime is installed but no VM could be had.
// Same status and exit code as native_runtime_unavailable (EX_SOFTWARE-style 70: the
// script never ran), a different cause.
vm_pool_unavailable :: proc(reason: string) -> Result {
	return Result{status = .Native_Runtime_Unavailable, exit_code = 70, message = reason}
}

is_success :: proc(result: Result) -> bool {
	return result.status == .Ok
}

js_string_from_string :: proc(value: string) -> jsc.JSStringRef {
	c_value, err := strings.clone_to_cstring(value, context.temp_allocator)

	if err != nil {
		return nil
	}

	return jsc.JSStringCreateWithUTF8CString(c_value)
}

// value_to_string converts a JS value to UTF-8. The bool is is_allocated (caller
// must delete when true), NOT success: conversion failure returns a static
// diagnostic with false; empty strings return ("", false).
value_to_string :: proc(ctx: jsc.JSContextRef, value: jsc.JSValueRef) -> (string, bool) {
	exception: jsc.JSValueRef
	js_string := jsc.JSValueToStringCopy(ctx, value, &exception)

	if js_string == nil {
		return "JavaScript value could not be converted to string", false
	}

	defer jsc.JSStringRelease(js_string)
	return js_string_ref_to_utf8_owned(js_string)
}
