// Linux-only: the page runner waits on page loops through epoll; elsewhere it refuses
// to start (page_runner_other.odin).
#+build linux
package main

import "core:fmt"
import "core:log"
import "core:os"
import "core:strings"
import "core:sys/linux"
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

// Pages on one runner wait concurrently: ten pages that each sleep 600 ms finish in
// about 600 ms, not 6 s. Also proves the runner blocks rather than spins while every
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
		lava.page_runner_open(&runner, "setTimeout(() => { process.exitCode = 3; }, 600);", "<sleeper>", {}, &outcomes[i])
	}
	cpu_before := thread_cpu_seconds()
	lava.page_runner_run(&runner)
	wall := time.duration_seconds(time.tick_since(start))
	cpu := thread_cpu_seconds() - cpu_before
	for o, i in outcomes {
		testing.expectf(t, o.done && o.status == .Ok && o.exit == 3, "page %d: %v", i, o)
	}
	testing.expectf(t, wall < 2.5, "10 x 600 ms pages took %.2fs: they ran one after another", wall)
	testing.expectf(t, cpu < 0.2, "runner burned %.3fs of CPU while every page waited on a timer", cpu)
}

// A page that never gets a VM (the runner is full) is reported, not dropped — from the
// run loop, never from inside page_runner_open, so on_done cannot recurse.
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
	testing.expect(t, !b.done, "a page that failed at open was reported from inside page_runner_open")
	lava.page_runner_run(&runner)
	testing.expect(t, b.done, "page without a VM was not reported")
	testing.expect_value(t, b.status, lava.Status.Native_Runtime_Unavailable)
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
	// The census first: a leak of three fds per page hits EMFILE in a 10k run, and the
	// failures it causes would otherwise be the first thing reported.
	when RUNNER_THREADS == 1 {
		fds_end := fd_census()
		testing.expectf(t, fds_end <= c.fds_after_warmup, "fd count grew from %d to %d over %d pages", c.fds_after_warmup, fds_end, c.total)
	} else {
		log.info("fd census skipped: needs -define:ODIN_TEST_THREADS=1 (make test-odin-serial)")
	}
	testing.expect_value(t, c.finished, c.total)
	testing.expect_value(t, c.failed, 0)
	busy, created := lava.vm_pool_stats(&runner.pool)
	testing.expect_value(t, busy, 0)
	testing.expectf(t, created <= 8, "runner created %d VMs for 8 pages in flight", created)
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

@(private = "file")
Reuse :: struct {
	first, second: Outcome,
	opened_second: bool,
}

@(private = "file")
reuse_done :: proc(runner: ^lava.Page_Runner, user_data: rawptr, result: lava.Result) {
	r := cast(^Reuse)user_data
	if !r.opened_second {
		record_outcome(runner, &r.first, result)
		r.opened_second = true
		// The killed page's VM is the runner's only one, so this page reuses it.
		lava.page_runner_open(
			runner,
			`const clean = typeof leak === 'undefined' && typeof leakRan === 'undefined';
			globalThis.n2 = 0; const t0 = Date.now(); setTimeout(() => { process.exitCode = (clean && typeof leakRan === 'undefined') ? 11 : 12; }, 30);`,
			"<second>",
			{},
			r,
		)
		return
	}
	record_outcome(runner, &r.second, result)
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
		{entry_limit = 0.1},
		&r,
	)
	lava.page_runner_run(&runner)
	testing.expect_value(t, r.first.kill, lava.Kill_Reason.Entry_Limit)
	testing.expectf(t, r.second.done && r.second.status == .Ok && r.second.exit == 11, "second page saw the first: %v", r.second)
	_, created := lava.vm_pool_stats(&runner.pool)
	testing.expect_value(t, created, 1)
}

