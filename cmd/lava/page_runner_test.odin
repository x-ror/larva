// Linux-only: the page runner waits on page loops through epoll; elsewhere it refuses
// to start (page_runner_other.odin).
#+build linux
package main

import "core:fmt"
import "core:log"
import "core:os"
import "core:strings"
import "core:sys/linux"
import "core:testing"
import "core:thread"
import "core:time"
import jsc "lava:pkg/jsc"
import lava "lava:pkg/runtime"
import eventloop "lava:pkg/runtime/eventloop"

// LIMITS is what a page under test runs with when its limits are not the subject: the
// runner refuses a page without a CPU budget, and 30 s is far above anything a
// passing case spends, so reaching it is itself a failure (a kill, not exit 1).
@(private = "file")
LIMITS :: lava.Page_Limits {
	cpu_budget = 30,
}

// A well-behaved page: 40 timer turns of ~2 ms work, then a throw (exit 1) to prove it ran
// to the end rather than being cut short with its siblings.
@(private = "file")
STEADY_PAGE :: `
let n = 0;
function step() {
	const s = Date.now(); while (Date.now() - s < 2) {}
	if (++n < 40) setTimeout(step, 1); else throw 7;
}
setTimeout(step, 0);
`

@(private = "file")
run_with_one_bad_page :: proc(
	t: ^testing.T,
	bad_source: string,
	bad_limits: lava.Page_Limits,
	want_kill: lava.Kill_Reason,
) {
	runner: lava.Page_Runner

	if !lava.page_runner_init(&runner, 4, record_page_outcome, context.allocator) {
		testing.fail_now(t, "page_runner_init failed")
	}

	defer lava.page_runner_destroy(&runner)

	outcomes: [4]Page_Outcome
	good := lava.Page_Limits {
		entry_limit = 1,
		cpu_budget  = 5,
	}
	lava.page_runner_open(&runner, STEADY_PAGE, "<good-0>", good, &outcomes[0])
	lava.page_runner_open(&runner, bad_source, "<bad>", bad_limits, &outcomes[1])
	lava.page_runner_open(&runner, STEADY_PAGE, "<good-1>", good, &outcomes[2])
	lava.page_runner_open(&runner, STEADY_PAGE, "<good-2>", good, &outcomes[3])
	testing.expect_value(t, lava.page_runner_live(&runner), 4)
	lava.page_runner_run(&runner)

	testing.expect(t, outcomes[1].done, "bad page never reported")
	testing.expect_value(t, outcomes[1].status, lava.Status.Execution_Error)
	testing.expect_value(t, outcomes[1].kill, want_kill)
	for i in ([]int{0, 2, 3}) {
		testing.expectf(t, outcomes[i].done, "page %d never reported", i)
		testing.expectf(
			t,
			outcomes[i].status == .Ok && outcomes[i].exit == 1,
			"page %d did not finish beside the killed page: %s",
			i,
			describe_outcome(outcomes[i]),
		)
	}
}

// Acceptance (#4): a `while(true){}` page is killed by its VM's limit and the other
// pages on the thread finish. The runaway starts after the others are mid-flight.
@(test)
runner_entry_limit_kills_only_the_runaway_page :: proc(t: ^testing.T) {
	run_with_one_bad_page(
		t,
		"setTimeout(() => { while (true) {} }, 20);",
		{entry_limit = 0.1, cpu_budget = 30},
		.Entry_Limit,
	)
}

// Acceptance (#4): a page spinning thousands of short timers is killed by the
// cumulative CPU budget, and the other pages on the thread finish.
@(test)
runner_cpu_budget_kills_only_the_spinner :: proc(t: ^testing.T) {
	spinner := `
	let n = 0;
	function spin() {
		const s = Date.now(); while (Date.now() - s < 2) {}
		if (++n < 5000) setTimeout(spin, 0);
	}
	setTimeout(spin, 0);
	`
	run_with_one_bad_page(t, spinner, {entry_limit = 1, cpu_budget = 0.2}, .Cpu_Budget)
}

