// Linux-only: the dispatcher's workers are page runners, which exist only there
// (page_dispatcher_other.odin refuses to start).
#+build linux
package main

import "base:runtime"
import "core:fmt"
import "core:log"
import "core:mem"
import "core:os"
import "core:strconv"
import "core:strings"
import "core:sync"
import "core:sys/linux"
import "core:testing"
import "core:thread"
import "core:time"
import lava "lava:pkg/runtime"

// The dispatcher's contract (page_dispatcher.odin) is Lava-only — no Node or Chrome
// surface — so these tests are its oracle (CLAUDE.md §6): which worker a page lands
// on, that a busy worker holds up no other, that every accepted page is reported
// exactly once on a worker thread whatever shutdown does, that a page sees nothing of
// pages on other workers or before it in its VM, and that the dispatcher gives back
// every byte, descriptor and thread-lived table it took.

// A page's limits when they are not the subject: a budget far above anything a
// passing page spends, so reaching it is itself a failure.
@(private = "file")
LIMITS :: lava.Page_Limits {
	cpu_budget = 30,
}

// Tally is shared by every page of a test; Rec is one page's own record. on_done runs
// on worker threads, so every field the test thread reads is either atomic or written
// under `mutex`.
@(private = "file")
Tally :: struct {
	mutex:        sync.Mutex,
	done:         int,
	submitter:    int,
	on_submitter: int,
	threads:      [16]int,
	n_threads:    int,
	// Follow-up chain (dispatcher_refuses_follow_ups_once_shutdown_begins).
	chain_left:   int,
	accepted:     int,
	refused:      int,
}

@(private = "file")
Rec :: struct {
	tally:   ^Tally,
	reports: int,
	status:  lava.Status,
	kill:    lava.Kill_Reason,
	exit:    int,
	thread:  int,
	at:      time.Tick,
	heap:    i64,
}

@(private = "file")
tally_init :: proc(tally: ^Tally) {
	tally^ = {}
	tally.submitter = sync.current_thread_id()
}

@(private = "file")
record :: proc(d: ^lava.Page_Dispatcher, user_data: rawptr, result: lava.Result) {
	result := result
	rec := cast(^Rec)user_data
	tid := sync.current_thread_id()
	rec.status = result.status
	rec.kill = result.kill
	rec.exit = result.exit_code
	rec.thread = tid
	rec.at = time.tick_now()
	rec.heap = result.heap_bytes
	tally := rec.tally
	sync.lock(&tally.mutex)

	if tid == tally.submitter {
		tally.on_submitter += 1
	}

	seen := false
	for i in 0 ..< tally.n_threads {
		if tally.threads[i] == tid {
			seen = true
		}
	}

	if !seen && tally.n_threads < len(tally.threads) {
		tally.threads[tally.n_threads] = tid
		tally.n_threads += 1
	}

	sync.unlock(&tally.mutex)
	// Inside on_done context.allocator is the dispatcher's, which owns the message.
	lava.result_destroy(&result)
	// Last, so a test that sees the count also sees the record.
	sync.atomic_add(&rec.reports, 1)
	sync.atomic_add(&tally.done, 1)
}

// wait_done polls until `want` pages are reported or `seconds` pass.
@(private = "file")
wait_done :: proc(tally: ^Tally, want: int, seconds: f64) -> bool {
	deadline := time.tick_now()
	for sync.atomic_load(&tally.done) < want {
		if time.duration_seconds(time.tick_since(deadline)) > seconds {
			return false
		}

		time.sleep(2 * time.Millisecond)
	}
	return true
}

@(private = "file")
init_or_fail :: proc(t: ^testing.T, d: ^lava.Page_Dispatcher, threads, slots: int, allocator: runtime.Allocator = {}) {
	if !lava.page_dispatcher_init(d, threads, slots, record, allocator = allocator) {
		testing.fail_now(t, "page_dispatcher_init failed")
	}
}