// A page whose only pending work is I/O must wake the runner through its loop's
// backend fd: no timer bounds the runner's wait. The server page has no timer at all;
// the client page connects 100 ms in, after the runner has long been blocked, so the
// accept and the reply can only reach a page through the runner's epoll set.
@(test)
runner_wakes_on_io_without_timers :: proc(t: ^testing.T) {
	runner: lava.Page_Runner
	if !lava.page_runner_init(&runner, 2, record_outcome, context.allocator) {
		testing.fail_now(t, "page_runner_init failed")
	}
	defer lava.page_runner_destroy(&runner)
	port := 20000 + int(time.tick_now()._nsec % 20000)
	// Heap, not tprintf: the server page's require() resets the temp arena.
	server := fmt.aprintf(`const srv = require('net').createServer((c) => {{ c.end('hi'); srv.close(); process.exitCode = 5; }});
	srv.listen(%d, '127.0.0.1');`, port)
	client := fmt.aprintf(`setTimeout(() => {{
		const s = require('net').connect(%d, '127.0.0.1');
		s.on('data', (d) => {{ process.exitCode = String(d) === 'hi' ? 5 : 6; }});
		s.on('error', () => {{ process.exitCode = 8; }});
	}}, 100);`, port)
	defer delete(server)
	defer delete(client)
	so, co: Outcome
	start := time.tick_now()
	lava.page_runner_open(&runner, server, "<server>", {}, &so)
	lava.page_runner_open(&runner, client, "<client>", {}, &co)
	// Deterministic half: both page loops sit in the runner's epoll set. (A missing
	// registration can still pass the timing half: JSC's signal thread interrupts
	// epoll_wait often enough to stand in for the wake.)
	testing.expectf(t, epoll_watch_count(runner.epfd) == 2, "page loops not in the runner's epoll set (%d of 2)", epoll_watch_count(runner.epfd))
	lava.page_runner_run(&runner)
	testing.expectf(t, so.done && so.status == .Ok && so.exit == 5, "server page: %v", so)
	testing.expectf(t, co.done && co.status == .Ok && co.exit == 5, "client page: %v", co)
	testing.expect(t, time.duration_seconds(time.tick_since(start)) < 3, "I/O-only pages took over 3s")
}

// process.exit() in a runner page ends that page — with the code it asked for — and
// not the process its sibling pages share. Code after the call does not run on: the
// spin after it is stopped by the VM, without counting as a kill.
@(test)
runner_process_exit_ends_only_its_page :: proc(t: ^testing.T) {
	run_with_one_bad_page_exit(t)
}

@(private = "file")
run_with_one_bad_page_exit :: proc(t: ^testing.T) {
	runner: lava.Page_Runner
	if !lava.page_runner_init(&runner, 3, record_outcome, context.allocator) {
		testing.fail_now(t, "page_runner_init failed")
	}
	defer lava.page_runner_destroy(&runner)
	outcomes: [3]Outcome
	lava.page_runner_open(&runner, STEADY_PAGE, "<good-0>", {}, &outcomes[0])
	lava.page_runner_open(&runner, "setTimeout(() => { process.exit(9); while (true) {} }, 20);", "<exit>", {}, &outcomes[1])
	lava.page_runner_open(&runner, STEADY_PAGE, "<good-1>", {}, &outcomes[2])
	lava.page_runner_run(&runner)
	testing.expectf(t, outcomes[1].done && outcomes[1].status == .Ok && outcomes[1].exit == 9 && outcomes[1].kill == .None, "exiting page: %v", outcomes[1])
	for i in ([]int{0, 2}) {
		testing.expectf(t, outcomes[i].done && outcomes[i].status == .Ok && outcomes[i].exit == 7, "page %d did not finish beside the exiting page: %v", i, outcomes[i])
	}
}

// Destroying a runner with pages still running reports each as .Cancelled — not as a
// page that finished — without running any more of its code.
@(test)
runner_destroy_reports_live_pages_cancelled :: proc(t: ^testing.T) {
	runner: lava.Page_Runner
	if !lava.page_runner_init(&runner, 2, record_outcome, context.allocator) {
		testing.fail_now(t, "page_runner_init failed")
	}
	o: Outcome
	lava.page_runner_open(&runner, "process.exitCode = 4; setTimeout(() => {}, 10000);", "<long>", {}, &o)
	lava.page_runner_destroy(&runner)
	testing.expect(t, o.done, "a live page was not reported on destroy")
	testing.expect_value(t, o.kill, lava.Kill_Reason.Cancelled)
	testing.expect_value(t, o.status, lava.Status.Execution_Error)
}

// epoll_watch_count reads how many fds an epoll instance watches, from the "tfd:"
// lines of its /proc/self/fdinfo entry.
@(private = "file")
epoll_watch_count :: proc(epfd: linux.Fd) -> int {
	data, err := os.read_entire_file(fmt.tprintf("/proc/self/fdinfo/%d", int(epfd)), context.temp_allocator)
	if err != nil do return -1
	return strings.count(string(data), "tfd:")
}

@(private = "file")
Heap_Pair :: struct {
	heavy, light: int,
}

@(private = "file")
record_heap :: proc(runner: ^lava.Page_Runner, user_data: rawptr, result: lava.Result) {
	result := result
	(cast(^int)user_data)^ = result.heap_bytes
	lava.result_destroy(&result)
}

