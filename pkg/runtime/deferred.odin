package lava_runtime

import "base:runtime"
import "core:c"
import jsc "lava:pkg/jsc"
import eventloop "lava:pkg/runtime/eventloop"

// The runtime half of driving JSC's RunLoop for FinalizationRegistry cleanups (#91): the
// natives js/internal/deferred.js reaches the page's loop through, the native
// FinalizationRegistry constructor, and the thread-level service of a page that drives
// its own thread (eval, `lava run`, workers, page_run_until). The engine half — the GLib
// context, the nested epoll set, the self-test — is pkg/jsc/runloop_linux.odin; the page
// runner's half is in page_runner.odin. WebAssembly does not go through the RunLoop at
// all (wasm.odin says why).
//
// The split of work, and why it keeps pages apart:
//   - the RunLoop is iterated at thread level only (jsc.runloop_dispatch): before a
//     blocking page loop's tick, outside its CPU window (deferred_service_page), by the
//     runner between rounds, and after a pool's VMs are released (vm_pool_destroy) —
//     not in page_close, which says why;
//   - what JSC runs from there for a page is deferred.js's shim — the cleanup the
//     engine's registry holds is the shim, not the page's callback (fr_construct_host) —
//     which hands the page's callback to `enqueue` (deferred_enqueue_cb): queued here, in
//     Odin, with one task posted to the page's own loop (async_begin + post_async, so the
//     loop stays alive until it runs);
//   - that task (deferred_cleanup_task) runs in the page's tick, inside its CPU window, and
//     runs ONE registry's queued cleanups through the microtask shim's dispatchCleanups
//     — one entry, so their microtasks drain after the last of them, and one frame of
//     lava:microtasks under the page's callback, the same a timer callback has;
//   - a closed page's natives find no Runtime_State (destroy_runtime_state clears the
//     global's slot), so `enqueue` refuses, and a task already posted dies with the loop
//     (close_begin: no task runs after it); destroy_runtime_state releases what was queued.
//
// Fail closed: on a thread whose RunLoop is driven, the engine's own FinalizationRegistry
// (or WebAssembly.compile/instantiate, wasm.odin) would run page code from the RunLoop,
// outside every window. Whatever the install could not replace is deleted from the page
// before its code runs (deferred_fail_closed, from page_create).

// Deferred_Cleanup is one FinalizationRegistry cleanup owed to a page: the page's callback,
// the held value, and which registry it came from (one task per registry). Both values
// are GC-protected from enqueue until they run or the page's Runtime_State goes —
// exactly one unprotect each (deferred_cleanup_release).
Deferred_Cleanup :: struct {
	fn:       jsc.JSValueRef,
	held:     jsc.JSValueRef,
	registry: f64,
}

// g_deferred_install_fault makes the next installs on this thread behave as if the host
// path had failed — the fault injection deferred_fail_closed is pinned with
// (cmd/lava/runloop_drive_test.odin). Test-only; nothing in production sets it.
@(thread_local)
g_deferred_install_fault: bool

// deferred_inject_install_fault sets g_deferred_install_fault for the calling thread.
deferred_inject_install_fault :: proc(on: bool) {
	g_deferred_install_fault = on
}

// make_deferred_bindings builds deferred.js's natives (the loader's
// natives['internal/deferred']), reachable only from that module's factory.
//
// Plain C-API functions, not host_native_create's: the engine may still run the shim of
// a page whose Runtime_State is gone (a cleanup JSC queued for the realm before it
// closed, dispatched any time after), and destroy_runtime_state has released the
// context's host-call table by then, so a host native would throw from the fail-closed
// dispatcher ("Uncaught Exception at run loop" on stderr). A C-API callback still runs,
// finds no state, and refuses. Both are cold: once per context, or once per cleanup.
make_deferred_bindings :: proc(ctx: jsc.JSContextRef) -> jsc.JSObjectRef {
	bind :: proc(ctx: jsc.JSContextRef, to: jsc.JSObjectRef, name: string, cb: jsc.JSObjectCallAsFunctionCallback) {
		set_named(ctx, to, name, cast(jsc.JSValueRef)make_native_function(ctx, name, cb))
	}

	bindings := jsc.JSObjectMake(ctx, nil, nil)
	bind(ctx, bindings, "enqueue", deferred_enqueue_cb)
	bind(ctx, bindings, "installFinalizationRegistry", deferred_install_registry_cb)
	return bindings
}