// Pages that each hold their worker for 100 ms of top-level CPU spread over every
// worker, and no on_done runs on the submitting thread.
@(test)
dispatcher_spreads_pages_over_workers :: proc(t: ^testing.T) {
	tally: Tally
	tally_init(&tally)
	d: lava.Page_Dispatcher
	init_or_fail(t, &d, 4, 2)
	recs: [16]Rec
	for &r in recs {
		r.tally = &tally
		ok := lava.page_dispatcher_submit(
			&d,
			"const s = Date.now(); while (Date.now() - s < 100) {} process.exitCode = 7;",
			"<busy>",
			LIMITS,
			&r,
		)
		testing.expect(t, ok, "submit refused on an open dispatcher")
	}
	testing.expect(t, wait_done(&tally, len(recs), 30), "pages never finished")
	lava.page_dispatcher_shutdown(&d)
	for r, i in recs {
		testing.expectf(t, r.reports == 1 && r.status == .Ok && r.exit == 7, "page %d: %v", i, r)
	}
	testing.expectf(t, tally.n_threads == 4, "16 pages ran on %d of 4 workers", tally.n_threads)
	testing.expect_value(t, tally.on_submitter, 0)
}

// Least-loaded, not round-robin. One worker is pinned by a long page; once the two
// short pages beside it have finished, the next two pages must go to the two idle
// workers. Round-robin from where it stopped (the pinned worker is next in turn)
// would hand the pinned worker a second page and leave one idle.
@(test)
dispatcher_picks_the_least_loaded_worker :: proc(t: ^testing.T) {
	tally: Tally
	tally_init(&tally)
	d: lava.Page_Dispatcher
	init_or_fail(t, &d, 3, 4)
	recs: [5]Rec
	for &r in recs {
		r.tally = &tally
	}
	LONG :: "setTimeout(() => { process.exitCode = 7; }, 5000);"
	SHORT :: "setTimeout(() => { process.exitCode = 7; }, 20);"
	lava.page_dispatcher_submit(&d, LONG, "<long>", LIMITS, &recs[0])
	lava.page_dispatcher_submit(&d, SHORT, "<short>", LIMITS, &recs[1])
	lava.page_dispatcher_submit(&d, SHORT, "<short>", LIMITS, &recs[2])
	testing.expect(t, wait_done(&tally, 2, 10), "short pages never finished")
	load: [3]int
	testing.expect_value(t, lava.page_dispatcher_load(&d, load[:]), 3)
	pinned := -1
	for l, i in load {
		if l == 1 {
			pinned = i
		}
	}
	testing.expectf(t, pinned >= 0 && load[0] + load[1] + load[2] == 1, "loads with one long page running: %v", load)
	lava.page_dispatcher_submit(&d, LONG, "<long>", LIMITS, &recs[3])
	lava.page_dispatcher_submit(&d, LONG, "<long>", LIMITS, &recs[4])
	lava.page_dispatcher_load(&d, load[:])
	for l, i in load {
		testing.expectf(
			t,
			l == 1,
			"worker %d has %d pages after two submits beside one pinned worker (pinned: %d): got no pages / doubled up %v",
			i,
			l,
			pinned,
			load,
		)
	}
	lava.page_dispatcher_shutdown(&d, cancel = true)
	testing.expect_value(t, sync.atomic_load(&tally.done), 5)
}

// A page spinning at top level holds its own worker, never another: five short pages
// submitted one after another while it spins each land on the other worker and
// finish while the spinner is still running.
@(test)
dispatcher_busy_page_does_not_hold_other_workers :: proc(t: ^testing.T) {
	tally: Tally
	tally_init(&tally)
	d: lava.Page_Dispatcher
	init_or_fail(t, &d, 2, 2)
	spinner := Rec {
		tally = &tally,
	}
	lava.page_dispatcher_submit(
		&d,
		"const s = Date.now(); while (Date.now() - s < 2000) {} process.exitCode = 7;",
		"<spinner>",
		LIMITS,
		&spinner,
	)
	short: [5]Rec
	start := time.tick_now()
	for &r, i in short {
		r.tally = &tally
		lava.page_dispatcher_submit(&d, "setTimeout(() => { process.exitCode = 3; }, 10);", "<short>", LIMITS, &r)
		testing.expectf(t, wait_done(&tally, i + 1, 5), "short page %d did not finish beside the spinner", i)
	}
	elapsed := time.duration_seconds(time.tick_since(start))
	spinner_done := sync.atomic_load(&spinner.reports)
	testing.expectf(
		t,
		spinner_done == 0 && elapsed < 1.8,
		"short pages took %.2fs; spinner reported: %d",
		elapsed,
		spinner_done,
	)
	lava.page_dispatcher_shutdown(&d)
	testing.expectf(t, spinner.reports == 1 && spinner.status == .Ok && spinner.exit == 7, "spinner: %v", spinner)
	for r, i in short {
		testing.expectf(t, r.reports == 1 && r.status == .Ok && r.exit == 3, "short page %d: %v", i, r)
		testing.expectf(t, r.thread != spinner.thread, "short page %d ran on the spinner's worker", i)
	}
}

