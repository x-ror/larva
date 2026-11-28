package lava_runtime

import "base:runtime"
import "core:c"
import "core:math"
import "core:os"
import "core:strings"
import "core:sync"
import "core:time"
import cookie "lava:pkg/http/cookie"
import proxy "lava:pkg/http/proxy"
import jsc "lava:pkg/jsc"
import profile "lava:pkg/profile"
import eventloop "lava:pkg/runtime/eventloop"

// Runtime_State holds per-context state. A pointer to it lives in the global
// object's private data slot (see make_global_class) instead of being exposed
// to JavaScript, so user code can neither read nor corrupt the loop pointer.
Runtime_State :: struct {
	loop:              ^eventloop.Loop,
	// The pooled VM the context lives in (nil on Windows, where eval uses an implicit
	// VM). Carries the page's CPU limits; invoke_user_callback charges and checks them
	// at every callback boundary.
	vm:                ^VM,
	// Set for a page the page runner drives (page_runner.odin).
	page_runner:       bool,
	// The exit code a requested stop (vm_request_stop) leaves the page with.
	page_exit_code:    int,
	// The allocator that owns what this state allocates for the page (timer bindings,
	// fetch requests, the host-native registry entries). Captured from the caller's
	// context at state creation and used EXPLICITLY, because allocations happen inside
	// `proc "c"` callbacks (where context is reset to runtime.default_context — the heap
	// allocator) but are freed later in destroy_runtime_state under the caller's
	// context. Without an explicit allocator those two contexts can differ (e.g. an
	// embedder/test using a custom or tracking allocator), causing a bad free.
	allocator:         runtime.Allocator,
	// The module loader's handle (bootstrap/loader.js; GC-protected). Never reachable
	// from page code; install_microtasks reads internal/native_shape off it.
	loader:            jsc.JSValueRef,
	// Standard JS error constructors (Error/TypeError/RangeError/…) snapshotted and
	// GC-protected from globalThis at context init, before any user code runs (see
	// capture_error_intrinsics). make_native_error builds native throws from these
	// instead of re-reading the mutable global, so a script that overwrites e.g.
	// globalThis.RangeError cannot intercept or alter a native error (errors.odin).
	// Keys are static literals; values unprotected on destroy.
	error_intrinsics:  map[string]jsc.JSValueRef,
	// Set when an uncaught exception escapes an async callback or a promise
	// rejects with no handler. The process then exits non-zero even though the
	// initial JSEvaluateScript returned cleanly (see resolve_exit_code).
	async_failed:      bool,
	rejection_handler: jsc.JSValueRef, // GC-protected fn registered with JSC; unprotected on destroy
	// The microtask shim's `dispatch` (js/bootstrap/microtasks.js), GC-protected: every
	// event-loop callback runs through it (invoke_user_callback), so its stack shows the
	// same one frame of the runtime whatever scheduled it.
	dispatch_fn:       jsc.JSValueRef,
	// The same shim's dispatchCleanups (GC-protected): runs one FinalizationRegistry's
	// due cleanups as one task (deferred.odin).
	dispatch_cleanups: jsc.JSValueRef,
	// Symbol.toPrimitive, read before user code on a `.Web` context (install_globals),
	// GC-protected: web_to_primitive's key for the WebIDL ToNumber of a timer id. A
	// well-known symbol cannot be replaced, but globalThis.Symbol can, so it is not
	// read at call time.
	symbol_to_primitive: jsc.JSValueRef,
	// The context this state belongs to, for a loop task that must call into it and has
	// no JS caller to take one from (deferred.odin's cleanups, wasm.odin's jobs). Set by
	// page_create.
	ctx:               jsc.JSContextRef,
	// FinalizationRegistry cleanups the engine handed deferred.js's shim, owed to this page
	// (deferred.odin): each value GC-protected until it runs or this state is destroyed.
	deferred_cleanups: [dynamic]Deferred_Cleanup,
	deferred_scheduled: bool,
	// FinalizationRegistry's routing (deferred.odin): the engine's constructor, the
	// module's cleanup wrapper and Reflect.construct, captured before page code and
	// GC-protected; and the two TypeError messages the engine gives for misuse, so the
	// native constructor throws its words.
	fr_engine:         jsc.JSValueRef,
	fr_wrap:           jsc.JSValueRef,
	fr_construct:      jsc.JSValueRef,
	// WebAssembly (wasm.odin): the engine's Module and Instance constructors, captured
	// before page code and GC-protected, and the settlements the page is still owed.
	wasm_module:       jsc.JSValueRef,
	wasm_instance:     jsc.JSValueRef,
	// WebAssembly.Module.imports, the brand check instantiate uses (wasm.odin).
	wasm_brand:        jsc.JSValueRef,
	wasm_jobs:         [dynamic]Wasm_Job,
	wasm_scheduled:    bool,
	// The page loop's watcher on the thread's RunLoop descriptor (deferred_service_page),
	// for a page whose loop blocks on its own; the loop holds a pointer to it while it is
	// watched, which deferred_unwatch_loop ends in page_close.
	deferred_watch:    eventloop.IO_Watcher,
	// Settled fetch requests awaiting free. Their teardown is deferred to here
	// because the io_uring watcher may reference a request once more after it is
	// stopped; freeing only at destroy keeps that memory valid (see fetch.odin).
	pending_free:      [dynamic]^Fetch_Request,
	// Fetches currently owned by this runtime context. Used during abnormal eval
	// teardown to stop requests and join any DNS worker before the loop/context die.
	active_fetches:    [dynamic]^Fetch_Request,
	// The page's origin as the embedder gave it (`lava run --origin=`), "" for an opaque
	// one: an origin or a whole URL, which is then also the page's URL (`location`).
	// BORROWED, not owned: read only while page_create installs the runtime, when
	// install_internal_modules copies it into JS strings for internal/blob and
	// internal/location, so it need outlive nothing but that call.
	page_origin:       string,
	// True while page_run_script evaluates the page's top-level script: the part of a
	// `lava run` page's life HTML calls "not completely loaded", during which a
	// fragment navigation replaces the session entry (internal/location).
	top_script_running: bool,
	// Embedded builtin factories compiled so far (builtin_compile_cb). Only an
	// observable for cmd/lava/lazy_builtins_test.odin; nothing branches on it.
	builtin_compiles:  int,
	// The page's DOM (dom.odin), for an HTML page (page_html.odin); nil for a script page.
	// Released by destroy_runtime_state through dom_release, while the context lives.
	dom:               ^Dom_Page,
	// The cookies fetch(), XMLHttpRequest and document.cookie read and write (cookie.odin):
	// the session's jar. By default it points at own_cookie_jar, the page's, made with
	// the state's allocator and destroyed with the state; a crawl job of a `lava serve`
	// session points it at the session's jar instead (page_crawl.odin, docs/LARVA.md
	// decision 3), which the jar's mutex lets other threads share.
	cookie_jar:        ^cookie.Jar,
	own_cookie_jar:    cookie.Jar,
	// The proxy the page's fetch() and XMLHttpRequest go through (fetch.odin); the zero
	// value goes direct. Borrowed: a crawl job's (page_crawl.odin), whose strings outlive
	// the page.
	proxy:             proxy.Proxy,
}

// JS_Callback bridges a JS function into an event-loop Callback. The function
// and any trailing timer arguments are GC-protected for the lifetime of the
// binding so JavaScriptCore cannot collect them between scheduling and firing.
JS_Callback :: struct {
	ctx:       jsc.JSContextRef,
	func:      jsc.JSObjectRef,
	// Trailing arguments forwarded to the callback on every fire
	// (setTimeout/Interval(fn, delay, ...args), setImmediate(fn, ...args)).
	// Owned + GC-protected by this binding; nil when there are none.
	args:      []jsc.JSValueRef,
	repeating: bool,
	// allocator made this binding and its args slice, and is the only one that may
	// free them: the owning Runtime_State's, captured by the timer native that made
	// the binding — the same capture fetch makes for its requests (CLAUDE.md §4).
	// The native is a `proc "c"`, so its ambient allocator is
	// runtime.default_context()'s heap, while the free runs under a different
	// context depending on the path: eval's, when the loop fires, re-arms or tears
	// the binding down; the heap again, when clearTimeout/clearImmediate disposes it
	// synchronously inside clear_timer_cb (eventloop.clear_timeout runs the dispose
	// eagerly). Neither side may trust the ambient allocator, so the binding carries
	// its own, and free_js_callback depends on nothing but the binding. Taking the
	// state's allocator rather than a hard-coded heap keeps bindings visible to the
	// embedder's allocator, so a leaked binding shows up in a tracking test instead
	// of vanishing into malloc. Pinned by cmd/lava/timer_binding_alloc_test.odin.
	allocator: runtime.Allocator,
}

// --- Runtime state lifecycle ---

new_runtime_state :: proc(loop: ^eventloop.Loop) -> ^Runtime_State {
	state := new(Runtime_State)
	state.loop = loop
	// Capture the owning allocator (see the field comment).
	state.allocator = context.allocator
	state.error_intrinsics = make(map[string]jsc.JSValueRef)
	state.active_fetches = make([dynamic]^Fetch_Request)
	state.wasm_jobs = make([dynamic]Wasm_Job, state.allocator)
	state.deferred_cleanups = make([dynamic]Deferred_Cleanup, state.allocator)
	cookie.jar_init(&state.own_cookie_jar, state.allocator)
	state.cookie_jar = &state.own_cookie_jar
	return state
}

