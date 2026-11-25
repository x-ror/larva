#+build linux, darwin
package main

import "core:testing"
import jsc "lava:pkg/jsc"
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
// clearImmediate share one owner-checked cancel (clear_timer_owned_id), which also
// reaches immediates; the surfaces differ only in how they read the id.

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

// Which argument forms reach timer `id` is the profile's, and the two oracles disagree on
// nearly all of them, so one script runs on each surface and its report is compared with
// the oracle's recording of the same script.
//
// Node (`.Node`): clearTimeout looks a number or a string up as a property key of its
// id table, so only the number N and the string "N" (the canonical decimal) cancel;
// "N.0", " N", "0xN", fractions, N ± 2^32, N + 2^33, objects and BigInt name nothing. Recorded on
// node 26.13.0: `node -e "require('./case.js'); setTimeout(() => console.log(report), 60)"`.
//
// Chrome (`.Web`): the id is a WebIDL `long`, so ToNumber, truncation and modulo 2^32
// decide, and every numeric spelling of N cancels it, N ± 2^32 and N + 2^33 included; ToNumber on a
// BigInt throws a TypeError. Recorded on Chrome 158.0.8127.88, `--headless=new
// --virtual-time-budget=5000 --dump-dom` on a local page loading the script and printing
// `report` 60 ms later; three runs, identical. Left out: an object whose valueOf returns
// N — alone it cancels, as WebIDL says, but at this point of this script it did not,
// which reads as a call-site optimization, not a rule to pin.
@(private = "file")
CLEAR_ID_FORMS_SCRIPT :: `
'use strict';
const forms = [
  ['N', (id) => id],
  ['"N"', (id) => String(id)],
  ['"N.0"', (id) => id + '.0'],
  ['" N"', (id) => ' ' + id],
  ['"0xN"', (id) => '0x' + id.toString(16)],
  ['"+N"', (id) => '+' + id],
  ['"0N"', (id) => '0' + id],
  ['N+0.5', (id) => id + 0.5],
  ['N+2^32', (id) => id + 4294967296],
  ['N-2^32', (id) => id - 4294967296],
  ['N+2^33', (id) => id + 8589934592],
  ['[N]', (id) => [id]],
  ['String obj', (id) => new String(String(id))],
  ['BigInt', (id) => BigInt(id)],
];
const fired = {};
const threw = {};
for (const [name, f] of forms) {
  const id = +setTimeout(() => { fired[name] = true; }, 1);
  try { clearTimeout(f(id)); } catch (e) { threw[name] = e.name; }
}
const iv = +setInterval(() => { fired.interval = true; clearInterval(iv); }, 1);
clearInterval(iv + 0.25);
setTimeout(() => {
  globalThis.report = forms.map(([n]) => n + ':' + (fired[n] ? 'fired' : 'cancelled') + (threw[n] ? '/' + threw[n] : '')).join(' ') +
    ' interval+0.25:' + (fired.interval ? 'fired' : 'cancelled');
}, 30);
`

@(private = "file")
NODE_CLEAR_ID_FORMS :: `N:cancelled "N":cancelled "N.0":fired " N":fired "0xN":fired "+N":fired "0N":fired N+0.5:fired N+2^32:fired N-2^32:fired N+2^33:fired [N]:fired String obj:fired BigInt:fired interval+0.25:fired`

@(private = "file")
CHROME_CLEAR_ID_FORMS :: `N:cancelled "N":cancelled "N.0":cancelled " N":cancelled "0xN":cancelled "+N":cancelled "0N":cancelled N+0.5:cancelled N+2^32:cancelled N-2^32:cancelled N+2^33:cancelled [N]:cancelled String obj:cancelled BigInt:fired/TypeError interval+0.25:cancelled`

@(test)
js_clear_globals_read_an_id_like_node :: proc(t: ^testing.T) {
	report, allocated := clear_id_forms_report(t, .Node)
	defer if allocated {
		delete(report)
	}
	testing.expect_value(t, report, NODE_CLEAR_ID_FORMS)
}

@(test)
js_clear_globals_read_an_id_like_chrome :: proc(t: ^testing.T) {
	report, allocated := clear_id_forms_report(t, .Web)
	defer if allocated {
		delete(report)
	}
	testing.expect_value(t, report, CHROME_CLEAR_ID_FORMS)
}

// clear_id_forms_report runs CLEAR_ID_FORMS_SCRIPT on a page of `surface` until its loop
// idles and returns the page's `report` global ("" when the page never set it);
// `allocated` says the caller owns the string, as for lava.value_to_string.
@(private = "file")
clear_id_forms_report :: proc(t: ^testing.T, surface: lava.Global_Surface) -> (report: string, allocated: bool) {
	page: lava.Page
	loop := eventloop.init(real_time = true)

	if !lava.page_create(&page, "<js-clear-id-forms>", &loop, limits = {cpu_budget = 30}, surface = surface) {
		testing.fail_now(t, "page_create refused the page")
	}

	if lava.page_run_script(&page, CLEAR_ID_FORMS_SCRIPT, "<js-clear-id-forms>") {
		for {
			if alive, _ := lava.page_tick(&page); !alive {
				break
			}
		}
	}

	v, ok := lava.page_eval(&page, `typeof report === 'string' ? report : ''`)

	if ok {
		report, allocated = lava.value_to_string(cast(jsc.JSContextRef)page.ctx, v)
	}

	result, busy := lava.page_close(&page)
	lava.result_destroy(&result)

	if busy != nil {
		eventloop.close_finish(busy)
	}

	return
}
