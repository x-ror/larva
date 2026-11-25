// Linux-only: the page runner exists only there (page_runner_other.odin).
#+build linux
package main

import "core:testing"
import lava "lava:pkg/runtime"

// The page runner's CPU quantum (#35, Page_Runner.slice_us) from the outside: no oracle
// can see it, because `lava run` and the oracle suites evaluate one page at a time and a
// single page never slices.

// Event-loop oracle cases whose ordering a slice between two due timers could break:
// FIFO (03), microtasks between timers (04, 09), a 0 ms timer created in a timer waits
// for the next turn (05), interval cancellation (06), the turn's `now` (12), the
// interval re-arm (13), timers before the turn's immediates (14). Each asserts its own
// order and throws on a mismatch, which ends the page with an error.
@(private = "file")
SLICED_CASES := [?]struct {
	name:   string,
	source: string,
} {
	{"03", #load("../../tests/runtime/eventloop/cases/03-timer-fifo.js", string)},
	{"04", #load("../../tests/runtime/eventloop/cases/04-microtasks-between-timers.js", string)},
	{"05", #load("../../tests/runtime/eventloop/cases/05-nested-timer-turn.js", string)},
	{"06", #load("../../tests/runtime/eventloop/cases/06-interval-cancellation.js", string)},
	{"09", #load("../../tests/runtime/eventloop/cases/09-nexttick-microtask-interleave.js", string)},
	{"12", #load("../../tests/runtime/eventloop/cases/12-timer-due-mid-phase-waits.js", string)},
	{"13", #load("../../tests/runtime/eventloop/cases/13-interval-rearms-from-callback-start.js", string)},
	{"14", #load("../../tests/runtime/eventloop/cases/14-timers-before-immediate.js", string)},
}

// The event-loop cases keep node's order when every turn is sliced: each runs as a
// runner page with a 1 µs quantum, which a timer callback always spends, so the timers
// phase suspends before every due timer after the first. One page at a time, alone on
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
function f() { if (++n === K) process.exitCode = 3; }
for (let i = 0; i < K; i++) setTimeout(f, 10);
last = performance.now();
`

// SIBLING_PAGE needs 20 turns: a chain of immediates, each queued by the one before,
// runs one per turn.
@(private = "file")
SIBLING_PAGE :: `
let steps = 0;
(function step() { if (++steps < 20) setImmediate(step); else process.exitCode = 4; })();
`

// A sibling ticks between the slices of a page with a pile of due timers (#35): with
// the default quantum, a page whose turn fires 30000 timers is suspended every 1 ms of
// CPU, and the runner ticks its sibling in between. The measure is runner rounds, not
// time, so a loaded machine cannot change the outcome: the sibling needs 20 rounds,
// one immediate per tick. Unsliced, the hog's turn is one tick and it is reported
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
		hog.outcome.status == .Ok && hog.outcome.exit == 3,
		"hog did not fire every timer: %s",
		describe_outcome(hog.outcome),
	)
	testing.expectf(
		t,
		sibling.outcome.status == .Ok && sibling.outcome.exit == 4,
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