// deferred_fail_closed deletes from the page what the install could not replace —
// FinalizationRegistry when deferred.js's routing is not in place, WebAssembly.compile
// and instantiate when wasm.odin's are not — on a thread whose RunLoop Lava drives, where
// the engine's would run page code from the RunLoop outside every window (#97 review,
// safety F1 of round 2). Runs in page_create, after the install and before any page code.
//
// Deleted rather than failing page_create: the cause is a transient allocation failure in
// the host-call registry or a JSC without a private symbol, and a page that loses one API
// it can feature-detect beats a page that is not run at all. A thread that is not driven
// keeps the engine's: there they never run (cleanups) or never settle (wasm), which is
// what they did before the drive and harms no other page.
deferred_fail_closed :: proc(ctx: jsc.JSContextRef, state: ^Runtime_State) {
	if state == nil || jsc.runloop_drive() != .Adopted {
		return
	}

	global := jsc.JSContextGetGlobalObject(ctx)

	if state.fr_engine == nil {
		delete_named(ctx, global, "FinalizationRegistry")
	}

	if state.wasm_module == nil {
		if wasm := get_named(ctx, global, "WebAssembly"); wasm != nil && jsc.JSValueIsObject(ctx, wasm) {
			delete_named(ctx, cast(jsc.JSObjectRef)wasm, "compile")
			delete_named(ctx, cast(jsc.JSObjectRef)wasm, "instantiate")
		}
	}
}

// deferred_release_cleanups gives back every cleanup a page was still owed when its
// Runtime_State goes: destroy_runtime_state, with the context alive.
deferred_release_cleanups :: proc(ctx: jsc.JSContextRef, state: ^Runtime_State) {
	for &item in state.deferred_cleanups {
		deferred_cleanup_release(ctx, &item)
	}
	delete(state.deferred_cleanups)
	state.deferred_cleanups = nil
}

// deferred_service_page is the thread-level RunLoop service of a page whose loop blocks
// on its own — eval's, `lava run`'s, a worker's, a page driven by page_run_until: on
// those threads the page's loop is the thread's only driver. page_tick runs it before
// each tick, outside the tick's CPU window; the page runner's never_block loops leave it
// to the runner, which watches the RunLoop in its own epoll set.
//
// It dispatches what the RunLoop has ready, makes sure the RunLoop descriptor is in the
// page loop's poll — an unreffed watcher, so a blocked tick wakes for JSC's work (a
// cleanup a concurrent collection queued from a helper thread) without it keeping the
// page alive — and caps the tick's blocking poll at GLib's next fd-less deadline. Neither
// is pinned by a test since wasm left the RunLoop: a page cannot make a collection end
// while its loop is blocked (eval_runs_a_finalization_cleanup collects before the loop).
deferred_service_page :: proc(state: ^Runtime_State) {
	if state == nil || state.loop == nil {
		return
	}

	fd, ok := jsc.runloop_fd()

	if !ok {
		return
	}

	if jsc.runloop_due() {
		jsc.runloop_dispatch()
	}

	if !state.deferred_watch.watched {
		state.deferred_watch = eventloop.IO_Watcher {
			fd       = uintptr(fd),
			mode     = .Read,
			callback = deferred_wake,
			unref    = true,
		}
		eventloop.watch_fd(state.loop, &state.deferred_watch)
	}

	timeout, _ := jsc.runloop_sync()
	// A 0 deadline (a source ready right now) caps at 1 ms rather than making the tick
	// non-blocking: the dispatch above has just run what was ready.
	state.loop.poll_cap_ms = timeout >= 0 ? max(timeout, 1) : 0
}

// deferred_unwatch_loop takes the RunLoop watcher deferred_service_page added off the
// page's loop; page_close runs it before the loop closes. Safe on a page never serviced.
deferred_unwatch_loop :: proc(state: ^Runtime_State) {
	if state == nil || state.loop == nil {
		return
	}

	eventloop.unwatch_fd(state.loop, &state.deferred_watch)
	state.loop.poll_cap_ms = 0
}

