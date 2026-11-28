// Linux-only: the page runner waits through epoll, and the heap reading
// (jsc.heap_size_bytes) resolves a symbol only Linux builds look up.
#+build linux
package main

import "core:log"
import "core:mem"
import "core:testing"
import lava "lava:pkg/runtime"

// The per-page heap limit (Page_Limits.heap_bytes, docs/LARVA.md decision 2): a page
// whose heap, after a full collection, is over its limit is killed alone with
// Kill_Reason.Heap_Limit, through the same Result path as a CPU-budget kill, and its VM
// is retired rather than pooled again. What these tests pin: the kill and its sibling
// that keeps running, the reading the Result carries, the killed VM leaving the pool,
// the runner allocator's books after it, and the pages a limit must leave alone — one
// under it, and one whose heap is over it only in garbage.

// A fresh page reads ~2.3 MB after the runtime install, so 4 MB is crossed after a
// couple of MB of the page's own; small, since every reading walks the heap and these
// tests share the suite's cores.
@(private = "file")
HEAP_LIMIT :: i64(4 * 1024 * 1024)

// Keeps 5k small objects per tick for up to 40 ticks, ~23 MB in all (0.58 MB per 5k,
// measured: page.odin's page_heap_check probe), so it crosses HEAP_LIMIT within a few
// ticks. Bounded rather than endless, so a check that never fires ends the page .Ok —
// a visible red — instead of growing the test process until the CPU budget runs out.
@(private = "file")
GROWER_PAGE :: `
const keep = [];
let rounds = 0;
(function grow() {
	for (let i = 0; i < 5000; i++) keep.push({ i, s: 'x' + i });
	if (++rounds < 40) setTimeout(grow, 0);
})();
`

// Its sibling: 40 timers 5 ms apart, so it is still running well after the grower is
// killed, and keeps nothing.
@(private = "file")
SIBLING_PAGE :: `
let n = 0;
(function tick() { if (++n < 40) setTimeout(tick, 5); })();
`

@(private = "file")
Heap_Page :: struct {
	outcome: Page_Outcome,
	heap:    i64,
	// 1-based delivery order across the run.
	order:   int,
	counter: ^int,
}

@(private = "file")
record_heap_page :: proc(runner: ^lava.Page_Runner, user_data: rawptr, result: lava.Result) {
	p := cast(^Heap_Page)user_data
	p.heap = result.heap_bytes
	p.counter^ += 1
	p.order = p.counter^
	record_page_outcome(runner, &p.outcome, result)
}

