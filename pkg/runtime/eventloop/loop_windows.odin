#+build windows
package eventloop

import "core:sys/windows"

// Windows event-loop backend. Readiness is provided by Winsock `select` over the
// set of watched sockets, mirroring the epoll (Linux) / kqueue (Darwin) model:
// platform_poll builds the read/write fd_sets, blocks until a socket is ready (or
// the timeout elapses), and dispatches each ready watcher's callback.
//
// Why select and not IOCP: the loop's I/O contract is readiness-based (a watcher
// fires when its fd is readable/writable), but IOCP is completion-based — it only
// reports finished overlapped operations, so a readiness watcher layered on a
// bare IOCP association can never fire (the bug this backend replaces).
// select reports a failed non-blocking connect in exceptfds, which the fetch
// transport needs; WSAPoll famously does not, so select is the correct primitive
// here. The FD_SETSIZE (64) cap is acceptable for current consumers (fetch); an
// AFD/wepoll backend can lift it later.
//
// Cross-thread wakeup uses a loopback TCP socket pair (Windows has no self-pipe):
// the read end sits in every select() readfds, and platform_wakeup sends a byte
// to the write end to break select out of its wait.

Platform_Loop :: struct {
	watchers:  [dynamic]^IO_Watcher, // active readiness watchers (loop thread)
	wake_recv: windows.SOCKET, // loopback pair read end, always selected for read
	wake_send: windows.SOCKET, // loopback pair write end, poked by platform_wakeup
	started:   bool, // WSAStartup succeeded (so platform_destroy cleans up)
}

platform_name :: proc(loop: ^Loop) -> string {
	return "windows-select"
}

platform_init :: proc(loop: ^Loop) -> bool {
	loop.platform.wake_recv = windows.INVALID_SOCKET
	loop.platform.wake_send = windows.INVALID_SOCKET

	wsadata: windows.WSADATA
	if windows.WSAStartup(windows.MAKEWORD(2, 2), &wsadata) != 0 {
		return false
	}
	loop.platform.started = true

	if !make_wakeup_pair(loop) {
		windows.WSACleanup()
		loop.platform.started = false
		return false
	}

	loop.platform.watchers = make([dynamic]^IO_Watcher, loop.allocator)
	return true
}

// make_wakeup_pair builds a connected loopback TCP socket pair. A transient
// listener on 127.0.0.1:0 accepts a self-connection; the kernel completes the
// loopback handshake from the backlog without a second thread, so the blocking
// connect/accept run safely on the loop thread during init. The read end is set
// non-blocking so draining it in platform_poll never stalls the loop.
@(private = "file")
make_wakeup_pair :: proc(loop: ^Loop) -> bool {
	listener := windows.socket(windows.AF_INET, windows.SOCK_STREAM, 0)
	if listener == windows.INVALID_SOCKET do return false
	defer windows.closesocket(listener)

	addr := windows.sockaddr_in {
		sin_family = u16(windows.AF_INET),
		sin_port = 0, // ask the kernel for an ephemeral port
		sin_addr = {s_addr = transmute(u32)[4]u8{127, 0, 0, 1}},
	}
	if windows.bind(listener, cast(^windows.SOCKADDR_STORAGE_LH)&addr, size_of(addr)) ==
	   windows.SOCKET_ERROR {
		return false
	}
	if windows.listen(listener, 1) == windows.SOCKET_ERROR do return false

	// Recover the bound ephemeral port to connect back to.
	bound: windows.sockaddr_in
	bound_len := i32(size_of(bound))
	if windows.getsockname(listener, cast(^windows.SOCKADDR_STORAGE_LH)&bound, &bound_len) ==
	   windows.SOCKET_ERROR {
		return false
	}

	send_sock := windows.socket(windows.AF_INET, windows.SOCK_STREAM, 0)
	if send_sock == windows.INVALID_SOCKET do return false
	connect_addr := windows.sockaddr_in {
		sin_family = u16(windows.AF_INET),
		sin_port = bound.sin_port,
		sin_addr = {s_addr = transmute(u32)[4]u8{127, 0, 0, 1}},
	}
	if windows.connect(
		   send_sock,
		   cast(^windows.SOCKADDR_STORAGE_LH)&connect_addr,
		   size_of(connect_addr),
	   ) ==
	   windows.SOCKET_ERROR {
		windows.closesocket(send_sock)
		return false
	}

	recv_sock := windows.accept(listener, nil, nil)
	if recv_sock == windows.INVALID_SOCKET {
		windows.closesocket(send_sock)
		return false
	}

	// Both ends are non-blocking: the read end so draining it in platform_poll
	// never stalls the loop, the write end so a wakeup() burst that fills the send
	// buffer can never block a worker thread (a byte is already pending, which is
	// all a wakeup needs). Bail cleanly if either cannot be configured — a blocking
	// drain or wakeup would be a latent hang in backend infrastructure.
	if !set_nonblocking(recv_sock) || !set_nonblocking(send_sock) {
		windows.closesocket(send_sock)
		windows.closesocket(recv_sock)
		return false
	}

	loop.platform.wake_recv = recv_sock
	loop.platform.wake_send = send_sock
	return true
}

// set_nonblocking puts a socket into non-blocking mode (FIONBIO).
@(private = "file")
set_nonblocking :: proc(sock: windows.SOCKET) -> bool {
	nonblock: windows.c_ulong = 1
	// FIONBIO has its high bit set (0x8004667e), so a checked cast to signed c_long
	// overflows; reinterpret the bits instead.
	return(
		windows.ioctlsocket(sock, transmute(windows.c_long)windows.FIONBIO, &nonblock) !=
		windows.SOCKET_ERROR \
	)
}

