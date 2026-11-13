// Linux-only: the page runner waits on page loops through epoll; elsewhere it refuses
// to start (page_runner_other.odin).
#+build linux
package main

import "core:log"
import "core:sys/posix"
import "core:testing"
import "core:time"
import lava "lava:pkg/runtime"

@(private = "file")
Outcome :: struct {
	done:   bool,
	status: lava.Status,
	kill:   lava.Kill_Reason,
	exit:   int,
}

@(private = "file")
record_outcome :: proc(runner: ^lava.Page_Runner, user_data: rawptr, result: lava.Result) {
	result := result
	o := cast(^Outcome)user_data
	o^ = {
		done   = true,
		status = result.status,
		kill   = result.kill,
		exit   = result.exit_code,
	}
	lava.result_destroy(&result)
}

// A well-behaved page: 40 timer turns of ~2 ms work, then exitCode 7 to prove it ran
// to the end rather than being cut short with its siblings.
@(private = "file")
STEADY_PAGE :: `
let n = 0;
function step() {
	const s = Date.now(); while (Date.now() - s < 2) {}
	if (++n < 40) setTimeout(step, 1); else process.exitCode = 7;
}
setTimeout(step, 0);
`

@(private = "file")
run_with_one_bad_page :: proc(t: ^testing.T, bad_source: string, bad_limits: lava.Page_Limits, want_kill: lava.Kill_Reason) {
	runner: lava.Page_Runner
	if !lava.page_runner_init(&runner, 4, record_outcome, context.allocator) {
		testing.fail_now(t, "page_runner_init failed")
	}
	defer lava.page_runner_destroy(&runner)

	outcomes: [4]Outcome
	good := lava.Page_Limits{entry_limit = 1, cpu_budget = 5}
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
		testing.expectf(t, outcomes[i].status == .Ok && outcomes[i].exit == 7, "page %d did not finish beside the killed page: %v", i, outcomes[i])
	}
}

