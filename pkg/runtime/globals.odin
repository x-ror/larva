package lava_runtime

import "base:runtime"
import "core:c"
import "core:os"
import "core:strings"
import "core:sync"
import "core:time"
import jsc "lava:pkg/jsc"
import eventloop "lava:pkg/runtime/eventloop"

// Runtime_State holds per-context state. A pointer to it lives in the global
// object's private data slot (see make_global_class) instead of being exposed
// to JavaScript, so user code can neither read nor corrupt the loop pointer.
Runtime_State :: struct {
	loop:              ^eventloop.Loop,
	// Allocator that owns the module_cache key strings. Captured from the caller's
	// context at state creation and used EXPLICITLY when cloning/freeing keys, because
	// keys are cloned inside `proc "c"` require callbacks (where context is reset to
	// runtime.default_context — the heap allocator) but freed later in
	// destroy_runtime_state under the caller's context. Without an explicit allocator
	// those two contexts can differ (e.g. an embedder/test using a custom or tracking
	// allocator), causing a bad free. The map itself carries its own bound allocator.
	allocator:         runtime.Allocator,
	// resolved path / specifier -> Cached_Module. The entry carries its own owned key
	// clone so module_cache_remove frees the key in O(1) (no scan to recover it).
	module_cache:      map[string]Cached_Module,
	builtin_require:   jsc.JSValueRef, // JS resolver for internal modules (events/util/assert/buffer); GC-protected
	esm_transform:     jsc.JSValueRef, // js/internal/esm.js transform(source,url,filename,dirname); GC-protected
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
	// process.nextTick scheduling shim (js/internal/microtasks.js). JSC auto-drains
	// its promise-job queue at every C boundary, so to keep nextTick callbacks
	// ahead of those jobs (Node semantics) native must bracket the boundary itself:
	// dispatch_fn runs an event-loop callback and drains nextTicks before returning,
	// next_tick_drain re-drains after JSC's auto-drain. Both GC-protected; driven by
	// invoke_user_callback.
	dispatch_fn:       jsc.JSValueRef,
	next_tick_drain:   jsc.JSValueRef,
	// Settled fetch requests awaiting free. Their teardown is deferred to here
	// because the io_uring watcher may reference a request once more after it is
	// stopped; freeing only at destroy keeps that memory valid (see fetch.odin).
	pending_free:      [dynamic]^Fetch_Request,
	// Fetches currently owned by this runtime context. Used during abnormal eval
	// teardown to stop requests and join any DNS worker before the loop/context die.
	active_fetches:    [dynamic]^Fetch_Request,
	// node:dns lookups run off-loop on the loop's shared worker pool (see dns.odin);
	// the pool's own `outstanding` list is the in-flight tracking, and pool_shutdown
	// joins + disposes at teardown, so no separate active_dns bag is needed here.
	// node:sqlite handle registries: opaque id -> ^sqlite.Database / ^sqlite.Statement
	// (kept as rawptr so this struct need not import pkg/std/sqlite). See sqlite.odin.
	sqlite_dbs:        map[u64]rawptr,
	sqlite_stmts:      map[u64]rawptr,
	next_sqlite_id:    u64,
	// node:net registries (see net.odin): integer id -> live ^Net_Server / ^Net_Connection.
	// Each is a watched fd, so the loop stays alive while a server listens or a connection
	// is open; net_shutdown_active tears them down before the loop/context die.
	net_servers:       map[u64]^Net_Server,
	net_conns:         map[u64]^Net_Connection,
	// node:https per-listener TLS contexts (tls_server.odin): id -> ^SSL_CTX (rawptr so this
	// cross-platform struct need not name the OpenSSL binding). createSecureContext builds one and
	// parks it here; net.listen consumes it (ownership moves to the Net_Server); any left unconsumed
	// (createServer without listen) are freed at teardown. Keyed off next_net_id. Linux-only in
	// practice; the map is inert on platforms without node:net.
	tls_server_ctxs:   map[u64]rawptr,
	// Intrusive FIFO of ProactorRing conns parked on -ENOBUFS (Slice 2a). head/tail + the conn's
	// starved_next/prev give O(1) enqueue/dequeue/remove (a [dynamic] with ordered_remove was O(K)
	// per op → O(K^2) to drain/close K parked conns at 10k-conn scale, precisely during overload).
	net_starved_head:  ^Net_Connection,
	net_starved_tail:  ^Net_Connection,
	net_recv_credits:  int, // buffers recycled with no parked taker — consumed by a later park (Slice 2a)
	next_net_id:       u64,
	// Graceful shutdown (Slice 3a): set when the loop's drain hook has closed the listeners and is
	// letting in-flight connections finish. drain_timer is the bounded-drain deadline that force-exits
	// if connections don't close in time (0 == none armed).
	draining:          bool,
	drain_timer:       eventloop.Timer_ID,
	// Node-style process.argv: [execPath, scriptPath, ...userArgs]. Built in eval()
	// and read by install_process. Empty for embedders that don't set it (then
	// install_process falls back to os.args).
	script_argv:       []string,
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
	// free them. Captured at creation from the owning Runtime_State (see
	// timer_binding_allocator), not re-read at free: js_callback_dispose can run at
	// loop teardown, after destroy_runtime_state has freed the state.
	allocator: runtime.Allocator,
}

when ODIN_OS == .Darwin {
	PROCESS_PLATFORM :: "darwin"
} else when ODIN_OS == .Linux {
	PROCESS_PLATFORM :: "linux"
} else when ODIN_OS == .Windows {
	PROCESS_PLATFORM :: "win32"
} else {
	PROCESS_PLATFORM :: "unknown"
}

when ODIN_ARCH == .amd64 {
	PROCESS_ARCH :: "x64"
} else when ODIN_ARCH == .arm64 {
	PROCESS_ARCH :: "arm64"
} else when ODIN_ARCH == .i386 {
	PROCESS_ARCH :: "ia32"
} else {
	PROCESS_ARCH :: "unknown"
}

// --- Runtime state lifecycle ---

