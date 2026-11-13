#+build darwin
package eventloop

import "core:sys/kqueue"
import "core:sys/posix"
import "core:time"

Platform_Loop :: struct {
	kq:          kqueue.KQ,
	wakeup_pipe: [2]posix.FD,
}

platform_name :: proc(loop: ^Loop) -> string {
	return "darwin-kqueue"
}

platform_init :: proc(loop: ^Loop) -> bool {
	// Sentinels so a failed init leaves no fd 0 defaults that platform_destroy
	// would close (closing fd 0 = stdin). Mirrors loop_linux.odin.
	loop.platform.kq = -1
	loop.platform.wakeup_pipe = {-1, -1}

	kq, kq_err := kqueue.kqueue()
	if kq_err != .NONE {
		return false
	}
	loop.platform.kq = kq

	if posix.pipe(&loop.platform.wakeup_pipe) != .OK {
		posix.close(loop.platform.kq)
		loop.platform.kq = -1
		return false
	}

	// Both ends nonblocking: the read end so draining never blocks the loop, the
	// write end so a cross-thread wakeup() never blocks a worker if the pipe fills
	// (a wakeup is already pending in that case). Matches the Linux pipe2 flags.
	posix.fcntl(loop.platform.wakeup_pipe[0], .SETFL, posix.O_Flags{.NONBLOCK})
	posix.fcntl(loop.platform.wakeup_pipe[1], .SETFL, posix.O_Flags{.NONBLOCK})
	// And close-on-exec on both ends so the internal wakeup pipe never leaks into a
	// child process (posix.pipe, unlike Linux's pipe2, cannot set this atomically).
	// Matches the {.CLOEXEC} half of the Linux pipe2 flags.
	posix.fcntl(loop.platform.wakeup_pipe[0], .SETFD, i32(posix.FD_CLOEXEC))
	posix.fcntl(loop.platform.wakeup_pipe[1], .SETFD, i32(posix.FD_CLOEXEC))

	ev := kqueue.KEvent {
		ident  = uintptr(loop.platform.wakeup_pipe[0]),
		filter = .Read,
		flags  = {.Add, .Enable},
	}
	_, err := kqueue.kevent(loop.platform.kq, {ev}, nil, nil)
	if err != .NONE {
		posix.close(loop.platform.wakeup_pipe[0])
		posix.close(loop.platform.wakeup_pipe[1])
		posix.close(loop.platform.kq)
		loop.platform.wakeup_pipe = {-1, -1}
		loop.platform.kq = -1
		return false
	}

	return true
}

platform_destroy :: proc(loop: ^Loop) {
	if loop.platform.wakeup_pipe[0] >= 0 {
		posix.close(loop.platform.wakeup_pipe[0])
		loop.platform.wakeup_pipe[0] = -1
	}
	if loop.platform.wakeup_pipe[1] >= 0 {
		posix.close(loop.platform.wakeup_pipe[1])
		loop.platform.wakeup_pipe[1] = -1
	}
	if loop.platform.kq >= 0 {
		posix.close(loop.platform.kq)
		loop.platform.kq = -1
	}
}

platform_wakeup :: proc(loop: ^Loop) {
	// EAGAIN on a full pipe is fine — the read end is already readable, so a
	// wakeup is already pending. The write end is nonblocking (see platform_init).
	dummy: byte = 1
	posix.write(loop.platform.wakeup_pipe[1], &dummy, 1)
}

platform_watch_fd :: proc(loop: ^Loop, watcher: ^IO_Watcher) -> bool {
	ev := kqueue.KEvent {
		ident  = watcher.fd,
		filter = .Read if watcher.mode == .Read else .Write,
		flags  = {.Add, .Enable},
		udata  = watcher,
	}
	_, err := kqueue.kevent(loop.platform.kq, {ev}, nil, nil)
	return err == .NONE
}

platform_unwatch_fd :: proc(loop: ^Loop, watcher: ^IO_Watcher) -> bool {
	ev := kqueue.KEvent {
		ident  = watcher.fd,
		filter = .Read if watcher.mode == .Read else .Write,
		flags  = {.Delete},
	}
	_, err := kqueue.kevent(loop.platform.kq, {ev}, nil, nil)
	return err == .NONE
}

platform_poll :: proc(loop: ^Loop, timeout_ms: int) {
	events: [32]kqueue.KEvent

	// Re-enter on EINTR rather than returning a spurious idle wake: a signal that
	// interrupts the wait must not be mistaken for "nothing to do". For a finite
	// timeout the retry waits the REMAINING time (an absolute deadline), so a storm
	// of signals can neither restart the full interval nor extend it unboundedly.
	poll_start := time.tick_now()
	n: i32
	for {
		ts: posix.timespec
		timeout: ^posix.timespec = nil
		if timeout_ms >= 0 {
			remaining := poll_remaining_ms(poll_start, timeout_ms)
			ts.tv_sec = posix.time_t(remaining / 1000)
			ts.tv_nsec = i64((remaining % 1000) * 1_000_000)
			timeout = &ts
		}

		res, err := kqueue.kevent(loop.platform.kq, nil, events[:], timeout)
		if err == .EINTR {
			continue
		}
		// Any other error is fatal (e.g. EBADF on a closed kqueue fd): flag it so the
		// run drivers stop instead of busy-spinning on a syscall that can never
		// make progress.
		if err != .NONE {
			loop.backend_error = true
			return
		}
		n = res
		break
	}
	if n == 0 {
		return
	}

	for i in 0 ..< n {
		ev := events[i]

		if ev.ident == uintptr(loop.platform.wakeup_pipe[0]) {
			buf: [64]byte
			for posix.read(loop.platform.wakeup_pipe[0], &buf[0], len(buf)) > 0 {}
			continue
		}

		watcher := cast(^IO_Watcher)ev.udata
		if watcher != nil && watcher.callback != nil {
			loop.io_events += 1
			watcher.callback(loop, watcher.user_data)
		}
	}
}

// Proactor (completion-mode socket I/O) is io_uring-only; this backend has no equivalent, so
// proactor_available is false and submit_recv/submit_send never succeed (callers use the
// readiness path, watch_fd). See docs/lava/io-uring-proactor.md.
platform_proactor_available :: proc(loop: ^Loop) -> bool {
	return false
}

platform_submit_recv :: proc(
	loop: ^Loop,
	fd: uintptr,
	buf: []byte,
	cb: Op_Completion,
	dispose: Op_Dispose,
	user_data: rawptr,
) -> u64 {
	return 0
}

platform_submit_send :: proc(
	loop: ^Loop,
	fd: uintptr,
	buf: []byte,
	cb: Op_Completion,
	dispose: Op_Dispose,
	user_data: rawptr,
) -> u64 {
	return 0
}

platform_cancel_op :: proc(loop: ^Loop, token: u64) -> bool {return false}

// Provided-buffer ring (Slice 2a) — Linux/io_uring only; no-op on darwin.
platform_bufring_ok :: proc(loop: ^Loop) -> bool {return false}
platform_submit_recv_ring :: proc(
	loop: ^Loop,
	fd: uintptr,
	cb: Op_Recv_Completion,
	dispose: Op_Dispose,
	user_data: rawptr,
) -> u64 {return 0}
platform_buf_ring_buf :: proc(loop: ^Loop, bid: u16, n: int) -> []byte {return nil}
platform_buf_ring_recycle :: proc(loop: ^Loop, bid: u16) {}
platform_recv_ring_multishot :: proc(loop: ^Loop) -> bool {return false}
platform_disable_multishot :: proc(loop: ^Loop) {}
