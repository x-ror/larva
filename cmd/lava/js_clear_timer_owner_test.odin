#+build linux, darwin
package main

import "core:testing"
import lava "lava:pkg/runtime"
import eventloop "lava:pkg/runtime/eventloop"

// Page JS cannot cancel a runtime-internal handle by guessing its id (#92). Handle ids
// come from one per-loop counter shared by the JS timer globals and the runtime's own
// timers (net's TLS-handshake and drain timers, pkg/http's transfer deadline), and
// clear_timer_cb used to pass any id straight to eventloop.clear_timeout, which runs
// the handle's dispose — for a pkg/http transfer that finishes the transfer as
// .Cancelled. Node cannot express this (no internal timer is reachable by id there), so
// the test plants native handles on the loop itself: a timeout and an immediate armed
// before the script, then a script that clears every id from 1 to well past the newest
// one through the clear globals. Both native handles must still fire, and their
// dispose must not run: they fired, so nothing owes them a release.
//
// Run on the .Web surface: that is the surface a page reaches. It has no clearImmediate
// (neither has Chrome), but clearTimeout, clearInterval and the .Node surface's
// clearImmediate are one native, clear_timer_cb, which also reaches immediates.

@(private = "file")
Native_Handle :: struct {
	fired:    int,
	disposed: int,
}

@(private = "file")
native_handle_fire :: proc(loop: ^eventloop.Loop, user_data: rawptr) {
	(cast(^Native_Handle)user_data).fired += 1
}

@(private = "file")
native_handle_dispose :: proc(user_data: rawptr) {
	(cast(^Native_Handle)user_data).disposed += 1
}

// The script's first timer id is newer than both native handles; clearing to 100 past
// it covers them whatever the loop numbered them. A JS timer that survived the sweep
// would throw, so the script also pins that its own handles are still clearable.
@(private = "file")
CLEAR_EVERY_ID_SCRIPT :: `
'use strict';
let ran = false;
const fresh = setTimeout(() => { ran = true; }, 0);
for (let i = 1; i < fresh + 100; i++) {
  clearTimeout(i);
  clearInterval(i);
}
setTimeout(() => { if (ran) throw new Error('a JS timer survived clearTimeout of its own id'); }, 5);
`

@(test)
js_clear_globals_cannot_cancel_native_handles :: proc(t: ^testing.T) {
	loop := eventloop.init()
	timeout, immediate: Native_Handle
	eventloop.set_timeout(&loop, native_handle_fire, 10, &timeout, native_handle_dispose)
	eventloop.set_immediate(&loop, native_handle_fire, &immediate, native_handle_dispose)

	// eval consumes (destroys) the loop on every path; do not destroy it here.
	result := lava.eval(CLEAR_EVERY_ID_SCRIPT, "<js-clear-timer-owner>", &loop, surface = .Web)
	defer lava.result_destroy(&result)

	testing.expectf(t, result.status == .Ok, "eval: status=%v message=%q", result.status, result.message)
	testing.expectf(t, timeout.fired == 1 && timeout.disposed == 0, "native timeout: %v", timeout)
	testing.expectf(t, immediate.fired == 1 && immediate.disposed == 0, "native immediate: %v", immediate)
}

// A fractional id names no timer: clearTimeout(id + 0.5) leaves timer `id` running.
// node 26.13.0 prints "fired" for `const t = setTimeout(f, 10); clearTimeout(t + 0.5)`
// (and the same for clearInterval). clear_timer_cb used to truncate the number with
// u64(), so the call cancelled `id`. The surviving timer records that it ran; a later
// timer throws if it did not. Run on `.Node`, where an uncaught throw from a timer ends
// the eval with an error status; a `.Web` page, like Chrome's, reports it and goes on.
// The native is the same one on both surfaces.
@(private = "file")
CLEAR_FRACTIONAL_ID_SCRIPT :: `
'use strict';
let timeoutRan = false, intervalRan = false;
const t = setTimeout(() => { timeoutRan = true; }, 0);
const i = setInterval(() => { intervalRan = true; clearInterval(i); }, 0);
clearTimeout(t + 0.5);
clearInterval(i + 0.25);
setTimeout(() => {
  if (!timeoutRan) throw new Error('clearTimeout(id + 0.5) cancelled timer id');
  if (!intervalRan) throw new Error('clearInterval(id + 0.25) cancelled interval id');
}, 5);
`

@(test)
js_clear_globals_ignore_a_fractional_id :: proc(t: ^testing.T) {
	loop := eventloop.init()

	// eval consumes (destroys) the loop on every path; do not destroy it here.
	result := lava.eval(CLEAR_FRACTIONAL_ID_SCRIPT, "<js-clear-fractional-id>", &loop, surface = .Node)
	defer lava.result_destroy(&result)

	testing.expectf(
		t,
		result.status == .Ok && result.exit_code == 0,
		"eval: status=%v exit=%d message=%q",
		result.status,
		result.exit_code,
		result.message,
	)
}
