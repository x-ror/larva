package eventloop

import "core:mem"
import "core:net"
import "core:testing"
import "core:thread"
import "core:time"

Recorder :: struct {
	events:        [dynamic]int,
	interval_id:   Timer_ID,
	dispose_count: int,
}

// count_dispose is a Dispose hook: the loop calls it for a handle it drops
// without (re-)firing, mirroring how the JS bridge frees a cleared timer's
// binding. It must run exactly once per cancelled handle and never for one that
// fired and "freed itself" (a double-free in the real bridge).
count_dispose :: proc(user_data: rawptr) {
	rec := cast(^Recorder)user_data
	rec.dispose_count += 1
}

record :: proc(loop: ^Loop, user_data: rawptr) {
	rec := cast(^Recorder)user_data
	append(&rec.events, 1)
}

record_2 :: proc(loop: ^Loop, user_data: rawptr) {
	rec := cast(^Recorder)user_data
	append(&rec.events, 2)
}

record_3 :: proc(loop: ^Loop, user_data: rawptr) {
	rec := cast(^Recorder)user_data
	append(&rec.events, 3)
}

record_and_queue_microtask :: proc(loop: ^Loop, user_data: rawptr) {
	rec := cast(^Recorder)user_data
	append(&rec.events, 1)
	queue_microtask(loop, record_2, user_data)
}

record_and_schedule_timer :: proc(loop: ^Loop, user_data: rawptr) {
	rec := cast(^Recorder)user_data
	append(&rec.events, 1)
	set_timeout(loop, record_3, 0, user_data)
}

record_and_schedule_immediate :: proc(loop: ^Loop, user_data: rawptr) {
	rec := cast(^Recorder)user_data
	append(&rec.events, 1)
	set_immediate(loop, record_2, user_data)
}

record_interval_and_clear_after_two_ticks :: proc(loop: ^Loop, user_data: rawptr) {
	rec := cast(^Recorder)user_data
	append(&rec.events, 1)

	if len(rec.events) == 2 {
		clear_interval(loop, rec.interval_id)
	}
}

record_and_queue_next_tick :: proc(loop: ^Loop, user_data: rawptr) {
	rec := cast(^Recorder)user_data
	append(&rec.events, 1)
	queue_next_tick(loop, record_2, user_data)
}

expect_events :: proc(t: ^testing.T, actual: []int, expected: []int) {
	if !testing.expect_value(t, len(actual), len(expected)) {
		return
	}

	for value, i in actual {
		testing.expect_value(t, value, expected[i])
	}
}

@(test)
microtasks_are_fifo :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)

	queue_microtask(&loop, record, &rec)
	queue_microtask(&loop, record_2, &rec)
	queue_microtask(&loop, record_3, &rec)

	testing.expect(t, run_once(&loop))
	expect_events(t, rec.events[:], []int{1, 2, 3})
	testing.expect_value(t, pending_count(&loop), 0)
}

@(test)
next_ticks_run_before_microtasks :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)

	queue_microtask(&loop, record_2, &rec)
	queue_next_tick(&loop, record, &rec)

	testing.expect(t, run_once(&loop))
	expect_events(t, rec.events[:], []int{1, 2})
}

@(test)
next_ticks_queued_by_microtasks_are_drained_before_leaving_checkpoint :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)

	queue_microtask(&loop, record_and_queue_next_tick, &rec)
	queue_microtask(&loop, record_3, &rec)

	testing.expect(t, run_once(&loop))
	expect_events(t, rec.events[:], []int{1, 3, 2})
}

@(test)
nested_microtasks_drain_in_same_turn :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)

	queue_microtask(&loop, record_and_queue_microtask, &rec)
	queue_microtask(&loop, record_3, &rec)

	testing.expect(t, run_once(&loop))
	expect_events(t, rec.events[:], []int{1, 3, 2})
}

@(test)
immediates_run_after_due_timers :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)

	set_immediate(&loop, record_2, &rec)
	set_timeout(&loop, record, 0, &rec)

	testing.expect(t, run_once(&loop))
	expect_events(t, rec.events[:], []int{1, 2})
}

@(test)
io_callbacks_run_before_immediates :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)

	// Even when the immediate is queued first, the poll-phase I/O callback runs
	// ahead of the check-phase immediate within the same tick.
	set_immediate(&loop, record_2, &rec)
	queue_io_callback(&loop, record, &rec)

	testing.expect(t, run_once(&loop))
	expect_events(t, rec.events[:], []int{1, 2})
	testing.expect_value(t, pending_count(&loop), 0)
}

@(test)
io_callback_scheduling_immediate_runs_in_order :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)

	// Mirrors the 08-io-before-immediate oracle case: an fs.readFile-style poll
	// completion records, then schedules a setImmediate that records after it.
	queue_io_callback(&loop, record_and_schedule_immediate, &rec)

	run_until_idle(&loop)
	expect_events(t, rec.events[:], []int{1, 2})
	testing.expect_value(t, pending_count(&loop), 0)
}

@(test)
cleared_immediate_does_not_run :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)

	id := set_immediate(&loop, record, &rec)
	testing.expect(t, clear_immediate(&loop, id))
	testing.expect(t, !run_until_idle(&loop))
	testing.expect_value(t, len(rec.events), 0)
}

@(test)
interval_repeats_until_cleared :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)

	rec.interval_id = set_interval(&loop, record_interval_and_clear_after_two_ticks, 5, &rec)

	testing.expect(t, run_until_idle(&loop))
	expect_events(t, rec.events[:], []int{1, 1})
	testing.expect_value(t, pending_count(&loop), 0)
	testing.expect_value(t, now(&loop), u64(10))
}

@(test)
timers_are_ordered_by_due_time_then_insertion :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)

	set_timeout(&loop, record_3, 20, &rec)
	set_timeout(&loop, record, 10, &rec)
	set_timeout(&loop, record_2, 10, &rec)

	testing.expect(t, run_until_idle(&loop))
	expect_events(t, rec.events[:], []int{1, 2, 3})
	testing.expect_value(t, now(&loop), u64(20))
}