new_runtime_state :: proc(loop: ^eventloop.Loop) -> ^Runtime_State {
	state := new(Runtime_State)
	state.loop = loop
	// Capture the owning allocator for module_cache keys (see the field comment).
	state.allocator = context.allocator
	// Bind the map backing to the same allocator explicitly (not implicitly via the
	// current context), so keys and backing provably share one allocator.
	state.module_cache = make(map[string]Cached_Module, 0, state.allocator)
	state.error_intrinsics = make(map[string]jsc.JSValueRef)
	state.active_fetches = make([dynamic]^Fetch_Request)
	state.sqlite_dbs = make(map[u64]rawptr)
	state.sqlite_stmts = make(map[u64]rawptr)
	state.next_sqlite_id = 1
	state.net_servers = make(map[u64]^Net_Server)
	state.net_conns = make(map[u64]^Net_Connection)
	state.tls_server_ctxs = make(map[u64]rawptr)
	state.next_net_id = 1
	return state
}

destroy_runtime_state :: proc(ctx: jsc.JSContextRef, state: ^Runtime_State) {
	if state == nil do return
	fetch_shutdown_active(state)
	fetch_destroy_pending(state)
	net_destroy_state(state)
	sqlite_destroy_state(state)
	for _, entry in state.module_cache {
		unprotect_before_eval_exit(ctx, entry.value)
		delete(entry.key, state.allocator)
	}
	delete(state.module_cache)
	// Same lifetime rule as the module cache above, for the thread-local host-call
	// registry: its entries are keyed by the context POINTER, which JSC reuses for a
	// later context, so they must go while this context is still the owner.
	host_natives_release_context(ctx, state.allocator)
	for _, ctor in state.error_intrinsics {
		unprotect_before_eval_exit(ctx, ctor)
	}
	delete(state.error_intrinsics)
	unprotect_before_eval_exit(ctx, state.builtin_require)
	unprotect_before_eval_exit(ctx, state.esm_transform)
	unprotect_before_eval_exit(ctx, state.rejection_handler)
	unprotect_before_eval_exit(ctx, state.dispatch_fn)
	unprotect_before_eval_exit(ctx, state.next_tick_drain)
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
	if value == nil do return
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
	if state == nil do return nil
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

// --- Module cache ---

// Cached_Module is one module_cache entry. It stores the owned key clone next to the
// value so module_cache_remove can free the key directly (look the entry up, free
// entry.key) in O(1), instead of scanning the whole map to recover the stored string.
Cached_Module :: struct {
	value: jsc.JSValueRef, // module.exports; GC-protected while cached
	key:   string, // the owned clone used as this entry's map key; freed on remove/teardown
}

module_cache_get :: proc(state: ^Runtime_State, key: string) -> (jsc.JSValueRef, bool) {
	if state == nil do return nil, false
	entry, ok := state.module_cache[key]
	return entry.value, ok
}

// module_cache_insert_new adds an entry for a key not already present: clone the
// key through the state allocator, protect the value, store — rolling back both
// if the map grow fails.
//
// CHECKED, unlike most `m[k] = v` in this package, because this entry owns two
// resources rather than none: the cloned key and a GC root. A discarded insert
// error leaks the clone and pins `value` for the life of the VM with nothing left
// that knows to release it — teardown unprotects by walking this very map. That
// payload, not the shape, is why these two call sites are worth the helper while
// the ordinary bare inserts elsewhere in this package are left alone.
//
// map_insert returns the stored value's pointer, nil exactly when the grow
// allocation failed (base/runtime/dynamic_map_internal.odin). Same signal the
// host-native registry uses.
@(private = "file")
module_cache_insert_new :: proc(
	ctx: jsc.JSContextRef,
	state: ^Runtime_State,
	key: string,
	value: jsc.JSValueRef,
) {
	cloned, err := strings.clone(key, state.allocator)
	if err != nil do return
	jsc.JSValueProtect(ctx, value)
	if map_insert(&state.module_cache, cloned, Cached_Module{value = value, key = cloned}) == nil {
		jsc.JSValueUnprotect(ctx, value)
		delete(cloned, state.allocator)
	}
}

module_cache_put :: proc(
	ctx: jsc.JSContextRef,
	state: ^Runtime_State,
	key: string,
	value: jsc.JSValueRef,
) {
	if state == nil do return
	if _, ok := state.module_cache[key]; ok do return
	module_cache_insert_new(ctx, state, key, value)
}

// module_cache_set inserts or replaces the cached exports for `key`. The
// CommonJS loader uses it to pre-register an in-progress module before
// evaluating its body (so a re-entrant/circular require returns the partial
// exports) and again afterwards to store the final exports (the body may have
// reassigned module.exports). Replacing re-points GC protection to the new value.
module_cache_set :: proc(
	ctx: jsc.JSContextRef,
	state: ^Runtime_State,
	key: string,
	value: jsc.JSValueRef,
) {
	if state == nil do return
	if entry, ok := state.module_cache[key]; ok {
		if entry.value == value do return
		jsc.JSValueProtect(ctx, value) // protect new before unprotecting old
		jsc.JSValueUnprotect(ctx, entry.value)
		entry.value = value // keep entry.key (the existing owned key string)
		// Unchecked on purpose, and it is the one insert shape that cannot fail: the
		// key is already present (we just read it), so this overwrites a slot instead
		// of growing the map.
		state.module_cache[key] = entry
		return
	}
	module_cache_insert_new(ctx, state, key, value)
}

// module_cache_remove drops a cached entry, unprotecting its value and freeing
// the owned key string. Used when a module throws while loading so a failed
// module is not left cached as partial exports (matching Node, which re-loads).
module_cache_remove :: proc(ctx: jsc.JSContextRef, state: ^Runtime_State, key: string) {
	if state == nil do return
	entry, ok := state.module_cache[key]
	if !ok do return
	jsc.JSValueUnprotect(ctx, entry.value)
	// entry.key is the clone we own and used as the map key (Odin maps do not free
	// string-key backing memory). Free it after dropping the entry — O(1), no scan.
	delete_key(&state.module_cache, key)
	delete(entry.key, state.allocator)
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
	if n <= 0 do return nil
	args, err := make([]jsc.JSValueRef, n, allocator)
	if err != nil do return nil
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

// timer_binding_allocator picks the allocator a new JS_Callback (and its args slice)
// is made with: the owning Runtime_State's, the same capture dns.odin uses for its
// requests (CLAUDE.md §4). The binding is made inside a `proc "c"` native, where the
// ambient allocator is runtime.default_context()'s heap, and freed by the loop under
// whatever context the embedder runs it with — so neither side may trust the ambient
// allocator, and the binding carries its own. Using the state's rather than a
// hard-coded heap keeps bindings visible to the embedder's allocator, so a leaked
// binding shows up in a tracking test instead of vanishing into malloc.
// Pinned by cmd/lava/timer_binding_alloc_test.odin.
timer_binding_allocator :: proc(ctx: jsc.JSContextRef) -> runtime.Allocator {
	if state := get_state_from_ctx(ctx); state != nil do return state.allocator
	return context.allocator
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
	if cb == nil do return

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
	if cb == nil do return
	free_js_callback(cb)
}

report_uncaught :: proc(ctx: jsc.JSContextRef, exception: jsc.JSValueRef) {
	msg, allocated := jsc_value_to_string_or_default(ctx, exception)
	defer if allocated do delete(msg, context.allocator)
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
	if argument_count >= 2 do reason = arguments[1]
	msg, allocated := jsc_value_to_string_or_default(ctx, reason)
	defer if allocated do delete(msg, context.allocator)
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
	if handler == nil do return
	jsc.JSValueProtect(ctx, cast(jsc.JSValueRef)handler)
	if state := get_state_from_ctx(ctx); state != nil {
		state.rejection_handler = cast(jsc.JSValueRef)handler
	}
	jsc.JSGlobalContextSetUnhandledRejectionCallback(cast(jsc.JSGlobalContextRef)ctx, handler, nil)
}

// get_named reads object[name], returning nil on allocation failure. Mirror of
// set_named; used to read process.exitCode when resolving the exit code.
get_named :: proc(ctx: jsc.JSContextRef, object: jsc.JSObjectRef, name: string) -> jsc.JSValueRef {
	c_name, err := strings.clone_to_cstring(name, context.temp_allocator)
	if err != nil do return nil
	js_name := jsc.JSStringCreateWithUTF8CString(c_name)
	defer jsc.JSStringRelease(js_name)
	return jsc.JSObjectGetProperty(ctx, object, js_name, nil)
}

// callback_arg returns the argument as a callable function object, or nil.
callback_arg :: proc(ctx: jsc.JSContextRef, value: jsc.JSValueRef) -> jsc.JSObjectRef {
	if !jsc.JSValueIsObject(ctx, value) do return nil
	obj := cast(jsc.JSObjectRef)value
	if !jsc.JSObjectIsFunction(ctx, obj) do return nil
	return obj
}

// make_js_error / make_js_named_error and the Node ERR_* helpers live in
// errors.odin (the single source of truth for native error construction).

// --- Timer / scheduling callbacks ---

// TIMER_MAX_MS is Node's TIMEOUT_MAX (2^31 - 1): the largest setTimeout/setInterval
// delay. A delay outside [1, TIMER_MAX_MS] (including NaN/Infinity) clamps to 1ms.
TIMER_MAX_MS :: 2147483647.0
// MAX_SAFE_HANDLE_ID bounds a numeric timer/immediate id for the u64() conversion in
// clear*: ids grow unbounded but stay exactly representable as f64 below 2^53.
MAX_SAFE_HANDLE_ID :: 9007199254740992.0

// clamp_timer_delay applies Node's [1, 2^31-1] ms clamp to a raw setTimeout/
// setInterval delay and returns the u64 the event loop expects. Anything < 1
// (including NaN) or > TIMER_MAX_MS becomes 1 — which also covers two guards:
// flooring at 1 stops a 0ms timer from busy-spinning the loop and starving pending
// I/O (and freezing the virtual clock), and the bounded value makes the u64()
// conversion safe (float→int on NaN/Infinity/out-of-range is undefined in Odin).
clamp_timer_delay :: proc(delay: f64) -> u64 {
	if !(delay >= 1 && delay <= TIMER_MAX_MS) do return 1
	return u64(delay)
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
	loop := get_loop_from_ctx(ctx)
	if loop == nil || argument_count < 1 do return jsc.JSValueMakeUndefined(ctx)

	fn := callback_arg(ctx, arguments[0])
	if fn == nil do return jsc.JSValueMakeUndefined(ctx)

	delay := 0.0
	if argument_count >= 2 do delay = jsc.JSValueToNumber(ctx, arguments[1], nil)

	// Trailing args (setTimeout(fn, delay, ...args)) are forwarded on fire.
	alloc := timer_binding_allocator(ctx)
	cb := make_js_callback(ctx, fn, false, capture_timer_args(ctx, argument_count, arguments, 2, alloc), alloc)
	id := eventloop.set_timeout(
		loop,
		js_callback_trampoline,
		clamp_timer_delay(delay),
		cb,
		js_callback_dispose,
	)
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
	loop := get_loop_from_ctx(ctx)
	if loop == nil || argument_count < 1 do return jsc.JSValueMakeUndefined(ctx)

	fn := callback_arg(ctx, arguments[0])
	if fn == nil do return jsc.JSValueMakeUndefined(ctx)

	interval := 0.0
	if argument_count >= 2 do interval = jsc.JSValueToNumber(ctx, arguments[1], nil)

	// Trailing args (setInterval(fn, delay, ...args)) are forwarded on every fire.
	alloc := timer_binding_allocator(ctx)
	cb := make_js_callback(ctx, fn, true, capture_timer_args(ctx, argument_count, arguments, 2, alloc), alloc)
	id := eventloop.set_interval(
		loop,
		js_callback_trampoline,
		clamp_timer_delay(interval),
		cb,
		js_callback_dispose,
	)
	return jsc.JSValueMakeNumber(ctx, f64(id))
}

set_immediate_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	loop := get_loop_from_ctx(ctx)
	if loop == nil || argument_count < 1 do return jsc.JSValueMakeUndefined(ctx)

	fn := callback_arg(ctx, arguments[0])
	if fn == nil do return jsc.JSValueMakeUndefined(ctx)

	// Trailing args (setImmediate(fn, ...args)) are forwarded on fire.
	alloc := timer_binding_allocator(ctx)
	cb := make_js_callback(ctx, fn, false, capture_timer_args(ctx, argument_count, arguments, 1, alloc), alloc)
	id := eventloop.set_immediate(loop, js_callback_trampoline, cb, js_callback_dispose)
	return jsc.JSValueMakeNumber(ctx, f64(id))
}

clear_timer_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	loop := get_loop_from_ctx(ctx)
	if loop == nil || argument_count < 1 do return jsc.JSValueMakeUndefined(ctx)

	// clearTimeout/clearInterval(NaN) (and any non-finite/negative id) is a no-op in
	// Node — no handle can carry that id. Guard before u64(): float→int on NaN or an
	// out-of-range value is undefined in Odin and could match an unrelated live id.
	// Handle ids start at 1 and grow unbounded, but stay f64-exact below 2^53, so the
	// upper bound is the exact-integer limit, not the timer-delay clamp.
	n := jsc.JSValueToNumber(ctx, arguments[0], nil)
	if !(n >= 1 && n <= MAX_SAFE_HANDLE_ID) do return jsc.JSValueMakeUndefined(ctx)
	eventloop.clear_timeout(loop, u64(n))
	return jsc.JSValueMakeUndefined(ctx)
}

