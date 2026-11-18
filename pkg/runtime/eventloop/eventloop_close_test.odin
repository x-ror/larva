// Linux-only: reads /proc/self/fd to tell whether a detached loop's wakeup pipe is
// still the same pipe.
#+build linux
package eventloop

import "base:runtime"
import "core:fmt"
import "core:os"
import "core:sync"
import "core:testing"
import "core:thread"
import "core:time"

// The split teardown (close_begin / close_finish / close_detach) that lets the page
// runner close a page without joining a pool worker blocked in `work` (#34). A job
// here blocks on a semaphore the test posts, standing in for a read on a FIFO.

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
		if sync.atomic_load(&r.stop) do return
		time.sleep(5 * time.Millisecond)
	}
	sync.sema_post(&r.job.gate)
}

@(private = "file")
wait_started :: proc(job: ^Blocking_Job) -> bool {
	deadline := time.tick_add(time.tick_now(), 2 * time.Second)
	for !sync.atomic_load(&job.started) {
		if time.tick_diff(time.tick_now(), deadline) <= 0 do return false
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
// says the workers are busy; close_finish, once close_ready, disposes the job's memory
// and still never runs `done`.
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
	testing.expect(t, !close_ready(loop), "close_ready while a worker is still inside work")

	sync.atomic_store(&rel.stop, true)
	thread.destroy(th)
	sync.sema_post(&job.gate)
	deadline := time.tick_add(time.tick_now(), 3 * time.Second)
	for !close_ready(loop) && time.tick_diff(time.tick_now(), deadline) > 0 do time.sleep(time.Millisecond)
	testing.expect(t, close_ready(loop), "workers never reported their exit")
	close_finish(loop)
	free(loop, runtime.heap_allocator())

	testing.expect_value(t, job.done, 0)
	testing.expect_value(t, sync.atomic_load(&job.cancel), 1)
	testing.expect_value(t, sync.atomic_load(&job.dispose), 1)
}

// A detached loop is finished by its own last worker: close_detach returns at once,
// the wakeup pipe stays open while the worker can still write it (a closed number
// would be reused by the next loop, and the late wakeup byte would land there), and
// once the worker exits, the job is disposed and the pipe closed — with nobody
// joining anything.
@(test)
close_detach_leaves_the_loop_to_its_last_worker :: proc(t: ^testing.T) {
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
	pipe_fd, _ := wakeup_fd(loop)
	pipe_link := fd_link(int(pipe_fd))
	defer delete(pipe_link)

	start := time.tick_now()
	testing.expect(t, close_begin(loop), "close_begin did not report the blocked worker")
	detached := close_detach(loop)
	took := time.duration_seconds(time.tick_since(start))
	testing.expectf(t, took < 0.5, "close_begin + close_detach waited %.2fs on a worker blocked in work", took)
	testing.expect(t, detached, "close_detach finished a loop whose worker is still blocked")
	// The loop belongs to its workers now: nothing below reads it.
	still := fd_link(int(pipe_fd))
	testing.expectf(
		t,
		still == pipe_link,
		"wakeup pipe fd %d changed from %q to %q while its worker was blocked",
		pipe_fd,
		pipe_link,
		still,
	)
	delete(still)

	sync.atomic_store(&rel.stop, true)
	thread.destroy(th)
	sync.sema_post(&job.gate)
	deadline := time.tick_add(time.tick_now(), 3 * time.Second)
	for sync.atomic_load(&job.dispose) == 0 && time.tick_diff(time.tick_now(), deadline) > 0 do time.sleep(time.Millisecond)
	testing.expect_value(t, sync.atomic_load(&job.dispose), 1)
	testing.expect_value(t, sync.atomic_load(&job.cancel), 1)
	testing.expect_value(t, job.done, 0)
	// The dispose runs before the pipe closes; give the worker the rest of its exit.
	closed := false
	for time.tick_diff(time.tick_now(), deadline) > 0 {
		now := fd_link(int(pipe_fd))
		closed = now != pipe_link
		delete(now)
		if closed do break
		time.sleep(time.Millisecond)
	}
	testing.expectf(t, closed, "the detached loop's wakeup pipe (fd %d) was never closed", pipe_fd)
}

// fd_link is what /proc/self/fd/<fd> points at ("pipe:[1234]"), or "" when the fd is
// closed. A pipe's inode number tells the same pipe from a recycled descriptor number.
@(private = "file")
fd_link :: proc(fd: int) -> string {
	target, err := os.read_link(fmt.tprintf("/proc/self/fd/%d", fd), context.allocator)
	if err != nil do return ""
	return target
}
