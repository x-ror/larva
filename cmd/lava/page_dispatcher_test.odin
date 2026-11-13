#+build linux
package main

import "core:sync"
import "core:testing"
import "core:time"
import lava "lava:pkg/runtime"

@(private = "file")
Tally :: struct {
	ok, killed, other: int,
}

// Called on worker threads: atomics only.
@(private = "file")
tally_done :: proc(d: ^lava.Page_Dispatcher, user_data: rawptr, result: lava.Result) {
	result := result
	t := cast(^Tally)user_data
	switch {
	case result.kill != .None:
		sync.atomic_add(&t.killed, 1)
	case result.status == .Ok && result.exit_code == 7:
		sync.atomic_add(&t.ok, 1)
	case:
		sync.atomic_add(&t.other, 1)
	}
	lava.result_destroy(&result)
}

// Pages are spread over every worker (least-loaded first) and run in parallel: 40
// pages of ~100 ms CPU each on 4 threads take ~1 s of wall time, not ~4 s.
@(test)
dispatcher_spreads_pages_over_workers :: proc(t: ^testing.T) {
	d: lava.Page_Dispatcher
	if !lava.page_dispatcher_init(&d, 4, 4, tally_done) do testing.fail_now(t, "page_dispatcher_init failed")
	tally: Tally
	start := time.tick_now()
	for _ in 0 ..< 40 {
		lava.page_dispatcher_submit(&d, "const s = Date.now(); while (Date.now() - s < 100) {} process.exitCode = 7;", "<busy>", {}, &tally)
	}
	load: [4]int
	lava.page_dispatcher_load(&d, load[:])
	for l, i in load do testing.expectf(t, l > 0, "worker %d got no pages: %v", i, load)
	lava.page_dispatcher_shutdown(&d)
	wall := time.duration_seconds(time.tick_since(start))
	testing.expect_value(t, tally.ok, 40)
	testing.expect_value(t, tally.other, 0)
	testing.expectf(t, wall < 3, "40 x 100 ms pages on 4 workers took %.2fs: not parallel", wall)
}

// A runaway page is killed on its worker; every other page, on that worker and the
// rest, still completes.
@(test)
dispatcher_runaway_page_is_killed_alone :: proc(t: ^testing.T) {
	d: lava.Page_Dispatcher
	if !lava.page_dispatcher_init(&d, 2, 4, tally_done) do testing.fail_now(t, "page_dispatcher_init failed")
	tally: Tally
	lava.page_dispatcher_submit(&d, "setTimeout(() => { while (true) {} }, 5);", "<runaway>", {entry_limit = 0.1}, &tally)
	for _ in 0 ..< 10 {
		lava.page_dispatcher_submit(&d, "setTimeout(() => { process.exitCode = 7; }, 50);", "<ok>", {entry_limit = 1}, &tally)
	}
	lava.page_dispatcher_shutdown(&d)
	testing.expect_value(t, tally.killed, 1)
	testing.expect_value(t, tally.ok, 10)
	testing.expect_value(t, tally.other, 0)
}

// More pages than a worker has slots wait in its inbox instead of failing for want of
// a VM.
@(test)
dispatcher_queues_past_capacity :: proc(t: ^testing.T) {
	d: lava.Page_Dispatcher
	if !lava.page_dispatcher_init(&d, 1, 2, tally_done) do testing.fail_now(t, "page_dispatcher_init failed")
	tally: Tally
	for _ in 0 ..< 12 do lava.page_dispatcher_submit(&d, "setTimeout(() => { process.exitCode = 7; }, 10);", "<q>", {}, &tally)
	lava.page_dispatcher_shutdown(&d)
	testing.expect_value(t, tally.ok, 12)
	testing.expect_value(t, tally.other, 0)
}

// Shutting down an idle dispatcher returns: workers blocked on an empty runner wake.
@(test)
dispatcher_idle_shutdown_returns :: proc(t: ^testing.T) {
	d: lava.Page_Dispatcher
	if !lava.page_dispatcher_init(&d, 3, 2, tally_done) do testing.fail_now(t, "page_dispatcher_init failed")
	lava.page_dispatcher_shutdown(&d)
}