@(test)
cleared_timer_does_not_run :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)

	id := set_timeout(&loop, record, 0, &rec)
	testing.expect(t, clear_timeout(&loop, id))
	testing.expect(t, !clear_timeout(&loop, id))
	testing.expect(t, !run_until_idle(&loop))
	testing.expect_value(t, len(rec.events), 0)
}

// --- Dispose-hook (binding cleanup) regression: clearing a timer/immediate must
// release its binding exactly once, and a normally-fired one-shot must not be
// disposed (that path frees its own binding — a double-free in the real bridge).

@(test)
cleared_timeout_disposes_binding :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)

	id := set_timeout(&loop, record, 5, &rec, count_dispose)
	testing.expect(t, clear_timeout(&loop, id))
	// No other pending work: run_until_idle must not even tick. The binding is
	// freed eagerly at clear, not lazily on a later tick that may never come.
	testing.expect(t, !run_until_idle(&loop))
	testing.expect_value(t, len(rec.events), 0)
	testing.expect_value(t, rec.dispose_count, 1)
}

@(test)
fired_timeout_is_not_disposed :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)

	set_timeout(&loop, record, 0, &rec, count_dispose)
	testing.expect(t, run_until_idle(&loop))
	testing.expect_value(t, len(rec.events), 1)
	// A one-shot that fired freed itself; the loop must not also dispose it.
	testing.expect_value(t, rec.dispose_count, 0)
}

@(test)
cleared_immediate_disposes_binding :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)

	id := set_immediate(&loop, record, &rec, count_dispose)
	testing.expect(t, clear_immediate(&loop, id))
	testing.expect(t, !run_until_idle(&loop))
	testing.expect_value(t, len(rec.events), 0)
	testing.expect_value(t, rec.dispose_count, 1)
}

@(test)
cleared_pending_interval_disposes_binding :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)

	id := set_interval(&loop, record, 5, &rec, count_dispose)
	// Cleared before it ever fires: its binding must still be released.
	testing.expect(t, clear_interval(&loop, id))
	testing.expect(t, !run_until_idle(&loop))
	testing.expect_value(t, len(rec.events), 0)
	testing.expect_value(t, rec.dispose_count, 1)
}

@(test)
interval_cleared_from_own_callback_disposes_binding :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)

	// Fires twice, then clears itself: it fired (so it was not freed on fire,
	// unlike a one-shot) and is not re-armed, so it is disposed exactly once.
	rec.interval_id = set_interval(&loop, record_interval_and_clear_after_two_ticks, 5, &rec, count_dispose)
	testing.expect(t, run_until_idle(&loop))
	expect_events(t, rec.events[:], []int{1, 1})
	testing.expect_value(t, rec.dispose_count, 1)
	testing.expect_value(t, pending_count(&loop), 0)
}

@(test)
microtasks_run_before_due_timers :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)

	set_timeout(&loop, record_2, 0, &rec)
	queue_microtask(&loop, record, &rec)

	testing.expect(t, run_once(&loop))
	expect_events(t, rec.events[:], []int{1, 2})
}

@(test)
microtasks_drain_between_timer_callbacks :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)

	set_timeout(&loop, record_and_queue_microtask, 0, &rec)
	set_timeout(&loop, record_3, 0, &rec)

	testing.expect(t, run_once(&loop))
	expect_events(t, rec.events[:], []int{1, 2, 3})
}

@(test)
timer_scheduled_by_timer_waits_for_next_turn :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)

	set_timeout(&loop, record_and_schedule_timer, 0, &rec)

	testing.expect(t, run_once(&loop))
	expect_events(t, rec.events[:], []int{1})
	testing.expect_value(t, pending_count(&loop), 1)

	testing.expect(t, run_next(&loop))
	expect_events(t, rec.events[:], []int{1, 3})
	testing.expect_value(t, pending_count(&loop), 0)
}

@(test)
close_callbacks_run_after_immediates :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)

	// setImmediate (check phase) must fire before close callbacks
	set_immediate(&loop, record_2, &rec)
	queue_close_callback(&loop, record_3, &rec)
	queue_microtask(&loop, record, &rec)

	testing.expect(t, run_once(&loop))
	// order: microtask(1) → immediate/check(2) → close(3)
	expect_events(t, rec.events[:], []int{1, 2, 3})
}

@(test)
unreffed_timer_does_not_keep_loop_alive :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)

	id := set_timeout(&loop, record, 100, &rec)
	timer_unref(&loop, id)

	// Loop should be considered idle because the only timer is unreffed
	testing.expect_value(t, pending_count(&loop), 0)
	testing.expect(t, !has_pending_work(&loop))
}

@(test)
refd_timer_keeps_loop_alive :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)

	id := set_timeout(&loop, record, 100, &rec)
	timer_unref(&loop, id)
	timer_ref(&loop, id)

	testing.expect_value(t, pending_count(&loop), 1)
	testing.expect(t, has_pending_work(&loop))
}

@(test)
next_tick_queued_inside_next_tick_runs_before_microtasks :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)

	// next_tick queues another next_tick; that must run before any microtask
	queue_next_tick(&loop, record_and_queue_next_tick, &rec)
	queue_microtask(&loop, record_3, &rec)

	testing.expect(t, run_once(&loop))
	// record(1) fires, queues next_tick(2); next_tick(2) fires; then microtask(3)
	expect_events(t, rec.events[:], []int{1, 2, 3})
}

@(test)
microtasks_drain_between_immediate_callbacks :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)

	set_immediate(&loop, record_and_queue_microtask, &rec)
	set_immediate(&loop, record_3, &rec)

	testing.expect(t, run_once(&loop))
	// immediate(1) fires → queues microtask(2); microtask(2) drains; then immediate(3)
	expect_events(t, rec.events[:], []int{1, 2, 3})
}

// --- Cross-thread wakeup ---
// wakeup() must unblock a loop parked in platform_poll from another thread. This
// is the primitive every background-worker feature (async DNS, thread-pool
// offload) relies on; it regressed silently before #74 because nothing exercised
// it (a worker would write the wakeup fd but the poll never woke).

