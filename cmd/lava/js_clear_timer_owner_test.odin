#+build linux, darwin
package main

import "core:testing"
import jsc "lava:pkg/jsc"
import lava "lava:pkg/runtime"
import eventloop "lava:pkg/runtime/eventloop"

// Page JS cannot cancel a runtime-internal handle by guessing its id (#92). Handle ids
// come from one per-loop counter shared by the JS timer globals and the runtime's own
// timers (net's TLS-handshake and drain timers, pkg/http's transfer deadline), and
// the clear globals used to pass any id straight to eventloop.clear_timeout, which runs
// the handle's dispose — for a pkg/http transfer that finishes the transfer as
// .Cancelled. Node cannot express this (no internal timer is reachable by id there), so
// the test plants native handles on the loop itself: a timeout and an immediate armed
// before the script, then a script that clears every id from 1 to well past the newest
// one through the clear globals. Both native handles must still fire, and their
// dispose must not run: they fired, so nothing owes them a release.
//
// clearTimeout and clearInterval share one owner-checked cancel (clear_timer_owned_id),
// which also reaches immediates.

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
	result := lava.eval(CLEAR_EVERY_ID_SCRIPT, "<js-clear-timer-owner>", &loop)
	defer lava.result_destroy(&result)

	testing.expectf(t, result.status == .Ok, "eval: status=%v message=%q", result.status, result.message)
	testing.expectf(t, timeout.fired == 1 && timeout.disposed == 0, "native timeout: %v", timeout)
	testing.expectf(t, immediate.fired == 1 && immediate.disposed == 0, "native immediate: %v", immediate)
}

// Which argument forms reach timer `id`: the script's report is compared with Chrome's
// recording of the same script.
//
// Chrome: the id is a WebIDL `long`, so ToNumber, truncation and modulo 2^32
// decide, and every numeric spelling of N cancels it, N ± 2^32 and N + 2^33 included. A
// conversion that fails throws a TypeError carrying the binding's prefix ("Failed to
// execute 'clearTimeout' on 'Window': "), for a BigInt (or its wrapper), a Symbol, an
// object with no primitive or a non-callable Symbol.toPrimitive; an error valueOf throws
// propagates as it is. Recorded on Chrome 158.0.8127.88, `--headless=new
// --virtual-time-budget=5000 --dump-dom` on a local page loading the script and printing
// `report` 60 ms later; three runs, identical. Not pinned: an object whose valueOf
// returns N, which in an earlier, longer version of this script did not cancel in Chrome
// for a reason not established.
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
  ['BigInt obj', (id) => Object(BigInt(id))],
  ['Symbol', () => Symbol()],
  ['throwing valueOf', () => ({ valueOf() { throw new RangeError('from valueOf'); } })],
  ['no primitive', () => ({ valueOf() { return {}; }, toString() { return {}; } })],
  ['bad toPrimitive', () => ({ [Symbol.toPrimitive]: 1 })],
];
const fired = {};
const threw = {};
for (const [name, f] of forms) {
  const id = +setTimeout(() => { fired[name] = true; }, 1);
  try { clearTimeout(f(id)); } catch (e) { threw[name] = e.name + ': ' + e.message; }
  // V8 renders the offending value and object into this one message; only its
  // binding prefix is the contract, so the rest is cut.
  if (name === 'bad toPrimitive' && threw[name]) threw[name] = threw[name].slice(0, threw[name].indexOf(':', 11) + 1);
}
const iv = +setInterval(() => { fired.interval = true; clearInterval(iv); }, 1);
clearInterval(iv + 0.25);
let intervalThrew = 'no throw';
try { clearInterval(Symbol()); } catch (e) { intervalThrew = e.name + ': ' + e.message; }
setTimeout(() => {
  globalThis.report = forms.map(([n]) => n + ':' + (fired[n] ? 'fired' : 'cancelled') + (threw[n] ? ' (' + threw[n] + ')' : '')).join(' ') +
    ' interval+0.25:' + (fired.interval ? 'fired' : 'cancelled') + ' clearInterval(Symbol):' + intervalThrew;
}, 30);
`

// The <pre> text of the --dump-dom output; nothing in it needed HTML unescaping.
@(private = "file")
CHROME_CLEAR_ID_FORMS :: `N:cancelled "N":cancelled "N.0":cancelled " N":cancelled "0xN":cancelled "+N":cancelled "0N":cancelled N+0.5:cancelled N+2^32:cancelled N-2^32:cancelled N+2^33:cancelled [N]:cancelled String obj:cancelled BigInt:fired (TypeError: Failed to execute 'clearTimeout' on 'Window': Cannot convert a BigInt value to a number) BigInt obj:fired (TypeError: Failed to execute 'clearTimeout' on 'Window': Cannot convert a BigInt value to a number) Symbol:fired (TypeError: Failed to execute 'clearTimeout' on 'Window': Cannot convert a Symbol value to a number) throwing valueOf:fired (RangeError: from valueOf) no primitive:fired (TypeError: Failed to execute 'clearTimeout' on 'Window': Cannot convert object to primitive value) bad toPrimitive:fired (TypeError: Failed to execute 'clearTimeout' on 'Window':) interval+0.25:cancelled clearInterval(Symbol):TypeError: Failed to execute 'clearInterval' on 'Window': Cannot convert a Symbol value to a number`

@(test)
js_clear_globals_read_an_id_like_chrome :: proc(t: ^testing.T) {
	report, allocated := clear_id_forms_report(t, CLEAR_ID_FORMS_SCRIPT)
	defer if allocated {
		delete(report)
	}
	testing.expect_value(t, report, CHROME_CLEAR_ID_FORMS)
}

// The deviation clear_timeout_web_cb declares: an id of 2^31 or more cannot be
// cleared, because the WebIDL `long` that names it wraps to a negative number first;
// Chrome's own ids never get that far. Lava-only: no oracle issues such an id. The loop's counter starts at 2^31,
// and the report says whether the timer's id is really that high, so a change in how
// ids are handed out cannot make the case pass on a small one.
@(private = "file")
HIGH_ID_SCRIPT :: `
'use strict';
let fired = false;
const id = setTimeout(() => { fired = true; }, 1);
clearTimeout(id);
setTimeout(() => { globalThis.report = (id >= 2147483648) + ':' + (fired ? 'fired' : 'cancelled'); }, 20);
`

@(test)
js_clear_globals_on_web_cannot_name_an_id_past_2_31 :: proc(t: ^testing.T) {
	web, web_allocated := clear_id_forms_report(t, HIGH_ID_SCRIPT, first_id = 2147483648)
	defer if web_allocated {
		delete(web)
	}

	testing.expect_value(t, web, "true:fired")
}

// clear_id_forms_report runs `script` on a page until its loop idles and
// returns the page's `report` global ("" when the page never set it); `allocated` says
// the caller owns the string, as for lava.value_to_string. `first_id`, when set, is
// where the loop's handle ids start.
@(private = "file")
clear_id_forms_report :: proc(
	t: ^testing.T,
	script: string,
	first_id: eventloop.Timer_ID = 0,
) -> (
	report: string,
	allocated: bool,
) {
	page: lava.Page
	loop := eventloop.init(real_time = true)

	if first_id != 0 {
		loop.next_timer_id = first_id
	}

	if !lava.page_create(&page, "<js-clear-id-forms>", &loop, limits = {cpu_budget = 30}) {
		testing.fail_now(t, "page_create refused the page")
	}

	if lava.page_run_script(&page, script, "<js-clear-id-forms>") {
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