// Pages on one runner wait concurrently: ten pages that each sleep 600 ms finish in
// about 600 ms, not 6 s, and the runner blocks rather than spins while every page waits.
//
// Both are measured past the opens. Ten page opens are CPU work (runtime install and the
// top-level script: 0.28-0.39 s of CPU for the ten) whose wall time grows with load —
// 4-6 s for the whole test at load ~18 on 4 cores, which is what a clock started before
// them timed. A page's timer counts from its loop's first tick, not from its open: the
// run alone took 0.600 s in every run, however long the opens had taken. So from the
// first round on it is 600 ms of timer wait, against 6 s if the pages waited one after
// another, and almost no CPU for load to stretch.
//
// Spinning is counted in rounds (page_runner_step calls), not CPU: 45-49 rounds
// blocking, 92k-130k with runner_wait removed (the recorded mutation), three runs each
// at load ~18. The CPU bound this used to assert (< 0.2 s) has the opposite weakness: a
// spinning runner that load deschedules burns less CPU — 0.48-0.50 s there, and less the
// more load there is — while it still runs tens of thousands of rounds.
@(test)
runner_pages_wait_concurrently :: proc(t: ^testing.T) {
	runner: lava.Page_Runner

	if !lava.page_runner_init(&runner, 10, record_page_outcome, context.allocator) {
		testing.fail_now(t, "page_runner_init failed")
	}

	defer lava.page_runner_destroy(&runner)
	outcomes: [10]Page_Outcome
	for i in 0 ..< 10 {
		lava.page_runner_open(
			&runner,
			"setTimeout(() => { throw 3; }, 600);",
			"<sleeper>",
			LIMITS,
			&outcomes[i],
		)
	}
	testing.expect_value(t, lava.page_runner_live(&runner), 10)
	start := time.tick_now()
	rounds := 0
	for lava.page_runner_live(&runner) > 0 {
		lava.page_runner_step(&runner)
		rounds += 1
	}
	wall := time.duration_seconds(time.tick_since(start))
	for o, i in outcomes {
		testing.expectf(t, o.done && o.status == .Ok && o.exit == 1, "page %d: %s", i, describe_outcome(o))
	}
	testing.expectf(t, wall < 2.5, "10 x 600 ms pages took %.2fs: they ran one after another", wall)
	testing.expectf(t, rounds < 1000, "runner spun %d rounds while every page waited on a timer", rounds)
}

// A page that never gets a VM (the runner is full) is reported, not dropped — from the
// run loop, never from inside page_runner_open, so on_done cannot recurse.
@(test)
runner_reports_a_page_it_cannot_start :: proc(t: ^testing.T) {
	runner: lava.Page_Runner

	if !lava.page_runner_init(&runner, 1, record_page_outcome, context.allocator) {
		testing.fail_now(t, "page_runner_init failed")
	}

	defer lava.page_runner_destroy(&runner)
	a, b: Page_Outcome
	lava.page_runner_open(&runner, "setTimeout(() => {}, 50);", "<a>", LIMITS, &a)
	lava.page_runner_open(&runner, "1", "<b>", LIMITS, &b)
	testing.expect(t, !b.done, "a page that failed at open was reported from inside page_runner_open")
	lava.page_runner_run(&runner)
	testing.expect(t, b.done, "page without a VM was not reported")
	testing.expect_value(t, b.status, lava.Status.Native_Runtime_Unavailable)
	testing.expect(t, a.done && a.status == .Ok, "the running page did not finish")
}

// BUSY_PAGE is a chain of 30 0 ms timers, each set by the one before, so it needs 30
// turns and a stall in any round delays every step after it. From the sixth timer on,
// HTML's nesting clamp (#116, eventloop TIMER_NESTING_LEVEL_MAX) makes each wait 4 ms,
// so the chain is ~0.1 s of wall time and nearly none of CPU. It is short on purpose:
// this test used a 100-step chain of 1 ms timers, which the clamp turned into 0.44-0.47 s
// for the page alone (4-core box, unloaded; a 4 ms chain measured the same), ~0.55 s
// beside its sibling — the clamp, not the sibling, was what a 0.6 s bound was timing,
// and load pushed it over.
@(private = "file")
BUSY_PAGE :: "let n = 0; (function f() { if (++n < 30) setTimeout(f, 0); })();"