wakeup_worker :: proc(data: rawptr) {
	loop := cast(^Loop)data
	// Give the main thread time to reach the blocking poll, then wake it.
	time.sleep(50 * time.Millisecond)
	wakeup(loop)
}

@(test)
wakeup_unblocks_blocking_poll :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	// Keep the worker handle (self_cleanup=false) and join it before destroy. Defers
	// run LIFO, so this join runs before `destroy(&loop)`: otherwise destroy could
	// close (and the OS reuse) the wakeup pipe fd while the worker's wakeup() write
	// is still in flight, writing to an unrelated fd.
	worker := thread.create_and_start_with_data(&loop, wakeup_worker, context, .Normal, false)
	defer {
		thread.join(worker)
		thread.destroy(worker)
	}

	// Blocks until the worker calls wakeup(); reaching the next line proves the
	// cross-thread wakeup woke the poll. (A regression hangs here — by design,
	// since the whole point is that the poll must be wakeable.)
	platform_poll(&loop, -1)
	testing.expect(t, true)
}

// --- Cross-thread async-completion handoff (the primitive async DNS uses) ---

Async_Arg :: struct {
	loop: ^Loop,
	rec:  ^Recorder,
}

// async_worker runs off-loop, then posts a completion back to the loop. post_async
// is the only loop call allowed from another thread.
async_worker :: proc(data: rawptr) {
	arg := cast(^Async_Arg)data
	time.sleep(20 * time.Millisecond)
	post_async(arg.loop, record, arg.rec)
}

@(test)
async_handoff_runs_posted_callback :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)
	arg := Async_Arg {
		loop = &loop,
		rec  = &rec,
	}

	// One off-loop op in flight keeps the loop alive and parked in poll until the
	// worker posts its completion via the wakeup.
	async_begin(&loop)
	testing.expect_value(t, pending_count(&loop), 1)
	thread.create_and_start_with_data(&arg, async_worker, context, .Normal, true)

	testing.expect(t, run_until_idle(&loop))
	expect_events(t, rec.events[:], []int{1}) // posted callback ran on the loop thread
	testing.expect_value(t, loop.active_async, 0)
	testing.expect_value(t, pending_count(&loop), 0)
}

// The same stale-wakeup hazard, but through run_until_idle — the driver the tests
// themselves use, and the one #113 did not reach. `run()` exits solely on
// !has_pending_work; run_until_idle used to exit on ONE no-progress tick, so a
// surplus wakeup byte ended the drive with an off-loop completion still in flight
// and returned the `did_work` an earlier tick had latched. That read as success,
// which is why it survived: CI saw 2-of-3 completions with active_async == 1 and
// no failure on the run_until_idle assertion itself.
//
// This is the sibling test below with `run` swapped for `run_until_idle`, and that
// is the whole point — the hazard already had a test, on the other driver only.
//
// NO TIMER, deliberately. A pending timer gives platform_poll a positive timeout,
// and a positive-timeout poll counts as progress on its own (see run_once), so the
// no-progress tick never happens and the bug hides. It takes the blocking poll —
// timeout -1 — which means the only thing that may complete the async is an
// off-loop thread. A first version of this test used a timer to avoid the thread,
// passed, and passed just as well with the fix reverted.
@(test)
run_until_idle_waits_out_a_stale_wakeup :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)
	arg := Async_Arg {
		loop = &loop,
		rec  = &rec,
	}

	async_begin(&loop)
	// The surplus byte, published before the drive starts: exactly what a
	// completion drained one tick before its wakeup byte leaves behind.
	wakeup(&loop)
	thread.create_and_start_with_data(&arg, async_worker, context, .Normal, true)

	testing.expect(t, run_until_idle(&loop))

	// The completion ran, so the drive did not stop at the no-progress tick.
	expect_events(t, rec.events[:], []int{1})
	testing.expect_value(t, loop.active_async, 0)
	testing.expect_value(t, pending_count(&loop), 0)
}

@(test)
run_ignores_stale_wakeup_while_async_is_active :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)
	arg := Async_Arg {
		loop = &loop,
		rec  = &rec,
	}

	async_begin(&loop)
	wakeup(&loop)
	thread.create_and_start_with_data(&arg, async_worker, context, .Normal, true)

	run(&loop)

	expect_events(t, rec.events[:], []int{1})
	testing.expect_value(t, loop.active_async, 0)
	testing.expect_value(t, pending_count(&loop), 0)
}

// --- Thread pool ---

Pool_Test_Job :: struct {
	rec:      ^Recorder,
	computed: int, // a worker writes this off-loop; the loop-thread done reads it back
}

// pool_test_work runs OFF the loop thread: a small sleep, then a write into the job.
// It must not touch the loop — post_async publishes the write when it hands back.
pool_test_work :: proc(user_data: rawptr) {
	job := cast(^Pool_Test_Job)user_data
	time.sleep(5 * time.Millisecond)
	job.computed = 42
}

// pool_test_done runs ON the loop thread and records the off-loop result.
pool_test_done :: proc(loop: ^Loop, user_data: rawptr) {
	job := cast(^Pool_Test_Job)user_data

	if job.rec != nil {
		append(&job.rec.events, job.computed)
	}
}

@(test)
threadpool_runs_work_offloop_and_completes_on_loop :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)

	jobs: [3]Pool_Test_Job
	for i in 0 ..< len(jobs) {
		jobs[i] = Pool_Test_Job {
			rec = &rec,
		}
		testing.expect(t, pool_submit(&loop, pool_test_work, pool_test_done, &jobs[i]))
	}
	// Each submit pins the loop alive (active_async) until its completion posts.
	testing.expect_value(t, pending_count(&loop), 3)

	testing.expect(t, run_until_idle(&loop))
	// All three completions ran on the loop thread, each recording the off-loop result.
	expect_events(t, rec.events[:], []int{42, 42, 42})
	testing.expect_value(t, loop.active_async, 0)
	testing.expect_value(t, pending_count(&loop), 0)
}