// Limits travel with the page to its worker: a timer spinner given a 0.2 s budget is
// killed by it, and the well-behaved pages beside it finish. With its limits dropped
// for any default the spinner would run its whole ~10 s and end .Ok.
@(test)
dispatcher_runaway_page_is_killed_alone :: proc(t: ^testing.T) {
	tally: Tally
	tally_init(&tally)
	d: lava.Page_Dispatcher
	init_or_fail(t, &d, 2, 4)
	SPINNER :: `
	let n = 0;
	function spin() {
		const s = Date.now(); while (Date.now() - s < 2) {}
		if (++n < 5000) setTimeout(spin, 0);
	}
	setTimeout(spin, 0);
	`
	STEADY :: `
	let n = 0;
	function step() {
		const s = Date.now(); while (Date.now() - s < 2) {}
		if (++n < 40) setTimeout(step, 1); else process.exitCode = 7;
	}
	setTimeout(step, 0);
	`
	bad := Rec {
		tally = &tally,
	}
	good: [6]Rec
	lava.page_dispatcher_submit(&d, SPINNER, "<spinner>", {entry_limit = 1, cpu_budget = 0.2}, &bad)
	for &r in good {
		r.tally = &tally
		lava.page_dispatcher_submit(&d, STEADY, "<steady>", {entry_limit = 1, cpu_budget = 5}, &r)
	}
	testing.expect(t, wait_done(&tally, 7, 60), "pages never finished")
	lava.page_dispatcher_shutdown(&d)
	testing.expectf(
		t,
		bad.status == .Execution_Error && bad.kill == .Cpu_Budget,
		"runaway not killed by its budget: %v",
		bad,
	)
	for r, i in good {
		testing.expectf(
			t,
			r.reports == 1 && r.status == .Ok && r.exit == 7,
			"page %d did not finish beside the runaway: %v",
			i,
			r,
		)
	}
}

// More pages than slots queue on the worker instead of failing. One worker with two
// slots, so a pool of two VMs: a third page opened at once would be refused for want
// of a VM (Native_Runtime_Unavailable), so twelve .Ok pages also show that no more
// than two were ever live.
@(test)
dispatcher_queues_past_capacity :: proc(t: ^testing.T) {
	tally: Tally
	tally_init(&tally)
	d: lava.Page_Dispatcher
	init_or_fail(t, &d, 1, 2)
	recs: [12]Rec
	for &r in recs {
		r.tally = &tally
		lava.page_dispatcher_submit(&d, "setTimeout(() => { process.exitCode = 7; }, 20);", "<queued>", LIMITS, &r)
	}
	testing.expect(t, wait_done(&tally, len(recs), 30), "pages never finished")
	lava.page_dispatcher_shutdown(&d)
	for r, i in recs {
		testing.expectf(t, r.reports == 1 && r.status == .Ok && r.exit == 7, "page %d: %v", i, r)
	}
}

// A global (and a builtin prototype) a page changes is visible neither to pages on
// other workers nor to the next page in its own, reused VM: one slot per worker, so a
// later page on the setter's thread is on the setter's VM. And on_done never runs on
// the submitting thread.
@(test)
dispatcher_pages_are_isolated_across_workers_and_reused_vms :: proc(t: ^testing.T) {
	tally: Tally
	tally_init(&tally)
	d: lava.Page_Dispatcher
	init_or_fail(t, &d, 2, 1)
	setter := Rec {
		tally = &tally,
	}
	lava.page_dispatcher_submit(
		&d,
		"globalThis.leak = 1; Array.prototype.leaked = 1; setTimeout(() => { process.exitCode = 7; }, 5);",
		"<setter>",
		LIMITS,
		&setter,
	)
	testing.expect(t, wait_done(&tally, 1, 10), "setter never finished")
	checkers: [8]Rec
	for &r in checkers {
		r.tally = &tally
		lava.page_dispatcher_submit(
			&d,
			"process.exitCode = (typeof leak === 'undefined' && [].leaked === undefined) ? 7 : 9;",
			"<checker>",
			LIMITS,
			&r,
		)
	}
	testing.expect(t, wait_done(&tally, 1 + len(checkers), 30), "checkers never finished")
	lava.page_dispatcher_shutdown(&d)
	testing.expectf(t, setter.status == .Ok && setter.exit == 7, "setter: %v", setter)
	on_setter_vm := 0
	for r, i in checkers {
		testing.expectf(
			t,
			r.reports == 1 && r.status == .Ok && r.exit == 7,
			"checker %d saw another page's global (exit 9) or failed: %v",
			i,
			r,
		)

		if r.thread == setter.thread {
			on_setter_vm += 1
		}
	}
	testing.expectf(
		t,
		on_setter_vm > 0 && on_setter_vm < len(checkers),
		"%d of %d checkers ran on the setter's worker: not both cases covered",
		on_setter_vm,
		len(checkers),
	)
	testing.expect_value(t, tally.on_submitter, 0)
}