// A busy page must not wait on its sibling's timers. The sibling's only timer is 1 s
// out. If a page loop may block in its own poll (never_block off, the recorded
// mutation), the sibling's tick sleeps in every round until that timer or GLib's next
// deadline, whichever is first: the busy chain advances a step per stall, and once
// JSC's early deadlines are past, one stall runs to the sibling's timer — the sibling
// is reported first. With never_block on, the busy page finishes at ~0.1 s, all of it
// the clamp's wall time. Measured by timing each page_runner_step round of this pair,
// one run per arm, unloaded 4-core box: busy reported at 95 ms with never_block on;
// with it off, the sibling at 0.97 s and the busy chain not yet done.
// The measure is report order, not a clock bound, with a ~10x margin a loaded machine
// does not erode: the busy page's time is timer waits, not CPU.
@(test)
runner_busy_page_is_not_held_up_by_a_waiting_sibling :: proc(t: ^testing.T) {
	runner: lava.Page_Runner

	if !lava.page_runner_init(&runner, 2, record_finished, context.allocator) {
		testing.fail_now(t, "page_runner_init failed")
	}

	defer lava.page_runner_destroy(&runner)
	reported := 0
	waiting := Finished {
		reported = &reported,
	}
	busy := Finished {
		reported = &reported,
	}
	// Opened first, so every round ticks the waiting page before the busy one.
	lava.page_runner_open(&runner, "setTimeout(() => {}, 1000);", "<waiting>", LIMITS, &waiting)
	lava.page_runner_open(&runner, BUSY_PAGE, "<busy>", LIMITS, &busy)
	lava.page_runner_run(&runner)
	testing.expectf(t, busy.outcome.status == .Ok, "busy page failed: %s", describe_outcome(busy.outcome))
	testing.expectf(t, waiting.outcome.status == .Ok, "waiting page failed: %s", describe_outcome(waiting.outcome))
	testing.expectf(
		t,
		busy.at == 1 && waiting.at == 2,
		"busy page reported %d, after its sibling (%d): it waited on its sibling's timers",
		busy.at,
		waiting.at,
	)
}

@(private = "file")
Reuse :: struct {
	first, second: Page_Outcome,
	opened_second: bool,
}

@(private = "file")
reuse_done :: proc(runner: ^lava.Page_Runner, user_data: rawptr, result: lava.Result) {
	r := cast(^Reuse)user_data

	if !r.opened_second {
		record_page_outcome(runner, &r.first, result)
		r.opened_second = true
		// The killed page's VM is the runner's only one, so this page reuses it.
		lava.page_runner_open(
			runner,
			`const clean = typeof leak === 'undefined' && typeof leakRan === 'undefined';

			globalThis.n2 = 0; const t0 = Date.now(); setTimeout(() => { if (clean && typeof leakRan === 'undefined') throw 11; }, 30);`,
			"<second>",
			LIMITS,
			r,
		)
		return
	}
	record_page_outcome(runner, &r.second, result)
}

// The next page on a killed page's VM slot sees nothing of it (CLAUDE.md §6): not its
// global, not its interval, and not its endless promise-job chain — the sharp case,
// since JSC's job queue belongs to the VM and the chain would otherwise resume inside
// the second page's entry (vm_quiesce), hanging a page that has no limits.
@(test)
runner_second_page_in_a_reused_vm_sees_nothing_of_a_killed_first :: proc(t: ^testing.T) {
	runner: lava.Page_Runner

	if !lava.page_runner_init(&runner, 1, reuse_done, context.allocator) {
		testing.fail_now(t, "page_runner_init failed")
	}

	defer lava.page_runner_destroy(&runner)
	r: Reuse
	lava.page_runner_open(
		&runner,
		`globalThis.leak = 1;
		setInterval(() => { globalThis.leakRan = 1; }, 1);
		setTimeout(() => { (function f() { Promise.resolve().then(f); })(); }, 5);`,
		"<first>",
		{entry_limit = 0.1, cpu_budget = LIMITS.cpu_budget},
		&r,
	)
	lava.page_runner_run(&runner)
	testing.expect_value(t, r.first.kill, lava.Kill_Reason.Entry_Limit)
	testing.expectf(
		t,
		r.second.done && r.second.status == .Ok && r.second.exit == 1,
		"second page saw the first: %s",
		describe_outcome(r.second),
	)
	_, created, _ := lava.vm_pool_stats(&runner.pool)
	testing.expect_value(t, created, 1)
}

