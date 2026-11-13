package lava_runtime

import "core:os"
import "core:path/filepath"
import "core:strings"
import jsc "lava:pkg/jsc"
import eventloop "lava:pkg/runtime/eventloop"

NODE_BASELINE :: "22"
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
	status:       Status,
	exit_code:    int,
	message:      string,
	is_allocated: bool,
	// True when the event loop exited because its backend poll failed fatally (loop.backend_error),
	// not because work drained or a stop was requested. The multi-worker supervisor reads this to tell
	// a crashed worker from one that finished cleanly (so a crash stops the other workers).
	backend_failed: bool,
	// Which page limit (eval's `limits`) ended the run, if any. A kill is reported as
	// .Execution_Error, so this is how a caller tells it from an uncaught exception.
	kill:           Kill_Reason,
	// The page's JS heap in bytes as it closed, when the page runner sampled it
	// (Page_Runner.heap_sample_every); 0 or -1 when not sampled.
	heap_bytes:     int,
}

result_destroy :: proc(res: ^Result) {
	if res.is_allocated && len(res.message) > 0 {
		delete(res.message)
	}
	res^ = Result{}
}

// create_eval_context makes eval's global context in a VM from `pool`, or the calling
// thread's implicit pool when nil (vm_pool.odin), so repeated evals reuse a warm VM instead of paying for — and
// permanently leaking a timerfd with — a new one each time. On Windows the context
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
//   until the pool is destroyed, where VM destruction used to hide it. Page-level
//   heap accounting and VM retirement are #4's memory work.
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
		if err != .None do return nil, nil, err
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
// survives even JSContextGroupRelease and a full GC, while the VM's memory does
// come back — so VMs are pooled for the life of the thread, never churned.
release_global_context_after_eval :: proc(ctx: jsc.JSGlobalContextRef) {
	when ODIN_OS != .Windows {
		jsc.JSGlobalContextRelease(ctx)
	}
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
// Pre_Run_Hook fires once per eval, after top-level evaluation has succeeded (listeners bound,
// context up) and BEFORE the event loop starts. It returns whether the loop should run: the
// multi-worker supervisor uses it as the startup-barrier rendezvous (report ready, block until the
// supervisor releases or aborts all workers), returning false on abort so this worker skips run() and
// falls through to the normal teardown. nil (the default) means "just run" — the single-worker path.
Pre_Run_Hook :: proc(user_data: rawptr) -> bool

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
	script_args: []string = nil,
	pre_run: Pre_Run_Hook = nil,
	pre_run_data: rawptr = nil,
	limits: Page_Limits = {},
) -> Result {
	// Per-eval temp arena boundary, mirroring the per-tick reset in
	// eventloop.run_once and the per-require reset in native_require_cb. It
	// reclaims the scratch allocated around the loop (setup_module_environment,
	// the .mjs entry wrap, the script/source-name cstrings) — which the per-tick
	// reset covers only when a loop is attached — so embedders calling eval
	// repeatedly without a loop do not accumulate it. Result.message is on
	// context.allocator, so nothing returned escapes through the temp arena.
	defer free_all(context.temp_allocator)

	// eval is one page run to completion on the calling thread (page.odin): open it
	// (runtime install + top-level script), drive its loop, close it. The page runner
	// drives the same three steps for many pages interleaved on one thread.
	page: Page
	if page_open(&page, source, source_name, loop, echo_result, script_args, limits) && loop != nil {
		// Startup-barrier rendezvous (multi-worker): report this worker ready and block until the
		// supervisor releases all workers, or aborts startup (some worker failed). On abort, skip the
		// loop entirely and fall through to the teardown — the loop never ran, so this is a direct
		// teardown, not a drain. nil hook (single-worker) always proceeds.
		proceed := true
		if pre_run != nil do proceed = pre_run(pre_run_data)
		if proceed {
			for {
				alive, _ := page_tick(&page)
				if !alive do break
			}
		}
	}
	return page_close(&page)
}

// resolve_exit_code computes the final process exit code after the event loop
// drains. An uncaught async exception or an unhandled promise rejection forces a
// non-zero exit; otherwise a script-assigned process.exitCode is honored, matching
// Node. (process.exit() is handled separately and terminates immediately.)
resolve_exit_code :: proc(ctx: jsc.JSContextRef, state: ^Runtime_State) -> int {
	if state != nil && state.async_failed do return 1
	return process_exit_code(ctx)
}

process_exit_code :: proc(ctx: jsc.JSContextRef) -> int {
	global := jsc.JSContextGetGlobalObject(ctx)
	process := get_named(ctx, global, "process")
	// JSValueGetType classifies the value in one call (Object vs the Undefined/Null
	// switch below); the JSValueIs* predicates are equally ABI-safe now that they
	// return a 1-byte `bool` (see cmd/lava jsc_value_predicates, #159) — the former
	// "unreliable across the FFI" note described the retired `b32` return.
	if process == nil || jsc.JSValueGetType(ctx, process) != .Object do return 0
	code := get_named(ctx, cast(jsc.JSObjectRef)process, "exitCode")
	if code == nil do return 0
	#partial switch jsc.JSValueGetType(ctx, code) {
	case .Undefined, .Null:
		return 0
	}
	n := jsc.JSValueToNumber(ctx, code, nil)
	if n != n do return 0 // NaN guard (e.g. exitCode set to a non-numeric value)
	return int(n)
}

run_file :: proc(
	path: string,
	loop: ^eventloop.Loop = nil,
	script_args: []string = nil,
) -> Result {
	if len(path) == 0 {
		if loop != nil do eventloop.destroy(loop)
		return Result {
			status = .Invalid_Input,
			exit_code = 2,
			message = "missing JavaScript file path",
		}
	}

	data, err := os.read_entire_file(path, context.allocator)
	if err != os.ERROR_NONE {
		if loop != nil do eventloop.destroy(loop)
		return Result {
			status = .Read_Error,
			exit_code = 1,
			message = "could not read JavaScript file",
		}
	}
	defer delete(data)

	return eval(string(data), path, loop, false, script_args)
}

// build_process_argv assembles Node's process.argv: [execPath, scriptPath,
// ...userArgs]. execPath is the lava binary (absolutized like Node's execPath);
// scriptPath is the absolute entry path, omitted for `lava eval` (no script file).
// Allocated in the temp arena (valid for the duration of the eval call).
build_process_argv :: proc(source_name: string, script_args: []string) -> []string {
	argv := make([dynamic]string, 0, len(script_args) + 2, context.temp_allocator)

	exec_path := "lava"
	if len(os.args) > 0 {
		exec_path = os.args[0]
		if abs_exec, abs_err := filepath.abs(exec_path, context.temp_allocator);
		   abs_err == os.ERROR_NONE && len(abs_exec) > 0 {
			exec_path = abs_exec
		}
	}
	append(&argv, exec_path)

	if source_name != "<eval>" {
		script_path := source_name
		if abs_script, abs_err := filepath.abs(source_name, context.temp_allocator);
		   abs_err == os.ERROR_NONE && len(abs_script) > 0 {
			script_path = abs_script
		}
		append(&argv, script_path)
	}

	for arg in script_args do append(&argv, arg)
	return argv[:]
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
	return Result {
		status = .Native_Runtime_Unavailable,
		exit_code = 70,
		message = reason,
	}
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
