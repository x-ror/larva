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
}

result_destroy :: proc(res: ^Result) {
	if res.is_allocated && len(res.message) > 0 {
		delete(res.message)
	}
	res^ = Result{}
}

// create_eval_context makes eval's global context in a VM from the calling thread's
// pool (vm_pool.odin), so repeated evals reuse a warm VM instead of paying for — and
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
) -> (
	vm: ^VM,
	ctx: jsc.JSGlobalContextRef,
	err: VM_Pool_Error,
) {
	when ODIN_OS == .Windows {
		return nil, jsc.JSGlobalContextCreate(global_class), .None
	} else {
		vm, err = vm_acquire(thread_vm_pool())
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
// limit. Zero limits (the default) keep the plain eventloop.run path, with no clock
// reads. Larva policy with no Node counterpart. Pinned by
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
	// eval consumes the loop on EVERY path (see the OWNERSHIP note above). These two
	// pre-flight rejections return before the JS context (and the deferred teardown
	// below) exists, so they destroy the loop explicitly. It holds no handles yet, so
	// this single destroy needs no live context.
	if len(source) == 0 {
		if loop != nil do eventloop.destroy(loop)
		return Result{status = .Invalid_Input, exit_code = 2, message = "empty JavaScript source"}
	}

	if strings.has_prefix(source_name, "node:") {
		if loop != nil do eventloop.destroy(loop)
		return Result {
			status = .Invalid_Input,
			exit_code = 2,
			message = "node: specifiers are module names, not eval source names",
		}
	}

	// A JS runtime must survive writes to closed pipes/sockets (Node parity):
	// see signals_posix.odin. Installed per eval — the call is idempotent.
	ignore_sigpipe()

	// Per-eval temp arena boundary, mirroring the per-tick reset in
	// eventloop.run_once and the per-require reset in native_require_cb. It
	// reclaims the scratch allocated around the loop (setup_module_environment,
	// the .mjs entry wrap, the script/source-name cstrings) — which the per-tick
	// reset covers only when a loop is attached — so embedders calling eval
	// repeatedly without a loop do not accumulate it. Result.message is on
	// context.allocator, so nothing returned escapes through the temp arena.
	defer free_all(context.temp_allocator)

	// Configure JSC before the first JSGlobalContextCreate. On Windows this disables
	// the (buggy on this bun-webkit build) baseline JIT tier and runs JSC's proper
	// process bring-up — without it, heavy JS corrupts memory mid-execution
	// (0xC0000409, surfaced as exit 127). See pkg/jsc/jsc_init_windows.cpp for the
	// full rationale. Idempotent; a no-op on Linux/macOS.
	jsc.lava_jsc_init()

	// A custom global class gives the global object a private-data slot, where we
	// stash Runtime_State (loop + module cache) out of reach of user JavaScript.
	global_class := make_global_class()
	vm, ctx, vm_err := create_eval_context(global_class)
	if ctx == nil {
		vm_release(vm)
		jsc.JSClassRelease(global_class)
		// Still consume the loop (no context was created, so no handles exist).
		if loop != nil do eventloop.destroy(loop)
		// A pool error means JSC is present but this thread has no VM to give: saying
		// "install JavaScriptCoreGTK" there would send the user after the wrong cause.
		switch vm_err {
		case .Exhausted:
			return vm_pool_unavailable("VM pool exhausted: every JavaScriptCore VM on this thread is busy")
		case .Create_Failed:
			return vm_pool_unavailable("JavaScriptCore could not create a VM (JSContextGroupCreate failed)")
		case .None:
		}
		return native_runtime_unavailable()
	}
	defer jsc.JSClassRelease(global_class)
	// Limits live on the VM, so without one (Windows: see create_eval_context) they
	// cannot be enforced. Refuse rather than run the page unlimited.
	if limits != {} {
		if vm == nil {
			release_global_context_after_eval(ctx)
			if loop != nil do eventloop.destroy(loop)
			return Result {
				status = .Invalid_Input,
				exit_code = 2,
				message = "page CPU limits need a pooled VM, which this platform does not use",
			}
		}
		vm_set_entry_limit(vm, limits.entry_limit)
		vm_set_cpu_budget(vm, limits.cpu_budget)
	}
	// Declared before the context release, so (LIFO) the VM goes back to the pool only
	// after its context is gone: a pooled VM never hosts two live contexts.
	defer vm_release(vm)
	defer release_global_context_after_eval(ctx)

	state := new_runtime_state(loop)
	// Build Node's process.argv = [execPath, scriptPath, ...userArgs]. argv[0] is
	// the lava binary (absolute, like Node's execPath); argv[1] is the absolute
	// script path (omitted for `lava eval`, where there is no script file). Built in
	// the per-eval temp arena, which outlives install_process (see the defer above).
	state.script_argv = build_process_argv(source_name, script_args)
	jsc.JSObjectSetPrivate(
		jsc.JSContextGetGlobalObject(cast(jsc.JSContextRef)ctx),
		cast(rawptr)state,
	)
	// Runs before the context is released (defers execute in reverse order), so
	// JSValueUnprotect on cached modules still has a live context.
	defer destroy_runtime_state(cast(jsc.JSContextRef)ctx, state)

	// Register the graceful-shutdown drain hook (multi-worker, Linux only): when the supervisor
	// requests a stop, the loop runs net_drain_begin on its own thread to stop accepting and drain
	// in-flight connections. KNOWN DIVERGENCE (design §9): only the multi-worker supervisor blocks
	// SIGINT/SIGTERM and calls request_shutdown, so this hook never fires for a single-worker run
	// (LAVA_WORKERS unset/1) — there SIGTERM still terminates immediately without draining, as it did
	// before Slice 3a. Routing the single-worker path through the same machinery is a follow-up.
	when ODIN_OS == .Linux {
		if loop != nil do eventloop.set_shutdown_hook(loop, net_drain_begin, state)
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

	// eval owns the loop's teardown (see the OWNERSHIP note above). A deferred
	// destroy — not a tail call after eventloop.run — so that EVERY return once the
	// context exists tears the loop down: a thrown top-level exception (which may
	// already have created timers/sockets), an .mjs wrap error, or a source-string
	// allocation failure would otherwise return the loop alive with GC-protected
	// callbacks stranded. Declared after destroy_runtime_state so it fires first
	// (LIFO), and before the context release, so dispose hooks still see a live
	// context. On abnormal returns it first stops active fetches and joins the fetch
	// resolver workers; node:dns lookups run on the loop's worker pool, which
	// eventloop.destroy -> pool_shutdown joins and disposes — so no background thread
	// can post into a destroyed loop/context. On the success path it runs after
	// eventloop.run returns.
	defer if loop != nil {
		fetch_shutdown_active(state)
		net_shutdown_active(state)
		eventloop.destroy(loop)
	}

	// Everything from here to the loop is one stretch on the page's VM, charged to its
	// CPU budget: runtime install, the entry body, its promise jobs and nextTicks.
	// Released on every return; vm_cpu_exit is a no-op once the depth is back at 0.
	vm_cpu_enter(vm)
	defer vm_cpu_exit(vm)

	setup_module_environment(cast(jsc.JSContextRef)ctx, source_name, loop)

	// ESM entrypoints (.mjs) are rewritten to CommonJS via the same transform the
	// loader applies to imported .mjs modules; script (.js) and `lava eval`
	// sources run unchanged.
	eval_source := source
	mjs_wrapped: string
	mjs_allocated := false
	defer if mjs_allocated do delete(mjs_wrapped)
	if strings.has_suffix(source_name, ".mjs") {
		wrap_exception: jsc.JSValueRef
		wrapped, ok := esm_wrap_source(
			cast(jsc.JSContextRef)ctx,
			source,
			source_name,
			&wrap_exception,
		)
		if !ok {
			msg, allocated := value_to_string(cast(jsc.JSContextRef)ctx, wrap_exception)
			return Result {
				status = .Execution_Error,
				exit_code = 1,
				message = msg,
				is_allocated = allocated,
			}
		}
		eval_source = wrapped
		mjs_wrapped = wrapped
		mjs_allocated = true
	} else {
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
	TOP_LEVEL_DRAIN :: "\n;var __lava_tl_drain = (typeof __lavaDrainNextTicks === 'function') && __lavaDrainNextTicks();\n"
	if combined, concat_err := strings.concatenate(
		{eval_source, TOP_LEVEL_DRAIN},
		context.temp_allocator,
	); concat_err == nil {
		eval_source = combined
	}

	script := js_string_from_string(eval_source)
	if script == nil {
		return Result {
			status = .Invalid_Input,
			exit_code = 2,
			message = "could not allocate JavaScript source string",
		}
	}
	defer jsc.JSStringRelease(script)

	c_source_name, c_source_name_err := strings.clone_to_cstring(
		source_name,
		context.temp_allocator,
	)
	if c_source_name_err != nil {
		return Result {
			status = .Invalid_Input,
			exit_code = 2,
			message = "could not allocate JavaScript source name",
		}
	}

	source_url := jsc.JSStringCreateWithUTF8CString(c_source_name)
	if source_url == nil {
		return Result {
			status = .Invalid_Input,
			exit_code = 2,
			message = "could not allocate JavaScript source URL object",
		}
	}
	defer jsc.JSStringRelease(source_url)

	exception: jsc.JSValueRef
	value := jsc.JSEvaluateScript(
		cast(jsc.JSContextRef)ctx,
		script,
		nil,
		source_url,
		1,
		&exception,
	)

	if exception != nil {
		if kill := vm_kill_reason(vm); kill != .None do return page_killed(kill)
		msg, allocated := value_to_string(cast(jsc.JSContextRef)ctx, exception)
		return Result {
			status = .Execution_Error,
			exit_code = 1,
			message = msg,
			is_allocated = allocated,
		}
	}

	// Refresh the cached entry exports: a CommonJS entry body may have reassigned
	// module.exports, so the pre-eval partial registered above is now stale.
	if !mjs_allocated {
		register_entry_module(cast(jsc.JSContextRef)ctx, state, source_name)
	}

	// The drain appended above ran nextTicks queued synchronously by the top-level
	// body; this runs the ones queued by the promise jobs JSC auto-drained when
	// JSEvaluateScript returned — so the nextTick queue is empty before the loop's
	// first timer/I/O phase, since Node drains nextTicks ahead of timers. Same
	// after-the-boundary re-drain that invoke_user_callback does per callback.
	drain_next_ticks_settled(cast(jsc.JSContextRef)ctx, state)
	vm_cpu_exit(vm)
	if kill := vm_kill_reason(vm); kill != .None do return page_killed(kill)

	if loop != nil {
		// Startup-barrier rendezvous (multi-worker): report this worker ready and block until the
		// supervisor releases all workers, or aborts startup (some worker failed). On abort, skip the
		// loop entirely and fall through to the deferred teardown — the loop never ran, so this is a
		// direct teardown, not a drain. nil hook (single-worker) always proceeds.
		proceed := true
		if pre_run != nil do proceed = pre_run(pre_run_data)
		if proceed && limits != {} {
			if kill := run_limited(loop, vm); kill != .None do return page_killed(kill)
		} else if proceed {
			eventloop.run(loop)
			// Loop teardown is the deferred eventloop.destroy declared above — it covers
			// this success path and every early return once the context exists.
		}
	}

	exit_code := resolve_exit_code(cast(jsc.JSContextRef)ctx, state)
	// Captured while the loop is still alive (the deferred destroy runs after this returns): a fatal
	// backend-poll failure means this worker crashed rather than finished/stopped cleanly.
	backend_failed := loop != nil && loop.backend_error

	if !echo_result || value == nil || jsc.JSValueIsUndefined(cast(jsc.JSContextRef)ctx, value) {
		return Result{status = .Ok, exit_code = exit_code, backend_failed = backend_failed}
	}

	msg, allocated := value_to_string(cast(jsc.JSContextRef)ctx, value)
	return Result {
		status = .Ok,
		exit_code = exit_code,
		message = msg,
		is_allocated = allocated,
		backend_failed = backend_failed,
	}
}

// run_limited is eventloop.run for a page under Page_Limits: every tick is charged to
// the VM's CPU budget, and the first tick that ends with a limit hit stops the loop.
// The tick, not each callback, is the unit: a tick's poll blocks without advancing
// the thread's CPU clock, so the whole tick is the page's work, and one clock read
// per tick costs less than one per callback. force_exit makes the deferred teardown
// in eval reclaim whatever the page still had registered.
@(private = "file")
run_limited :: proc(loop: ^eventloop.Loop, vm: ^VM) -> Kill_Reason {
	for eventloop.has_pending_work(loop) && !loop.backend_error && !loop.force_exit {
		vm_cpu_enter(vm)
		eventloop.run_next(loop)
		vm_cpu_exit(vm)
		if kill := vm_kill_reason(vm); kill != .None {
			loop.force_exit = true
			return kill
		}
	}
	return .None
}

// page_killed builds the Result for a page a limit ended. Larva policy, not a Node
// surface: Node has no per-script CPU limit, so the message is ours.
@(private = "file")
page_killed :: proc(kill: Kill_Reason) -> Result {
	msg: string
	switch kill {
	case .Entry_Limit:
		msg = "page killed: a script exceeded the execution time limit"
	case .Cpu_Budget:
		msg = "page killed: CPU budget exceeded"
	case .None:
	}
	return Result{status = .Execution_Error, exit_code = 1, message = msg, kill = kill}
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