destroy_runtime_state :: proc(ctx: jsc.JSContextRef, state: ^Runtime_State) {
	if state == nil {
		return
	}

	fetch_shutdown_active(state)
	fetch_destroy_pending(state)
	// Wrappers first (private slot cleared, then unprotected), the document after them.
	dom_release(ctx, state)
	// The thread-local host-call registry's entries are keyed by the context POINTER,
	// which JSC reuses for a later context, so they must go while this context is still
	// the owner.
	host_natives_release_context(ctx, state.allocator)
	for _, ctor in state.error_intrinsics {
		unprotect_before_eval_exit(ctx, ctor)
	}
	delete(state.error_intrinsics)
	unprotect_before_eval_exit(ctx, state.loader)
	unprotect_before_eval_exit(ctx, state.rejection_handler)
	unprotect_before_eval_exit(ctx, state.dispatch_fn)
	unprotect_before_eval_exit(ctx, state.dispatch_cleanups)
	unprotect_before_eval_exit(ctx, state.symbol_to_primitive)
	deferred_release_cleanups(ctx, state)
	unprotect_before_eval_exit(ctx, state.fr_engine)
	unprotect_before_eval_exit(ctx, state.fr_wrap)
	unprotect_before_eval_exit(ctx, state.fr_construct)
	wasm_release_jobs(ctx, state)
	state.cookie_jar = nil
	cookie.jar_destroy(&state.own_cookie_jar)
	// Clear the global's private slot BEFORE the free, so get_state_from_ctx can
	// never hand out a dangling ^Runtime_State. The reachable path is the one the
	// fail-closed dispatcher defines: host_dispatch_fail -> make_js_error ->
	// get_state_from_ctx, and the sweep above has just emptied this context's
	// registry, so any host-native call after this point is a GUARANTEED miss.
	// Without this, the one code path specified to run when our invariants are
	// already broken would read freed memory; with it, the miss lands in the
	// already-handled state == nil branch. No JS runs after this today (traced:
	// release_global_context_after_eval evaluates nothing), so this is defence in
	// depth, not a live bug — one C-API call at teardown for that.
	jsc.JSObjectSetPrivate(jsc.JSContextGetGlobalObject(ctx), nil)
	free(state)
}

// unprotect_before_eval_exit drops a GC root held by Runtime_State — except on
// Windows, where it is a no-op (a nil value is also skipped everywhere).
//
// This mirrors release_global_context_after_eval's Windows carve-out and exists
// for the same reason: these unprotects run from eval's deferred teardown right
// before the one-shot CLI's os.exit. On Windows, touching JSC's GC during that
// final teardown races the VM's concurrent GC/JIT worker threads — which a heavy
// JS workload (e.g. node:crypto scrypt's ROMix) leaves running at exit — and
// poisons the ensuing ExitProcess DLL-detach, so the process exits 127
// (ERROR_PROC_NOT_FOUND) despite the script having run correctly. The VM is
// already intentionally leaked on Windows (the context is never released), so
// dropping these roots is a semantic no-op anyway; the OS reclaims everything,
// exactly as the process.exit() fast path already does. Other platforms tear
// down cleanly and keep unprotecting.
unprotect_before_eval_exit :: proc(ctx: jsc.JSContextRef, value: jsc.JSValueRef) {
	if value == nil {
		return
	}

	when ODIN_OS != .Windows {
		jsc.JSValueUnprotect(ctx, value)
	}
}

get_state_from_ctx :: proc(ctx: jsc.JSContextRef) -> ^Runtime_State {
	global := jsc.JSContextGetGlobalObject(ctx)
	return cast(^Runtime_State)jsc.JSObjectGetPrivate(global)
}

// get_loop_from_ctx returns the event loop bound to this context (or nil).
// Replaces the previous string-based __loop_ptr__ global.
get_loop_from_ctx :: proc(ctx: jsc.JSContextRef) -> ^eventloop.Loop {
	state := get_state_from_ctx(ctx)

	if state == nil {
		return nil
	}

	return state.loop
}

// make_global_class creates a JSClass whose instances support a private-data
// slot. We use it for the global object so we can stash Runtime_State on it.
make_global_class :: proc() -> jsc.JSClassRef {
	def := jsc.JSClassDefinition {
		class_name = "LavaGlobal",
	}
	return jsc.JSClassCreate(&def)
}

// --- JS callback bridge ---

make_js_callback :: proc(
	ctx: jsc.JSContextRef,
	fn: jsc.JSObjectRef,
	repeating: bool,
	args: []jsc.JSValueRef,
	allocator: runtime.Allocator,
) -> ^JS_Callback {
	jsc.JSValueProtect(ctx, cast(jsc.JSValueRef)fn)
	cb := new(JS_Callback, allocator)
	cb.ctx = ctx
	cb.allocator = allocator
	cb.func = fn
	cb.args = args
	cb.repeating = repeating
	return cb
}

// capture_timer_args clones and GC-protects the trailing timer arguments — every
// argument at or after `start` (index 2 for setTimeout/setInterval, 1 for
// setImmediate). The returned slice is owned by the JS_Callback and released by
// free_js_callback. Returns nil when there are none (or on allocation failure).
// `allocator` must be the one the owning JS_Callback is made with.
capture_timer_args :: proc(
	ctx: jsc.JSContextRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	start: int,
	allocator: runtime.Allocator,
) -> []jsc.JSValueRef {
	n := int(argument_count) - start

	if n <= 0 {
		return nil
	}

	args, err := make([]jsc.JSValueRef, n, allocator)

	if err != nil {
		return nil
	}

	for i in 0 ..< n {
		v := arguments[start + i]
		jsc.JSValueProtect(ctx, v)
		args[i] = v
	}
	return args
}

// free_js_callback releases a binding. When release_roots is true it also
// unprotects the function and every forwarded argument; when false, only the
// native binding memory is released and the roots stay with the process-lifetime
// VM. Called once per binding - by js_callback_trampoline on a one-shot's only
// fire, or by js_callback_dispose when the loop drops the binding without
// (re-)firing.
free_js_callback :: proc(cb: ^JS_Callback, release_roots := true) {
	if release_roots {
		jsc.JSValueUnprotect(cb.ctx, cast(jsc.JSValueRef)cb.func)
		for arg in cb.args {
			jsc.JSValueUnprotect(cb.ctx, arg)
		}
	}

	allocator := cb.allocator
	delete(cb.args, allocator)
	free(cb, allocator)
}

// should_release_fired_callback_roots keeps normal callback GC-root cleanup on
// every platform except the Windows one-shot CLI exit edge. A heavy final JS
// callback (crypto.scrypt's setImmediate-backed ROMix is the current canary, but
// the same holds for any timer/immediate/I-O callback) can leave JSC worker
// threads alive; unprotecting the just-fired callback root as the last loop work
// then poisons Windows process teardown and ExitProcess reports 127. If more loop
// work exists, keep releasing roots so long-running scripts do not leak every
// one-shot timer/immediate callback. The VM is already intentionally leaked on
// Windows at eval exit, so the final callback root is reclaimed by the OS with the
// rest of the process.
//
// "Last loop work" is has_pending_work() read from inside the trampoline: run_once
// uncounts the firing task (immediates/I-O/close removed before the call, one-shot
// timers ref-dropped at pop) before invoking it, so the check sees only the work
// queued *behind* this callback — true for any final callback, not just setImmediate.
should_release_fired_callback_roots :: proc(loop: ^eventloop.Loop) -> bool {
	when ODIN_OS == .Windows {
		return eventloop.has_pending_work(loop)
	}
	return true
}

js_callback_trampoline :: proc(loop: ^eventloop.Loop, user_data: rawptr) {
	cb := cast(^JS_Callback)user_data

	if cb == nil {
		return
	}

	exception: jsc.JSValueRef
	invoke_user_callback(cb.ctx, cb.func, raw_data(cb.args), c.size_t(len(cb.args)), &exception)

	if exception != nil {
		report_uncaught(cb.ctx, exception)
		mark_async_failed(cb.ctx)
	}

	// Non-repeating callbacks (setTimeout/setImmediate/microtasks) fire once;
	// release their GC protection and heap binding. Repeating timers keep the
	// binding alive for the next tick — it is released by js_callback_dispose
	// (the loop's dispose hook) when the interval is cleared, since the
	// trampoline never runs for a cancelled timer.
	if !cb.repeating {
		free_js_callback(cb, should_release_fired_callback_roots(loop))
	}
}

// js_callback_dispose is the event loop's dispose hook for timer/immediate
// bindings: it releases a JS_Callback the loop drops without firing (a cleared
// setTimeout/setImmediate) or after firing without re-arming (a setInterval
// cleared from within its own callback). It mirrors the trampoline's one-shot
// cleanup, so a binding is freed exactly once — by the trampoline when it fires
// for the last time, or here when it is cancelled.
js_callback_dispose :: proc(user_data: rawptr) {
	cb := cast(^JS_Callback)user_data

	if cb == nil {
		return
	}

	free_js_callback(cb)
}

report_uncaught :: proc(ctx: jsc.JSContextRef, exception: jsc.JSValueRef) {
	msg, allocated := jsc_value_to_string_or_default(ctx, exception)
	defer if allocated {
		delete(msg, context.allocator)
	}
	process_write(os.stderr, "Uncaught ", msg, "\n")
}