// deferred_wake is the watcher's callback. It runs inside a tick and must not dispatch
// there: waking the poll is all it is for, and the next tick's deferred_service_page runs
// what woke it.
@(private = "file")
deferred_wake :: proc(loop: ^eventloop.Loop, user_data: rawptr) {}

// deferred_page_alive is the Runtime_State a deferred native may post to: the page is
// live, has a loop that has not begun closing, and routes FinalizationRegistry.
@(private = "file")
deferred_page_alive :: proc(ctx: jsc.JSContextRef) -> ^Runtime_State {
	state := get_state_from_ctx(ctx)

	if state == nil || state.loop == nil || state.loop.destroyed || state.fr_engine == nil {
		return nil
	}

	return state
}

// enqueue(cleanup, heldValue, registry) -> boolean: owes the page `cleanup(heldValue)` in
// a later tick of its own. Called by deferred.js's shim from the RunLoop, at thread level:
// it queues and returns, and runs nothing of the page. false — and nothing queued — when
// the page has no loop to run it on (closed, or never had one).
@(private = "file")
deferred_enqueue_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	state := deferred_page_alive(ctx)

	if state == nil || argument_count < 3 || !is_function(ctx, arguments[0]) {
		return jsc.JSValueMakeBoolean(ctx, false)
	}

	item := Deferred_Cleanup {
		fn       = arguments[0],
		held     = arguments[1],
		registry = jsc.JSValueToNumber(ctx, arguments[2], nil),
	}
	jsc.JSValueProtect(ctx, item.fn)
	jsc.JSValueProtect(ctx, item.held)
	append(&state.deferred_cleanups, item)
	deferred_schedule(state)
	return jsc.JSValueMakeBoolean(ctx, true)
}

// deferred_schedule posts one task to the page's loop for its next registry's cleanups.
// post_async from the loop's own thread wakes the loop like a worker completion, and the
// async_begin keeps the page alive until the task runs; drain_async drops it.
@(private = "file")
deferred_schedule :: proc(state: ^Runtime_State) {
	if state.deferred_scheduled ||
	   len(state.deferred_cleanups) == 0 ||
	   state.loop == nil ||
	   state.loop.destroyed {
		return
	}

	state.deferred_scheduled = true
	eventloop.async_begin(state.loop)
	eventloop.post_async(state.loop, deferred_cleanup_task, state)
}

// deferred_cleanup_task runs ONE registry's queued cleanups, in the page's tick, as one
// entry through the microtask shim's dispatchCleanups (charged and checked like any
// callback: page_checkpoint). The loop runs no task after close_begin, which precedes
// destroy_runtime_state, so `state` is live here.
@(private = "file")
deferred_cleanup_task :: proc(loop: ^eventloop.Loop, user_data: rawptr) {
	state := cast(^Runtime_State)user_data
	state.deferred_scheduled = false
	ctx := state.ctx

	if len(state.deferred_cleanups) == 0 {
		return
	}

	end := 1
	for end < len(state.deferred_cleanups) &&
	    state.deferred_cleanups[end].registry == state.deferred_cleanups[0].registry {
		end += 1
	}

	defer {
		for i in 0 ..< end {
			deferred_cleanup_release(ctx, &state.deferred_cleanups[i])
		}
		remove_range(&state.deferred_cleanups, 0, end)
		deferred_schedule(state)
	}

	if page_stop_if_killed(state) || state.dispatch_cleanups == nil {
		return
	}

	fns := make([]jsc.JSValueRef, end, context.temp_allocator)
	helds := make([]jsc.JSValueRef, end, context.temp_allocator)
	for i in 0 ..< end {
		fns[i] = state.deferred_cleanups[i].fn
		helds[i] = state.deferred_cleanups[i].held
	}
	args := [3]jsc.JSValueRef {
		cast(jsc.JSValueRef)jsc.JSObjectMakeArray(ctx, c.size_t(end), raw_data(fns), nil),
		cast(jsc.JSValueRef)jsc.JSObjectMakeArray(ctx, c.size_t(end), raw_data(helds), nil),
		jsc.JSValueMakeNumber(ctx, f64(end)),
	}
	exc: jsc.JSValueRef
	jsc.JSObjectCallAsFunction(ctx, cast(jsc.JSObjectRef)state.dispatch_cleanups, nil, 3, raw_data(args[:]), &exc)

	if page_checkpoint(state, &exc) {
		return
	}

	if exc != nil {
		report_uncaught(ctx, exc)
		mark_async_failed(ctx)
		return
	}

	drain_next_ticks_settled(ctx, state)
}