// process.nextTick and queueMicrotask are installed from JS (MICROTASK_PRELUDE)
// rather than as native callbacks: their Node-matching ordering relative to
// JSC's promise-job queue is expressed most naturally in JS. See
// install_microtasks and js/internal/microtasks.js.

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
//   delivers 300001 bytes where Lava delivered 65536 (node 24.18.1, parent-set O_NONBLOCK
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
			if n == 0 do return written, .Unexpected_EOF
			continue
		}
		if !stdio_retryable(werr) do return written, werr
		// A retryable error with no progress means the fd is full (or a signal landed).
		// Wait for it to become writable instead of spinning; on the platforms where
		// this cannot be expressed the wait is a no-op and the loop simply retries.
		if n == 0 do stdio_wait_writable(fd)
	}
	return written, nil
}


// process_write_bytes is process_write for an already-resolved byte slice, so a caller
// holding Buffer bytes does not have to launder them through a string. Same mutex, same
// retry loop — which is what keeps process.stdout.write and console.log from interleaving
// mid-line under workers.
process_write_bytes :: proc(fd: ^os.File, data: []byte) {
	if len(data) == 0 do return
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
		if len(p) == 0 do continue
		process_write_all(fd, transmute([]byte)p)
	}
}

console_raw_write :: proc(
	fd: ^os.File,
	ctx: jsc.JSContextRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
) {
	if argument_count < 1 do return
	text, allocated := jsc_value_to_string_or_default(ctx, arguments[0])
	process_write(fd, text)
	if allocated do delete(text, context.allocator)
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

// --- process ---

process_exit_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	// process.exit([code]): with no argument (or explicit undefined) the default is
	// process.exitCode (Node parity). An explicit numeric code overrides it; a NaN
	// code is a RangeError (ERR_OUT_OF_RANGE) in Node, not a silent garbage exit.
	code := process_exit_code(ctx)
	// JSValueGetType reads the value's type directly; JSValueIsUndefined is equally
	// ABI-safe now that it returns a 1-byte `bool` (see cmd/lava jsc_value_predicates,
	// #159 — the retired `b32` return was the old hazard).
	if argument_count >= 1 && jsc.JSValueGetType(ctx, arguments[0]) != .Undefined {
		n := jsc.JSValueToNumber(ctx, arguments[0], nil)
		if n != n {
			if exception != nil {
				exception^ = err_out_of_range(ctx, "code", "an integer", "NaN")
			}
			return jsc.JSValueMakeUndefined(ctx)
		}
		code = int(n)
	}
	os.exit(code)
}