// Heap sampling attributes heap to the page that grew it: one VM per page, so a page
// holding 200k objects at close reports several MB more than a trivial page on the
// other VM. Off by default (it walks the heap): heap_bytes stays unsampled.
@(test)
runner_samples_each_pages_heap :: proc(t: ^testing.T) {
	sample :: proc(t: ^testing.T, every: int) -> Heap_Pair {
		runner: lava.Page_Runner
		if !lava.page_runner_init(&runner, 2, record_heap, context.allocator) {
			testing.fail_now(t, "page_runner_init failed")
		}
		defer lava.page_runner_destroy(&runner)
		runner.heap_sample_every = every
		p: Heap_Pair
		lava.page_runner_open(&runner, "globalThis.a = []; for (let i = 0; i < 200000; i++) a.push({ i, s: 'x' + i });", "<heavy>", {}, &p.heavy)
		lava.page_runner_open(&runner, "1", "<light>", {}, &p.light)
		lava.page_runner_run(&runner)
		return p
	}
	on := sample(t, 1)
	testing.expectf(t, on.light > 0 && on.heavy > on.light + 5_000_000, "heap not attributed per page: heavy %d, light %d", on.heavy, on.light)
	off := sample(t, 0)
	testing.expectf(t, off.heavy <= 0 && off.light <= 0, "heap sampled with sampling off: %v", off)
}

@(private = "file")
Nth :: struct {
	heap:   [3]int,
	n:      int,
}

@(private = "file")
nth_done :: proc(runner: ^lava.Page_Runner, user_data: rawptr, result: lava.Result) {
	result := result
	h := cast(^Nth)user_data
	h.heap[h.n] = result.heap_bytes
	h.n += 1
	lava.result_destroy(&result)
	if h.n < 3 do lava.page_runner_open(runner, "1", "<nth>", {}, h)
}

// Sampling every 2nd page a VM hosts: three pages in a row on the runner's one VM, and
// only the second is sampled.
@(test)
runner_samples_every_nth_page_per_vm :: proc(t: ^testing.T) {
	runner: lava.Page_Runner
	if !lava.page_runner_init(&runner, 1, nth_done, context.allocator) {
		testing.fail_now(t, "page_runner_init failed")
	}
	defer lava.page_runner_destroy(&runner)
	runner.heap_sample_every = 2
	h: Nth
	lava.page_runner_open(&runner, "1", "<nth>", {}, &h)
	lava.page_runner_run(&runner)
	testing.expectf(t, h.n == 3 && h.heap[0] == -1 && h.heap[1] > 0 && h.heap[2] == -1, "sampled the wrong pages: %v", h.heap)
}

// page_runner_run returns once its pages are done even when the runner watches an
// external fd: only a driver that asks (block_when_idle) waits on it with no pages.
@(test)
runner_run_returns_with_a_watched_fd_and_no_pages :: proc(t: ^testing.T) {
	runner: lava.Page_Runner
	if !lava.page_runner_init(&runner, 1, record_outcome, context.allocator) {
		testing.fail_now(t, "page_runner_init failed")
	}
	defer lava.page_runner_destroy(&runner)
	efd, err := linux.eventfd(0, {.CLOEXEC, .NONBLOCK})
	if err != .NONE do testing.fail_now(t, "eventfd failed")
	defer linux.close(efd)
	testing.expect(t, lava.page_runner_watch_fd(&runner, efd), "watch_fd failed")
	// No pages at all: the idle step is what would wait on the eventfd forever.
	lava.page_runner_run(&runner)
	o: Outcome
	lava.page_runner_open(&runner, "setTimeout(() => {}, 5);", "<one>", {}, &o)
	lava.page_runner_run(&runner)
	testing.expect(t, o.done, "page not reported")
}

// A killed page is not heap-sampled even on a sampled slot (its heap is not a finished
// page's, and sampling would run its leftover jobs).
@(test)
runner_does_not_sample_a_killed_page :: proc(t: ^testing.T) {
	runner: lava.Page_Runner
	if !lava.page_runner_init(&runner, 1, record_heap, context.allocator) {
		testing.fail_now(t, "page_runner_init failed")
	}
	defer lava.page_runner_destroy(&runner)
	runner.heap_sample_every = 1
	heap := 7
	lava.page_runner_open(&runner, "setTimeout(() => { while (true) {} }, 1);", "<killed>", {entry_limit = 0.05}, &heap)
	lava.page_runner_run(&runner)
	testing.expectf(t, heap == -1, "a killed page was sampled (%d)", heap)
}