@(test)
threadpool_shutdown_joins_inflight_work :: proc(t: ^testing.T) {
	// Submitting then destroying without running the loop must not hang or leak: the
	// worker is joined, the job wrapper is freed, and the dropped completion's task is
	// never invoked (so the freed wrapper is not dereferenced).
	loop := init()
	job := Pool_Test_Job{}
	testing.expect(t, pool_submit(&loop, pool_test_work, pool_test_done, &job))
	destroy(&loop) // joins the worker mid-flight; reaching the next line is the assertion
	testing.expect(t, true)
}

Pool_Dispose_Job :: struct {
	disposed: ^int,
}

pool_test_noop_work :: proc(user_data: rawptr) {}

// pool_test_dispose runs on the loop thread for a job whose `done` will not run.
pool_test_dispose :: proc(user_data: rawptr) {
	job := cast(^Pool_Dispose_Job)user_data
	job.disposed^ += 1
}

@(test)
threadpool_shutdown_disposes_undelivered_jobs :: proc(t: ^testing.T) {
	// A queued backlog (more jobs than workers) torn down before the loop ever runs:
	// no completion is delivered, so every job's `dispose` must run exactly once (and
	// its `done` never does), letting a caller release user_data on abnormal teardown.
	loop := init()
	disposed := 0
	N :: 16
	jobs: [N]Pool_Dispose_Job
	for i in 0 ..< N {
		jobs[i] = Pool_Dispose_Job {
			disposed = &disposed,
		}
		testing.expect(t, pool_submit(&loop, pool_test_noop_work, nil, &jobs[i], pool_test_dispose))
	}
	destroy(&loop) // no loop run → no completion delivered → all N jobs disposed
	testing.expect_value(t, disposed, N)
}

@(test)
threadpool_ring_preserves_fifo_across_grow_and_wrap :: proc(t: ^testing.T) {
	// Exercise the pending ring directly (no workers, fully deterministic): fill past
	// capacity (grow), partially drain so the head advances, refill so the live region
	// wraps past the end, then push past capacity again so growth happens WHILE the
	// region is wrapped (the unwrap-copy path). Every job must dequeue exactly once in
	// submit order. (pool_ring_* are pointer-only; no Loop/threads needed.)
	pool := Thread_Pool{}
	defer if pool.pending != nil {
		delete(pool.pending)
	}

	jobs: [20]Pool_Job
	expect := 0
	pushed := 0

	// Grow 0 -> 8 and fill.
	for ; pushed < 8; pushed += 1 {
		pool_ring_push(&pool, &jobs[pushed], context.allocator)
	}
	// Drain 6: head advances to 6, two live entries remain.
	for _ in 0 ..< 6 {
		testing.expect(t, pool_ring_pop(&pool) == &jobs[expect], "fifo before wrap")
		expect += 1
	}
	// Refill to capacity: the live region now wraps past the end of the 8-slot backing.
	for ; pushed < 14; pushed += 1 {
		pool_ring_push(&pool, &jobs[pushed], context.allocator)
	}
	// Push past capacity: growth happens while the live region is wrapped (8 -> 16).
	for ; pushed < 20; pushed += 1 {
		pool_ring_push(&pool, &jobs[pushed], context.allocator)
	}
	// Drain everything: exactly once, still in submit order.
	for pool.pending_count > 0 {
		testing.expect(t, pool_ring_pop(&pool) == &jobs[expect], "fifo after wrap+grow")
		expect += 1
	}
	testing.expect_value(t, expect, 20)
}

// --- Per-tick temp arena reset ---

record_and_alloc_temp :: proc(loop: ^Loop, user_data: rawptr) {
	rec := cast(^Recorder)user_data
	append(&rec.events, 1)
	// Per-tick scratch, like the runtime's fetch response parsing / fs paths.
	_, _ = mem.alloc(4096, allocator = context.temp_allocator)
}

@(test)
run_resets_temp_allocator_each_tick :: proc(t: ^testing.T) {
	// A fixed 8 KiB arena as the temp allocator: four ticks each allocating
	// 4 KiB of scratch only fit if run() resets the arena between ticks.
	buf: [8192]byte
	arena: mem.Arena
	mem.arena_init(&arena, buf[:])
	context.temp_allocator = mem.arena_allocator(&arena)

	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)

	// Distinct deadlines so each callback fires on its own tick.
	for delay in 1 ..= 4 {
		set_timeout(&loop, record_and_alloc_temp, u64(delay), &rec)
	}

	run(&loop)

	expect_events(t, rec.events[:], []int{1, 1, 1, 1}) // no callback hit an exhausted arena
	testing.expect_value(t, arena.offset, 0) // every tick's scratch was reclaimed
}

@(test)
async_cancel_undoes_begin :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	// async_begin marks an off-loop op in flight; if dispatch then fails (e.g. a
	// worker thread couldn't spawn), async_cancel must undo it so the loop is not
	// kept alive — and run_until_idle must return immediately, not block.
	async_begin(&loop)
	testing.expect_value(t, pending_count(&loop), 1)
	async_cancel(&loop)
	testing.expect_value(t, pending_count(&loop), 0)
	testing.expect(t, !has_pending_work(&loop))
	testing.expect(t, !run_until_idle(&loop))
}

@(test)
backend_error_stops_run_drivers :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	// An in-flight off-loop op keeps the loop alive: has_pending_work stays true,
	// so without the backend_error escape the run drivers would spin forever once
	// platform_poll can no longer make progress (a fatal poll syscall error).
	async_begin(&loop)
	testing.expect(t, has_pending_work(&loop))

	// Simulate platform_poll flagging a fatal backend error.
	loop.backend_error = true

	// Both drivers must return promptly rather than busy-spin. (A regression here
	// shows up as the test hanging until the runner times out.)
	testing.expect(t, !run_until_idle(&loop))
	run(&loop)
	testing.expect(t, loop.backend_error) // flag is preserved for the embedder
}

@(test)
timers_fire_in_due_order_regardless_of_insertion :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)

	// Inserted out of deadline order; the min-heap must still fire by due_ms.
	set_timeout(&loop, record_3, 30, &rec) // -> 3
	set_timeout(&loop, record, 10, &rec) // -> 1
	set_timeout(&loop, record_2, 20, &rec) // -> 2

	run_until_idle(&loop)
	expect_events(t, rec.events[:], []int{1, 2, 3})
	testing.expect_value(t, pending_count(&loop), 0)
}