// mark_async_failed records that the process should exit non-zero because an
// async callback threw or a promise rejected without a handler. resolve_exit_code
// reads it once the loop drains.
mark_async_failed :: proc(ctx: jsc.JSContextRef) {
	if state := get_state_from_ctx(ctx); state != nil {
		state.async_failed = true
	}
}

// unhandled_rejection_cb is registered with JavaScriptCore via
// JSGlobalContextSetUnhandledRejectionCallback. JSC invokes it as
// handler(promise, reason) at a microtask checkpoint when a rejected promise has
// no handler, matching Node's default --unhandled-rejections=throw behavior.
unhandled_rejection_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	reason := jsc.JSValueMakeUndefined(ctx)

	if argument_count >= 2 {
		reason = arguments[1]
	}

	msg, allocated := jsc_value_to_string_or_default(ctx, reason)
	defer if allocated {
		delete(msg, context.allocator)
	}
	process_write(os.stderr, "Uncaught (in promise) ", msg, "\n")
	mark_async_failed(ctx)
	return jsc.JSValueMakeUndefined(ctx)
}

// install_rejection_tracker registers unhandled_rejection_cb with the context so
// unhandled promise rejections surface to stderr and the exit code.
install_rejection_tracker :: proc(ctx: jsc.JSContextRef) {
	name := jsc.JSStringCreateWithUTF8CString("unhandledRejection")
	defer jsc.JSStringRelease(name)
	handler := jsc.JSObjectMakeFunctionWithCallback(ctx, name, unhandled_rejection_cb)

	if handler == nil {
		return
	}

	jsc.JSValueProtect(ctx, cast(jsc.JSValueRef)handler)

	if state := get_state_from_ctx(ctx); state != nil {
		state.rejection_handler = cast(jsc.JSValueRef)handler
	}

	jsc.JSGlobalContextSetUnhandledRejectionCallback(cast(jsc.JSGlobalContextRef)ctx, handler, nil)
}

// get_named reads object[name], returning nil on allocation failure. Mirror of
// set_named.
get_named :: proc(ctx: jsc.JSContextRef, object: jsc.JSObjectRef, name: string) -> jsc.JSValueRef {
	c_name, err := strings.clone_to_cstring(name, context.temp_allocator)

	if err != nil {
		return nil
	}

	js_name := jsc.JSStringCreateWithUTF8CString(c_name)
	defer jsc.JSStringRelease(js_name)
	return jsc.JSObjectGetProperty(ctx, object, js_name, nil)
}

// callback_arg returns the argument as a callable function object, or nil.
callback_arg :: proc(ctx: jsc.JSContextRef, value: jsc.JSValueRef) -> jsc.JSObjectRef {
	if !jsc.JSValueIsObject(ctx, value) {
		return nil
	}

	obj := cast(jsc.JSObjectRef)value

	if !jsc.JSObjectIsFunction(ctx, obj) {
		return nil
	}

	return obj
}

// make_js_error / make_js_named_error and the Node ERR_* helpers live in
// errors.odin (the single source of truth for native error construction).

// --- Timer / scheduling callbacks ---

// timer_delay_ms reads setTimeout/setInterval's `timeout` argument as Chrome's binding
// does, on both surfaces: a WebIDL `long`, then a negative value is 0.
//
// Params:
//   op  The method, for the prefix of a conversion TypeError.
// Returns:
//   The delay in ms, in [0, 2^31 - 1]; ok false when the conversion threw, the error
//   in `exception` — the caller then schedules nothing.
// Node:
//   No counterpart; Chrome is the oracle. ToNumber runs the argument's valueOf/toString
//   (once, at the call) and its error propagates; a BigInt or a Symbol throws a
//   TypeError. Then truncation modulo 2^32 read as signed: NaN, ±Infinity, -1, 2^31 and
//   2^32 - 1 are 0 ms, 2^32 + 5 is 5 ms, 4.9 is 4 ms. A 0 ms delay stays 0 — node's
//   floor of 1 ms is gone — so it is queued as a task at once
//   (eventloop.set_timer). Recorded on Chrome 158.0.8127.88:
//   tests/web/cases/timers-delay-coercion.
//
// The nesting clamp (4 ms past level 5) is the loop's, which knows the running task.
// Out of the u64() conversion's way: webidl_long's result is an exact integer in
// [-2^31, 2^31 - 1], never NaN or out of range.
@(private = "file")
timer_delay_ms :: proc(
	ctx: jsc.JSContextRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	op: string,
	exception: ^jsc.JSValueRef,
) -> (
	u64,
	bool,
) {
	// An omitted timeout is the IDL default, 0.
	if argument_count < 2 {
		return 0, true
	}

	n, ok := web_to_number(ctx, arguments[1], op, exception)

	if !ok {
		return 0, false
	}

	x := webidl_long(n)
	return x > 0 ? u64(x) : 0, true
}

set_timeout_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()

	// One state lookup serves both the loop and the binding allocator (see
	// JS_Callback.allocator); get_loop_from_ctx would repeat the two FFI crossings.
	// The handler is required: Chrome's binding throws its arity TypeError, no `code`
	// ("Failed to execute 'setTimeout' on 'Window': 1 argument required, but only 0 present.",
	// Chrome 158, tests/web/cases/timers-errors). Before the state lookup, so a context
	// without a loop answers the same.
	if argument_count < 1 {
		web_throw_type_error(ctx, "setTimeout", "1 argument required, but only 0 present.", exception)
		return nil
	}

	state := get_state_from_ctx(ctx)

	if state == nil || state.loop == nil {
		return jsc.JSValueMakeUndefined(ctx)
	}

	loop, alloc := state.loop, state.allocator

	fn := callback_arg(ctx, arguments[0])

	if fn == nil {
		return jsc.JSValueMakeUndefined(ctx)
	}

	// Converted before anything is captured: a throwing conversion schedules nothing.
	delay, ok := timer_delay_ms(ctx, argument_count, arguments, "setTimeout", exception)

	if !ok {
		return nil
	}

	// Trailing args (setTimeout(fn, delay, ...args)) are forwarded on fire.
	cb := make_js_callback(ctx, fn, false, capture_timer_args(ctx, argument_count, arguments, 2, alloc), alloc)
	id := eventloop.set_timeout(loop, js_callback_trampoline, delay, cb, js_callback_dispose)
	return jsc.JSValueMakeNumber(ctx, f64(id))
}

set_interval_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()

	// One state lookup serves both the loop and the binding allocator (see
	// JS_Callback.allocator); get_loop_from_ctx would repeat the two FFI crossings.
	// The handler is required: Chrome's binding throws its arity TypeError, no `code`
	// ("Failed to execute 'setInterval' on 'Window': 1 argument required, but only 0 present.",
	// Chrome 158, tests/web/cases/timers-errors). Before the state lookup, so a context
	// without a loop answers the same.
	if argument_count < 1 {
		web_throw_type_error(ctx, "setInterval", "1 argument required, but only 0 present.", exception)
		return nil
	}

	state := get_state_from_ctx(ctx)

	if state == nil || state.loop == nil {
		return jsc.JSValueMakeUndefined(ctx)
	}

	loop, alloc := state.loop, state.allocator

	fn := callback_arg(ctx, arguments[0])

	if fn == nil {
		return jsc.JSValueMakeUndefined(ctx)
	}

	// Converted before anything is captured: a throwing conversion schedules nothing.
	interval, ok := timer_delay_ms(ctx, argument_count, arguments, "setInterval", exception)

	if !ok {
		return nil
	}

	// Trailing args (setInterval(fn, delay, ...args)) are forwarded on every fire.
	cb := make_js_callback(ctx, fn, true, capture_timer_args(ctx, argument_count, arguments, 2, alloc), alloc)
	id := eventloop.set_interval(loop, js_callback_trampoline, interval, cb, js_callback_dispose)
	return jsc.JSValueMakeNumber(ctx, f64(id))
}

// clear_timeout_web_cb and clear_interval_web_cb are clearTimeout and clearInterval: they
// cancel the timer `id` if, and only if, the JS timer globals created it, reading the id
// as Chrome does.
//
// Node:
//   No counterpart; Chrome is the oracle. The id is a WebIDL `long`: ToNumber, then
//   truncation and modulo 2^32, so "N.0", " N", "0xN", N + 0.5, N ± 2^32, N + 2^33,
//   [N] and new String("N") all cancel timer N, and a result ≤ 0 is a no-op. A
//   conversion that fails throws a TypeError, no `code`, with the binding's prefix:
//   "Failed to execute 'clearTimeout' on 'Window': Cannot convert a BigInt value to a
//   number" (also for a BigInt wrapper), "… a Symbol value …", "… Cannot convert object
//   to primitive value". An error the argument's own valueOf/toString/toPrimitive
//   throws propagates unchanged. Recorded on Chrome 158.0.8127.88; pinned by
//   js_clear_globals_read_an_id_like_chrome.
// Deviates:
//   A Lava id of 2^31 or more cannot be cleared, since a `long` cannot name it; Chrome's
//   ids are `long`s and never get there, and a loop issuing two billion handles is not a
//   page we keep alive. Pinned by js_clear_globals_on_web_cannot_name_an_id_past_2_31.
//   A non-callable Symbol.toPrimitive throws with the prefix but not V8's rendering of
//   the value and object ("'1' returned for property … of object '#<Object>' is not a
//   function"); the case pins the prefix only.
clear_timeout_web_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	return clear_timer_web(ctx, argument_count, arguments, exception, "clearTimeout")
}