@(private = "file")
deferred_cleanup_release :: proc(ctx: jsc.JSContextRef, item: ^Deferred_Cleanup) {
	unprotect_before_eval_exit(ctx, item.fn)
	unprotect_before_eval_exit(ctx, item.held)
	item^ = {}
}

// FR_NOT_CALLABLE and FR_WITHOUT_NEW are JSC 2.52's own TypeError messages for
// `new FinalizationRegistry(notAFunction)` and `FinalizationRegistry()` (a bare JSC shell
// against the same libjavascriptcoregtk-6.0, 2026-11-26): the native constructor below
// stands in for the engine's, so it says what the engine says.
@(private = "file")
FR_NOT_CALLABLE :: "First argument to FinalizationRegistry should be a function"
@(private = "file")
FR_WITHOUT_NEW :: "calling FinalizationRegistry constructor without new is invalid"

// installFinalizationRegistry(wrap): replaces the global FinalizationRegistry with a
// native constructor whose registries hold `wrap(cleanup)` — deferred.js's shim — instead
// of the page's cleanup, so the engine's cleanup task, run from the thread's RunLoop,
// only queues it for the page's own tick. Called once by deferred.js at module eval,
// before page code: the engine constructor, its prototype and Reflect.construct read here
// are the engine's own.
//
// Why a native constructor and not a JS wrapper: a page must not be able to tell (#91
// review F1-F2). A host function named FinalizationRegistry prints JSC's own
// `function FinalizationRegistry() { [native code] }`, has the engine's name and length,
// and a misuse's stack holds one native frame of that name, as the engine's does; a Proxy
// printed `function ProxyObject()` and added frames, a JS function its source. new.target
// reaches the native in the frame's `this` slot, so subclasses and Reflect.construct get
// their own prototype from the engine constructor (Reflect.construct with that
// new.target). Pinned against Chrome by tests/web/cases/finalization-shape.js.
//
// Without the host-call path (another platform, the private ABI missing) the engine's
// constructor stays, unrouted; the thread's RunLoop is then not driven either
// (runloop_self_test requires the host path), so its cleanups never run — what they did
// before #91 — rather than run outside their page's window.
@(private = "file")
deferred_install_registry_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	state := get_state_from_ctx(ctx)

	if state == nil || state.fr_engine != nil || argument_count < 1 || !is_function(ctx, arguments[0]) {
		return jsc.JSValueMakeUndefined(ctx)
	}

	// Test-only: as if the host path were missing (g_deferred_install_fault).
	if g_deferred_install_fault {
		return jsc.JSValueMakeUndefined(ctx)
	}

	global := jsc.JSContextGetGlobalObject(ctx)
	engine := get_named(ctx, global, "FinalizationRegistry")
	reflect := get_named(ctx, global, "Reflect")

	if !is_function(ctx, engine) || reflect == nil || !jsc.JSValueIsObject(ctx, reflect) {
		return jsc.JSValueMakeUndefined(ctx)
	}

	construct := get_named(ctx, cast(jsc.JSObjectRef)reflect, "construct")
	prototype := get_named(ctx, cast(jsc.JSObjectRef)engine, "prototype")

	if !is_function(ctx, construct) || prototype == nil || !jsc.JSValueIsObject(ctx, prototype) {
		return jsc.JSValueMakeUndefined(ctx)
	}

	native, ok := jsc.host_function_create(ctx, "FinalizationRegistry", fr_call_host, 1, ctor = fr_construct_host)

	if !ok || native == nil {
		return jsc.JSValueMakeUndefined(ctx)
	}

	jsc.JSValueProtect(ctx, engine)
	jsc.JSValueProtect(ctx, arguments[0])
	jsc.JSValueProtect(ctx, construct)
	state.fr_engine = engine
	state.fr_wrap = arguments[0]
	state.fr_construct = construct

	// The engine's attributes: `prototype` is non-writable, non-enumerable and
	// non-configurable on the constructor; the two properties overwritten below are
	// writable already and keep their attributes.
	name := jsc.JSStringCreateWithUTF8CString("prototype")
	jsc.JSObjectSetProperty(ctx, native, name, prototype, {.ReadOnly, .DontEnum, .DontDelete}, nil)
	jsc.JSStringRelease(name)
	set_named(ctx, cast(jsc.JSObjectRef)prototype, "constructor", cast(jsc.JSValueRef)native)
	set_named(ctx, global, "FinalizationRegistry", cast(jsc.JSValueRef)native)
	return jsc.JSValueMakeUndefined(ctx)
}