// Acceptance (#4): a `while(true){}` page is killed by its VM's limit and the other
// pages on the thread finish. The runaway starts after the others are mid-flight.
@(test)
runner_entry_limit_kills_only_the_runaway_page :: proc(t: ^testing.T) {
	run_with_one_bad_page(t, "setTimeout(() => { while (true) {} }, 20);", {entry_limit = 0.1}, .Entry_Limit)
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

// Pages on one runner wait concurrently: ten pages that each sleep 300 ms finish in
// about 300 ms, not 3 s. Also proves the runner blocks rather than spins while every
// page waits (see the CPU bound).
@(test)
runner_pages_wait_concurrently :: proc(t: ^testing.T) {
	runner: lava.Page_Runner
	if !lava.page_runner_init(&runner, 10, record_outcome, context.allocator) {
		testing.fail_now(t, "page_runner_init failed")
	}
	defer lava.page_runner_destroy(&runner)
	outcomes: [10]Outcome
	start := time.tick_now()
	for i in 0 ..< 10 {
		lava.page_runner_open(&runner, "setTimeout(() => { process.exitCode = 3; }, 300);", "<sleeper>", {}, &outcomes[i])
	}
	cpu_before := thread_cpu_seconds()
	lava.page_runner_run(&runner)
	wall := time.duration_seconds(time.tick_since(start))
	cpu := thread_cpu_seconds() - cpu_before
	for o, i in outcomes {
		testing.expectf(t, o.done && o.status == .Ok && o.exit == 3, "page %d: %v", i, o)
	}
	testing.expectf(t, wall < 1.5, "10 x 300 ms pages took %.2fs: they ran one after another", wall)
	testing.expectf(t, cpu < 0.2, "runner burned %.3fs of CPU while every page waited on a timer", cpu)
}

// A page that never gets a VM (the runner is full) is reported, not dropped.
@(test)
runner_reports_a_page_it_cannot_start :: proc(t: ^testing.T) {
	runner: lava.Page_Runner
	if !lava.page_runner_init(&runner, 1, record_outcome, context.allocator) {
		testing.fail_now(t, "page_runner_init failed")
	}
	defer lava.page_runner_destroy(&runner)
	a, b: Outcome
	lava.page_runner_open(&runner, "setTimeout(() => {}, 50);", "<a>", {}, &a)
	lava.page_runner_open(&runner, "1", "<b>", {}, &b)
	testing.expect(t, b.done, "page without a VM was not reported")
	testing.expect_value(t, b.status, lava.Status.Native_Runtime_Unavailable)
	lava.page_runner_run(&runner)
	testing.expect(t, a.done && a.status == .Ok, "the running page did not finish")
}

@(private = "file")
Churn :: struct {
	opened, finished, failed: int,
	total:                    int,
	fds_after_warmup:         int,
	outcome:                  Outcome,
}

@(private = "file")
churn_done :: proc(runner: ^lava.Page_Runner, user_data: rawptr, result: lava.Result) {
	result := result
	c := cast(^Churn)user_data
	c.finished += 1
	if result.status != .Ok do c.failed += 1
	lava.result_destroy(&result)
	if c.finished == 100 do c.fds_after_warmup = fd_census()
	if c.opened < c.total {
		c.opened += 1
		lava.page_runner_open(runner, "let x = 0; setTimeout(() => { x++; }, 0); Promise.resolve().then(() => x++);", "<churn>", {}, c)
	}
}

// Acceptance (#4): /proc/self/fd stays flat over 10k pages — every page's loop
// descriptors close with the page, and the runner's fixed pool keeps the VM count
// (and so the permanent per-VM timerfd count) at its capacity. 8 pages in flight.
// The full 10k runs only on one runner thread (`make test-odin-serial`), where the
// census means something; otherwise a short run still exercises the churn path.
@(test)
runner_fd_count_stays_flat_over_10k_pages :: proc(t: ^testing.T) {
	runner: lava.Page_Runner
	if !lava.page_runner_init(&runner, 8, churn_done, context.allocator) {
		testing.fail_now(t, "page_runner_init failed")
	}
	defer lava.page_runner_destroy(&runner)
	c := Churn {
		total = RUNNER_THREADS == 1 ? 10_000 : 300,
	}
	for _ in 0 ..< 8 {
		c.opened += 1
		lava.page_runner_open(&runner, "let x = 0; setTimeout(() => { x++; }, 0);", "<churn>", {}, &c)
	}
	lava.page_runner_run(&runner)
	testing.expect_value(t, c.finished, c.total)
	testing.expect_value(t, c.failed, 0)
	busy, created := lava.vm_pool_stats(&runner.pool)
	testing.expect_value(t, busy, 0)
	testing.expectf(t, created <= 8, "runner created %d VMs for 8 pages in flight", created)
	when RUNNER_THREADS == 1 {
		fds_end := fd_census()
		testing.expectf(t, fds_end <= c.fds_after_warmup, "fd count grew from %d to %d over %d pages", c.fds_after_warmup, fds_end, c.total)
	} else {
		log.info("fd census skipped: needs -define:ODIN_TEST_THREADS=1 (make test-odin-serial)")
	}
}

@(private = "file")
thread_cpu_seconds :: proc() -> f64 {
	ts: posix.timespec
	posix.clock_gettime(.THREAD_CPUTIME_ID, &ts)
	return f64(ts.tv_sec) + f64(ts.tv_nsec) / 1e9
}

@(private = "file")
Timed :: struct {
	start:    time.Tick,
	finished: f64,
	status:   lava.Status,
}

@(private = "file")
record_time :: proc(runner: ^lava.Page_Runner, user_data: rawptr, result: lava.Result) {
	result := result
	o := cast(^Timed)user_data
	o.finished = time.duration_seconds(time.tick_since(o.start))
	o.status = result.status
	lava.result_destroy(&result)
}

// A busy page must not wait on its sibling's timers. The sibling re-arms a 50 ms
// interval for 1 s; if a page loop could block in its own poll, every round would
// stall up to 50 ms on it, and the busy page's 100 short turns would finish only
// once the sibling stops: 1.10 s with never_block off (the recorded mutation),
// against well under 0.6 s with it on.
@(test)
runner_busy_page_is_not_held_up_by_a_waiting_sibling :: proc(t: ^testing.T) {
	runner: lava.Page_Runner
	if !lava.page_runner_init(&runner, 2, record_time, context.allocator) {
		testing.fail_now(t, "page_runner_init failed")
	}
	defer lava.page_runner_destroy(&runner)
	waiting := Timed {
		start = time.tick_now(),
	}
	busy := Timed {
		start = time.tick_now(),
	}
	lava.page_runner_open(&runner, "let k = 0; const i = setInterval(() => { if (++k == 20) clearInterval(i); }, 50);", "<waiting>", {}, &waiting)
	lava.page_runner_open(&runner, "let n = 0; (function f() { if (++n < 100) setTimeout(f, 1); })();", "<busy>", {}, &busy)
	lava.page_runner_run(&runner)
	testing.expect_value(t, busy.status, lava.Status.Ok)
	testing.expect_value(t, waiting.status, lava.Status.Ok)
	testing.expectf(t, busy.finished < 0.6, "busy page took %.2fs: it waited on its sibling's timers", busy.finished)
}