// Destroying a runner with pages still running reports each as .Cancelled — not as a
// page that finished — without running any more of its code.
@(test)
runner_destroy_reports_live_pages_cancelled :: proc(t: ^testing.T) {
	runner: lava.Page_Runner

	if !lava.page_runner_init(&runner, 2, record_page_outcome, context.allocator) {
		testing.fail_now(t, "page_runner_init failed")
	}

	o: Page_Outcome
	lava.page_runner_open(&runner, "setTimeout(() => {}, 10000);", "<long>", LIMITS, &o)
	lava.page_runner_destroy(&runner)
	testing.expect(t, o.done, "a live page was not reported on destroy")
	testing.expect_value(t, o.kill, lava.Kill_Reason.Cancelled)
	testing.expect_value(t, o.status, lava.Status.Execution_Error)
}

// epoll_watched_kinds reads what each fd an epoll instance watches is, from the
// "tfd:" lines of its fdinfo and each fd's /proc/self/fd link.
@(private = "file")
epoll_watched_kinds :: proc(epfd: linux.Fd) -> []string {
	data, err := os.read_entire_file(fmt.tprintf("/proc/self/fdinfo/%d", int(epfd)), context.temp_allocator)

	if err != nil {
		return nil
	}

	kinds := make([dynamic]string, context.temp_allocator)
	for line in strings.split_lines(string(data), context.temp_allocator) {
		rest := strings.trim_space(line)

		if !strings.has_prefix(rest, "tfd:") {
			continue
		}

		fields := strings.fields(strings.trim_space(rest[4:]), context.temp_allocator)

		if len(fields) == 0 {
			continue
		}

		target, lerr := os.read_link(fmt.tprintf("/proc/self/fd/%s", fields[0]), context.temp_allocator)
		append(&kinds, lerr == nil ? target : "?")
	}
	return kinds[:]
}

// epoll_watch_count reads how many fds an epoll instance watches, from the "tfd:"
// lines of its /proc/self/fdinfo entry.
@(private = "file")
epoll_watch_count :: proc(epfd: linux.Fd) -> int {
	data, err := os.read_entire_file(fmt.tprintf("/proc/self/fdinfo/%d", int(epfd)), context.temp_allocator)

	if err != nil {
		return -1
	}

	return strings.count(string(data), "tfd:")
}

// A runner page must carry a CPU budget, or the runner's one guarantee — a page that
// spins is killed alone (docs/LARVA.md stage 1) — would hold only for callers who
// remembered to ask. The budget specifically: an entry limit alone bounds one entry,
// and a page of endless short callbacks lives forever under it. NaN and negative
// budgets mean "none" to vm_set_cpu_budget, so they are refused too. The refusal
// happens before the page takes a loop or a VM, and is reported from the run loop —
// never from inside page_runner_open.
@(test)
runner_refuses_a_page_without_a_cpu_budget :: proc(t: ^testing.T) {
	runner: lava.Page_Runner

	if !lava.page_runner_init(&runner, 4, record_page_outcome, context.allocator) {
		testing.fail_now(t, "page_runner_init failed")
	}

	defer lava.page_runner_destroy(&runner)
	nan := 0.0
	nan = nan / nan
	bad := [4]lava.Page_Limits{{}, {cpu_budget = -1}, {cpu_budget = nan}, {entry_limit = 0.1}}
	outcomes: [4]Page_Outcome
	for limits, i in bad {
		lava.page_runner_open(
			&runner,
			"setTimeout(() => {}, 1);",
			"<unbudgeted>",
			limits,
			&outcomes[i],
		)
		testing.expectf(t, !outcomes[i].done, "limits %v: refusal reported from inside page_runner_open", limits)
	}
	testing.expect_value(t, lava.page_runner_live(&runner), 0)
	_, created, _ := lava.vm_pool_stats(&runner.pool)
	testing.expect_value(t, created, 0)
	lava.page_runner_run(&runner)
	for o, i in outcomes {
		testing.expectf(t, o.done && o.status == .Invalid_Input && o.kill == .None, "limits %v: %s", bad[i], describe_outcome(o))
	}
}

@(private = "file")
Heap_Outcome :: struct {
	done:   bool,
	status: lava.Status,
	kill:   lava.Kill_Reason,
	heap:   i64,
}

@(private = "file")
record_heap :: proc(runner: ^lava.Page_Runner, user_data: rawptr, result: lava.Result) {
	result := result
	o := cast(^Heap_Outcome)user_data
	o^ = {
		done   = true,
		status = result.status,
		kill   = result.kill,
		heap   = result.heap_bytes,
	}
	lava.result_destroy(&result)
}

