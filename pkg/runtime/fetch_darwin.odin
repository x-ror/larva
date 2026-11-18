#+build darwin
package lava_runtime

import "core:c"
import "core:net"
import "core:sys/posix"
import eventloop "lava:pkg/runtime/eventloop"

// Darwin socket primitives for the shared fetch transport (fetch_transport.odin):
// the kqueue backend is readiness-based like epoll, so the connect→write→read
// state machine is identical — only the socket syscalls differ. Uses core:sys/
// posix (BSD sockets): create + fcntl(O_NONBLOCK), connect, send/recv, getsockopt
// SO_ERROR. macOS has no MSG_NOSIGNAL, so SIGPIPE is suppressed per-socket with
// SO_NOSIGPIPE instead of a per-send flag.

// SO_NOSIGPIPE is not in posix.Sock_Option; pass its raw Darwin value (0x1022)
// to setsockopt so a peer reset never raises SIGPIPE and kills the process.
SO_NOSIGPIPE :: 0x1022

fetch_close_fd :: proc(fd: uintptr) {
	posix.close(posix.FD(fd))
}

// fetch_new_socket creates a non-blocking TCP socket of the given family with
// SIGPIPE suppressed, returning -1 on failure. It fails closed: if the socket
// cannot be made non-blocking (would block the event loop) or SO_NOSIGPIPE
// cannot be set (a peer reset could raise SIGPIPE and kill the process), it
// closes the fd and reports failure rather than proceeding unsafely.
@(private = "file")
fetch_new_socket :: proc(family: posix.AF) -> posix.FD {
	fd := posix.socket(family, .STREAM)

	if fd < 0 {
		return -1
	}

	if posix.fcntl(fd, .SETFL, posix.O_Flags{.NONBLOCK}) == -1 {
		posix.close(fd)
		return -1
	}

	one: c.int = 1

	if posix.setsockopt(
		   fd,
		   c.int(posix.SOL_SOCKET),
		   cast(posix.Sock_Option)SO_NOSIGPIPE,
		   &one,
		   posix.socklen_t(size_of(one)),
	   ) !=
	   .OK {
		posix.close(fd)
		return -1
	}

	return fd
}

// fetch_connect_ip4 / fetch_connect_ip6 open a non-blocking socket, kick off
// connect(), and hand off to fetch_register_socket (which watches for writability
// == connect completion). A non-blocking connect returns EINPROGRESS, which is
// expected; any other failure rejects. Both run on the loop thread.
fetch_connect_ip4 :: proc(req: ^Fetch_Request, ip4: net.IP4_Address, port: int) -> (ok: bool, err: string) {
	fd := fetch_new_socket(.INET)

	if fd < 0 {
		return false, "fetch: could not create socket"
	}

	addr := posix.sockaddr_in {
		sin_len = size_of(posix.sockaddr_in),
		sin_family = cast(posix.sa_family_t)posix.AF.INET,
		sin_port = u16be(port),
		sin_addr = {s_addr = transmute(posix.in_addr_t)ip4},
	}

	if posix.connect(fd, cast(^posix.sockaddr)&addr, posix.socklen_t(size_of(addr))) != .OK {
		// EINPROGRESS (and EINTR, a signal interrupting the call) both mean the
		// connect proceeds asynchronously; anything else is a hard failure.
		e := posix.errno()

		if e != .EINPROGRESS && e != .EINTR {
			posix.close(fd)
			return false, "fetch: connect failed"
		}
	}

	return fetch_register_socket(req, uintptr(fd))
}

fetch_connect_ip6 :: proc(req: ^Fetch_Request, ip6: net.IP6_Address, port: int) -> (ok: bool, err: string) {
	fd := fetch_new_socket(.INET6)

	if fd < 0 {
		return false, "fetch: could not create socket"
	}

	// IP6_Address is [8]u16be, whose memory layout is already the 16 network-order
	// bytes sin6_addr expects.
	addr := posix.sockaddr_in6 {
		sin6_len    = size_of(posix.sockaddr_in6),
		sin6_family = cast(posix.sa_family_t)posix.AF.INET6,
		sin6_port   = u16be(port),
	}
	addr.sin6_addr.s6_addr = transmute([16]u8)ip6

	if posix.connect(fd, cast(^posix.sockaddr)&addr, posix.socklen_t(size_of(addr))) != .OK {
		// EINPROGRESS (and EINTR, a signal interrupting the call) both mean the
		// connect proceeds asynchronously; anything else is a hard failure.
		e := posix.errno()

		if e != .EINPROGRESS && e != .EINTR {
			posix.close(fd)
			return false, "fetch: connect failed"
		}
	}

	return fetch_register_socket(req, uintptr(fd))
}

// fetch_connect_succeeded reports whether the non-blocking connect completed
// without error, read from the socket's SO_ERROR once it signals writable.
fetch_connect_succeeded :: proc(req: ^Fetch_Request) -> bool {
	so_error: c.int
	optlen := posix.socklen_t(size_of(so_error))
	res := posix.getsockopt(posix.FD(req.fd), c.int(posix.SOL_SOCKET), .ERROR, &so_error, &optlen)
	return res == .OK && so_error == 0
}

// fetch_raw_send writes one chunk to the plaintext socket. SIGPIPE is already
// suppressed via SO_NOSIGPIPE, so a reset peer surfaces as EPIPE here.
fetch_raw_send :: proc(req: ^Fetch_Request, chunk: []byte) -> (n: int, res: Fetch_IO_Result) {
	sent := posix.send(posix.FD(req.fd), raw_data(chunk), len(chunk), {})

	if sent >= 0 {
		return int(sent), .Ok
	}
	#partial switch posix.errno() {
	case .EAGAIN:
		// == EWOULDBLOCK on Darwin
		return 0, .Would_Block
	case .EINTR:
		// interrupted before any byte was sent — re-poll and retry
		return 0, .Would_Block
	case:
		return 0, .Failed
	}
}

// fetch_raw_recv reads from the plaintext socket. A 0-byte read is an orderly
// close (.Closed); EAGAIN means wait for more data.
fetch_raw_recv :: proc(req: ^Fetch_Request, buf: []byte) -> (n: int, res: Fetch_IO_Result) {
	got := posix.recv(posix.FD(req.fd), raw_data(buf), len(buf), {})

	if got > 0 {
		return int(got), .Ok
	}

	if got == 0 {
		return 0, .Closed
	}
	#partial switch posix.errno() {
	case .EAGAIN:
		// == EWOULDBLOCK on Darwin
		return 0, .Would_Block
	case .EINTR:
		// interrupted before any byte arrived — re-poll and retry
		return 0, .Would_Block
	case:
		return 0, .Failed
	}
}

// fetch_set_watch_mode points the socket's watch at readability or writability,
// returning false if the re-registration fails. kqueue (like epoll) needs an
// explicit unwatch + rewatch to flip the EVFILT_READ/EVFILT_WRITE interest; a
// no-op when the mode is unchanged.
fetch_set_watch_mode :: proc(loop: ^eventloop.Loop, req: ^Fetch_Request, mode: eventloop.Poll_Mode) -> bool {
	if req.watcher.mode == mode {
		return true
	}

	eventloop.unwatch_fd(loop, &req.watcher)
	req.watcher.mode = mode
	return eventloop.watch_fd(loop, &req.watcher)
}