@(test)
equal_deadline_timers_fire_fifo :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)

	// Same deadline: seq must break the tie in scheduling order (Node FIFO).
	set_timeout(&loop, record, 10, &rec)
	set_timeout(&loop, record_2, 10, &rec)
	set_timeout(&loop, record_3, 10, &rec)

	run_until_idle(&loop)
	expect_events(t, rec.events[:], []int{1, 2, 3})
}

@(test)
cancelled_heap_timer_is_skipped_and_uncounted :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)

	set_timeout(&loop, record, 10, &rec) // -> 1
	mid := set_timeout(&loop, record_2, 20, &rec) // cancelled
	set_timeout(&loop, record_3, 30, &rec) // -> 3
	testing.expect_value(t, pending_count(&loop), 3)

	clear_timeout(&loop, mid)
	testing.expect_value(t, pending_count(&loop), 2) // O(1) counter dropped it

	run_until_idle(&loop)
	expect_events(t, rec.events[:], []int{1, 3})
	testing.expect_value(t, pending_count(&loop), 0)
}

@(test)
many_timers_fire_in_sorted_order :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)

	// Insert 64 timers with descending deadlines; the heap must emit ascending.
	N :: 64
	for i in 0 ..< N {
		set_timeout(&loop, record, u64((N - i) * 10), &rec)
	}
	testing.expect_value(t, pending_count(&loop), N)

	run_until_idle(&loop)
	testing.expect_value(t, len(rec.events), N)
	testing.expect_value(t, pending_count(&loop), 0)
	testing.expect_value(t, loop.now_ms, u64(N * 10))
}

// IO_Probe records that a readiness watcher fired and stops watching so the loop
// can go idle (active_io_count → 0).
IO_Probe :: struct {
	loop:    ^Loop,
	watcher: ^IO_Watcher,
	fired:   bool,
}

io_probe_cb :: proc(loop: ^Loop, user_data: rawptr) {
	probe := cast(^IO_Probe)user_data
	probe.fired = true
	// Clear the callback before unwatching: the io_uring backend re-arms a watcher
	// from watcher.callback after the callback returns, and the byte is left unread
	// (so the fd stays readable), so without this the watcher would re-fire forever.
	// Mirrors how the fetch transport stops a settled watcher.
	probe.watcher.callback = nil
	unwatch_fd(loop, probe.watcher)
}

// watch_fd fires its callback when a watched socket becomes readable. This is the
// core readiness contract every backend must honour (epoll/kqueue/select); it is
// the regression guard against a backend that reports success from watch_fd but
// can never fire (the original Windows IOCP stub did exactly that, parking the
// loop forever).
@(test)
watch_fd_fires_on_readable_socket :: proc(t: ^testing.T) {
	// A connected loopback TCP pair: write on the client, watch the server end.
	listener, lerr := net.listen_tcp(net.Endpoint{address = net.IP4_Loopback, port = 0})

	if !testing.expect_value(t, lerr, nil) {
		return
	}

	defer net.close(listener)

	bound, berr := net.bound_endpoint(listener)

	if !testing.expect_value(t, berr, nil) {
		return
	}

	client, cerr := net.dial_tcp_from_endpoint(net.Endpoint{address = net.IP4_Loopback, port = bound.port})

	if !testing.expect_value(t, cerr, nil) {
		return
	}

	defer net.close(client)

	server, _, aerr := net.accept_tcp(listener)

	if !testing.expect_value(t, aerr, nil) {
		return
	}

	defer net.close(server)

	loop := init(real_time = true)
	defer destroy(&loop)

	probe := IO_Probe {
		loop = &loop,
	}
	watcher := IO_Watcher {
		fd        = uintptr(server),
		mode      = .Read,
		callback  = io_probe_cb,
		user_data = &probe,
	}
	probe.watcher = &watcher

	if !testing.expect(t, watch_fd(&loop, &watcher), "watch_fd should accept the socket") {
		return
	}

	testing.expect_value(t, loop.active_io_count, 1)

	// Make the server end readable, then drive the loop. The callback fires and
	// unwatches, dropping active_io_count to 0 so run_until_idle returns.
	_, serr := net.send_tcp(client, {42})

	if !testing.expect_value(t, serr, nil) {
		return
	}

	run_until_idle(&loop)

	testing.expect(t, probe.fired, "watcher callback should have fired on readable socket")
	testing.expect_value(t, loop.active_io_count, 0)
}

// connect_loopback_pair builds a connected loopback TCP pair for the readiness
// tests: `client` is the write end, `server` the accepted end to watch. The
// listener is closed before returning (the established connection survives); the
// caller closes client and server. ok=false (sockets zeroed) on any setup failure.
connect_loopback_pair :: proc(t: ^testing.T) -> (client, server: net.TCP_Socket, ok: bool) {
	listener, lerr := net.listen_tcp(net.Endpoint{address = net.IP4_Loopback, port = 0})

	if !testing.expect_value(t, lerr, nil) {
		return
	}

	defer net.close(listener)

	bound, berr := net.bound_endpoint(listener)

	if !testing.expect_value(t, berr, nil) {
		return
	}

	dialed, cerr := net.dial_tcp_from_endpoint(net.Endpoint{address = net.IP4_Loopback, port = bound.port})

	if !testing.expect_value(t, cerr, nil) {
		return
	}

	accepted, _, aerr := net.accept_tcp(listener)

	if !testing.expect_value(t, aerr, nil) {
		net.close(dialed)
		return
	}

	client = dialed
	server = accepted
	ok = true
	return
}

noop_io_cb :: proc(loop: ^Loop, user_data: rawptr) {}

