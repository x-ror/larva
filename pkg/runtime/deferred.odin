package lava_runtime

import "base:runtime"
import "core:c"
import jsc "lava:pkg/jsc"
import eventloop "lava:pkg/runtime/eventloop"

// The runtime half of driving JSC's RunLoop (#91, #97): the natives js/internal/deferred.js
// reaches the page's loop through, and the thread-level service of a page that drives its
// own thread (eval, `lava run`, workers, page_run_until). The
// engine half — the GLib context, the nested epoll set, the self-test — is
// pkg/jsc/runloop_linux.odin; the page runner's half is in page_runner.odin.
//
// The split of work, and why it keeps pages apart:
//   - the RunLoop is iterated at thread level only (jsc.runloop_dispatch): before a
//     blocking page loop's tick, outside its CPU window (deferred_service_page), by the
//     runner between rounds, and after a pool's VMs are released (vm_pool_destroy) —
//     not in page_close, which says why;
//   - what JSC runs from there for a page is deferred.js's shim, which queues the page's
//     callback and calls `schedule`, which posts one task to the page's own loop
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
// a page whose Runtime_State is gone (a cleanup or a settlement JSC posted for the realm
// before it closed, dispatched any time after), and destroy_runtime_state has
// released the context's host-call table by then, so a host native would throw from
// the fail-closed dispatcher ("Uncaught Exception at run loop" on stderr). A C-API
// callback still runs, finds no state, and refuses. All five are cold: at most a call
// per cleanup batch or compile.
make_deferred_bindings :: proc(ctx: jsc.JSContextRef) -> jsc.JSObjectRef {
	bind :: proc(ctx: jsc.JSContextRef, to: jsc.JSObjectRef, name: string, cb: jsc.JSObjectCallAsFunctionCallback) {
		set_named(ctx, to, name, cast(jsc.JSValueRef)make_native_function(ctx, name, cb))
	}

	bindings := jsc.JSObjectMake(ctx, nil, nil)
	bind(ctx, bindings, "schedule", deferred_schedule_cb)
	bind(ctx, bindings, "hold", deferred_hold_cb)
	bind(ctx, bindings, "release", deferred_release_cb)
	bind(ctx, bindings, "setFlush", deferred_set_flush_cb)
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
// page loop's poll — an unreffed watcher, so a blocked tick wakes for JSC's work (a wasm
// compile finishing on a JSC worker, a cleanup a GC scheduled) without it keeping the page
// alive — and caps the tick's blocking poll at GLib's next fd-less deadline.
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

// hold() -> boolean: keeps the page's loop alive until release() — a pending wasm
// compile, as node keeps its process alive for one. false where nothing drives the
// thread's RunLoop: the settlement would never come, so the module returns the engine's
// promise unheld, which is what the page got before the drive existed.
@(private = "file")
deferred_hold_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	state := deferred_page_alive(ctx)

	if state == nil || jsc.runloop_drive() != .Adopted {
		return jsc.JSValueMakeBoolean(ctx, false)
	}

	eventloop.async_begin(state.loop)
	return jsc.JSValueMakeBoolean(ctx, true)
}

// release() drops one hold() of a page that is still live; on a closed page it does
// nothing — its loop, and the count, are gone.
@(private = "file")
deferred_release_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()

	if state := deferred_page_alive(ctx); state != nil {
		eventloop.async_cancel(state.loop)
	}

	return jsc.JSValueMakeUndefined(ctx)
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
	state.deferred_ctx = ctx
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
	invoke_user_callback(state.deferred_ctx, cast(jsc.JSObjectRef)state.deferred_flush, nil, 0, &exception)

	if exception != nil {
		report_uncaught(state.deferred_ctx, exception)
		mark_async_failed(state.deferred_ctx)
	}
}