clear_interval_web_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	return clear_timer_web(ctx, argument_count, arguments, exception, "clearInterval")
}

// clear_timer_web is the body of the two `.Web` clears; `op` names the method in a
// thrown message, as Chrome's binding does. Two thin callbacks rather than reading the
// callee's `name`, which a page can redefine.
@(private = "file")
clear_timer_web :: proc(
	ctx: jsc.JSContextRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
	op: string,
) -> jsc.JSValueRef {
	// An omitted id is the IDL default, 0: no timer.
	if argument_count < 1 {
		return jsc.JSValueMakeUndefined(ctx)
	}

	n, ok := web_to_number(ctx, arguments[0], op, exception)

	if !ok {
		return nil
	}

	if x := webidl_long(n); x >= 1 {
		clear_timer_owned_id(ctx, u64(x))
	}

	return jsc.JSValueMakeUndefined(ctx)
}

// webidl_long is WebIDL's ConvertToInt for `long` on a number ToNumber produced: NaN
// and ±Infinity are 0; otherwise truncate, take it modulo 2^32 and read the result as
// signed. Every step stays in f64, where these magnitudes are exact, so no float→int
// conversion sees an out-of-range value; the result is an integer in [-2^31, 2^31 - 1].
@(private = "file")
webidl_long :: proc(n: f64) -> f64 {
	if !math.is_nan(n) && !math.is_inf(n) {
		x := math.mod(math.trunc(n), 4294967296)

		if x < 0 {
			x += 4294967296
		}

		if x >= 2147483648 {
			x -= 4294967296
		}

		return x
	}

	return 0
}

// web_to_number is ECMAScript ToNumber as a WebIDL binding runs it: ToPrimitive with
// the number hint, then a BigInt or a Symbol primitive is refused. JSValueToNumber
// alone is not that — the C API converts a BigInt, wrapped or not, where ToNumber
// throws — so the primitive step is done here and JSValueToNumber only ever sees a
// primitive it converts without running page code. false: a throw is in `exception`.
@(private = "file")
web_to_number :: proc(ctx: jsc.JSContextRef, v: jsc.JSValueRef, op: string, exception: ^jsc.JSValueRef) -> (f64, bool) {
	p := v

	if jsc.JSValueIsObject(ctx, v) {
		ok: bool
		p, ok = web_to_primitive(ctx, cast(jsc.JSObjectRef)v, op, exception)

		if !ok {
			return 0, false
		}
	}

	if value_is_bigint(ctx, p) {
		return 0, web_throw_type_error(ctx, op, "Cannot convert a BigInt value to a number", exception)
	}

	if jsc.JSValueGetType(ctx, p) == .Symbol {
		return 0, web_throw_type_error(ctx, op, "Cannot convert a Symbol value to a number", exception)
	}

	return jsc.JSValueToNumber(ctx, p, nil), true
}

// web_to_primitive is ToPrimitive(obj, "number"): a callable Symbol.toPrimitive is
// called with "number", else valueOf then toString, the first non-object result wins.
// The page's own errors from those calls propagate as they are; the failures the
// algorithm itself raises are prefixed TypeErrors. Without a captured Symbol.toPrimitive
// (a context install_globals did not set up as `.Web`) only the valueOf/toString step
// runs. The values held across the calls are locals of this native frame, which JSC
// scans conservatively, and the argument itself is rooted by the caller.
@(private = "file")
web_to_primitive :: proc(
	ctx: jsc.JSContextRef,
	obj: jsc.JSObjectRef,
	op: string,
	exception: ^jsc.JSValueRef,
) -> (
	jsc.JSValueRef,
	bool,
) {
	thrown: jsc.JSValueRef
	state := get_state_from_ctx(ctx)

	if state != nil && state.symbol_to_primitive != nil {
		exotic := jsc.JSObjectGetPropertyForKey(ctx, obj, state.symbol_to_primitive, &thrown)

		if thrown != nil {
			return nil, web_rethrow(thrown, exception)
		}

		if exotic != nil && !jsc.JSValueIsUndefined(ctx, exotic) && !jsc.JSValueIsNull(ctx, exotic) {
			if !jsc.JSValueIsObject(ctx, exotic) || !jsc.JSObjectIsFunction(ctx, cast(jsc.JSObjectRef)exotic) {
				return nil, web_throw_type_error(ctx, op, "Symbol.toPrimitive is not a function", exception)
			}

			hint := [1]jsc.JSValueRef{js_string_value(ctx, "number")}
			r := jsc.JSObjectCallAsFunction(ctx, cast(jsc.JSObjectRef)exotic, obj, 1, raw_data(hint[:]), &thrown)

			if thrown != nil {
				return nil, web_rethrow(thrown, exception)
			}

			if r == nil || jsc.JSValueIsObject(ctx, r) {
				return nil, web_throw_type_error(ctx, op, "Cannot convert object to primitive value", exception)
			}

			return r, true
		}
	}

	for name in ([2]cstring{"valueOf", "toString"}) {
		key := jsc.JSStringCreateWithUTF8CString(name)
		method := jsc.JSObjectGetProperty(ctx, obj, key, &thrown)
		jsc.JSStringRelease(key)

		if thrown != nil {
			return nil, web_rethrow(thrown, exception)
		}

		if method == nil || !jsc.JSValueIsObject(ctx, method) || !jsc.JSObjectIsFunction(ctx, cast(jsc.JSObjectRef)method) {
			continue
		}

		r := jsc.JSObjectCallAsFunction(ctx, cast(jsc.JSObjectRef)method, obj, 0, nil, &thrown)

		if thrown != nil {
			return nil, web_rethrow(thrown, exception)
		}

		if r != nil && !jsc.JSValueIsObject(ctx, r) {
			return r, true
		}
	}

	return nil, web_throw_type_error(ctx, op, "Cannot convert object to primitive value", exception)
}

// web_throw_type_error stores the TypeError a Window binding throws for `op` in
// `exception` and returns false, for `return 0, web_throw_type_error(…)`.
@(private = "file")
web_throw_type_error :: proc(ctx: jsc.JSContextRef, op, detail: string, exception: ^jsc.JSValueRef) -> bool {
	if exception != nil {
		message := strings.concatenate({"Failed to execute '", op, "' on 'Window': ", detail})
		defer delete(message)
		exception^ = make_js_named_error(ctx, "TypeError", message)
	}

	return false
}

// capture_symbol_to_primitive keeps the realm's Symbol.toPrimitive on Runtime_State for
// web_to_primitive. Called from install_globals, before any page code runs, so the
// global `Symbol` it reads is the intrinsic. One protect, released in
// destroy_runtime_state; a second install on the same context keeps the first.
@(private = "file")
capture_symbol_to_primitive :: proc(ctx: jsc.JSContextRef, global: jsc.JSObjectRef) {
	state := get_state_from_ctx(ctx)

	if state == nil || state.symbol_to_primitive != nil {
		return
	}

	symbol_ctor := get_named(ctx, global, "Symbol")

	if symbol_ctor == nil || !jsc.JSValueIsObject(ctx, symbol_ctor) {
		return
	}

	key := get_named(ctx, cast(jsc.JSObjectRef)symbol_ctor, "toPrimitive")

	if key == nil || jsc.JSValueGetType(ctx, key) != .Symbol {
		return
	}

	jsc.JSValueProtect(ctx, key)
	state.symbol_to_primitive = key
}

// web_rethrow passes a page-thrown error through unchanged and returns false.
@(private = "file")
web_rethrow :: proc(thrown: jsc.JSValueRef, exception: ^jsc.JSValueRef) -> bool {
	if exception != nil {
		exception^ = thrown
	}

	return false
}

// clear_timer_owned_id cancels handle `id` on the context's loop if a JS timer global
// created it. Owner-checked: a plain clear_timeout would run an internal handle's
// dispose for any id the script guessed (#92).
@(private = "file")
clear_timer_owned_id :: proc(ctx: jsc.JSContextRef, id: u64) {
	if loop := get_loop_from_ctx(ctx); loop != nil {
		eventloop.clear_timeout_owned(loop, id, js_callback_dispose)
	}
}

// queueMicrotask is installed from JS (MICROTASK_PRELUDE) rather than as a native
// callback: it lives inside JSC's promise-job queue. See install_microtasks and
// js/bootstrap/microtasks.js.

// --- console ---
//
// The full `console` surface (util.format `%s/%d/%j` substitution, group
// indentation, `table`, `time`/`count`, `assert`/`trace`/`dir`, …) is
// implemented in JavaScript — see CONSOLE_PRELUDE / install_console — exactly
// as Node implements lib/internal/console. The native layer only exposes two
// raw write primitives so stdout and stderr stay under Odin's control.

// output_mutex serializes ALL process output (stdout AND stderr) so that under N workers (Slice 3a)
// concurrent writes can't interleave mid-line. process_write is the single locked writer every output
// path must use — console, uncaught/rejection reports, internal init failures — writing each message's
// parts under one lock so a whole line lands atomically relative to other workers.
@(private = "file")
output_mutex: sync.Mutex