// run_one_by_one runs each page to its end before opening the next, on a one-slot
// runner, so every page is on the same VM and the VM's page count is the page's
// index + 1.
@(private = "file")
run_one_by_one :: proc(t: ^testing.T, every: int, sources: []string, limits: []lava.Page_Limits, out: []Heap_Outcome) {
	runner: lava.Page_Runner

	if !lava.page_runner_init(&runner, 1, record_heap, context.allocator) {
		testing.fail_now(t, "page_runner_init failed")
	}

	defer lava.page_runner_destroy(&runner)
	runner.heap_sample_every = every
	for src, i in sources {
		lava.page_runner_open(&runner, src, "<heap>", limits[i], &out[i])
		lava.page_runner_run(&runner)
	}
}

// Sampling is off by default and reports 0; on, every page's heap is sampled (> 0).
@(test)
runner_heap_sampling_is_off_by_default :: proc(t: ^testing.T) {
	src := []string{"globalThis.x = 0;"}
	lim := []lava.Page_Limits{LIMITS}
	off, on: [1]Heap_Outcome
	run_one_by_one(t, 0, src, lim, off[:])
	run_one_by_one(t, 1, src, lim, on[:])
	testing.expectf(t, off[0].done && off[0].status == .Ok && off[0].heap == 0, "sampling off: %v", off[0])
	testing.expectf(t, on[0].done && on[0].status == .Ok && on[0].heap > 0, "sampling on, heap not sampled: %v", on[0])
}

// Every Nth page PER VM: one by one on one VM with N = 2, only the second of three
// pages is sampled; and with two VMs each hosting two pages at once, both second
// pages are sampled and neither first — a per-runner count would sample the second
// and fourth page opened instead.
@(test)
runner_samples_every_nth_page_per_vm :: proc(t: ^testing.T) {
	src := []string{"1", "1", "1"}
	lim := []lava.Page_Limits{LIMITS, LIMITS, LIMITS}
	seq: [3]Heap_Outcome
	run_one_by_one(t, 2, src, lim, seq[:])
	testing.expectf(
		t,
		seq[0].heap == 0 && seq[1].heap > 0 && seq[2].heap == 0,
		"sampled the wrong pages on one VM: %v %v %v",
		seq[0].heap,
		seq[1].heap,
		seq[2].heap,
	)

	runner: lava.Page_Runner

	if !lava.page_runner_init(&runner, 2, record_heap, context.allocator) {
		testing.fail_now(t, "page_runner_init failed")
	}

	defer lava.page_runner_destroy(&runner)
	runner.heap_sample_every = 2
	pair: [4]Heap_Outcome
	lava.page_runner_open(&runner, "setTimeout(() => {}, 5);", "<a>", LIMITS, &pair[0])
	lava.page_runner_open(&runner, "setTimeout(() => {}, 5);", "<b>", LIMITS, &pair[1])
	lava.page_runner_run(&runner)
	lava.page_runner_open(&runner, "setTimeout(() => {}, 5);", "<c>", LIMITS, &pair[2])
	lava.page_runner_open(&runner, "setTimeout(() => {}, 5);", "<d>", LIMITS, &pair[3])
	lava.page_runner_run(&runner)
	testing.expectf(
		t,
		pair[0].heap == 0 && pair[1].heap == 0 && pair[2].heap > 0 && pair[3].heap > 0,
		"sampled the wrong pages across two VMs: %v %v %v %v",
		pair[0].heap,
		pair[1].heap,
		pair[2].heap,
		pair[3].heap,
	)
}

// A page a limit ended is not sampled — its heap is not a finished page's, and the
// sampling call would run whatever jobs the kill left queued — while the next page on
// the same VM is.
@(test)
runner_does_not_sample_a_killed_page :: proc(t: ^testing.T) {
	src := []string{"while (true) {}", "1"}
	lim := []lava.Page_Limits{{entry_limit = 0.05, cpu_budget = 30}, LIMITS}
	out: [2]Heap_Outcome
	run_one_by_one(t, 1, src, lim, out[:])
	testing.expectf(t, out[0].kill == .Entry_Limit, "runaway page was not killed: %v", out[0])
	testing.expectf(t, out[0].heap == 0, "a killed page was sampled: %v", out[0])
	testing.expectf(t, out[1].status == .Ok && out[1].heap > 0, "the page after it was not sampled: %v", out[1])
}