// active_io_count must track the LOGICAL registered set, not the platform syscall
// result: a duplicate watch must not double-count (io_uring would otherwise arm a
// second poll), and a no-op unwatch — an fd already removed by the kernel on close,
// or io_uring's logical-only unwatch invoked twice — must not drive the count
// negative (a spurious decrement can let the loop exit with I/O still pending).
@(test)
io_count_accounting_is_idempotent :: proc(t: ^testing.T) {
	client, server, ok := connect_loopback_pair(t)

	if !ok {
		return
	}

	defer net.close(client)
	defer net.close(server)

	loop := init(real_time = true)
	defer destroy(&loop)

	w := IO_Watcher {
		fd       = uintptr(server),
		mode     = .Read,
		callback = noop_io_cb,
	}

	testing.expect(t, watch_fd(&loop, &w), "first watch should register")
	testing.expect_value(t, loop.active_io_count, 1)

	testing.expect(t, !watch_fd(&loop, &w), "duplicate watch should be rejected")
	testing.expect_value(t, loop.active_io_count, 1)

	testing.expect(t, unwatch_fd(&loop, &w), "unwatch of a watched fd should succeed")
	testing.expect_value(t, loop.active_io_count, 0)

	testing.expect(t, !unwatch_fd(&loop, &w), "double unwatch should be a no-op")
	testing.expect_value(t, loop.active_io_count, 0)
}

// Immediate_Starvation drives the poll-starvation regression test: a setImmediate
// chain that keeps rescheduling itself until the watched socket fires.
Immediate_Starvation :: struct {
	loop:      ^Loop,
	watcher:   ^IO_Watcher,
	chain_len: int,
	io_fired:  bool,
}

starvation_immediate_cb :: proc(loop: ^Loop, user_data: rawptr) {
	st := cast(^Immediate_Starvation)user_data
	st.chain_len += 1

	// Keep an immediate perpetually pending until the I/O watcher fires. If a
	// did_work tick skips the poll phase entirely (the pre-fix behavior), the
	// watcher never fires and this chain never ends.
	if !st.io_fired {
		set_immediate(loop, starvation_immediate_cb, st)
	}
}

starvation_io_cb :: proc(loop: ^Loop, user_data: rawptr) {
	st := cast(^Immediate_Starvation)user_data
	st.io_fired = true
	st.watcher.callback = nil
	unwatch_fd(loop, st.watcher)
}

// A self-rescheduling setImmediate chain must not starve socket I/O: Node still
// runs the poll phase (timeout 0) every iteration while immediates are pending, so
// a ready fd is serviced rather than blocked until the chain ends. The regression
// (poll only runs when there is nothing else to do) leaves io_fired false forever.
@(test)
immediate_chain_does_not_starve_io :: proc(t: ^testing.T) {
	client, server, ok := connect_loopback_pair(t)

	if !ok {
		return
	}

	defer net.close(client)
	defer net.close(server)

	loop := init(real_time = true)
	defer destroy(&loop)

	st := Immediate_Starvation {
		loop = &loop,
	}
	w := IO_Watcher {
		fd        = uintptr(server),
		mode      = .Read,
		callback  = starvation_io_cb,
		user_data = &st,
	}
	st.watcher = &w

	if !testing.expect(t, watch_fd(&loop, &w)) {
		return
	}

	// Make the server end readable, then give the loopback byte time to land so the
	// very first non-blocking poll observes it.
	_, serr := net.send_tcp(client, {7})

	if !testing.expect_value(t, serr, nil) {
		return
	}

	time.sleep(20 * time.Millisecond)

	set_immediate(&loop, starvation_immediate_cb, &st)
	run_until_idle(&loop, 512)

	testing.expect(t, st.io_fired, "I/O watcher must fire despite a busy setImmediate chain")
	testing.expect_value(t, loop.active_io_count, 0)
	testing.expect_value(t, pending_count(&loop), 0)
}

// Interval_Self_Cancel drives the running_id-vs-microtask regression test.
Interval_Self_Cancel :: struct {
	id:         Timer_ID,
	fire_count: int,
}

cancel_interval_microtask :: proc(loop: ^Loop, user_data: rawptr) {
	sc := cast(^Interval_Self_Cancel)user_data
	clear_interval(loop, sc.id)
}

interval_queue_self_cancel_cb :: proc(loop: ^Loop, user_data: rawptr) {
	sc := cast(^Interval_Self_Cancel)user_data
	sc.fire_count += 1
	// Cancel from a microtask the callback queues, not synchronously. The cancel
	// only takes effect if running_id still names this timer when the microtask
	// runs — i.e. the post-callback microtask checkpoint happens before running_id
	// is cleared. Otherwise clear_interval finds nothing to cancel and the repeating
	// timer is wrongly re-armed.
	queue_microtask(loop, cancel_interval_microtask, sc)
}

@(test)
interval_cancelled_from_its_microtask_does_not_rearm :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	sc := Interval_Self_Cancel{}
	sc.id = set_interval(&loop, interval_queue_self_cancel_cb, 10, &sc)

	run_until_idle(&loop)

	testing.expect_value(t, sc.fire_count, 1) // fired once, then cancelled — never re-armed
	testing.expect_value(t, pending_count(&loop), 0)
}

// --- Stale-poll cancellation (#183) ---
//
// These exercise the watch/unwatch race that the io_uring backend must make
// memory-safe: a POLL_ADD that has (or may have) become ready before unwatch_fd
// is called must never dispatch its callback afterwards. They run on every backend
// — epoll removes the registration outright (EPOLL_CTL_DEL), io_uring cancels the
// poll and invalidates its generation token — and assert the same observable
// contract: no callback after unwatch. The assertions hold regardless of exact
// completion timing, so the tests are deterministic, not timing-dependent.

Watch_Counter :: struct {
	fired: int,
}

watch_count_cb :: proc(loop: ^Loop, user_data: rawptr) {
	c := cast(^Watch_Counter)user_data
	c.fired += 1
}

// Stop_Watch is a watcher that records its fire and immediately stops itself, so a
// loop driven to idle terminates even though the underlying fd stays readable.
Stop_Watch :: struct {
	loop:    ^Loop,
	watcher: ^IO_Watcher,
	fired:   int,
}

stop_watch_cb :: proc(loop: ^Loop, user_data: rawptr) {
	s := cast(^Stop_Watch)user_data
	s.fired += 1
	s.watcher.callback = nil
	unwatch_fd(loop, s.watcher)
}