// shutdown(drain): every accepted page — running or still queued — runs to its end and
// is reported exactly once.
@(test)
dispatcher_drain_shutdown_reports_every_page_once :: proc(t: ^testing.T) {
	tally: Tally
	tally_init(&tally)
	d: lava.Page_Dispatcher
	init_or_fail(t, &d, 3, 2)
	recs: [30]Rec
	for &r in recs {
		r.tally = &tally
		lava.page_dispatcher_submit(&d, "setTimeout(() => { process.exitCode = 7; }, 20);", "<drain>", LIMITS, &r)
	}
	lava.page_dispatcher_shutdown(&d)
	for r, i in recs {
		testing.expectf(
			t,
			r.reports == 1 && r.status == .Ok && r.exit == 7,
			"page %d not drained (reported %d times): %v",
			i,
			r.reports,
			r,
		)
	}
}

// shutdown(cancel): running pages (endless intervals, which no budget would end
// soon) and queued ones are each reported exactly once, .Cancelled. The pages would
// end on their own after 4 s, so a lost cancel reads as .Ok pages, not as a hang.
@(test)
dispatcher_cancel_shutdown_cancels_running_and_queued :: proc(t: ^testing.T) {
	tally: Tally
	tally_init(&tally)
	d: lava.Page_Dispatcher
	init_or_fail(t, &d, 1, 2)
	recs: [5]Rec
	for &r in recs {
		r.tally = &tally
		lava.page_dispatcher_submit(
			&d,
			"const i = setInterval(() => {}, 5); setTimeout(() => { clearInterval(i); process.exitCode = 7; }, 4000);",
			"<interval>",
			LIMITS,
			&r,
		)
	}
	time.sleep(200 * time.Millisecond)
	start := time.tick_now()
	lava.page_dispatcher_shutdown(&d, cancel = true)
	elapsed := time.duration_seconds(time.tick_since(start))
	for r, i in recs {
		testing.expectf(
			t,
			r.reports == 1 && r.status == .Execution_Error && r.kill == .Cancelled,
			"page %d not cancelled: %v",
			i,
			r,
		)
	}
	testing.expectf(t, elapsed < 2, "cancelling shutdown took %.2fs", elapsed)
}

@(private = "file")
CHAIN_PAGE :: "setTimeout(() => {}, 10);"

// chain submits a follow-up from inside on_done, on the worker thread, until the
// chain budget runs out; the dispatcher must refuse them once shutdown has begun.
@(private = "file")
chain :: proc(d: ^lava.Page_Dispatcher, user_data: rawptr, result: lava.Result) {
	result := result
	tally := cast(^Tally)user_data
	lava.result_destroy(&result)

	if sync.atomic_sub(&tally.chain_left, 1) > 0 {
		if lava.page_dispatcher_submit(d, CHAIN_PAGE, "<follow-up>", LIMITS, tally) {
			sync.atomic_add(&tally.accepted, 1)
		} else {
			sync.atomic_add(&tally.refused, 1)
		}
	}

	sync.atomic_add(&tally.done, 1)
}

// on_done keeps submitting while shutdown runs: follow-ups are accepted while the
// dispatcher is open and refused once shutdown has begun, every accepted one is
// reported (done == initial + accepted), and none lands on a worker that has already
// decided to exit. The chain is bounded so that a dispatcher which never refuses
// still ends — and fails `refused > 0` rather than hanging.
@(test)
dispatcher_refuses_follow_ups_once_shutdown_begins :: proc(t: ^testing.T) {
	tally: Tally
	tally_init(&tally)
	tally.chain_left = 400
	d: lava.Page_Dispatcher

	if !lava.page_dispatcher_init(&d, 3, 2, chain) {
		testing.fail_now(t, "page_dispatcher_init failed")
	}

	INITIAL :: 12
	for _ in 0 ..< INITIAL {
		lava.page_dispatcher_submit(&d, CHAIN_PAGE, "<chain>", LIMITS, &tally)
	}
	time.sleep(150 * time.Millisecond)
	lava.page_dispatcher_shutdown(&d)
	done := sync.atomic_load(&tally.done)
	accepted := sync.atomic_load(&tally.accepted)
	refused := sync.atomic_load(&tally.refused)
	testing.expectf(
		t,
		done == INITIAL + accepted,
		"done %d != %d initial + %d accepted follow-ups",
		done,
		INITIAL,
		accepted,
	)
	testing.expectf(t, refused > 0, "no follow-up was refused during shutdown (accepted %d)", accepted)
	testing.expectf(
		t,
		sync.atomic_load(&tally.chain_left) > 0,
		"the chain ran out before shutdown: the test did not exercise refusal",
	)
}