// A page that keeps allocating is killed with .Heap_Limit while its sibling on the same
// runner — opened beside it, still running when the kill lands — finishes .Ok. The kill
// carries the reading that decided it: over the limit, and within the schedule's bound
// (page_heap_check: 1.07-1.62x of this 4 MB in twenty runs, 2.5x once in the parallel suite on
// a loaded box; 3x is the margin asserted). The killed
// page's VM is retired — gone from the pool, never handed to a later page — though the
// pool's own thresholds are both off, and the runner allocator's books are empty after
// destroy, with no free of memory it never handed out (CLAUDE.md §4).
@(test)
runner_kills_a_page_over_its_heap_limit_alone :: proc(t: ^testing.T) {
	track: mem.Tracking_Allocator
	mem.tracking_allocator_init(&track, context.allocator)
	defer mem.tracking_allocator_destroy(&track)
	track.bad_free_callback = mem.tracking_allocator_bad_free_callback_add_to_array

	runner: lava.Page_Runner

	if !lava.page_runner_init(&runner, 2, record_heap_page, mem.tracking_allocator(&track)) {
		testing.fail_now(t, "page_runner_init failed")
	}

	runner.pool.retire_after_pages = 0
	runner.pool.retire_heap_bytes = 0
	limits := lava.Page_Limits {
		cpu_budget = 30,
		heap_bytes = HEAP_LIMIT,
	}
	counter := 0
	grower := Heap_Page {
		counter = &counter,
	}
	sibling := Heap_Page {
		counter = &counter,
	}
	lava.page_runner_open(&runner, GROWER_PAGE, "<grower>", limits, &grower)
	lava.page_runner_open(&runner, SIBLING_PAGE, "<sibling>", limits, &sibling)

	if len(runner.pool.vms) != 2 {
		lava.page_runner_destroy(&runner)
		testing.fail_now(t, "the two pages did not each take a VM")
	}

	grower_vm := runner.pool.vms[0]
	sibling_vm := runner.pool.vms[1]
	lava.page_runner_run(&runner)

	_, created, retired := lava.vm_pool_stats(&runner.pool)
	vms_left := len(runner.pool.vms)
	kept_sibling := vms_left == 1 && runner.pool.vms[0] == sibling_vm
	kept_grower := false
	for vm in runner.pool.vms {
		if vm == grower_vm {
			kept_grower = true
		}
	}
	lava.page_runner_destroy(&runner)

	log.infof("heap-limit kill at %d KB (limit %d KB)", grower.heap / 1024, HEAP_LIMIT / 1024)
	testing.expectf(
		t,
		grower.outcome.done && grower.outcome.status == .Execution_Error && grower.outcome.kill == .Heap_Limit,
		"grower: %s",
		describe_outcome(grower.outcome),
	)
	testing.expect_value(t, string(cstring(&grower.outcome.message[0])), "page killed: heap limit exceeded")
	testing.expectf(
		t,
		grower.heap > HEAP_LIMIT && grower.heap <= 3 * HEAP_LIMIT,
		"the kill's reading (%d) is not over the limit (%d) and within 3x of it",
		grower.heap,
		HEAP_LIMIT,
	)
	sib := sibling.outcome
	testing.expectf(
		t,
		sib.done && sib.status == .Ok && sib.kill == .None && sib.exit == 0,
		"sibling: %s",
		describe_outcome(sib),
	)
	testing.expectf(
		t,
		grower.order == 1 && sibling.order == 2,
		"the sibling ended before the kill (orders %d, %d): it shows nothing about running on",
		grower.order,
		sibling.order,
	)
	testing.expect_value(t, created, 2)
	testing.expect_value(t, retired, 1)
	testing.expectf(t, !kept_grower, "the killed page's VM went back to the pool")
	testing.expectf(t, kept_sibling, "the pool holds %d VM(s), not the sibling's alone", vms_left)
	testing.expectf(
		t,
		len(track.bad_free_array) == 0,
		"%d free(s) through the runner allocator of memory it never allocated",
		len(track.bad_free_array),
	)
	for _, entry in track.allocation_map {
		testing.expectf(t, false, "runner allocator leaked %d bytes from %v", entry.size, entry.location)
	}
}

// A page well under its limit runs as if it had none: one keeping 20k objects (~2.3 MB)
// under a 16 MB limit finishes .Ok, and its VM stays in the pool.
@(test)
runner_heap_limit_spares_a_page_under_it :: proc(t: ^testing.T) {
	runner: lava.Page_Runner

	if !lava.page_runner_init(&runner, 1, record_page_outcome, context.allocator) {
		testing.fail_now(t, "page_runner_init failed")
	}

	defer lava.page_runner_destroy(&runner)
	out: Page_Outcome
	lava.page_runner_open(
		&runner,
		`globalThis.keep = Array.from({ length: 20000 }, (_, i) => ({ i })); setTimeout(() => {}, 1);`,
		"<under>",
		{cpu_budget = 30, heap_bytes = 4 * HEAP_LIMIT},
		&out,
	)
	lava.page_runner_run(&runner)
	testing.expectf(t, out.done && out.status == .Ok && out.kill == .None && out.exit == 0, "%s", describe_outcome(out))
	_, created, retired := lava.vm_pool_stats(&runner.pool)
	testing.expect_value(t, created, 1)
	testing.expect_value(t, retired, 0)
}

// A page whose heap capacity passes its limit only in garbage is not killed: the check
// collects before its verdict. 8 ticks, each making 100k short-lived objects (~7 MB)
// and keeping none, under an 8 MB limit — the capacity such a churn reaches without a
// collection is several times that (page_heap_check's probe: 138-154 MB).
@(test)
runner_heap_limit_spares_a_page_that_only_churns_garbage :: proc(t: ^testing.T) {
	runner: lava.Page_Runner

	if !lava.page_runner_init(&runner, 1, record_page_outcome, context.allocator) {
		testing.fail_now(t, "page_runner_init failed")
	}

	defer lava.page_runner_destroy(&runner)
	out: Page_Outcome
	lava.page_runner_open(
		&runner,
		`let r = 0;
		(function churn() {
			let a = Array.from({ length: 100000 }, (_, i) => ({ i, s: 'y' + i }));
			a = null;
			if (++r < 8) setTimeout(churn, 0);
		})();`,
		"<churn>",
		{cpu_budget = 30, heap_bytes = 2 * HEAP_LIMIT},
		&out,
	)
	lava.page_runner_run(&runner)
	testing.expectf(t, out.done && out.status == .Ok && out.kill == .None && out.exit == 0, "%s", describe_outcome(out))
}
