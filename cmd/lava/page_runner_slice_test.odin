// Linux-only: the page runner exists only there (page_runner_other.odin).
#+build linux
package main

import "core:testing"
import lava "lava:pkg/runtime"

// The page runner's CPU quantum (#35, Page_Runner.slice_us) from the outside: no oracle
// can see it, because `lava run` and the oracle suites evaluate one page at a time and a
// single page never slices.

// Event-loop cases whose ordering a slice between two timer tasks could break: the HTML
// timer order recorded in Chrome (tests/web/cases; their oracle runs print, which a
// runner page does not have, so they are restated below with an assertion). Each
// asserts its own order and throws on a mismatch, which ends the page with an error.
@(private = "file")
SLICED_CASES := [?]struct {
	name:   string,
	source: string,
} {
	{"timers-due-mid-callback", WEB_DUE_MID_CALLBACK},
	{"timers-ready-order", WEB_READY_ORDER},
	{"timers-interval-rearm", WEB_INTERVAL_REARM},
}

// WEB_DUE_MID_CALLBACK is tests/web/cases/timers-due-mid-callback.js: Chrome prints A,C,B.
@(private = "file")
WEB_DUE_MID_CALLBACK :: `
const ev = [];
setTimeout(() => {
  ev.push('A');
  const end = performance.now() + 400;
  while (performance.now() < end);
  setTimeout(() => ev.push('C'), 0);
}, 10);
setTimeout(() => ev.push('B'), 210);
setTimeout(() => { if (ev.join() !== 'A,C,B') throw new Error(ev.join()); }, 700);
`

// WEB_READY_ORDER is tests/web/cases/timers-ready-order.js: Chrome prints X,Y,Z,T,W.
@(private = "file")
WEB_READY_ORDER :: `
const ev = [];
setTimeout(() => ev.push('T'), 10);
setTimeout(() => {
  ev.push('X');
  const end = performance.now() + 100;
  while (performance.now() < end);
  setTimeout(() => ev.push('Z'), 0);
}, 0);
setTimeout(() => { ev.push('Y'); setTimeout(() => ev.push('W'), 0); }, 0);
setTimeout(() => { if (ev.join() !== 'X,Y,Z,T,W') throw new Error(ev.join()); }, 300);
`

// WEB_INTERVAL_REARM is tests/web/cases/timers-interval-rearm.js: Chrome prints
// A,interval1,interval2,early,late.
@(private = "file")
WEB_INTERVAL_REARM :: `
const ev = [];
const spin = (ms) => { const end = performance.now() + ms; while (performance.now() < end); };
setTimeout(() => { ev.push('A'); spin(200); }, 300);
let fires = 0;
const interval = setInterval(() => {
  fires++;
  ev.push('interval' + fires);
  if (fires === 1) {
    setTimeout(() => ev.push('early'), 200);
    setTimeout(() => ev.push('late'), 400);
    spin(200);
    setTimeout(() => {}, 0);
  } else {
    clearInterval(interval);
  }
}, 300);
setTimeout(() => {
  if (ev.join() !== 'A,interval1,interval2,early,late') throw new Error(ev.join());
}, 1400);
`

// The event-loop cases keep their order when every turn is sliced: each runs as a
// runner page with a 1 µs quantum, which a timer callback always spends, so the timers
// phase suspends before every timer task after the first. One page at a time, alone on
// its runner, so the cases' wall-clock margins are not eaten by a sibling. Case 14 is
// the one that sees a slice falling through to check (t1,micro,imm,t2).
@(test)
runner_slicing_keeps_event_loop_order :: proc(t: ^testing.T) {
	for c in SLICED_CASES {
		runner: lava.Page_Runner

		if !lava.page_runner_init(&runner, 1, record_page_outcome, context.allocator) {
			testing.fail_now(t, "page_runner_init failed")
		}

		runner.slice_us = 1
		outcome: Page_Outcome
		lava.page_runner_open(&runner, c.source, c.name, {cpu_budget = 30}, &outcome)
		lava.page_runner_run(&runner)
		lava.page_runner_destroy(&runner)
		testing.expectf(
			t,
			outcome.done && outcome.status == .Ok && outcome.exit == 0,
			"case %s sliced: %s",
			c.name,
			describe_outcome(outcome),
		)
	}
}