@(private = "file")
shutdown_proc :: proc(d: ^lava.Page_Dispatcher) {
	lava.page_dispatcher_shutdown(d)
}

// After shutdown a submit is refused (false, no on_done, no crash); shutdown is
// idempotent, a zero dispatcher refuses everything, and concurrent shutdowns all
// return with every page reported once.
@(test)
dispatcher_refuses_after_shutdown :: proc(t: ^testing.T) {
	tally: Tally
	tally_init(&tally)
	zero: lava.Page_Dispatcher
	r0 := Rec {
		tally = &tally,
	}
	testing.expect(
		t,
		!lava.page_dispatcher_submit(&zero, "1", "<zero>", LIMITS, &r0),
		"a never-initialised dispatcher accepted a page",
	)
	lava.page_dispatcher_shutdown(&zero)

	d: lava.Page_Dispatcher
	init_or_fail(t, &d, 2, 1)
	lava.page_dispatcher_shutdown(&d)
	testing.expect(
		t,
		!lava.page_dispatcher_submit(&d, "1", "<late>", LIMITS, &r0),
		"submit after shutdown was accepted",
	)
	lava.page_dispatcher_shutdown(&d)
	load: [2]int
	testing.expect_value(t, lava.page_dispatcher_load(&d, load[:]), 0)

	d2: lava.Page_Dispatcher
	init_or_fail(t, &d2, 2, 2)
	recs: [8]Rec
	for &r in recs {
		r.tally = &tally
		lava.page_dispatcher_submit(&d2, "setTimeout(() => { process.exitCode = 7; }, 30);", "<racing>", LIMITS, &r)
	}
	others: [3]^thread.Thread
	for &o in others {
		o = thread.create_and_start_with_poly_data(&d2, shutdown_proc)
	}
	lava.page_dispatcher_shutdown(&d2)
	for o in others {
		thread.destroy(o)
	}
	testing.expect(
		t,
		!lava.page_dispatcher_submit(&d2, "1", "<late>", LIMITS, &r0),
		"submit after concurrent shutdowns was accepted",
	)
	testing.expect_value(t, sync.atomic_load(&r0.reports), 0)
	for r, i in recs {
		testing.expectf(t, r.reports == 1 && r.status == .Ok && r.exit == 7, "page %d: %v", i, r)
	}
}

// Everything the dispatcher owns — workers, inboxes, job clones, the threads, every
// page's runtime state and Result — goes through the allocator it was given and
// comes back through it: zero outstanding and no bad free once shutdown returns,
// including pages that threw (an allocated message) and pages a cancel ended.
@(test)
dispatcher_allocations_pair_through_its_allocator :: proc(t: ^testing.T) {
	track: mem.Tracking_Allocator
	mem.tracking_allocator_init(&track, runtime.heap_allocator())
	defer mem.tracking_allocator_destroy(&track)
	// Recorded, not a panic: a bad free must fail this test, not the whole run.
	track.bad_free_callback = mem.tracking_allocator_bad_free_callback_add_to_array
	alloc := mem.tracking_allocator(&track)

	tally: Tally
	tally_init(&tally)
	for round in 0 ..< 2 {
		d: lava.Page_Dispatcher
		init_or_fail(t, &d, 2, 2, alloc)
		recs: [12]Rec
		for &r, i in recs {
			r.tally = &tally
			src := "setTimeout(() => { process.exitCode = 7; }, 10);"

			if i % 3 == 1 {src = "throw new Error('boom ' + 'x'.repeat(64));"}

			if i % 3 == 2 {src = "setInterval(() => {}, 5);"}

			lava.page_dispatcher_submit(&d, src, "<alloc>", LIMITS, &r)
		}
		time.sleep(100 * time.Millisecond)
		lava.page_dispatcher_shutdown(&d, cancel = true)
		for r, i in recs {
			testing.expectf(t, r.reports == 1, "round %d page %d reported %d times", round, i, r.reports)
		}
	}
	sync.lock(&track.mutex)
	outstanding := len(track.allocation_map)
	bad := len(track.bad_free_array)
	sync.unlock(&track.mutex)
	testing.expectf(t, outstanding == 0, "dispatcher leaked %d allocations on its allocator", outstanding)
	testing.expectf(
		t,
		bad == 0,
		"dispatcher made %d bad free(s) on its allocator: something it owns was freed elsewhere",
		bad,
	)
}