// process_write_all writes every byte of `data` to `fd`, or reports why it could not.
//
// Params:
//   fd     Destination file; the caller must already hold output_mutex.
//   data   Bytes to write; an empty slice is a no-op success.
// Returns:
//   written  Bytes actually delivered — equal to len(data) on success.
//   err      The error that stopped the loop; nil when everything was written.
// Node:
//   node writes files and TTYs synchronously on POSIX and QUEUES pipes on its loop,
//   flushing before a natural exit. On a natural exit `console.log('x'.repeat(300000))`
//   delivers 300001 bytes where Lava delivered 65536 (node 26.13.0, parent-set O_NONBLOCK
//   pipe). It is not a blanket "node never truncates": across `process.exit(0)` node drops
//   its queued write and delivers 65536 on the same harness — the exact signature this
//   fix removes from Lava.
// Deviates:
//   Two, both from writing synchronously where node queues, and both measured on that
//   harness. (1) A full stdout parks the loop thread in poll(2) until the reader drains:
//   during a 2s stall node fired 19 timer ticks and Lava fired 0. Lava already behaved
//   this way for a BLOCKING pipe; the fix makes it reachable for a non-blocking one too.
//   (2) `console.log(big); process.exit(0)` delivers everything here and 65536 under node.
//   Blocking was chosen over dropping bytes. Pinned by tests/stdio/stdio-write.test.mjs.
//
// Two distinct failures are folded in here, and only the first is obvious. `os.write`
// loops on a SHORT write but abandons the loop on any errno (core/os/file_linux.odin),
// and the previous caller discarded both `n` and `err` — so a full pipe ended the write
// and reported success. Nothing in Lava sets O_NONBLOCK on fd 1/2, which is exactly why
// this was invisible: the flag is INHERITED from whatever launched the process, so an
// ordinary shell pipe never reproduces it and a process manager does.
//
// The EAGAIN retry deliberately blocks rather than spins. A busy loop on a full pipe
// burns a core until the reader drains; waiting for writability is what the kernel
// interface is for. EINTR carries no information about the fd and is simply retried.
process_write_all :: proc(fd: ^os.File, data: []byte) -> (written: int, err: os.Error) {
	rest := data
	for len(rest) > 0 {
		n, werr := os.write(fd, rest)

		if n > 0 {
			written += n
			rest = rest[n:]
		}

		// A successful write of zero bytes would loop forever holding output_mutex.
		// Unreachable on Linux/darwin (core:os forces an error), but Windows'
		// WriteFile on a PIPE_NOWAIT handle returns TRUE with 0 written and
		// GetLastError() 0, which core:os maps to a nil error. Bail rather than spin.
		if werr == nil {
			if n == 0 {
				return written, .Unexpected_EOF
			}

			continue
		}

		if !stdio_retryable(werr) {
			return written, werr
		}

		// A retryable error with no progress means the fd is full (or a signal landed).
		// Wait for it to become writable instead of spinning; on the platforms where
		// this cannot be expressed the wait is a no-op and the loop simply retries.
		if n == 0 {
			stdio_wait_writable(fd)
		}
	}
	return written, nil
}


// process_write_bytes is process_write for an already-resolved byte slice, so a caller
// holding Buffer bytes does not have to launder them through a string. Same mutex, same
// retry loop — which is what keeps process.stdout.write and console.log from interleaving
// mid-line under workers.
process_write_bytes :: proc(fd: ^os.File, data: []byte) {
	if len(data) == 0 {
		return
	}

	sync.lock(&output_mutex)
	defer sync.unlock(&output_mutex)
	process_write_all(fd, data)
}

// process_write serializes a whole message under output_mutex so a line lands atomically
// relative to other workers. It now writes every byte across a retryable stall instead of
// stopping at one buffer-full.
//
// A NON-retryable failure is still swallowed, and deliberately: there is no channel to
// report it on from a `proc "c"` callback, and node's own stdout error is equally
// invisible for console.log — `lava run big.js | head -c 100` and the node equivalent both
// exit 0 in ~0.04s. An earlier version of this comment claimed it "gives up loudly", which
// was never true; the returns are discarded.
process_write :: proc(fd: ^os.File, parts: ..string) {
	sync.lock(&output_mutex)
	defer sync.unlock(&output_mutex)
	for p in parts {
		if len(p) == 0 {
			continue
		}

		process_write_all(fd, transmute([]byte)p)
	}
}

console_raw_write :: proc(
	fd: ^os.File,
	ctx: jsc.JSContextRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
) {
	if argument_count < 1 {
		return
	}

	text, allocated := jsc_value_to_string_or_default(ctx, arguments[0])
	process_write(fd, text)

	if allocated {
		delete(text, context.allocator)
	}
}

console_stdout_write_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	console_raw_write(os.stdout, ctx, argument_count, arguments)
	return jsc.JSValueMakeUndefined(ctx)
}

console_stderr_write_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	console_raw_write(os.stderr, ctx, argument_count, arguments)
	return jsc.JSValueMakeUndefined(ctx)
}

// --- installation ---

// install_globals wires the Window global surface (console, timers, queueMicrotask,
// performance, globalThis and every Web API global the loader installs) onto the
// context's global object. Timer functions are no-ops when no event loop is bound.
install_globals :: proc(ctx: jsc.JSContextRef, loop: ^eventloop.Loop) {
	global := jsc.JSContextGetGlobalObject(ctx)

	set_named(ctx, global, "globalThis", cast(jsc.JSValueRef)global)

	// Chrome's shapes (Chrome 158, tests/web/cases/shape-operations): 1 for the two
	// setters, 0 for the two cancels, and none of the four is a constructor, as no WebIDL
	// operation is (#114).
	inject_native_function(ctx, global, "setTimeout", set_timeout_cb, arity = 1, constructible = false)
	inject_native_function(ctx, global, "setInterval", set_interval_cb, arity = 1, constructible = false)
	inject_native_function(ctx, global, "clearTimeout", clear_timeout_web_cb, arity = 0, constructible = false)
	inject_native_function(ctx, global, "clearInterval", clear_interval_web_cb, arity = 0, constructible = false)
	capture_symbol_to_primitive(ctx, global)

	install_console(ctx, global)
	install_internal_modules(ctx, global)
	install_microtasks(ctx, global)
	install_rejection_tracker(ctx)
}

// holder_ended is vm_holder_ended for the VM behind `ctx`'s Runtime_State.
@(private = "file")
holder_ended :: proc(ctx: jsc.JSContextRef) -> bool {
	state := get_state_from_ctx(ctx)
	return state != nil && vm_holder_ended(state.vm)
}

// The Performance API clock origin. perf_origin_tick anchors the monotonic
// high-resolution timer (performance.now); perf_time_origin_ms is the wall-clock
// Unix epoch at that anchor (performance.timeOrigin), so
// timeOrigin + now() approximates Date.now(). Captured once per process.
@(private = "file")
perf_once: sync.Once
@(private = "file")
perf_origin_tick: time.Tick
@(private = "file")
perf_time_origin_ms: f64

// perf_init captures the process-wide clock origin exactly once. Guarded by sync.Once (perf_once) so
// N workers (Slice 3a) racing their first make_performance_bindings neither double-init nor tear the
// values; a single shared origin is intentional — performance.now() stays comparable across workers.
@(private = "file")
perf_init :: proc() {
	perf_origin_tick = time.tick_now()
	perf_time_origin_ms = f64(time.to_unix_nanoseconds(time.now())) / 1e6
}

// make_performance_bindings hands internal/performance its clock: a monotonic now()
// and the timeOrigin it counts from (W3C High Resolution Time). The `performance`
// global and the Performance interface around them are JS (js/internal/performance.js);
// the clock is the one native piece, and these bindings reach that module alone, as its
// factory's fourth argument.
make_performance_bindings :: proc(ctx: jsc.JSContextRef) -> jsc.JSObjectRef {
	sync.once_do(&perf_once, perf_init)

	bindings := jsc.JSObjectMake(ctx, nil, nil)
	inject_native_function(ctx, bindings, "now", performance_now_cb, arity = 0, constructible = false)
	set_named(ctx, bindings, "timeOrigin", jsc.JSValueMakeNumber(ctx, perf_time_origin_ms))
	return bindings
}

// performance_now_cb returns the high-resolution milliseconds (a fractional
// double) elapsed on the monotonic clock since the time origin.
performance_now_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	ms := time.duration_milliseconds(time.tick_since(perf_origin_tick))
	return jsc.JSValueMakeNumber(ctx, ms)
}

