#+build linux
package lava_runtime

import "core:net"
import "core:sys/linux"
import eventloop "lava:pkg/runtime/eventloop"

// Linux socket primitives for the shared fetch transport (fetch_transport.odin):
// non-blocking socket create/connect, the SO_ERROR connect check, raw send/recv,
// and the io_uring/epoll watch-mode flip. Uses core:sys/linux directly so the
// socket is created non-blocking in one call (.NONBLOCK socket flag).

fetch_close_fd :: proc(fd: uintptr) {
	linux.close(linux.Fd(fd))
}

// fetch_connect_ip4 / fetch_connect_ip6 open a non-blocking socket, kick off
// connect(), and hand off to fetch_register_socket (which watches for writability
// == connect completion). Both run on the loop thread.
fetch_connect_ip4 :: proc(req: ^Fetch_Request, ip4: net.IP4_Address, port: int) -> (ok: bool, err: string) {
	sock_fd, sock_err := linux.socket(.INET, .STREAM, {.NONBLOCK}, .TCP)
	if sock_err != .NONE do return false, "fetch: could not create socket"
	// net.IP4_Address is [4]u8 in network order — exactly the bytes sin_addr wants.
	addr := linux.Sock_Addr_In {
		sin_family = .INET,
		sin_port   = u16be(port),
		sin_addr   = transmute([4]u8)ip4,
	}
	// EINTR: a signal interrupted connect() before it could report EINPROGRESS;
	// the connection still proceeds asynchronously, so treat it like EINPROGRESS
	// rather than a hard failure.
	if conn_err := linux.connect(sock_fd, &addr); conn_err != .NONE && conn_err != .EINPROGRESS && conn_err != .EINTR {
		linux.close(sock_fd)
		return false, "fetch: connect failed"
	}
	return fetch_register_socket(req, uintptr(sock_fd))
}

fetch_connect_ip6 :: proc(req: ^Fetch_Request, ip6: net.IP6_Address, port: int) -> (ok: bool, err: string) {
	sock_fd, sock_err := linux.socket(.INET6, .STREAM, {.NONBLOCK}, .TCP)
	if sock_err != .NONE do return false, "fetch: could not create socket"
	// IP6_Address is [8]u16be, whose memory layout is already the 16 network-order
	// bytes sin6_addr expects.
	addr := linux.Sock_Addr_In6 {
		sin6_family = .INET6,
		sin6_port   = u16be(port),
		sin6_addr   = transmute([16]u8)ip6,
	}
	// EINTR: a signal interrupted connect() before it could report EINPROGRESS;
	// the connection still proceeds asynchronously, so treat it like EINPROGRESS
	// rather than a hard failure.
	if conn_err := linux.connect(sock_fd, &addr); conn_err != .NONE && conn_err != .EINPROGRESS && conn_err != .EINTR {
		linux.close(sock_fd)
		return false, "fetch: connect failed"
	}
	return fetch_register_socket(req, uintptr(sock_fd))
}

// fetch_connect_succeeded reports whether the non-blocking connect completed
// without error, read from the socket's SO_ERROR once it signals writable.
fetch_connect_succeeded :: proc(req: ^Fetch_Request) -> bool {
	// getsockopt_base takes the output pointer directly; the typed wrappers wrap
	// it in a way that does not fit a plain i32 out-param.
	so_error: i32
	_, opt_err := linux.getsockopt_base(
		linux.Fd(req.fd),
		cast(int)linux.SOL_SOCKET,
		linux.Socket_Option.ERROR,
		&so_error,
	)
	return opt_err == .NONE && so_error == 0
}

// fetch_raw_send writes one chunk to the plaintext socket. NOSIGNAL: a peer that
// resets mid-write must surface as EPIPE (a normally rejected fetch), not raise
// SIGPIPE and kill the process.
fetch_raw_send :: proc(req: ^Fetch_Request, chunk: []byte) -> (n: int, res: Fetch_IO_Result) {
	sent, send_err := linux.send(linux.Fd(req.fd), chunk, {.NOSIGNAL})
	#partial switch send_err {
	case .NONE:
		return sent, .Ok
	case .EAGAIN:
		// == EWOULDBLOCK
		return 0, .Would_Block
	case .EINTR:
		// Interrupted before any byte was sent — re-poll and retry rather than
		// failing the request.
		return 0, .Would_Block
	case:
		return 0, .Failed
	}
}

// fetch_raw_recv reads from the plaintext socket. A 0-byte read is an orderly
// close (.Closed); EAGAIN means wait for more data.
fetch_raw_recv :: proc(req: ^Fetch_Request, buf: []byte) -> (n: int, res: Fetch_IO_Result) {
	got, recv_err := linux.recv(linux.Fd(req.fd), buf, {})
	#partial switch recv_err {
	case .NONE:
		return got, got == 0 ? .Closed : .Ok
	case .EAGAIN:
		// == EWOULDBLOCK
		return 0, .Would_Block
	case .EINTR:
		// Interrupted before any byte arrived — re-poll and retry.
		return 0, .Would_Block
	case:
		return 0, .Failed
	}
}

// fetch_set_watch_mode points the socket's watch at readability or writability,
// returning false if the re-registration fails (so the caller can fail the
// request instead of stalling forever waiting for an event that won't come).
// The io_uring backend re-arms from watcher.mode after this callback returns, so
// mutating the field is enough; epoll needs an explicit re-registration. A no-op
// when the mode is unchanged.
fetch_set_watch_mode :: proc(loop: ^eventloop.Loop, req: ^Fetch_Request, mode: eventloop.Poll_Mode) -> bool {
	if req.watcher.mode == mode do return true
	if loop.platform.use_uring {
		req.watcher.mode = mode
		return true
	}
	eventloop.unwatch_fd(loop, &req.watcher)
	req.watcher.mode = mode
	return eventloop.watch_fd(loop, &req.watcher)
}