// The dispatcher's own descriptors — a wake pipe and an epoll set per worker — and
// every page's loop descriptors are closed once shutdown returns, and so are the VMs'
// timerfds and each worker's RunLoop drive (its GLib context's wakeup eventfd and the
// drive's epoll set: runloop_thread_teardown). A VM's timerfd closes once the thread's
// RunLoop is iterated after the VM is released (vm_pool_releases_its_timerfds), and a
// worker's RunLoop also ends with the thread, before join returns — measured here at 0
// left of the 6 VMs' timerfds. Only meaningful on one runner thread (fd_census).
@(test)
dispatcher_closes_its_descriptors :: proc(t: ^testing.T) {
	when RUNNER_THREADS != 1 {
		log.info("skipped: /proc/self/fd is process-wide; needs -define:ODIN_TEST_THREADS=1")
		return
	}
	// Round 0 is a warm-up: JSC's one-time process initialisation opens descriptors of
	// its own on first use, which no dispatcher could close.
	before, timers_before, timers_live: int
	for round in 0 ..< 2 {
		before = fd_census()
		timers_before = fd_census(timerfds_only = true)
		tally: Tally
		tally_init(&tally)
		d: lava.Page_Dispatcher
		init_or_fail(t, &d, 3, 2)
		recs: [30]Rec
		for &r in recs {
			r.tally = &tally
			lava.page_dispatcher_submit(&d, "setTimeout(() => { process.exitCode = 7; }, 5);", "<fd>", LIMITS, &r)
		}
		testing.expect(t, wait_done(&tally, len(recs), 30), "pages never finished")
		timers_live = fd_census(timerfds_only = true) - timers_before
		lava.page_dispatcher_shutdown(&d)
		for r, i in recs {
			testing.expectf(t, r.reports == 1 && r.status == .Ok, "round %d page %d: %v", round, i, r)
		}
	}
	after := fd_census()
	timers := fd_census(timerfds_only = true) - timers_before
	log.infof("fd delta %d, timerfd delta %d (%d while the workers lived)", after - before, timers, timers_live)
	testing.expectf(t, timers_live > 0, "no VM timerfd while the workers lived: the census cannot see them")
	testing.expectf(t, timers == 0, "%d VM timerfds outlived the worker threads", timers)
	testing.expectf(t, after == before, "dispatcher left %d descriptors open", after - before)
}

// A dispatcher worker gives back its thread's host-native tables when it ends
// (host_native_thread_teardown); before, every thread that ran a page leaked them.
// Process-wide counter, so only meaningful on one runner thread.
@(test)
dispatcher_workers_give_back_their_host_tables :: proc(t: ^testing.T) {
	when RUNNER_THREADS != 1 {
		log.info("skipped: host_native_tables_live is process-wide; needs -define:ODIN_TEST_THREADS=1")
		return
	}
	before := lava.host_native_tables_live()
	tally: Tally
	tally_init(&tally)
	d: lava.Page_Dispatcher
	init_or_fail(t, &d, 3, 1)
	recs: [6]Rec
	for &r in recs {
		r.tally = &tally
		lava.page_dispatcher_submit(&d, "require('buffer'); process.exitCode = 7;", "<tables>", LIMITS, &r)
	}
	testing.expect(t, wait_done(&tally, len(recs), 30), "pages never finished")
	during := lava.host_native_tables_live()
	lava.page_dispatcher_shutdown(&d)
	after := lava.host_native_tables_live()
	testing.expectf(
		t,
		during > before,
		"pages bound no host tables (%d -> %d): the test proves nothing",
		before,
		during,
	)
	testing.expectf(t, after == before, "worker threads left %d host-native table set(s) behind", after - before)
}