// A completion that became ready before unwatch_fd was called must be dropped, not
// dispatched. The callback is intentionally left set across unwatch, so ONLY the
// backend cancellation (io_uring stale-token drop / epoll DEL) can suppress it —
// this is the regression guard for the use-after-free that motivated #183.
@(test)
unwatch_fd_drops_stale_io_completion :: proc(t: ^testing.T) {
	client, server, ok := connect_loopback_pair(t)

	if !ok {
		return
	}

	defer net.close(client)
	defer net.close(server)

	loop := init(real_time = true)
	defer destroy(&loop)

	counter := Watch_Counter{}
	w := IO_Watcher {
		fd        = uintptr(server),
		mode      = .Read,
		callback  = watch_count_cb,
		user_data = &counter,
	}

	if !testing.expect(t, watch_fd(&loop, &w)) {
		return
	}

	testing.expect_value(t, loop.active_io_count, 1)

	// Make the watched fd readable, but do NOT drive the loop: the completion is now
	// pending in the backend but unobserved.
	_, serr := net.send_tcp(client, {1})

	if !testing.expect_value(t, serr, nil) {
		return
	}

	time.sleep(20 * time.Millisecond)

	// Unwatch before the completion is drained, leaving the callback set.
	testing.expect(t, unwatch_fd(&loop, &w))
	testing.expect_value(t, loop.active_io_count, 0)

	// Reap whatever the backend produces (the cancelled poll and the cancel op on
	// io_uring); none of it may reach the callback.
	platform_poll(&loop, 20)
	platform_poll(&loop, 0)

	testing.expect_value(t, counter.fired, 0)
}

// After unwatch_fd, re-watching the SAME watcher struct (the backpressure
// pause→resume pattern) must dispatch the fresh registration while any straggling
// completion from the cancelled one is dropped. Verifies io_uring slot reuse and
// the generation bump distinguish the two.
@(test)
rewatch_after_unwatch_dispatches_live_watcher :: proc(t: ^testing.T) {
	client, server, ok := connect_loopback_pair(t)

	if !ok {
		return
	}

	defer net.close(client)
	defer net.close(server)

	loop := init(real_time = true)
	defer destroy(&loop)

	stale := Watch_Counter{}
	w := IO_Watcher {
		fd        = uintptr(server),
		mode      = .Read,
		callback  = watch_count_cb,
		user_data = &stale,
	}

	if !testing.expect(t, watch_fd(&loop, &w)) {
		return
	}

	_, serr := net.send_tcp(client, {1})

	if !testing.expect_value(t, serr, nil) {
		return
	}

	time.sleep(20 * time.Millisecond)

	// Pause: clear the callback (as the fetch transport does) and unwatch, then drain
	// the now-stale completion.
	w.callback = nil
	testing.expect(t, unwatch_fd(&loop, &w))
	platform_poll(&loop, 20)
	platform_poll(&loop, 0)

	// Resume: re-watch the same struct with a fresh, self-stopping callback. The fd
	// is still readable (the byte was never read), so the live poll fires once.
	live := Stop_Watch {
		loop    = &loop,
		watcher = &w,
	}
	w.callback = stop_watch_cb
	w.user_data = &live
	w.mode = .Read

	if !testing.expect(t, watch_fd(&loop, &w)) {
		return
	}

	run_until_idle(&loop, 64)

	testing.expect_value(t, stale.fired, 0) // the cancelled poll never dispatched
	testing.expect_value(t, live.fired, 1) // the fresh registration did
	testing.expect_value(t, loop.active_io_count, 0)
}

// Repeated arm→cancel cycles on a perpetually-readable fd: every armed poll has a
// completion racing its cancel, and every one must be dropped by its stale token.
// Models repeated backpressure pause/resume churn without ever dispatching stale.
@(test)
repeated_unwatch_never_dispatches_stale :: proc(t: ^testing.T) {
	client, server, ok := connect_loopback_pair(t)

	if !ok {
		return
	}

	defer net.close(client)
	defer net.close(server)

	loop := init(real_time = true)
	defer destroy(&loop)

	counter := Watch_Counter{}
	w := IO_Watcher {
		fd        = uintptr(server),
		mode      = .Read,
		callback  = watch_count_cb,
		user_data = &counter,
	}

	_, serr := net.send_tcp(client, {1})

	if !testing.expect_value(t, serr, nil) {
		return
	}

	time.sleep(20 * time.Millisecond)

	for _ in 0 ..< 8 {
		if !testing.expect(t, watch_fd(&loop, &w)) {
			return
		}

		testing.expect(t, unwatch_fd(&loop, &w))
		platform_poll(&loop, 5)
	}
	platform_poll(&loop, 5)
	platform_poll(&loop, 0)

	testing.expect_value(t, counter.fired, 0)
	testing.expect_value(t, loop.active_io_count, 0)
}

// Rearm_Self unwatches and immediately re-watches the SAME watcher struct from
// inside its own callback, until it has fired `limit` times. On io_uring this
// releases the slot (bumping its generation) and allocates a fresh one mid-dispatch,
// so the drain's post-callback re-validation must recognize the just-fired token as
// stale and NOT re-arm it, while the freshly-armed poll keeps the watcher live.
Rearm_Self :: struct {
	loop:    ^Loop,
	watcher: ^IO_Watcher,
	fired:   int,
	limit:   int,
}

rearm_self_cb :: proc(loop: ^Loop, user_data: rawptr) {
	s := cast(^Rearm_Self)user_data
	s.fired += 1
	unwatch_fd(loop, s.watcher)

	if s.fired >= s.limit {
		s.watcher.callback = nil // stop: no re-watch, loop drains to idle
		return
	}

	watch_fd(loop, s.watcher)
}