platform_destroy :: proc(loop: ^Loop) {
	if loop.platform.wake_recv != windows.INVALID_SOCKET {
		windows.closesocket(loop.platform.wake_recv)
		loop.platform.wake_recv = windows.INVALID_SOCKET
	}
	if loop.platform.wake_send != windows.INVALID_SOCKET {
		windows.closesocket(loop.platform.wake_send)
		loop.platform.wake_send = windows.INVALID_SOCKET
	}
	delete(loop.platform.watchers)
	if loop.platform.started {
		windows.WSACleanup()
		loop.platform.started = false
	}
}

platform_wakeup :: proc(loop: ^Loop) {
	// One byte breaks select out of its wait; the read end is drained in
	// platform_poll. Safe to call from any thread. The write end is non-blocking, so
	// if the send buffer is already full (a wakeup is pending and undrained) the call
	// returns WSAEWOULDBLOCK harmlessly — the pending byte already does the job.
	if loop.platform.wake_send != windows.INVALID_SOCKET {
		b: byte = 1
		windows.send(loop.platform.wake_send, &b, 1, 0)
	}
}

// platform_watch_fd records a readiness watcher. The bool return is a real state
// transition (mirroring epoll's EEXIST / kqueue's add result): true ONLY when a
// new watcher is added, so the shared watch_fd wrapper's active_io_count stays in
// lockstep with the set and cannot drift. A duplicate registration returns false
// (nothing was added — the watcher is already counted). select's fd_set holds at
// most FD_SETSIZE sockets per set; reserve one read slot for the wakeup socket and
// reject (honestly, returning false) once the set is full, rather than silently
// dropping a watcher that could then never fire.
platform_watch_fd :: proc(loop: ^Loop, watcher: ^IO_Watcher) -> bool {
	if len(loop.platform.watchers) >= windows.FD_SETSIZE - 1 do return false
	for w in loop.platform.watchers {
		if w == watcher do return false // already registered, already counted
	}
	append(&loop.platform.watchers, watcher)
	return true
}

// platform_unwatch_fd removes a watcher. Like watch, the bool is a real state
// transition: true ONLY when a watcher is actually removed, so active_io_count is
// never decremented for a watcher that was not registered.
platform_unwatch_fd :: proc(loop: ^Loop, watcher: ^IO_Watcher) -> bool {
	for w, i in loop.platform.watchers {
		if w == watcher {
			unordered_remove(&loop.platform.watchers, i)
			return true
		}
	}
	return false
}

@(private = "file")
fd_set_add :: proc(set: ^windows.fd_set, sock: windows.SOCKET) {
	if set.fd_count < windows.FD_SETSIZE {
		set.fd_array[set.fd_count] = sock
		set.fd_count += 1
	}
}

@(private = "file")
fd_set_has :: proc(set: ^windows.fd_set, sock: windows.SOCKET) -> bool {
	for i in 0 ..< set.fd_count {
		if set.fd_array[i] == sock do return true
	}
	return false
}

// No multi-loop driver on this target yet (Linux-first): backend_fd reports false,
// and the page runner refuses to start.
platform_backend_fd :: proc(loop: ^Loop) -> (uintptr, bool) {return 0, false}

platform_poll :: proc(loop: ^Loop, timeout_ms: int) {
	readfds, writefds, exceptfds: windows.fd_set

	// The wakeup socket is always watched for readability.
	fd_set_add(&readfds, loop.platform.wake_recv)

	for w in loop.platform.watchers {
		sock := windows.SOCKET(w.fd)
		if w.mode == .Read {
			fd_set_add(&readfds, sock)
		} else {
			fd_set_add(&writefds, sock)
		}
		// A socket error (incl. a failed non-blocking connect) shows in exceptfds;
		// surface it as readiness so the watcher's callback runs and handles it.
		fd_set_add(&exceptfds, sock)
	}

	tv: windows.timeval
	timeout: ^windows.timeval = nil
	if timeout_ms >= 0 {
		tv.tv_sec = windows.c_long(timeout_ms / 1000)
		tv.tv_usec = windows.c_long((timeout_ms % 1000) * 1000)
		timeout = &tv
	}

	// nfds is ignored on Windows. select rewrites the sets in place to contain
	// only the ready sockets.
	n := windows.select(
		0,
		cast([^]windows.fd_set)&readfds,
		cast([^]windows.fd_set)&writefds,
		cast([^]windows.fd_set)&exceptfds,
		timeout,
	)
	if n == windows.SOCKET_ERROR {
		loop.backend_error = true
		return
	}
	if n == 0 do return // timeout

	// Drain the wakeup byte(s); the read end is non-blocking.
	if fd_set_has(&readfds, loop.platform.wake_recv) {
		buf: [64]byte
		for windows.recv(loop.platform.wake_recv, &buf[0], len(buf), 0) > 0 {}
	}

	// Snapshot the ready watchers before dispatch: a callback may unwatch itself
	// (mutating loop.platform.watchers), so we must not iterate it live.
	ready: [windows.FD_SETSIZE]^IO_Watcher
	count := 0
	for w in loop.platform.watchers {
		sock := windows.SOCKET(w.fd)
		if fd_set_has(&readfds, sock) ||
		   fd_set_has(&writefds, sock) ||
		   fd_set_has(&exceptfds, sock) {
			if count < len(ready) {
				ready[count] = w
				count += 1
			}
		}
	}
	for i in 0 ..< count {
		w := ready[i]
		if w.callback != nil {
			loop.io_events += 1
			w.callback(loop, w.user_data)
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

// Provided-buffer ring (Slice 2a) — Linux/io_uring only; no-op on windows.
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