// init refuses what it cannot run — no thread, no slot, no on_done — and allocates
// nothing doing so; the refused dispatcher refuses pages.
@(test)
dispatcher_init_refuses_bad_arguments :: proc(t: ^testing.T) {
	track: mem.Tracking_Allocator
	mem.tracking_allocator_init(&track, runtime.heap_allocator())
	defer mem.tracking_allocator_destroy(&track)
	alloc := mem.tracking_allocator(&track)
	d: lava.Page_Dispatcher
	testing.expect(t, !lava.page_dispatcher_init(&d, 0, 1, record, allocator = alloc), "init accepted 0 threads")
	testing.expect(
		t,
		!lava.page_dispatcher_init(&d, 1, 0, record, allocator = alloc),
		"init accepted 0 pages per thread",
	)
	testing.expect(t, !lava.page_dispatcher_init(&d, 1, 1, nil, allocator = alloc), "init accepted a nil on_done")
	testing.expect(t, !lava.page_dispatcher_submit(&d, "1", "<x>", LIMITS), "a refused dispatcher accepted a page")
	lava.page_dispatcher_shutdown(&d)
	testing.expect_value(t, track.total_allocation_count, 0)
}

// A worker that cannot start (its wake pipe or epoll set refused: RLIMIT_NOFILE is
// pinned just above what is open) fails init as a whole, and the workers that did
// start are stopped and joined: nothing allocated stays out, no descriptor stays open.
// Mutates a process-wide limit, so one runner thread only.
@(test)
dispatcher_init_failure_leaves_nothing_behind :: proc(t: ^testing.T) {
	when RUNNER_THREADS != 1 {
		log.info("skipped: mutates RLIMIT_NOFILE process-wide; needs -define:ODIN_TEST_THREADS=1")
		return
	}
	track: mem.Tracking_Allocator
	mem.tracking_allocator_init(&track, runtime.heap_allocator())
	defer mem.tracking_allocator_destroy(&track)
	alloc := mem.tracking_allocator(&track)

	probe, probe_err := linux.epoll_create1({.FDCLOEXEC})

	if probe_err != nil {
		testing.fail_now(t, "could not open a probe descriptor")
	}

	linux.close(probe)
	before := fd_census()
	saved: linux.RLimit

	if linux.getrlimit(.NOFILE, &saved) != nil {
		testing.fail_now(t, "getrlimit failed")
	}

	// Room for a handful of descriptors above the lowest free number (3 per worker),
	// far short of the 64 workers asked for, whatever holes lie below.
	tight := linux.RLimit {
		cur = uint(probe) + 8,
		max = saved.max,
	}

	if linux.setrlimit(.NOFILE, &tight) != nil {
		testing.fail_now(t, "setrlimit failed")
	}

	d: lava.Page_Dispatcher
	ok := lava.page_dispatcher_init(&d, 64, 1, record, allocator = alloc)
	linux.setrlimit(.NOFILE, &saved)
	testing.expect(t, !ok, "init succeeded with descriptors for only a few workers")

	if ok {
		lava.page_dispatcher_shutdown(&d)
	}

	testing.expect(t, !lava.page_dispatcher_submit(&d, "1", "<x>", LIMITS), "a failed dispatcher accepted a page")
	testing.expect(
		t,
		track.total_allocation_count > 0,
		"init failed before it allocated anything: the cleanup path did not run",
	)
	sync.lock(&track.mutex)
	outstanding := len(track.allocation_map)
	sync.unlock(&track.mutex)
	testing.expectf(t, outstanding == 0, "failed init left %d allocations behind", outstanding)
	testing.expectf(t, fd_census() == before, "failed init left %d descriptors open", fd_census() - before)
}

// init's heap_sample_every reaches every worker's runner: sampling every page gives each
// .Ok page a heap sample, and the default samples none.
@(test)
dispatcher_forwards_heap_sampling :: proc(t: ^testing.T) {
	for every in ([]int{1, 0}) {
		tally: Tally
		tally_init(&tally)
		d: lava.Page_Dispatcher

		if !lava.page_dispatcher_init(&d, 2, 2, record, heap_sample_every = every) {
			testing.fail_now(t, "page_dispatcher_init failed")
		}

		recs: [6]Rec
		for &r in recs {
			r.tally = &tally
			lava.page_dispatcher_submit(&d, "setTimeout(() => { process.exitCode = 7; }, 5);", "<heap>", LIMITS, &r)
		}
		lava.page_dispatcher_shutdown(&d)
		for r, i in recs {
			testing.expectf(t, r.reports == 1 && r.status == .Ok, "every=%d page %d: %v", every, i, r)

			if every == 1 {
				testing.expectf(
					t,
					r.heap > 0,
					"sampling every page, page %d was not sampled: heap_bytes %d",
					i,
					r.heap,
				)
			} else {
				testing.expectf(t, r.heap == 0, "sampling off, page %d was sampled: heap_bytes %d", i, r.heap)
			}
		}
	}
}