// install_microtasks evaluates MICROTASK_PRELUDE to a factory and calls it so it
// installs queueMicrotask and hands back the `dispatch` every event-loop callback runs
// through (invoke_user_callback). See js/bootstrap/microtasks.js for why queueMicrotask
// lives in JS on top of JSC's promise-job queue rather than the native event loop.
install_microtasks :: proc(ctx: jsc.JSContextRef, global: jsc.JSObjectRef) {
	override_dir := js_override_dir()
	factory := eval_internal_source(
		ctx,
		"lava:microtasks",
		override_dir,
		"js/bootstrap/microtasks.js",
		MICROTASK_PRELUDE,
	)

	if factory == nil || !jsc.JSValueIsObject(ctx, factory) {
		return
	}

	// A throw from a queueMicrotask callback is an uncaught exception (not an unhandled
	// rejection); the shim routes it here, the same path the timer trampoline uses for
	// async callbacks.
	report := make_native_function(ctx, "__lava_report_uncaught", microtask_report_uncaught_cb)

	if report == nil {
		return
	}

	// internal/native_shape, which queueMicrotask is defined through (#114): off the
	// module resolver, which no user code reaches; undefined without the loader.
	native_shape := jsc.JSValueMakeUndefined(ctx)

	if rs := get_state_from_ctx(ctx); rs != nil && rs.loader != nil {
		if shape := get_named(ctx, cast(jsc.JSObjectRef)rs.loader, "nativeShape"); shape != nil {
			native_shape = shape
		}
	}

	args := [3]jsc.JSValueRef{cast(jsc.JSValueRef)global, cast(jsc.JSValueRef)report, native_shape}
	exception: jsc.JSValueRef
	exports := jsc.JSObjectCallAsFunction(ctx, cast(jsc.JSObjectRef)factory, nil, 3, raw_data(args[:]), &exception)

	if exception != nil {
		report_internal_exception(ctx, "lava:microtasks", exception)
		return
	}

	// The factory returns { dispatch, dispatchCleanups }. Stash both (GC-protected) on
	// Runtime_State; invoke_user_callback and deferred.odin drive them.
	if exports == nil || !jsc.JSValueIsObject(ctx, exports) {
		return
	}

	state := get_state_from_ctx(ctx)

	if state == nil {
		return
	}

	dispatch := get_named(ctx, cast(jsc.JSObjectRef)exports, "dispatch")
	cleanups := get_named(ctx, cast(jsc.JSObjectRef)exports, "dispatchCleanups")

	if cleanups != nil && jsc.JSValueIsObject(ctx, cleanups) {
		jsc.JSValueProtect(ctx, cleanups)
		state.dispatch_cleanups = cleanups
	}

	if dispatch != nil && jsc.JSValueIsObject(ctx, dispatch) {
		jsc.JSValueProtect(ctx, dispatch)
		state.dispatch_fn = dispatch
	}

}

// invoke_user_callback runs a user JS callback at an event-loop boundary (timer /
// I/O / fetch completion), THROUGH the microtask shim's `dispatch`, so every callback
// shows the same one runtime frame; JSC drains the promise jobs it queued when the
// call returns (the microtask checkpoint). `args`/`argc` are the
// callback's own arguments; there is no `this` parameter because every call site
// used the default receiver (NULL thisObject → global), which `dispatch` mirrors.
// Falls back to a direct call if the shim is absent (embedder bypass).
invoke_user_callback :: proc(
	ctx: jsc.JSContextRef,
	fn: jsc.JSObjectRef,
	args: [^]jsc.JSValueRef,
	argc: c.size_t,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	state := get_state_from_ctx(ctx)

	// A page a limit has ended runs nothing more: the rest of this tick's due timers,
	// immediates and I/O callbacks are skipped, not each handed a fresh watchdog
	// window (see vm_cpu_checkpoint).
	if state != nil && page_stop_if_killed(state) {
		return jsc.JSValueMakeUndefined(ctx)
	}

	if state == nil || state.dispatch_fn == nil {
		result := jsc.JSObjectCallAsFunction(ctx, fn, nil, argc, args, exception)

		if state != nil {
			page_checkpoint(state, exception)
		}

		return result
	}

	// dispatch(fn, ...args): prepend the callback so the shim invokes it.
	n := int(argc) + 1
	dispatch_args := make([]jsc.JSValueRef, n, context.temp_allocator)
	dispatch_args[0] = cast(jsc.JSValueRef)fn
	for i in 0 ..< int(argc) {
		dispatch_args[i + 1] = args[i]
	}
	result := jsc.JSObjectCallAsFunction(
		ctx,
		cast(jsc.JSObjectRef)state.dispatch_fn,
		nil,
		c.size_t(n),
		raw_data(dispatch_args),
		exception,
	)

	if page_checkpoint(state, exception) {
		return jsc.JSValueMakeUndefined(ctx)
	}

	return result
}

// page_checkpoint charges the callback that just ran to the page's CPU budget and
// reports whether a limit has now ended the page. A kill's termination exception is
// dropped: the page is over, the caller reports the kill through Result.kill, and
// reporting it as an uncaught error too would print one "uncaught" per skipped entry.
//
// It is also where a runner page's tick learns its CPU quantum is spent (#35): it asks
// the loop to suspend the timers phase before the next due timer. Only the timers phase
// acts on the request; anywhere else it is dropped when the next timers phase starts.
page_checkpoint :: proc(state: ^Runtime_State, exception: ^jsc.JSValueRef) -> (killed: bool) {
	vm_cpu_checkpoint(state.vm)

	if state.loop != nil && vm_slice_spent(state.vm) {
		state.loop.yield_requested = true
	}

	if !page_stop_if_killed(state) {
		return false
	}

	if exception != nil {
		exception^ = nil
	}

	return true
}

// page_stop_if_killed stops the page's loop once a limit or a requested stop
// (process.exit in a runner page) has ended it.
page_stop_if_killed :: proc(state: ^Runtime_State) -> bool {
	if vm_kill_reason(state.vm) == .None && !(state.vm != nil && state.vm.stop_requested) {
		return false
	}

	if state.loop != nil {
		state.loop.force_exit = true
	}

	return true
}

// microtask_report_uncaught_cb(error) reports a throw from a queueMicrotask
// callback as an uncaught exception and flags the process to exit
// non-zero — mirroring js_callback_trampoline's handling of a throwing timer.
microtask_report_uncaught_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()

	if argument_count >= 1 {
		report_uncaught(ctx, arguments[0])
		mark_async_failed(ctx)
	}

	return jsc.JSValueMakeUndefined(ctx)
}

// make_blob_bindings returns internal/blob's natives: the two UTF-8 codecs it shares
// with the buffer bindings (the same function objects, so Blob's bytes are Buffer's
// bytes for every string, lone surrogates included) and `origin`, the page's origin
// as given, from which createObjectURL mints `blob:<origin>/<uuid>`. A separate object
// rather than the buffer bindings themselves: the origin is per page, and nothing of
// node:buffer's table needs to reach Blob.
make_blob_bindings :: proc(
	ctx: jsc.JSContextRef,
	buffer_bindings: jsc.JSObjectRef,
	origin: string,
) -> jsc.JSObjectRef {
	bindings := jsc.JSObjectMake(ctx, nil, nil)

	for name in ([]string{"utf8Encode", "utf8Decode"}) {
		if fn := get_named(ctx, buffer_bindings, name); fn != nil {
			set_named(ctx, bindings, name, fn)
		}
	}

	set_named(ctx, bindings, "origin", js_string_value(ctx, origin))
	// `endings: 'native'`'s terminator, as Chrome writes it on this platform.
	when ODIN_OS == .Windows {
		set_named(ctx, bindings, "eol", js_string_value(ctx, "\r\n"))
	} else {
		set_named(ctx, bindings, "eol", js_string_value(ctx, "\n"))
	}
	return bindings
}

// install_internal_modules hands the module loader a native `compile(id)` and the
// per-module natives, and stores the loader's handle on Runtime_State. The loader
// eagerly instantiates the modules that install the Web API globals; every other
// internal module's factory is compiled by builtin_compile_cb on its first require.
//
// Compile-on-first-require, not at init: evaluating every factory source made a page
// that needs none of the lazy modules pay for them all. When it landed (with the Node
// modules still embedded) `lava run bench/micro/noop.js` went 16.85 -> 14.63 ms (medians
// of 50 interleaved spawn-to-exit runs per arm after 5 warmups, darwin arm64, -o:speed,
// f106ab4 vs that change). See builtin_compile_cb.
install_internal_modules :: proc(ctx: jsc.JSContextRef, global: jsc.JSObjectRef) {
	state := get_state_from_ctx(ctx)

	if state == nil {
		return
	}

	override_dir := js_override_dir()
	loader := eval_internal_source(ctx, "internal:loader", override_dir, "js/bootstrap/loader.js", BOOTSTRAP_LOADER)

	if loader == nil || !jsc.JSValueIsObject(ctx, loader) {
		return
	}

	// Cold native: called once per module per context, so the generic host path, not
	// a *_host wrapper. Passed as a bare argument, so it is reachable only from the
	// loader's closure — never from page code.
	compile := host_native_create(ctx, "compile", builtin_compile_cb, 1)

	if compile == nil {
		compile = make_native_function(ctx, "compile", builtin_compile_cb)
	}

	if compile == nil {
		return
	}

	// Native primitives keyed by module id. The loader passes natives[id] to
	// each factory as its fourth argument, so a module receives its Odin-backed
	// bindings without anything landing on globalThis (cf. install_console).
	natives := jsc.JSObjectMake(ctx, nil, nil)
	set_named(ctx, natives, "internal/crypto/random", cast(jsc.JSValueRef)make_crypto_bindings(ctx))
	// One table of codec natives serves `encoding` and `base64`: encoding.js takes its
	// utf-8 encoder and both decoders from it, base64.js its base64/latin1 codecs. It
	// used to reach the utf-8 decoder as `Buffer.prototype.toString.call(bytes, 'utf8')`,
	// which put a live `Function.prototype.call` read on the RETURN path of decode():
	// replacing `.call` made decode() hand back the replacement's value.
	buffer_bindings := make_buffer_bindings(ctx)
	set_named(ctx, natives, "internal/encoding", cast(jsc.JSValueRef)buffer_bindings)
	set_named(ctx, natives, "internal/base64", cast(jsc.JSValueRef)buffer_bindings)
	set_named(ctx, natives, "internal/blob", cast(jsc.JSValueRef)make_blob_bindings(ctx, buffer_bindings, state.page_origin))
	set_named(ctx, natives, "internal/fetch", cast(jsc.JSValueRef)make_fetch_bindings(ctx))
	set_named(ctx, natives, "internal/deferred", cast(jsc.JSValueRef)make_deferred_bindings(ctx))
	set_named(ctx, natives, "internal/performance", cast(jsc.JSValueRef)make_performance_bindings(ctx))
	set_named(ctx, natives, "internal/location", cast(jsc.JSValueRef)make_location_bindings(ctx, state.page_origin))
	set_named(ctx, natives, "internal/navigator", cast(jsc.JSValueRef)make_navigator_bindings(ctx, profile.default_profile()))
	set_named(ctx, natives, "internal/cookie", cast(jsc.JSValueRef)make_cookie_bindings(ctx, state.page_origin))
	// Native, not a module: nothing of it is JS a page could see in a stack (wasm.odin).
	install_wasm(ctx, state)

	// The loader's third argument, as `compile` is its first: reachable only from its
	// closure and, through req.neverOptimize, from internal modules. Cold (a handful of
	// calls per page), so the generic host path. Without it the loader runs a no-op.
	never_optimize := cast(jsc.JSValueRef)host_native_create(ctx, "neverOptimize", never_optimize_cb, 0)

	if never_optimize == nil {
		never_optimize = cast(jsc.JSValueRef)make_native_function(ctx, "neverOptimize", never_optimize_cb)
	}

	if never_optimize == nil {
		never_optimize = jsc.JSValueMakeUndefined(ctx)
	}

	args := [3]jsc.JSValueRef{cast(jsc.JSValueRef)compile, cast(jsc.JSValueRef)natives, never_optimize}
	exception: jsc.JSValueRef
	handle := jsc.JSObjectCallAsFunction(ctx, cast(jsc.JSObjectRef)loader, nil, 3, raw_data(args[:]), &exception)

	if exception != nil {
		report_internal_exception(ctx, "internal:loader", exception)
		return
	}

	if handle == nil || !jsc.JSValueIsObject(ctx, handle) {
		return
	}

	jsc.JSValueProtect(ctx, handle)
	state.loader = handle
}