// fr_call_host is FinalizationRegistry called without `new`: the engine's TypeError.
@(private = "file")
fr_call_host :: proc "c" (global: rawptr, cf: [^]u64) -> i64 {
	context = runtime.default_context()
	ctx := jsc.JSContextRef(global)
	err := make_native_error(ctx, "TypeError", FR_WITHOUT_NEW)
	jsc.host_throw(ctx, err)
	return transmute(i64)err
}

// fr_construct_host is `new FinalizationRegistry(cleanup)`: the engine's constructor,
// given the shim for `cleanup` and this call's new.target.
@(private = "file")
fr_construct_host :: proc "c" (global: rawptr, cf: [^]u64) -> i64 {
	context = runtime.default_context()
	ctx := jsc.JSContextRef(global)
	state := get_state_from_ctx(ctx)
	argc := int(u32(cf[jsc.CALL_FRAME_ARGC_SLOT] & 0xFFFFFFFF)) - 1
	cleanup := argc >= 1 ? jsc.JSValueRef(uintptr(cf[jsc.CALL_FRAME_FIRST_ARG_SLOT])) : jsc.JSValueMakeUndefined(ctx)
	new_target := jsc.JSValueRef(uintptr(cf[jsc.CALL_FRAME_THIS_SLOT]))

	if !is_function(ctx, cleanup) {
		err := make_native_error(ctx, "TypeError", FR_NOT_CALLABLE)
		jsc.host_throw(ctx, err)
		return transmute(i64)err
	}

	// A closed page: nothing of its realm runs any more, so any object will do.
	if state == nil || state.fr_engine == nil {
		return transmute(i64)jsc.JSObjectMake(ctx, nil, nil)
	}

	exc: jsc.JSValueRef
	wrap_args := [1]jsc.JSValueRef{cleanup}
	shim := jsc.JSObjectCallAsFunction(ctx, cast(jsc.JSObjectRef)state.fr_wrap, nil, 1, raw_data(wrap_args[:]), &exc)

	if exc == nil {
		list := jsc.JSObjectMakeArray(ctx, 1, &shim, &exc)

		if exc == nil {
			args := [3]jsc.JSValueRef{state.fr_engine, cast(jsc.JSValueRef)list, new_target}
			result := jsc.JSObjectCallAsFunction(
				ctx,
				cast(jsc.JSObjectRef)state.fr_construct,
				nil,
				3,
				raw_data(args[:]),
				&exc,
			)

			if exc == nil {
				return transmute(i64)result
			}
		}
	}

	jsc.host_throw(ctx, exc)
	return transmute(i64)exc
}

is_function :: proc(ctx: jsc.JSContextRef, v: jsc.JSValueRef) -> bool {
	return v != nil && jsc.JSValueIsObject(ctx, v) && jsc.JSObjectIsFunction(ctx, cast(jsc.JSObjectRef)v)
}

// delete_named deletes `object[name]`; a missing or non-configurable property stays.
delete_named :: proc(ctx: jsc.JSContextRef, object: jsc.JSObjectRef, name: cstring) {
	key := jsc.JSStringCreateWithUTF8CString(name)
	defer jsc.JSStringRelease(key)
	jsc.JSObjectDeleteProperty(ctx, object, key, nil)
}
