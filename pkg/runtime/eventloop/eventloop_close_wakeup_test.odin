// Linux-only: polls the wakeup pipe's read end (wakeup_fd is Linux-only) under the
// epoll backend (force_readiness_backend).
#+build linux
package eventloop

import "core:sys/linux"
import "core:testing"
import "core:time"

// close_ready is announced on the wakeup pipe: a pool worker counts itself out
// (pool.exited) and then writes the pipe, so a driver that waits on wakeup_fd for a
// closed loop's workers wakes once close_finish will no longer wait (larva#49, #34).
// Lava has no such driver today; the contract ships with close_ready and wakeup_fd and
// is pinned here, Lava-only, since no page runner of Lava's observes it.
//
// No job is in flight at close_begin — every worker is idle, and exits on its stop
// broadcast — so the only writes to the pipe after it is drained are those exits'.
// Under the epoll backend nothing consumes the pipe on its own; io_uring would (it
// keeps a read armed on it until close_begin closes the ring), so the test forces the
// readiness backend.

@(private = "file")
Quick_Job :: struct {
	done: bool, // loop thread only
}

@(private = "file")
quick_work :: proc(user_data: rawptr) {}

@(private = "file")
quick_done :: proc(loop: ^Loop, user_data: rawptr) {
	(cast(^Quick_Job)user_data).done = true
}

@(test)
close_ready_is_announced_on_the_wakeup_pipe :: proc(t: ^testing.T) {
	saved := force_readiness_backend
	force_readiness_backend = true
	defer force_readiness_backend = saved
	loop := init()

	// Start the pool and let its one job complete, so all four workers sit idle.
	job: Quick_Job
	testing.expect(t, pool_submit(&loop, quick_work, quick_done, &job))
	deadline := time.tick_add(time.tick_now(), 2 * time.Second)
	for !job.done && time.tick_diff(time.tick_now(), deadline) > 0 do run_once(&loop)
	if !job.done {
		destroy(&loop)
		testing.fail_now(t, "the pool job never completed")
	}

	pipe_fd, ok := wakeup_fd(&loop)
	if !ok {
		destroy(&loop)
		testing.fail_now(t, "the loop has no wakeup pipe")
	}
	drain_wakeup(&loop)

	testing.expect(t, !close_begin(&loop), "close_begin reported a busy worker with none in a job")
	for !close_ready(&loop) && time.tick_diff(time.tick_now(), deadline) > 0 do time.sleep(time.Millisecond)
	testing.expect(t, close_ready(&loop), "idle workers never counted themselves out")

	// The last worker writes the pipe just after its count moves; allow it a second.
	fds := [1]linux.Poll_Fd{{fd = pipe_fd, events = {.IN}}}
	n, _ := linux.poll(fds[:], 1000)
	testing.expectf(t, n == 1 && .IN in fds[0].revents, "the wakeup pipe was not written as the workers exited (poll %d)", n)

	close_finish(&loop)
}