// Finished is one page's outcome plus its place in the order the runner reported the
// test's pages in; `reported` is shared by them.
@(private = "file")
Finished :: struct {
	outcome:  Page_Outcome,
	at:       int,
	reported: ^int,
}

@(private = "file")
record_finished :: proc(runner: ^lava.Page_Runner, user_data: rawptr, result: lava.Result) {
	f := cast(^Finished)user_data
	f.reported^ += 1
	f.at = f.reported^
	record_page_outcome(runner, &f.outcome, result)
}

// HOG_PAGE has 30000 timers due in one turn. The timer registered first spins until
// every other one is due, so the next turn finds them all due at once; unsliced, that
// turn fires them all in one page_tick.
@(private = "file")
HOG_PAGE :: `
const K = 30000;
let n = 0, last = 0;
setTimeout(() => { while (performance.now() < last + 15); }, 0);
function f() { if (++n === K) throw 3; }
for (let i = 0; i < K; i++) setTimeout(f, 10);
last = performance.now();
`

// SIBLING_PAGE needs 6 turns: a chain of 0 ms timers, each set by the one before,
// runs one per turn (a timer created in a timer task waits for the next turn). The
// chain stops at 5 timers so none is created past nesting level 5: from the sixth on,
// HTML's nesting clamp (#116, eventloop TIMER_NESTING_LEVEL_MAX) makes each wait 4 ms
// of wall time, and a 20-step chain then took ~56 ms of clock — long enough for the
// hog's sliced turn to finish first on a fast runner (CI, #139). Unclamped, the
// sibling's progress is counted in rounds alone.
@(private = "file")
SIBLING_PAGE :: `
let steps = 0;
(function step() { if (++steps < 6) setTimeout(step, 0); else throw 4; })();
`

// A sibling ticks between the slices of a page with a pile of due timers (#35): with
// the default quantum, a page whose turn fires 30000 timers is suspended every 1 ms of
// CPU, and the runner ticks its sibling in between. The measure is runner rounds, not
// time, so a loaded machine cannot change the outcome: the sibling needs 6 rounds,
// one timer per tick, none of them held by the nesting clamp. Unsliced, the hog's turn is one tick and it is reported
// within a handful of rounds, long before the sibling; sliced, that turn alone is
// 30000 callbacks — about 100 ms of CPU at ~3 µs each (more in this debug build) — so
// at least ~90 slices, and the sibling is reported first.
@(test)
runner_sibling_ticks_between_slices_of_a_timer_heavy_page :: proc(t: ^testing.T) {
	runner: lava.Page_Runner

	if !lava.page_runner_init(&runner, 2, record_finished, context.allocator) {
		testing.fail_now(t, "page_runner_init failed")
	}

	defer lava.page_runner_destroy(&runner)
	reported := 0
	sibling := Finished {
		reported = &reported,
	}
	hog := Finished {
		reported = &reported,
	}
	lava.page_runner_open(&runner, SIBLING_PAGE, "<sibling>", {cpu_budget = 30}, &sibling)
	lava.page_runner_open(&runner, HOG_PAGE, "<hog>", {cpu_budget = 30}, &hog)
	lava.page_runner_run(&runner)

	testing.expectf(
		t,
		hog.outcome.status == .Ok && hog.outcome.exit == 1,
		"hog did not fire every timer: %s",
		describe_outcome(hog.outcome),
	)
	testing.expectf(
		t,
		sibling.outcome.status == .Ok && sibling.outcome.exit == 1,
		"sibling did not finish: %s",
		describe_outcome(sibling.outcome),
	)
	testing.expectf(
		t,
		sibling.at == 1 && hog.at == 2,
		"the sibling (reported %d) waited out the hog's turn (reported %d)",
		sibling.at,
		hog.at,
	)
}