// A worker that has been woken once and then gone idle still wakes for the next page.
// Every page is submitted only after the previous one finished and the worker has had
// 100 ms to go back to sleep in its runner's epoll wait, so each needs a fresh wake
// (worker_wake's `posted` flag cleared by the worker in between). A worker that never
// clears it leaves every later submit without a write: the page is never run, and the
// shutdown that would wake the worker hangs too.
@(test)
dispatcher_wakes_an_idle_worker_again :: proc(t: ^testing.T) {
	tally: Tally
	tally_init(&tally)
	d: lava.Page_Dispatcher
	init_or_fail(t, &d, 1, 1)
	recs: [4]Rec
	for &r, i in recs {
		r.tally = &tally
		lava.page_dispatcher_submit(&d, "process.exitCode = 7;", "<idle>", LIMITS, &r)

		if !wait_done(&tally, i + 1, 5) {
			testing.expectf(t, false, "worker never woke for page %d after going idle", i)
			break
		}

		time.sleep(100 * time.Millisecond)
	}
	lava.page_dispatcher_shutdown(&d)
	for r, i in recs {
		testing.expectf(t, r.reports == 1 && r.status == .Ok && r.exit == 7, "page %d: %v", i, r)
	}
}

// thread_cpu_ticks reads utime + stime of one thread of this process, in clock ticks
// (/proc/self/task/<tid>/stat fields 14 and 15); -1 when it cannot be read.
@(private = "file")
thread_cpu_ticks :: proc(tid: int) -> int {
	path := fmt.tprintf("/proc/self/task/%d/stat", tid)
	data, err := os.read_entire_file(path, context.temp_allocator)

	if err != nil {
		return -1
	}

	text := string(data)
	// The command name (field 2) may hold spaces; fields are counted after its ')'.
	close_paren := strings.last_index_byte(text, ')')

	if close_paren < 0 {
		return -1
	}

	fields := strings.fields(text[close_paren + 1:], context.temp_allocator)

	// fields[0] is field 3 (state), so utime (14) and stime (15) are [11] and [12].
	if len(fields) < 13 {
		return -1
	}

	utime, ok1 := strconv.parse_int(fields[11])
	stime, ok2 := strconv.parse_int(fields[12])

	if !ok1 || !ok2 {
		return -1
	}

	return utime + stime
}

// Idle workers sleep. After a page each, both workers have been woken through their
// pipes; with nothing left to run, each must block in its runner's epoll wait instead
// of returning at once on a pipe it never drained (the pipe is level-triggered). 400 ms
// of idling is measured on each worker's own CPU clock: a sleeping worker spends 0-1
// ticks of it, a spinning one, even sharing two cores with the other and this thread,
// well over 10.
@(test)
dispatcher_idle_workers_sleep :: proc(t: ^testing.T) {
	tally: Tally
	tally_init(&tally)
	d: lava.Page_Dispatcher
	init_or_fail(t, &d, 2, 1)
	recs: [2]Rec
	for &r in recs {
		r.tally = &tally
		lava.page_dispatcher_submit(&d, "process.exitCode = 7;", "<idle>", LIMITS, &r)
	}
	testing.expect(t, wait_done(&tally, 2, 10), "pages never finished")
	testing.expectf(t, recs[0].thread != recs[1].thread, "both pages ran on one worker: %d", recs[0].thread)
	// Let both workers finish the round that reported the page.
	time.sleep(50 * time.Millisecond)
	before := [2]int{thread_cpu_ticks(recs[0].thread), thread_cpu_ticks(recs[1].thread)}
	time.sleep(400 * time.Millisecond)
	after := [2]int{thread_cpu_ticks(recs[0].thread), thread_cpu_ticks(recs[1].thread)}
	lava.page_dispatcher_shutdown(&d)
	for i in 0 ..< 2 {
		testing.expectf(t, before[i] >= 0 && after[i] >= 0, "could not read worker %d's CPU clock", i)
		testing.expectf(
			t,
			after[i] - before[i] <= 3,
			"idle worker %d burned %d ticks of CPU in 400 ms: it spins instead of sleeping",
			i,
			after[i] - before[i],
		)
	}
}