// A callback that unwatches then re-watches itself within a single dispatch must
// keep firing via its fresh registration, with no stale re-arm double-counting. This
// exercises the io_uring re-validation path that distinguishes a re-watch (new slot)
// from the just-completed poll (released slot) after the callback returns.
@(test)
rewatch_within_callback_keeps_watcher_live :: proc(t: ^testing.T) {
	client, server, ok := connect_loopback_pair(t)

	if !ok {
		return
	}

	defer net.close(client)
	defer net.close(server)

	loop := init(real_time = true)
	defer destroy(&loop)

	// Make the fd permanently readable (the byte is never consumed), so each fresh
	// poll completes and the watcher keeps firing until it stops itself.
	_, serr := net.send_tcp(client, {1})

	if !testing.expect_value(t, serr, nil) {
		return
	}

	time.sleep(20 * time.Millisecond)

	s := Rearm_Self {
		loop  = &loop,
		limit = 3,
	}
	w := IO_Watcher {
		fd        = uintptr(server),
		mode      = .Read,
		callback  = rearm_self_cb,
		user_data = &s,
	}
	s.watcher = &w

	if !testing.expect(t, watch_fd(&loop, &w)) {
		return
	}

	run_until_idle(&loop, 256)

	testing.expect_value(t, s.fired, 3) // fired exactly limit times across re-arms
	testing.expect_value(t, loop.active_io_count, 0) // final unwatch left nothing armed
}

// --- timer_index (O(1) clearTimeout) invariant + eager-removal regressions (PR #282) ---

// check_timer_index asserts the id->slot map matches the heap exactly and the heap order
// holds. A missed index update during a swap would surface here as a wrong slot.
check_timer_index :: proc(t: ^testing.T, loop: ^Loop) {
	testing.expect_value(t, len(loop.timer_index), len(loop.timers))
	for i in 0 ..< len(loop.timers) {
		idx, ok := loop.timer_index[loop.timers[i].id]
		testing.expect(t, ok, "live timer id missing from timer_index")
		testing.expect_value(t, idx, i)
	}
	for i in 1 ..< len(loop.timers) {
		parent := (i - 1) / 2
		// min-heap: parent must not be strictly greater than child.
		testing.expect(t, !timer_less(&loop.timers[i], &loop.timers[parent]), "heap order violated")
	}
}

@(private = "file")
test_lcg :: proc(s: ^u64) -> u64 {
	s^ = s^ * 6364136223846793005 + 1442695040888963407
	return s^ >> 33
}

// Sift-up moves earlier timers as smaller ones are inserted; cancelling a moved timer must
// find it at its current slot (not its insertion slot) and remove it without tombstones.
@(test)
timer_index_consistent_after_siftup_and_cancel :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)
	rec := Recorder{}
	defer delete(rec.events)

	ids: [8]Timer_ID
	// Descending delays: each insert is the new minimum, sifting to the root and pushing
	// the rest down — every insert moves existing entries.
	for k in 0 ..< 8 {
		ids[k] = set_timeout(&loop, record, u64((8 - k) * 1000), &rec, count_dispose)
	}
	check_timer_index(t, &loop)
	testing.expect_value(t, len(loop.timers), 8)

	testing.expect(t, clear_timeout(&loop, ids[0])) // inserted first, sifted deepest
	testing.expect(t, clear_timeout(&loop, ids[3]))
	testing.expect(t, clear_timeout(&loop, ids[5]))
	check_timer_index(t, &loop)
	testing.expect_value(t, len(loop.timers), 5) // eager removal: heap shrank, no tombstones
	testing.expect_value(t, rec.dispose_count, 3)
	testing.expect(t, !clear_timeout(&loop, ids[0])) // already removed → no-op
}

// Codex #1: cancellation must not leave tombstones in the heap/index behind a live, not-yet-
// due root. Arming many far-future timers then cancelling all must drain to empty.
@(test)
timer_cancel_removes_eagerly_bounding_memory :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)
	rec := Recorder{}
	defer delete(rec.events)

	N :: 200
	ids: [N]Timer_ID
	for k in 0 ..< N {
		ids[k] = set_timeout(&loop, record, 1_000_000, &rec, count_dispose)
	}
	testing.expect_value(t, len(loop.timers), N)
	testing.expect_value(t, len(loop.timer_index), N)

	for k in 0 ..< N {
		testing.expect(t, clear_timeout(&loop, ids[k]))
	}
	testing.expect_value(t, len(loop.timers), 0) // not N tombstones
	testing.expect_value(t, len(loop.timer_index), 0)
	testing.expect_value(t, rec.dispose_count, N)
	testing.expect_value(t, len(rec.events), 0)
}

// A re-armed interval lives back in the heap each fire; an external clear must find the
// re-armed instance via the index and remove it cleanly.
@(test)
interval_rearm_then_external_cancel :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)
	rec := Recorder{}
	defer delete(rec.events)

	id := set_interval(&loop, record, 0, &rec, count_dispose)
	for _ in 0 ..< 3 {run_once(&loop)} 	// fire + re-arm a few times
	testing.expect(t, len(rec.events) >= 1)
	check_timer_index(t, &loop)

	testing.expect(t, clear_interval(&loop, id))
	testing.expect_value(t, len(loop.timers), 0)
	testing.expect_value(t, len(loop.timer_index), 0)
	testing.expect_value(t, rec.dispose_count, 1)
	testing.expect(t, !run_until_idle(&loop))
}

// Randomized arm/cancel churn: the id->slot invariant must hold after every operation.
@(test)
timer_index_invariant_under_random_churn :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)
	rec := Recorder{}
	defer delete(rec.events)

	live: [dynamic]Timer_ID
	defer delete(live)
	seed: u64 = 0x9E3779B97F4A7C15

	for _ in 0 ..< 1500 {
		r := test_lcg(&seed)

		if len(live) == 0 || (r & 1) == 0 {
			id := set_timeout(&loop, record, u64(r % 100000 + 1), &rec, count_dispose)
			append(&live, id)
		} else {
			pick := int((r >> 1) % u64(len(live)))
			testing.expect(t, clear_timeout(&loop, live[pick]))
			unordered_remove(&live, pick)
		}

		if len(loop.timers) != len(loop.timer_index) {
			testing.expect_value(t, len(loop.timer_index), len(loop.timers))
			return
		}
	}
	check_timer_index(t, &loop)
	testing.expect_value(t, len(loop.timers), len(live))
	for id in live {
		clear_timeout(&loop, id)
	}
	testing.expect_value(t, len(loop.timers), 0)
	testing.expect_value(t, len(loop.timer_index), 0)
}