// never_optimize_cb is the loader's `neverOptimize(...fns)`: it keeps JSC's optimizing
// tiers off each function argument (jsc.never_optimize), for the install-time helpers
// that run once per page (bootstrap/loader.js, internal/native_shape).
//
// Returns:
//   undefined, always; a non-object argument is skipped.
// Node:
//   n/a — not reachable from page code, and a JIT tier is not observable: every shape
//   and web case reads the same with and without it.
//
// Measured on bench/pages (-o:speed, N=1, 400 pages a launch, medians of 5 interleaved
// launches per arm, 4-core Xeon shared with other work; 8ecd066 vs this hook alone):
// process CPU 14.9 -> 10.4 ms a page, pages/s 82 -> 100. JSC_useDFGJIT=0 for the whole
// process, the ceiling, measured 9.8 ms a page in the same run. Marking the primordials
// wrappers too reached it, but cost url-parse 1.9x and request-new 1.5x in `make bench`:
// those run on every page call, and stay optimizable.
never_optimize_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	for i in 0 ..< int(argument_count) {
		if jsc.JSValueIsObject(ctx, arguments[i]) {
			jsc.never_optimize(ctx, arguments[i])
		}
	}

	return jsc.JSValueMakeUndefined(ctx)
}

// builtin_compile_cb is the loader's `compile(id)`: it evaluates the embedded
// source of module `id` (`internal/url`, `internal/fetch/body`) and returns its
// factory `(require, module, exports, native) => exports?`.
//
// Returns:
//   The factory; undefined for a non-string or an id with no embedded file, and
//   for a source that failed to evaluate (reported to stderr, as at init before
//   this was lazy — the loader then answers "not a builtin").
// Node:
//   Not observable: Node also compiles a builtin on its first require, and the
//   loader's cache (bootstrap/loader.js) keeps it to once per context.
//
// The id is matched against EMBEDDED_JS_DIRS — exact directory prefix, exact
// basename — so only a file in the embedded set is reachable: 'node/constructor',
// '__proto__', '' and anything with '..' match no row. The override path and the
// source name are rebuilt from the MATCHED row, never from the argument, so a
// LAVA_JS_OVERRIDE build cannot be steered to read a file outside js/ either.
// The scan is linear over ~40 rows with no allocation; it runs once per builtin,
// plus once per `require` of a bare name that is not a builtin (express, lodash)
// on its way to the filesystem resolver.
//
// js_override_dir is recomputed per call rather than cached on Runtime_State: in a
// normal build it is a compile-time "" and costs nothing; only override builds
// (mutation runs) pay one os.exists per compile.
builtin_compile_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	// Everything below is scratch for this one evaluation (path and cstring
	// copies); nothing outlives the call. A guard rather than leaning on the
	// caller's choke point: compile runs under native_require_cb's per-require
	// free_all, under eval's at init, or under a loop tick's when a builtin
	// requires a lazy internal module from a callback.
	runtime.DEFAULT_TEMP_ALLOCATOR_TEMP_GUARD()
	undefined := jsc.JSValueMakeUndefined(ctx)
	state := get_state_from_ctx(ctx)

	if state == nil || argument_count < 1 || !jsc.JSValueIsString(ctx, arguments[0]) {
		return undefined
	}

	// The loader builds ids by concatenation, so the argument is usually a rope,
	// which value_chars8 declines; read_string_arg flattens it. Where the cell read
	// is unavailable (off Linux) the C API hands back UTF-16 even for an ASCII
	// string, so narrow it into a stack buffer; a non-ASCII unit or an id longer
	// than any embedded one cannot match.
	r := read_string_arg(ctx, arguments[0])
	defer if r.str != nil {
		jsc.JSStringRelease(r.str)
	}

	if !r.ok {
		return undefined
	}

	narrow: [64]byte
	id: string

	if r.is8 {
		id = string(r.s8)
	} else {
		if len(r.s16) > len(narrow) {
			return undefined
		}

		for u, i in r.s16 {
			if u >= 0x80 {
				return undefined
			}

			narrow[i] = byte(u)
		}
		id = string(narrow[:len(r.s16)])
	}

	slash := strings.last_index_byte(id, '/')

	if slash <= 0 {
		return undefined
	}

	prefix, base := id[:slash], id[slash + 1:]

	if len(base) == 0 {
		return undefined
	}

	for dir in EMBEDDED_JS_DIRS {
		if dir.prefix != prefix {
			continue
		}

		for file in dir.files {
			if len(file.name) != len(base) + 3 || !strings.has_suffix(file.name, ".js") {
				continue
			}

			if file.name[:len(base)] != base {
				continue
			}

			rel_path, rel_err := strings.concatenate({"js/", dir.prefix, "/", file.name}, context.temp_allocator)

			if rel_err != nil {
				return undefined
			}

			// Source name is what a stack frame shows: `node:internal/fetch`, the shape
			// internal/web_errors scrubs from every stack a page sees (#114).
			spec := rel_path[len("js/"):len(rel_path) - len(".js")]
			source_name, name_err := strings.concatenate({"node:", spec}, context.temp_allocator)

			if name_err != nil {
				return undefined
			}

			factory := eval_internal_source(ctx, source_name, js_override_dir(), rel_path, string(file.data))

			if factory == nil {
				return undefined
			}

			state.builtin_compiles += 1
			return factory
		}
		return undefined
	}
	return undefined
}

// install_console builds the full `console` object. CONSOLE_PRELUDE evaluates
// to a factory function `(out, err) => { … }`; we call it with the two native
// write primitives passed directly as arguments. The primitives are therefore
// never exposed on globalThis — no transient leak for user code to capture, and
// no `delete` that would push the global object into JSC's dictionary mode. The
// only property the prelude adds to globalThis is `console` itself.
install_console :: proc(ctx: jsc.JSContextRef, global: jsc.JSObjectRef) {
	out_fn := make_native_function(ctx, "__lava_write_out", console_stdout_write_cb)
	err_fn := make_native_function(ctx, "__lava_write_err", console_stderr_write_cb)

	if out_fn == nil || err_fn == nil {
		return
	}

	override_dir := js_override_dir()
	factory := eval_internal_source(ctx, "lava:console", override_dir, "js/bootstrap/console.js", CONSOLE_PRELUDE)

	if factory == nil || !jsc.JSValueIsObject(ctx, factory) {
		return
	}

	args := [2]jsc.JSValueRef{cast(jsc.JSValueRef)out_fn, cast(jsc.JSValueRef)err_fn}
	exception: jsc.JSValueRef
	jsc.JSObjectCallAsFunction(ctx, cast(jsc.JSObjectRef)factory, nil, 2, raw_data(args[:]), &exception)

	if exception != nil {
		report_internal_exception(ctx, "lava:console", exception)
	}
}

