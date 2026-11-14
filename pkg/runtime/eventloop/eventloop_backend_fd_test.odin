#+build linux
package eventloop

import "core:sys/linux"
import "core:testing"

// backend_fd is how a multi-loop driver (the page runner) learns, without ticking the
// loop, that it has I/O to process. Register it in an outer epoll, make a watched fd
// readable, and the outer epoll must report it — a missed wake would leave the
// driver blocked forever on a page with no timer. Deterministic, unlike a runner-level
// test, where JSC's signal thread interrupts epoll_wait often enough to hide a miss.
@(test)
backend_fd_wakes_an_outer_epoll_on_watched_io :: proc(t: ^testing.T) {
	loop := init(real_time = true)
	defer destroy(&loop)
	loop.never_block = true
	fd, ok := backend_fd(&loop)
	if !ok do testing.fail_now(t, "no backend fd")

	outer, oerr := linux.epoll_create1({.FDCLOEXEC})
	if oerr != .NONE do testing.fail_now(t, "epoll_create1 failed")
	defer linux.close(outer)
	ev := linux.EPoll_Event {
		events = {.IN, .ET},
	}
	testing.expect_value(t, linux.epoll_ctl(outer, .ADD, linux.Fd(fd), &ev), linux.Errno.NONE)

	pipe: [2]linux.Fd
	if linux.pipe2(&pipe, {.CLOEXEC, .NONBLOCK}) != .NONE do testing.fail_now(t, "pipe2 failed")
	defer linux.close(pipe[0])
	defer linux.close(pipe[1])
	fired := false
	on_ready :: proc(loop: ^Loop, user_data: rawptr) {(cast(^bool)user_data)^ = true}
	w := IO_Watcher {
		fd        = uintptr(pipe[0]),
		mode      = .Read,
		callback  = on_ready,
		user_data = &fired,
	}
	testing.expect(t, watch_fd(&loop, &w), "watch_fd failed")
	// One non-blocking tick submits the watch (io_uring stages it until the poll phase).
	run_once(&loop)

	events: [4]linux.EPoll_Event
	n, _ := linux.epoll_wait(outer, raw_data(events[:]), 4, 0)
	testing.expectf(t, n == 0, "outer epoll ready before any I/O (%d)", n)

	b := [1]u8{'x'}
	linux.write(pipe[1], b[:])
	// Retry across EINTR; anything else that returns 0 within 1 s is the miss.
	for _ in 0 ..< 10 {
		n, _ = linux.epoll_wait(outer, raw_data(events[:]), 4, 100)
		if n > 0 do break
	}
	testing.expect(t, n > 0, "backend_fd did not wake the outer epoll for watched I/O")
	run_once(&loop)
	testing.expect(t, fired, "the loop did not run the watcher after the wake")
	unwatch_fd(&loop, &w)
}