// The sample is the page's heap: a page holding 200k objects reads more than 4 MB
// above a trivial page run before it on the same VM.
@(test)
runner_heap_sample_grows_with_the_page :: proc(t: ^testing.T) {
	src := []string{"1", "globalThis.keep = Array.from({ length: 200000 }, (_, i) => ({ i, s: 'x' + i }));"}
	lim := []lava.Page_Limits{LIMITS, LIMITS}
	out: [2]Heap_Outcome
	run_one_by_one(t, 1, src, lim, out[:])
	testing.expectf(
		t,
		out[0].heap > 0 && out[1].heap > out[0].heap + 4 << 20,
		"heap not attributed per page: light %d, heavy %d",
		out[0].heap,
		out[1].heap,
	)
}

// A sampled heap at or above lava.HEAP_COLLECT_BYTES gets its VM a full collection
// before the next page's first entry (page_create), standing in for the GC activity
// timers the RunLoop drive turns off: a page keeping 400k objects, then a trivial page
// on the same VM. What shows the collection is JSC's `heapSize`, the bytes the last
// collection marked live, read after the trivial page: that collection saw only the
// trivial page. The sample itself (heapCapacity) cannot show it — a full collection
// keeps the heap's blocks for reuse, so capacity barely moves.
//
// A trivial page runs first: the heavy one must not be the VM's first. A VM's first
// realm was seen to outlive its page through several full collections — every run on
// `.Node`, master included, some runs on `.Web` (a scratch probe, 2026-11-26) — a JSC
// effect this test does not pin; it would make the collection here look absent.
@(test)
runner_collects_a_vm_whose_sampled_heap_was_large :: proc(t: ^testing.T) {
	runner: lava.Page_Runner

	if !lava.page_runner_init(&runner, 1, record_heap, context.allocator) {
		testing.fail_now(t, "page_runner_init failed")
	}

	defer lava.page_runner_destroy(&runner)
	runner.heap_sample_every = 1
	out: [3]Heap_Outcome
	lava.page_runner_open(&runner, "1", "<warm>", LIMITS, &out[2])
	lava.page_runner_run(&runner)
	lava.page_runner_open(
		&runner,
		"globalThis.keep = Array.from({ length: 400000 }, (_, i) => ({ i, s: 'x' + i }));",
		"<heavy>",
		LIMITS,
		&out[0],
	)
	lava.page_runner_run(&runner)
	lava.page_runner_open(&runner, "1", "<light>", LIMITS, &out[1])
	lava.page_runner_run(&runner)
	testing.expectf(
		t,
		out[0].heap >= lava.HEAP_COLLECT_BYTES,
		"the heavy page's heap (%d) is under the threshold: the case proves nothing",
		out[0].heap,
	)

	if len(runner.pool.vms) != 1 {
		testing.fail_now(t, "the pages left no VM to read")
	}

	probe := jsc.JSGlobalContextCreateInGroup(runner.pool.vms[0].group, nil)
	defer jsc.JSGlobalContextRelease(probe)
	stats := jsc_memory_stats(cast(jsc.JSContextRef)probe)

	if stats == nil {
		testing.fail_now(t, "JSGetMemoryUsageStatistics returned nothing")
	}

	key := jsc.JSStringCreateWithUTF8CString("heapSize")
	defer jsc.JSStringRelease(key)
	live := jsc.JSValueToNumber(
		cast(jsc.JSContextRef)probe,
		jsc.JSObjectGetProperty(cast(jsc.JSContextRef)probe, stats, key, nil),
		nil,
	)
	testing.expectf(
		t,
		live > 0 && live < 4 << 20,
		"the last collection marked %.0f bytes live: the VM was not collected after a %d-byte page",
		live,
		out[0].heap,
	)
}

@(private = "file")
Late_Writer :: struct {
	fd:    linux.Fd,
	delay: time.Duration,
}

@(private = "file")
late_write :: proc(w: ^Late_Writer) {
	time.sleep(w.delay)
	b := [1]u8{1}
	linux.write(w.fd, b[:])
}