process_cwd_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	dir, err := os.get_working_directory(context.temp_allocator)
	if err != os.ERROR_NONE do return js_string_value(ctx, ".")
	return js_string_value(ctx, dir)
}

process_memory_usage_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	obj := jsc.JSObjectMake(ctx, nil, nil)
	rss := f64(os_process_rss_bytes())
	set_named(ctx, obj, "rss", jsc.JSValueMakeNumber(ctx, rss))
	set_named(ctx, obj, "heapTotal", jsc.JSValueMakeNumber(ctx, 0))
	set_named(ctx, obj, "heapUsed", jsc.JSValueMakeNumber(ctx, 0))
	set_named(ctx, obj, "external", jsc.JSValueMakeNumber(ctx, 0))
	set_named(ctx, obj, "arrayBuffers", jsc.JSValueMakeNumber(ctx, 0))
	return cast(jsc.JSValueRef)obj
}

// --- installation ---

// install_globals wires the Node-like global surface (console, process,
// timers, queueMicrotask, globalThis) onto the context's global object.
// Timer functions are no-ops when no event loop is bound.
install_globals :: proc(ctx: jsc.JSContextRef, loop: ^eventloop.Loop) {
	global := jsc.JSContextGetGlobalObject(ctx)

	set_named(ctx, global, "globalThis", cast(jsc.JSValueRef)global)
	set_named(ctx, global, "global", cast(jsc.JSValueRef)global)

	// Explicit arity: these are the only natives whose `.length` reaches user code,
	// so Node is the oracle for it — setTimeout(callback, delay) and
	// setInterval(callback, delay) report 2, the rest 1. They all reported 1 before
	// (inject_native_function's default), which was a silent parity gap on the
	// working path, not just on the fallback. Pinned by
	// tests/node-compat/cases/56-native-function-arity.js.
	inject_native_function(ctx, global, "setTimeout", set_timeout_cb, arity = 2)
	inject_native_function(ctx, global, "setInterval", set_interval_cb, arity = 2)
	inject_native_function(ctx, global, "setImmediate", set_immediate_cb)
	inject_native_function(ctx, global, "clearTimeout", clear_timer_cb)
	inject_native_function(ctx, global, "clearInterval", clear_timer_cb)
	inject_native_function(ctx, global, "clearImmediate", clear_timer_cb)

	install_console(ctx, global)
	// process must exist before install_internal_modules so the loader can put the
	// intrinsic into natives['process'] for the node:process factory. Console is
	// already on the global (just above). Both factories export that captured
	// reference — never a lazy global read — so a pre-first-require reassignment of
	// globalThis.process / globalThis.console cannot poison the builtin (#247).
	install_process(ctx, global)
	install_internal_modules(ctx, global)

	install_performance(ctx, global)
	// process.nextTick + queueMicrotask are a JS shim (needs `process` to exist).
	install_microtasks(ctx, global)
	// process.stdout / process.stderr LAST of the process bits: the loader hands out a
	// closure rather than eager-requiring stdio, because stdio builds on `stream`, which
	// needs both the `process` global and `process.nextTick` to already be there.
	install_stdio(ctx, global)
	install_rejection_tracker(ctx)
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
// N workers (Slice 3a) racing their first install_performance neither double-init nor tear the
// values; a single shared origin is intentional — performance.now() stays comparable across workers.
@(private = "file")
perf_init :: proc() {
	perf_origin_tick = time.tick_now()
	perf_time_origin_ms = f64(time.to_unix_nanoseconds(time.now())) / 1e6
}

// install_performance installs the `performance` global with a monotonic now()
// and a timeOrigin, matching the W3C High Resolution Time surface Node exposes.
install_performance :: proc(ctx: jsc.JSContextRef, global: jsc.JSObjectRef) {
	sync.once_do(&perf_once, perf_init)

	performance := jsc.JSObjectMake(ctx, nil, nil)
	inject_native_function(ctx, performance, "now", performance_now_cb)
	set_named(ctx, performance, "timeOrigin", jsc.JSValueMakeNumber(ctx, perf_time_origin_ms))
	set_named(ctx, global, "performance", cast(jsc.JSValueRef)performance)
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

// install_microtasks evaluates MICROTASK_PRELUDE to a factory and calls it with
// (globalThis, process) so it can install process.nextTick and queueMicrotask
// with Node-matching ordering. See js/internal/microtasks.js for why these live
// in JS on top of JSC's promise-job queue rather than the native event loop.
install_microtasks :: proc(ctx: jsc.JSContextRef, global: jsc.JSObjectRef) {
	process := get_named(ctx, global, "process")
	if process == nil || !jsc.JSValueIsObject(ctx, process) do return

	factory := eval_internal(ctx, "lava:microtasks", MICROTASK_PRELUDE)
	if factory == nil || !jsc.JSValueIsObject(ctx, factory) do return

	// A throw from a nextTick/queueMicrotask callback is an uncaught exception
	// (not an unhandled rejection); the shim routes it here, the same path the
	// timer trampoline uses for async callbacks.
	report := make_native_function(ctx, "__lava_report_uncaught", microtask_report_uncaught_cb)
	if report == nil do return

	args := [3]jsc.JSValueRef{cast(jsc.JSValueRef)global, process, cast(jsc.JSValueRef)report}
	exception: jsc.JSValueRef
	exports := jsc.JSObjectCallAsFunction(
		ctx,
		cast(jsc.JSObjectRef)factory,
		nil,
		3,
		raw_data(args[:]),
		&exception,
	)
	if exception != nil {
		report_internal_exception(ctx, "lava:microtasks", exception)
		return
	}

	// The factory returns { drainNextTicks, dispatch }. Stash both (GC-protected)
	// on Runtime_State; invoke_user_callback drives them so process.nextTick keeps
	// its priority over promise jobs across JSC's auto-draining promise queue (the
	// "why" is in js/internal/microtasks.js).
	if exports == nil || !jsc.JSValueIsObject(ctx, exports) do return
	state := get_state_from_ctx(ctx)
	if state == nil do return

	dispatch := get_named(ctx, cast(jsc.JSObjectRef)exports, "dispatch")
	drain := get_named(ctx, cast(jsc.JSObjectRef)exports, "drainNextTicks")
	if dispatch != nil && jsc.JSValueIsObject(ctx, dispatch) {
		jsc.JSValueProtect(ctx, dispatch)
		state.dispatch_fn = dispatch
	}
	if drain != nil && jsc.JSValueIsObject(ctx, drain) {
		jsc.JSValueProtect(ctx, drain)
		state.next_tick_drain = drain
	}
}

// invoke_user_callback runs a user JS callback at an event-loop boundary (timer /
// immediate / I/O / fetch completion) with Node's process.nextTick ordering. It
// calls the callback THROUGH the microtask shim's `dispatch`, which drains the
// nextTick queue before returning — so nextTicks beat promise jobs queued earlier
// in the same turn (checkpoint 1) — then re-drains the nextTicks queued by the
// promise jobs JSC auto-drained on return (checkpoint 2). `args`/`argc` are the
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
	if state == nil || state.dispatch_fn == nil {
		return jsc.JSObjectCallAsFunction(ctx, fn, nil, argc, args, exception)
	}

	// dispatch(fn, ...args): prepend the callback so the shim invokes it and then
	// runs checkpoint 1 in its `finally`.
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
	drain_next_ticks_settled(ctx, state)
	return result
}

// drain_next_ticks_settled runs checkpoint 2: it drains the process.nextTick
// queue, looping until a drain does no work. Each drain call is a C-API boundary,
// so JSC auto-drains its promise jobs between iterations — recreating Node's
// "drain nextTicks, run microtasks, repeat" loop. A throw cannot escape (the shim
// runs nextTick callbacks guarded), but the exception arm is kept for safety.
drain_next_ticks_settled :: proc(ctx: jsc.JSContextRef, state: ^Runtime_State) {
	if state == nil || state.next_tick_drain == nil do return
	for {
		exc: jsc.JSValueRef
		result := jsc.JSObjectCallAsFunction(
			ctx,
			cast(jsc.JSObjectRef)state.next_tick_drain,
			nil,
			0,
			nil,
			&exc,
		)
		if exc != nil {
			report_uncaught(ctx, exc)
			mark_async_failed(ctx)
			return
		}
		if result == nil || !bool(jsc.JSValueToBoolean(ctx, result)) do return
	}
}

// microtask_report_uncaught_cb(error) reports a throw from a nextTick or
// queueMicrotask callback as an uncaught exception and flags the process to exit
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

// install_internal_modules evaluates the JS built-in modules (util, events,
// assert, buffer) to factory functions, hands them to the loader, and stores
// the resulting resolver on Runtime_State. native_require_cb consults that
// resolver before hitting the filesystem. The loader also eagerly instantiates
// modules that install globals (Buffer), so those exist without a require.
install_internal_modules :: proc(ctx: jsc.JSContextRef, global: jsc.JSObjectRef) {
	state := get_state_from_ctx(ctx)
	if state == nil do return

	Module :: struct {
		name:   string,
		source: string,
	}
	modules := [?]Module {
		{"primordials", INTERNAL_PRIMORDIALS},
		{"util", INTERNAL_UTIL},
		{"events", INTERNAL_EVENTS},
		{"assert", INTERNAL_ASSERT},
		{"buffer", INTERNAL_BUFFER},
		{"crypto", INTERNAL_CRYPTO},
		{"stream/web", INTERNAL_STREAMS},
		{"stream", INTERNAL_STREAM},
		{"stream/promises", INTERNAL_STREAM_PROMISES},
		{"fetch", INTERNAL_FETCH},
		{"abort", INTERNAL_ABORT},
		{"timers/promises", INTERNAL_TIMERS_PROMISES},
		{"encoding", INTERNAL_ENCODING},
		{"url", INTERNAL_URL},
		{"structured_clone", INTERNAL_STRUCTURED_CLONE},
		{"path", INTERNAL_PATH},
		{"path/posix", INTERNAL_PATH_POSIX},
		{"path/win32", INTERNAL_PATH_WIN32},
		{"sqlite", INTERNAL_SQLITE},
		{"dns", INTERNAL_DNS},
		{"dns/promises", INTERNAL_DNS_PROMISES},
		{"net", INTERNAL_NET},
		{"http", INTERNAL_HTTP},
		{"https", INTERNAL_HTTPS},
		{"os", INTERNAL_OS},
		{"querystring", INTERNAL_QUERYSTRING},
		{"string_decoder", INTERNAL_STRING_DECODER},
		{"timers", INTERNAL_TIMERS},
		{"util/types", INTERNAL_UTIL_TYPES},
		{"punycode", INTERNAL_PUNYCODE},
		{"process", INTERNAL_PROCESS},
		{"console", INTERNAL_CONSOLE},
		{"tty", INTERNAL_TTY},
		{"diagnostics_channel", INTERNAL_DIAGNOSTICS_CHANNEL},
		// Internal helpers backing util.parseArgs / util.parseEnv / util.MIMEType; hidden
		// from the public resolver (loader.js publicReq), like primordials — Node has no
		// node:parse_args or node:mime.
		{"parse_args", INTERNAL_PARSE_ARGS},
		{"parse_env", INTERNAL_PARSE_ENV},
		{"mime", INTERNAL_MIME},
		{"stdio", INTERNAL_STDIO},
		{"fs", INTERNAL_FS},
	}

	factories := jsc.JSObjectMake(ctx, nil, nil)
	for m in modules {
		factory := eval_internal(ctx, m.name, m.source)
		if factory == nil do continue
		set_named(ctx, factories, m.name, factory)
	}

	loader := eval_internal(ctx, "internal:loader", INTERNAL_LOADER)
	if loader == nil || !jsc.JSValueIsObject(ctx, loader) do return

	// Native primitives keyed by module name. The loader passes natives[key] to
	// each factory as its fourth argument, so a module receives its Odin-backed
	// bindings without anything landing on globalThis (cf. install_console).
	natives := jsc.JSObjectMake(ctx, nil, nil)
	set_named(ctx, natives, "crypto", cast(jsc.JSValueRef)make_crypto_bindings(ctx))
	// The SAME bindings object serves both `buffer` and `encoding`. encoding.js
	// used to reach the utf-8 decoder as `Buffer.prototype.toString.call(bytes,
	// 'utf8')`, which put a live `Function.prototype.call` read on the RETURN path
	// of TextDecoder.prototype.decode: replacing `.call` made decode() hand back
	// the replacement's value, so `decode()` returned a non-string. Handing
	// encoding.js the codec directly removes the read, and skips toString's length
	// getter, range clamp and encoding-name dispatch on the way.
	buffer_bindings := make_buffer_bindings(ctx)
	set_named(ctx, natives, "buffer", cast(jsc.JSValueRef)buffer_bindings)
	set_named(ctx, natives, "encoding", cast(jsc.JSValueRef)buffer_bindings)
	set_named(ctx, natives, "fetch", cast(jsc.JSValueRef)make_fetch_bindings(ctx))
	set_named(ctx, natives, "sqlite", cast(jsc.JSValueRef)make_sqlite_bindings(ctx))
	set_named(ctx, natives, "dns", cast(jsc.JSValueRef)make_dns_bindings(ctx))
	set_named(ctx, natives, "net", cast(jsc.JSValueRef)make_net_bindings(ctx))
	set_named(ctx, natives, "http", cast(jsc.JSValueRef)make_http_bindings(ctx))
	set_named(ctx, natives, "https", cast(jsc.JSValueRef)make_https_bindings(ctx))
	set_named(ctx, natives, "os", cast(jsc.JSValueRef)make_os_bindings(ctx))
	set_named(ctx, natives, "tty", cast(jsc.JSValueRef)make_tty_bindings(ctx))
	set_named(ctx, natives, "stdio", cast(jsc.JSValueRef)make_stdio_bindings(ctx))
	set_named(ctx, natives, "fs", cast(jsc.JSValueRef)make_fs_bindings(ctx))
	// Intrinsic process/console objects. Captured here (context init, before user
	// code) and handed to the factories so require('node:process') /
	// require('node:console') never re-read the globals — node returns the
	// intrinsic even when a dependency reassigned globalThis.process / console
	// before the first require (#247). install_process runs before this proc.
	if process_val := get_named(ctx, global, "process"); process_val != nil {
		set_named(ctx, natives, "process", process_val)
	}
	if console_val := get_named(ctx, global, "console"); console_val != nil {
		set_named(ctx, natives, "console", console_val)
	}

	args := [2]jsc.JSValueRef{cast(jsc.JSValueRef)factories, cast(jsc.JSValueRef)natives}
	exception: jsc.JSValueRef
	resolver := jsc.JSObjectCallAsFunction(
		ctx,
		cast(jsc.JSObjectRef)loader,
		nil,
		2,
		raw_data(args[:]),
		&exception,
	)
	if exception != nil {
		report_internal_exception(ctx, "internal:loader", exception)
		return
	}
	if resolver == nil || !jsc.JSValueIsObject(ctx, resolver) do return

	jsc.JSValueProtect(ctx, resolver)
	state.builtin_require = resolver

	// The ESM source transform (js/internal/esm.js) evaluates to a FACTORY —
	// `factory(primordials) -> transform(source, url, filename, dirname)`. The
	// transform is stored on the state, not registered as a requireable module, so
	// native_require_cb can rewrite `.mjs` files to CommonJS without exposing it to
	// user code.
	//
	// It takes primordials as an argument because that non-registration is exactly
	// what denies it a `require`, and its output is EXECUTED SOURCE: a live
	// `RegExp.prototype.exec` there hands an attacker the match groups the transform
	// interpolates into the emitted module body as identifiers. The table comes off
	// the loader's resolver (loader.js sets it) so there is one shared capture rather
	// than a second evaluation of primordials.
	//
	// Fail CLOSED. Without the table the transform would run on live intrinsics, so a
	// missing one leaves state.esm_transform nil and `.mjs` reports "ESM transform
	// unavailable" instead of silently transforming with the poisonable path.
	esm_factory := eval_internal(ctx, "lava:esm", INTERNAL_ESM)
	if esm_factory != nil && jsc.JSValueIsObject(ctx, esm_factory) {
		primordials := get_named(ctx, cast(jsc.JSObjectRef)resolver, "primordials")
		if primordials != nil && jsc.JSValueIsObject(ctx, primordials) {
			esm_args := [1]jsc.JSValueRef{primordials}
			esm_exception: jsc.JSValueRef
			transform := jsc.JSObjectCallAsFunction(
				ctx,
				cast(jsc.JSObjectRef)esm_factory,
				nil,
				1,
				raw_data(esm_args[:]),
				&esm_exception,
			)
			if esm_exception != nil {
				report_internal_exception(ctx, "lava:esm", esm_exception)
			} else if transform != nil && jsc.JSValueIsObject(ctx, transform) {
				jsc.JSValueProtect(ctx, transform)
				state.esm_transform = transform
			}
		}
	}
}

// require_builtin asks the JS resolver for an internal module by specifier.
// Returns nil when the resolver is absent or the module is unknown (the latter
// surfaces as `undefined`, which the caller treats as "not a builtin").
require_builtin :: proc(
	ctx: jsc.JSContextRef,
	specifier: jsc.JSValueRef,
	out_exception: ^jsc.JSValueRef = nil,
) -> jsc.JSValueRef {
	state := get_state_from_ctx(ctx)
	if state == nil || state.builtin_require == nil do return nil
	args := [1]jsc.JSValueRef{specifier}
	exception: jsc.JSValueRef
	result := jsc.JSObjectCallAsFunction(
		ctx,
		cast(jsc.JSObjectRef)state.builtin_require,
		nil,
		1,
		raw_data(args[:]),
		&exception,
	)
	// A builtin factory that threw (e.g. a lazy module failing to initialize) must
	// surface that error, not be mistaken for "not a builtin" and fall through to
	// filesystem resolution as a misleading MODULE_NOT_FOUND.
	if exception != nil {
		if out_exception != nil do out_exception^ = exception
		return nil
	}
	if result == nil || jsc.JSValueIsUndefined(ctx, result) do return nil
	return result
}

// install_stdio calls the loader's installStdio(process), which defines process.stdout
// and process.stderr as lazy configurable getters — node's own shape, and one
// JSObjectSetProperty cannot express. Silent no-op when the resolver is absent: a missing
// stdio leaves the properties undefined, which is exactly the pre-existing behavior.
install_stdio :: proc(ctx: jsc.JSContextRef, global: jsc.JSObjectRef) {
	state := get_state_from_ctx(ctx)
	if state == nil || state.builtin_require == nil do return
	installer := get_named(ctx, cast(jsc.JSObjectRef)state.builtin_require, "installStdio")
	if installer == nil || !jsc.JSValueIsObject(ctx, installer) do return
	proc_obj := get_named(ctx, global, "process")
	if proc_obj == nil || !jsc.JSValueIsObject(ctx, proc_obj) do return
	args := [1]jsc.JSValueRef{proc_obj}
	exception: jsc.JSValueRef
	jsc.JSObjectCallAsFunction(
		ctx,
		cast(jsc.JSObjectRef)installer,
		nil,
		1,
		raw_data(args[:]),
		&exception,
	)
	if exception != nil do report_internal_exception(ctx, "internal:stdio", exception)
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
	if out_fn == nil || err_fn == nil do return

	factory := eval_internal(ctx, "lava:console", CONSOLE_PRELUDE)
	if factory == nil || !jsc.JSValueIsObject(ctx, factory) do return

	args := [2]jsc.JSValueRef{cast(jsc.JSValueRef)out_fn, cast(jsc.JSValueRef)err_fn}
	exception: jsc.JSValueRef
	jsc.JSObjectCallAsFunction(
		ctx,
		cast(jsc.JSObjectRef)factory,
		nil,
		2,
		raw_data(args[:]),
		&exception,
	)
	if exception != nil do report_internal_exception(ctx, "lava:console", exception)
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
	if err != nil do return nil
	js_name := jsc.JSStringCreateWithUTF8CString(c_name)
	defer jsc.JSStringRelease(js_name)
	return jsc.JSObjectMakeFunctionWithCallback(ctx, js_name, callback)
}

// eval_internal runs a trusted, lava-provided JS snippet (a prelude) and returns
// its value. Any exception is reported to stderr rather than surfaced to user
// code; nil is returned in that case.
eval_internal :: proc(ctx: jsc.JSContextRef, name: string, source: string) -> jsc.JSValueRef {
	c_source, source_err := strings.clone_to_cstring(source, context.temp_allocator)
	if source_err != nil do return nil
	js_source := jsc.JSStringCreateWithUTF8CString(c_source)
	defer jsc.JSStringRelease(js_source)

	c_name, name_err := strings.clone_to_cstring(name, context.temp_allocator)
	if name_err != nil do return nil
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

report_internal_exception :: proc(ctx: jsc.JSContextRef, name: string, exception: jsc.JSValueRef) {
	msg, allocated := jsc_value_to_string_or_default(ctx, exception)
	process_write(os.stderr, "lava: failed to initialize ", name, ": ", msg, "\n")
	if allocated do delete(msg, context.allocator)
}

install_process :: proc(ctx: jsc.JSContextRef, global: jsc.JSObjectRef) {
	process := jsc.JSObjectMake(ctx, nil, nil)

	set_named(ctx, process, "platform", js_string_value(ctx, PROCESS_PLATFORM))
	set_named(ctx, process, "arch", js_string_value(ctx, PROCESS_ARCH))
	set_named(ctx, process, "pid", jsc.JSValueMakeNumber(ctx, f64(os.get_pid())))

	set_named(ctx, process, "version", js_string_value(ctx, process_version_string()))

	versions := jsc.JSObjectMake(ctx, nil, nil)
	set_named(ctx, versions, "node", js_string_value(ctx, NODE_BASELINE))
	set_named(ctx, process, "versions", cast(jsc.JSValueRef)versions)

	// Node's argv layout is [execPath, scriptPath, ...userArgs] (eval() builds it
	// on the state). Fall back to os.args only for embedders that never set it.
	argv := os.args
	if state := get_state_from_ctx(ctx); state != nil && len(state.script_argv) > 0 {
		argv = state.script_argv
	}
	set_named(ctx, process, "argv", cast(jsc.JSValueRef)build_string_array(ctx, argv))
	set_named(ctx, process, "env", cast(jsc.JSValueRef)build_env_object(ctx))

	inject_native_function(ctx, process, "exit", process_exit_cb)
	inject_native_function(ctx, process, "cwd", process_cwd_cb)
	inject_native_function(ctx, process, "memoryUsage", process_memory_usage_cb)

	set_named(ctx, global, "process", cast(jsc.JSValueRef)process)
}

process_version_string :: proc() -> string {
	parts := [?]string{"v", NODE_BASELINE, ".0.0"}
	result, err := strings.concatenate(parts[:], context.temp_allocator)
	if err != nil do return "v22.0.0"
	return result
}

// --- helpers ---

set_named :: proc(
	ctx: jsc.JSContextRef,
	object: jsc.JSObjectRef,
	name: string,
	value: jsc.JSValueRef,
) {
	c_name, err := strings.clone_to_cstring(name, context.temp_allocator)
	if err != nil do return
	js_name := jsc.JSStringCreateWithUTF8CString(c_name)
	defer jsc.JSStringRelease(js_name)
	jsc.JSObjectSetProperty(ctx, object, js_name, value, {}, nil)
}

// Builds the array by setting each element as it is created. Parking freshly-made
// JSValueRefs in a temp_allocator slice and passing them to JSObjectMakeArray in one shot
// is a use-after-free: that slice is in Odin heap memory, which JSC's conservative GC does
// NOT scan (only the machine stack + registers), so the elements are unrooted GC cells and
// a collection mid-build frees them. Setting into the array immediately keeps each rooted.
// See http.odin's parseRequest for the crash this pattern caused.
build_string_array :: proc(ctx: jsc.JSContextRef, items: []string) -> jsc.JSObjectRef {
	arr := jsc.JSObjectMakeArray(ctx, 0, nil, nil)
	for item, i in items {
		jsc.JSObjectSetPropertyAtIndex(ctx, arr, c.uint(i), js_string_value(ctx, item), nil)
	}
	return arr
}

// build_env_object snapshots the OS environment into a plain object. NOTE: unlike
// Node's live magic `process.env`, this is a one-shot copy — writes/deletes do not
// reach the real environment, so native code reading os.environ later (e.g. a future
// child_process) will not see them. Tracked divergence; revisit when child processes
// land.
build_env_object :: proc(ctx: jsc.JSContextRef) -> jsc.JSObjectRef {
	object := jsc.JSObjectMake(ctx, nil, nil)
	environ, err := os.environ(context.temp_allocator)
	if err != os.ERROR_NONE do return object
	for entry in environ {
		idx := strings.index_byte(entry, '=')
		if idx <= 0 do continue
		set_named(ctx, object, entry[:idx], js_string_value(ctx, entry[idx + 1:]))
	}
	return object
}

// CONSOLE_PRELUDE evaluates to a factory function which, given the two native
// write primitives (stdout, stderr), builds the Node `console` object and
// installs it on globalThis. Implemented in JS (like Node) so util.format
// substitution, value inspection, grouping and table rendering stay simple. The
// primitives arrive as arguments, so they are never visible on globalThis.
CONSOLE_PRELUDE :: #load("js/console.js", string)

// process.nextTick / queueMicrotask ordering shim (factory `(globalThis,
// process) => {}`). Installed after `process` exists; see install_microtasks.
MICROTASK_PRELUDE :: #load("js/internal/microtasks.js", string)

// Internal built-in modules, embedded at compile time. Each evaluates to a
// factory `(require, module, exports) => exports?`; the loader wires them up.
INTERNAL_LOADER :: #load("js/internal/loader.js", string)
INTERNAL_PRIMORDIALS :: #load("js/internal/primordials.js", string)
INTERNAL_UTIL :: #load("js/internal/util.js", string)
INTERNAL_EVENTS :: #load("js/internal/events.js", string)
INTERNAL_ASSERT :: #load("js/internal/assert.js", string)
INTERNAL_BUFFER :: #load("js/internal/buffer.js", string)
INTERNAL_CRYPTO :: #load("js/internal/crypto.js", string)
INTERNAL_STREAMS :: #load("js/internal/streams.js", string)
INTERNAL_STREAM :: #load("js/internal/stream.js", string)
INTERNAL_STREAM_PROMISES :: #load("js/internal/stream_promises.js", string)
INTERNAL_FETCH :: #load("js/internal/fetch.js", string)
INTERNAL_ABORT :: #load("js/internal/abort.js", string)
INTERNAL_TIMERS_PROMISES :: #load("js/internal/timers_promises.js", string)
INTERNAL_ENCODING :: #load("js/internal/encoding.js", string)
INTERNAL_URL :: #load("js/internal/url.js", string)
INTERNAL_STRUCTURED_CLONE :: #load("js/internal/structured_clone.js", string)
INTERNAL_PATH :: #load("js/internal/path.js", string)
INTERNAL_PATH_POSIX :: #load("js/internal/path_posix.js", string)
INTERNAL_PATH_WIN32 :: #load("js/internal/path_win32.js", string)
INTERNAL_SQLITE :: #load("js/internal/sqlite.js", string)
INTERNAL_DNS :: #load("js/internal/dns.js", string)
INTERNAL_DNS_PROMISES :: #load("js/internal/dns_promises.js", string)
INTERNAL_OS :: #load("js/internal/os.js", string)
INTERNAL_QUERYSTRING :: #load("js/internal/querystring.js", string)
INTERNAL_STRING_DECODER :: #load("js/internal/string_decoder.js", string)
INTERNAL_TIMERS :: #load("js/internal/timers.js", string)
INTERNAL_UTIL_TYPES :: #load("js/internal/util_types.js", string)
INTERNAL_PUNYCODE :: #load("js/internal/punycode.js", string)
INTERNAL_PROCESS :: #load("js/internal/process.js", string)
INTERNAL_CONSOLE :: #load("js/internal/console.js", string)
INTERNAL_TTY :: #load("js/internal/tty.js", string)
INTERNAL_FS :: #load("js/internal/fs.js", string)
INTERNAL_NET :: #load("js/internal/net.js", string)
INTERNAL_HTTP :: #load("js/internal/http.js", string)
INTERNAL_HTTPS :: #load("js/internal/https.js", string)
INTERNAL_DIAGNOSTICS_CHANNEL :: #load("js/internal/diagnostics_channel.js", string)
INTERNAL_PARSE_ARGS :: #load("js/internal/parse_args.js", string)
INTERNAL_PARSE_ENV :: #load("js/internal/parse_env.js", string)
INTERNAL_MIME :: #load("js/internal/mime.js", string)
INTERNAL_STDIO :: #load("js/internal/stdio.js", string)

// ESM-to-CommonJS source transform. Stored on Runtime_State rather than handed to
// the module resolver (see install_internal_modules); evaluates to a function.
INTERNAL_ESM :: #load("js/internal/esm.js", string)
