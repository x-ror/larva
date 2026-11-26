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
//     which queues the page's callback and calls `schedule`, which posts one task to the
//     page's own loop
//     (async_begin + post_async, so the loop stays alive until it runs);
//   - that task (deferred_flush_task) runs in the page's tick, inside its CPU window, and
//     calls the page's flush through invoke_user_callback, which charges the budget,
//     drains nextTicks and stops a page a limit has ended;
//   - a closed page's natives find no Runtime_State (destroy_runtime_state clears the
//     global's slot), so `schedule` refuses and the shim drops the queue, and a task
//     already posted dies with the loop (close_begin: no task runs after it).

// make_deferred_bindings builds deferred.js's natives (the loader's
// natives['internal/deferred']), reachable only from that module's factory.
//
// Plain C-API functions, not host_native_create's: the engine may still run the shim of
// a page whose Runtime_State is gone (a cleanup JSC queued for the realm before it
// closed, dispatched any time after), and destroy_runtime_state has released the
// context's host-call table by then, so a host native would throw from the fail-closed
// dispatcher ("Uncaught Exception at run loop" on stderr). A C-API callback still runs,
// finds no state, and refuses. All four are cold: once per context, or once per cleanup
// batch.
make_deferred_bindings :: proc(ctx: jsc.JSContextRef) -> jsc.JSObjectRef {
	bind :: proc(ctx: jsc.JSContextRef, to: jsc.JSObjectRef, name: string, cb: jsc.JSObjectCallAsFunctionCallback) {
		set_named(ctx, to, name, cast(jsc.JSValueRef)make_native_function(ctx, name, cb))
	}

	bindings := jsc.JSObjectMake(ctx, nil, nil)
	bind(ctx, bindings, "schedule", deferred_schedule_cb)
	bind(ctx, bindings, "setFlush", deferred_set_flush_cb)
	bind(ctx, bindings, "installFinalizationRegistry", deferred_install_registry_cb)
	// The same reporter a throwing nextTick/queueMicrotask callback uses: report_uncaught,
	// then the non-zero exit an uncaught callback error forces.
	bind(ctx, bindings, "reportUncaught", microtask_report_uncaught_cb)
	return bindings
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
// live, has a loop that has not begun closing, and installed its flush.
@(private = "file")
deferred_page_alive :: proc(ctx: jsc.JSContextRef) -> ^Runtime_State {
	state := get_state_from_ctx(ctx)

	if state == nil || state.loop == nil || state.loop.destroyed || state.deferred_flush == nil {
		return nil
	}

	return state
}

// schedule() -> boolean: asks the page's loop for one turn that runs the page's flush.
// false when the page has no loop to run it on (closed, or never had one); the module then
// drops its queue.
@(private = "file")
deferred_schedule_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	state := deferred_page_alive(ctx)

	if state == nil {
		return jsc.JSValueMakeBoolean(ctx, false)
	}

	// post_async from the loop's own thread: it wakes the loop like a worker completion,
	// and drain_async drops the hold taken here when the task runs.
	eventloop.async_begin(state.loop)
	eventloop.post_async(state.loop, deferred_flush_task, state)
	return jsc.JSValueMakeBoolean(ctx, true)
}

// setFlush(fn): records the module's flush on the page's Runtime_State, GC-protected
// until destroy_runtime_state. Once per context: the module calls it at install, and a
// second call is ignored so the protect count stays one.
@(private = "file")
deferred_set_flush_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	state := get_state_from_ctx(ctx)

	if state == nil || state.deferred_flush != nil || argument_count < 1 {
		return jsc.JSValueMakeUndefined(ctx)
	}

	fn := arguments[0]

	if !jsc.JSValueIsObject(ctx, fn) || !jsc.JSObjectIsFunction(ctx, cast(jsc.JSObjectRef)fn) {
		return jsc.JSValueMakeUndefined(ctx)
	}

	jsc.JSValueProtect(ctx, fn)
	state.deferred_flush = fn
	return jsc.JSValueMakeUndefined(ctx)
}

// deferred_flush_task is the loop task `schedule` posts: it runs the page's flush in the
// page's tick, as a user callback. The loop runs no task after close_begin, which comes
// before destroy_runtime_state, so `state` is live whenever this runs.
@(private = "file")
deferred_flush_task :: proc(loop: ^eventloop.Loop, user_data: rawptr) {
	state := cast(^Runtime_State)user_data

	if state == nil || state.deferred_flush == nil {
		return
	}

	exception: jsc.JSValueRef
	invoke_user_callback(state.ctx, cast(jsc.JSObjectRef)state.deferred_flush, nil, 0, &exception)

	if exception != nil {
		report_uncaught(state.ctx, exception)
		mark_async_failed(state.ctx)
	}
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

@(private = "file")
is_function :: proc(ctx: jsc.JSContextRef, v: jsc.JSValueRef) -> bool {
	return v != nil && jsc.JSValueIsObject(ctx, v) && jsc.JSObjectIsFunction(ctx, cast(jsc.JSObjectRef)v)
}
