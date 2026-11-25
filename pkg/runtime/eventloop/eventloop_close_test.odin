package eventloop

import "base:runtime"
import "core:sync"
import "core:testing"
import "core:thread"
import "core:time"

// The split teardown (close_begin / close_finish) of a loop with a private pool, which
// lets eval report a page's Result before it waits for a pool worker blocked in `work`
// (#34). A job here blocks on a semaphore the test posts, standing in for a read on a
// FIFO. The shared pool's side, where nothing waits, is eventloop_worker_pool_test.odin.

@(private = "file")
Blocking_Job :: struct {
	gate:    sync.Sema,
	started: bool, // atomic: the worker is inside `work`
	done:    int, // loop thread only
	cancel:  int, // atomic: also read while a worker runs
	dispose: int, // atomic: a detached loop's last worker runs dispose
}

@(private = "file")
blocking_work :: proc(user_data: rawptr) {
	job := cast(^Blocking_Job)user_data
	sync.atomic_store(&job.started, true)
	sync.sema_wait(&job.gate)
}

@(private = "file")
blocking_done :: proc(loop: ^Loop, user_data: rawptr) {
	(cast(^Blocking_Job)user_data).done += 1
}

@(private = "file")
blocking_cancel :: proc(user_data: rawptr) {
	sync.atomic_add(&(cast(^Blocking_Job)user_data).cancel, 1)
}

@(private = "file")
blocking_dispose :: proc(user_data: rawptr) {
	sync.atomic_add(&(cast(^Blocking_Job)user_data).dispose, 1)
}

// Safety net for the red phase: a close that joins the worker would hang the test
// binary forever, so a helper releases the gate after `delay` and the test fails on
// its timing assertion instead.
@(private = "file")
Releaser :: struct {
	job:   ^Blocking_Job,
	delay: time.Duration,
	stop:  bool,
}

@(private = "file")
releaser_proc :: proc(r: ^Releaser) {
	deadline := time.tick_add(time.tick_now(), r.delay)
	for time.tick_diff(time.tick_now(), deadline) > 0 {
		if sync.atomic_load(&r.stop) {
			return
		}

		time.sleep(5 * time.Millisecond)
	}
	sync.sema_post(&r.job.gate)
}

@(private = "file")
wait_started :: proc(job: ^Blocking_Job) -> bool {
	deadline := time.tick_add(time.tick_now(), 2 * time.Second)
	for !sync.atomic_load(&job.started) {
		if time.tick_diff(time.tick_now(), deadline) <= 0 {
			return false
		}

		time.sleep(time.Millisecond)
	}
	return true
}

@(private = "file")
heap_loop :: proc() -> ^Loop {
	loop := new(Loop, runtime.heap_allocator())
	loop^ = init(runtime.heap_allocator())
	return loop
}

// close_begin returns at once with a worker blocked in `work`, releases the job's
// engine half through `cancel` exactly once, runs neither `done` nor `dispose`, and
// says the workers are busy; close_finish waits for the worker, which disposes the
// job's memory, and still never runs `done`.
@(test)
close_begin_cancels_a_running_job_without_waiting_for_it :: proc(t: ^testing.T) {
	loop := heap_loop()
	job: Blocking_Job
	testing.expect(t, pool_submit(loop, blocking_work, blocking_done, &job, blocking_dispose, blocking_cancel))

	if !wait_started(&job) {
		testing.fail_now(t, "the worker never started the job")
	}

	rel := Releaser {
		job   = &job,
		delay = 2 * time.Second,
	}
	th := thread.create_and_start_with_poly_data(&rel, releaser_proc)

	start := time.tick_now()
	busy := close_begin(loop)
	took := time.duration_seconds(time.tick_since(start))
	testing.expectf(t, took < 0.5, "close_begin waited %.2fs on a worker blocked in work", took)
	testing.expect(t, busy, "close_begin did not report the blocked worker")
	testing.expect_value(t, sync.atomic_load(&job.cancel), 1)
	testing.expect_value(t, sync.atomic_load(&job.dispose), 0)

	sync.atomic_store(&rel.stop, true)
	thread.destroy(th)
	sync.sema_post(&job.gate)
	start = time.tick_now()
	close_finish(loop)
	took = time.duration_seconds(time.tick_since(start))
	free(loop, runtime.heap_allocator())
	testing.expectf(t, took < 2, "close_finish took %.2fs after the job was released", took)

	testing.expect_value(t, job.done, 0)
	testing.expect_value(t, sync.atomic_load(&job.cancel), 1)
	testing.expect_value(t, sync.atomic_load(&job.dispose), 1)
}