// make_native_function wraps an Odin callback as a standalone JS function value
// without binding it to any object — the caller decides where (if anywhere) it
// is reachable from.
make_native_function :: proc(
	ctx: jsc.JSContextRef,
	name: string,
	callback: jsc.JSObjectCallAsFunctionCallback,
) -> jsc.JSObjectRef {
	c_name, err := strings.clone_to_cstring(name, context.temp_allocator)

	if err != nil {
		return nil
	}

	js_name := jsc.JSStringCreateWithUTF8CString(c_name)
	defer jsc.JSStringRelease(js_name)
	return jsc.JSObjectMakeFunctionWithCallback(ctx, js_name, callback)
}

// LAVA_JS_OVERRIDE compiles in the dev-only "builtin JS from disk" path. It is OFF
// in every normal build (`make build`, release, bench): such a binary never stats or
// reads a file to get its runtime JS, so the embedded `#load` strings are the only
// source and nothing on disk can steer it. scripts/build.sh turns it on only when
// LAVA_JS_OVERRIDE=1 is in the environment, which the mutation runner sets for its
// mutant builds.
LAVA_JS_OVERRIDE :: #config(LAVA_JS_OVERRIDE, false)

RUNTIME_SOURCE_FILE :: #file

// js_override_dir returns the compile-time `pkg/runtime` directory when this is a
// LAVA_JS_OVERRIDE build and `bin/.lava.js-override` exists (written by
// scripts/build.sh when only `pkg/runtime/js/**/*.js` changed since `bin/lava` was
// linked). The analogue of Node's `--node-builtin-modules-path`: a JS-only mutation
// takes effect from disk without relinking `bin/lava` once per mutation.
// It costs one `os.exists` per context init, and only in override builds.
js_override_dir :: proc() -> string {
	when !LAVA_JS_OVERRIDE {
		return ""
	} else {
		file := RUNTIME_SOURCE_FILE
		last_sep := -1
		for i := len(file) - 1; i >= 0; i -= 1 {
			if file[i] == '/' || file[i] == '\\' {
				last_sep = i
				break
			}
		}

		if last_sep < 0 {
			return ""
		}

		runtime_dir := file[:last_sep]
		marker, err := strings.concatenate({runtime_dir, "/../../bin/.lava.js-override"}, context.temp_allocator)

		if err != nil || !os.exists(marker) {
			return ""
		}

		return runtime_dir
	}
}

eval_internal_source :: proc(
	ctx: jsc.JSContextRef,
	name: string,
	override_dir: string,
	rel_path: string,
	embedded: string,
) -> jsc.JSValueRef {
	if len(override_dir) > 0 && len(rel_path) > 0 {
		full_path, err := strings.concatenate({override_dir, "/", rel_path}, context.temp_allocator)

		if err == nil {
			if data, read_err := os.read_entire_file(full_path, context.temp_allocator); read_err == os.ERROR_NONE {
				return eval_internal(ctx, name, string(data))
			}
		}
	}

	// The embedded text, on a pooled VM: through the VM's script of it, made once per
	// VM rather than a new source string per page (vm_script; jsc.script_create says
	// what that saves).
	if state := get_state_from_ctx(ctx); state != nil && state.vm != nil {
		if script := vm_script(state.vm, name, embedded); script != nil {
			exception: jsc.JSValueRef
			value := jsc.script_evaluate(ctx, script, &exception)

			if exception != nil {
				report_internal_exception(ctx, name, exception)
				return nil
			}

			return value
		}
	}

	return eval_internal(ctx, name, embedded)
}

// eval_internal runs a trusted, lava-provided JS snippet (a prelude) and returns
// its value. Any exception is reported to stderr rather than surfaced to user
// code; nil is returned in that case.
eval_internal :: proc(ctx: jsc.JSContextRef, name: string, source: string) -> jsc.JSValueRef {
	c_source, source_err := strings.clone_to_cstring(source, context.temp_allocator)

	if source_err != nil {
		return nil
	}

	js_source := jsc.JSStringCreateWithUTF8CString(c_source)
	defer jsc.JSStringRelease(js_source)

	c_name, name_err := strings.clone_to_cstring(name, context.temp_allocator)

	if name_err != nil {
		return nil
	}

	js_name := jsc.JSStringCreateWithUTF8CString(c_name)
	defer jsc.JSStringRelease(js_name)

	exception: jsc.JSValueRef
	value := jsc.JSEvaluateScript(ctx, js_source, nil, js_name, 1, &exception)

	if exception != nil {
		report_internal_exception(ctx, name, exception)
		return nil
	}

	return value
}

// report_internal_exception writes a failed install step to stderr — unless the
// context's holder has been ended by a limit or a stop, whose watchdog termination is
// what failed it. That page's Result already names the kill, so a line here would
// report a runtime defect that is not there. It did, for a page killed by a 20 ms
// budget on a cold VM, whose install
// takes ~31 ms of thread CPU (-o:none, first page on a fresh thread; ~8-10 ms warm; two
// runs of 4 pages each): every module the cut terminated, then "failed to initialize
// internal:loader: TypeError: undefined is not an object (evaluating
// 'req('internal/crypto/random').randomUUID')", the loader reading the undefined that
// builtin_compile_cb answers for a module whose evaluation failed. In a runner that
// lands on the process's stderr among every other page's output.
//
// The rest of such an install still runs, each step cut at the kill's 1 ms watchdog
// floor. Returning from install_globals at the kill was tried and reverted: those later
// entries are what consume a termination JSC still holds when one landed inside a nested
// evaluation (builtin_compile_cb's) and was answered there. Without them the next page
// in the VM had its console prelude terminated by it, with no limit of its own hit — 11
// of 120 killed-then-clean page pairs on one warm VM, against 0 of 120 with them.
report_internal_exception :: proc(ctx: jsc.JSContextRef, name: string, exception: jsc.JSValueRef) {
	if holder_ended(ctx) {
		return
	}

	msg, allocated := jsc_value_to_string_or_default(ctx, exception)
	process_write(os.stderr, "lava: failed to initialize ", name, ": ", msg, "\n")

	if allocated {
		delete(msg, context.allocator)
	}
}

// --- helpers ---

set_named :: proc(ctx: jsc.JSContextRef, object: jsc.JSObjectRef, name: string, value: jsc.JSValueRef) {
	c_name, err := strings.clone_to_cstring(name, context.temp_allocator)

	if err != nil {
		return
	}

	js_name := jsc.JSStringCreateWithUTF8CString(c_name)
	defer jsc.JSStringRelease(js_name)
	jsc.JSObjectSetProperty(ctx, object, js_name, value, {}, nil)
}

// Builds the array by setting each element as it is created. Parking freshly-made
// JSValueRefs in a temp_allocator slice and passing them to JSObjectMakeArray in one shot
// is a use-after-free: that slice is in Odin heap memory, which JSC's conservative GC does
// NOT scan (only the machine stack + registers), so the elements are unrooted GC cells and
// a collection mid-build frees them. Setting into the array immediately keeps each rooted.
// The node:http server's parseRequest (http.odin, since deleted) crashed on exactly this pattern.
build_string_array :: proc(ctx: jsc.JSContextRef, items: []string) -> jsc.JSObjectRef {
	arr := jsc.JSObjectMakeArray(ctx, 0, nil, nil)
	for item, i in items {
		jsc.JSObjectSetPropertyAtIndex(ctx, arr, c.uint(i), js_string_value(ctx, item), nil)
	}
	return arr
}

// CONSOLE_PRELUDE evaluates to a factory function which, given the two native
// write primitives (stdout, stderr), builds the Node `console` object and
// installs it on globalThis. Implemented in JS (like Node) so util.format
// substitution, value inspection, grouping and table rendering stay simple. The
// primitives arrive as arguments, so they are never visible on globalThis.
CONSOLE_PRELUDE :: #load("js/bootstrap/console.js", string)

// queueMicrotask and the callback dispatcher (factory `(globalThis, reportUncaught,
// nativeShape) => {}`); see install_microtasks.
MICROTASK_PRELUDE :: #load("js/bootstrap/microtasks.js", string)

// The module loader: evaluates to `(compile, natives) => handle`. A bootstrap
// file, not a module — it is what makes the modules below requireable.
BOOTSTRAP_LOADER :: #load("js/bootstrap/loader.js", string)

// Embedded_JS_Dir is one directory of built-in modules, embedded whole. Each file
// evaluates to a factory `(require, module, exports, native) => exports?`; its id
// is `<prefix>/<basename without .js>`, which is also the path under js/.
Embedded_JS_Dir :: struct {
	prefix: string,
	files:  []runtime.Load_Directory_File,
}

// EMBEDDED_JS_DIRS lists DIRECTORIES, never files: a module enters the binary by
// existing under one of these, so there is no hand-kept file table to drift from the
// tree (scripts/check-js-graph.mjs fails when a directory holding .js is missing
// here). One entry per directory because #load_directory is not recursive — it
// returns basenames and skips subdirectories, which is why `internal/fetch/body` needs
// the `internal/fetch` row. It loads every file, so the loop filters on `.js`.
//
// A package-level VARIABLE, not a `::` constant: `#load_directory` compiles only in
// a package-level `:=` declaration (odin 2026-11a rejects the constant and the
// proc-local forms). Nothing writes to it after init.
EMBEDDED_JS_DIRS := [?]Embedded_JS_Dir {
	{"internal", #load_directory("js/internal")},
	{"internal/crypto", #load_directory("js/internal/crypto")},
	{"internal/fetch", #load_directory("js/internal/fetch")},
	{"internal/webstreams", #load_directory("js/internal/webstreams")},
}