// page_runner_run keeps its contract with a watched descriptor in the set: it returns
// once no page is live, and never waits on the descriptor. Its only page is refused at
// open, so each run is one round with nothing to tick — the round in which a run that
// waited when idle would sleep until the descriptor turned readable, 1.5 s later.
//
// The page is refused for its missing budget, BEFORE it gets a loop: with the wait in
// place, a run whose page failed after getting a loop returned in ~20 ms, its
// epoll_wait ended by EINTR (observed; the likely source is task work the loop's
// io_uring teardown queues on this thread), which hides the wait. Three runs, so one
// stray interrupt left by an earlier test cannot hide it either.
@(test)
runner_run_returns_with_a_watched_fd_and_no_pages :: proc(t: ^testing.T) {
	fds: [2]linux.Fd

	if linux.pipe2(&fds, {.CLOEXEC, .NONBLOCK}) != nil {
		testing.fail_now(t, "pipe2 failed")
	}

	defer linux.close(fds[0])
	defer linux.close(fds[1])
	runner: lava.Page_Runner

	if !lava.page_runner_init(&runner, 1, record_page_outcome, context.allocator) {
		testing.fail_now(t, "page_runner_init failed")
	}

	defer lava.page_runner_destroy(&runner)
	testing.expect(t, lava.page_runner_watch_fd(&runner, i32(fds[0])), "watch refused")
	w := Late_Writer{fds[1], 1500 * time.Millisecond}
	th := thread.create_and_start_with_poly_data(&w, late_write)
	defer thread.destroy(th)
	start := time.tick_now()
	for i in 0 ..< 3 {
		o: Page_Outcome
		lava.page_runner_open(&runner, "1", "<no-budget>", {}, &o)
		lava.page_runner_run(&runner)
		testing.expectf(t, o.done && o.status == .Invalid_Input, "run %d, refused page: %s", i, describe_outcome(o))
	}
	elapsed := time.duration_seconds(time.tick_since(start))
	testing.expectf(t, elapsed < 1.0, "page_runner_run blocked %.2fs on a watched fd with no page live", elapsed)
}

// page_runner_step blocks with no page live until a watched descriptor is readable,
// and wakes when it is; with nothing at all to wait on it returns at once. A blocked
// step may also return early on a signal (EINTR: JSC signals its threads), so the
// test steps until the byte arrives and counts the steps: a step that blocks takes a
// handful over 300 ms, one that does not takes thousands.
@(test)
runner_step_wakes_on_a_watched_fd :: proc(t: ^testing.T) {
	bare: lava.Page_Runner

	if !lava.page_runner_init(&bare, 1, record_page_outcome, context.allocator) {
		testing.fail_now(t, "page_runner_init failed")
	}

	start := time.tick_now()
	lava.page_runner_step(&bare)
	testing.expectf(t, time.duration_seconds(time.tick_since(start)) < 0.5, "step with nothing to wait on blocked")
	lava.page_runner_destroy(&bare)

	fds: [2]linux.Fd

	if linux.pipe2(&fds, {.CLOEXEC, .NONBLOCK}) != nil {
		testing.fail_now(t, "pipe2 failed")
	}

	defer linux.close(fds[0])
	defer linux.close(fds[1])
	runner: lava.Page_Runner

	if !lava.page_runner_init(&runner, 1, record_page_outcome, context.allocator) {
		testing.fail_now(t, "page_runner_init failed")
	}

	defer lava.page_runner_destroy(&runner)
	testing.expect(t, lava.page_runner_watch_fd(&runner, i32(fds[0])), "watch refused")
	w := Late_Writer{fds[1], 300 * time.Millisecond}
	th := thread.create_and_start_with_poly_data(&w, late_write)
	defer thread.destroy(th)
	start = time.tick_now()
	steps := 0
	buf: [8]u8
	for time.duration_seconds(time.tick_since(start)) < 3 {
		lava.page_runner_step(&runner)
		steps += 1

		if n, _ := linux.read(fds[0], buf[:]); n > 0 {
			break
		}
	}
	elapsed := time.duration_seconds(time.tick_since(start))
	testing.expectf(t, elapsed > 0.2 && elapsed < 3, "the byte written at 300 ms was seen after %.2fs", elapsed)
	testing.expectf(t, steps < 50, "%d steps in %.2fs: step did not block until the fd was readable", steps, elapsed)
}

// page_runner_orphans on a destroyed runner — whose worker pool is gone with it —
// answers 0 instead of reaching through the nil pool.
@(test)
runner_orphans_is_zero_once_destroyed :: proc(t: ^testing.T) {
	runner: lava.Page_Runner

	if !lava.page_runner_init(&runner, 1, record_page_outcome, context.allocator) {
		testing.fail_now(t, "page_runner_init failed")
	}

	lava.page_runner_destroy(&runner)
	testing.expect_value(t, lava.page_runner_orphans(&runner), 0)
}
