#+build windows
package lava_runtime

import "core:net"
import "core:sys/windows"
import eventloop "lava:pkg/runtime/eventloop"

// Windows (Winsock) platform primitives for the shared fetch transport. Mirrors
// fetch_darwin.odin / fetch_linux.odin: a non-blocking connect handed off to the
// event loop's select backend (loop_windows.odin), then raw send/recv driven by
// readiness. Winsock is already initialised process-wide by the event loop
// (WSAStartup in platform_init), which outlives every in-flight request, so these
// procs do not start it again. Both http:// and https:// use this path — TLS runs
// over the same non-blocking SOCKET via the shared OpenSSL backend (fetch_tls.odin,
// linked against libssl/libcrypto on Windows; see tls.odin).

// fetch_close_fd closes a socket created by this backend.
fetch_close_fd :: proc(fd: uintptr) {
	windows.closesocket(windows.SOCKET(fd))
}

// fetch_new_socket opens a non-blocking TCP socket in the given address family,
// returning INVALID_SOCKET on failure. Internal to this file.
@(private = "file")
fetch_new_socket :: proc(family: windows.c_int) -> windows.SOCKET {
	sock := windows.socket(family, windows.SOCK_STREAM, 0)
	if sock == windows.INVALID_SOCKET do return windows.INVALID_SOCKET
	nonblock: windows.c_ulong = 1
	// FIONBIO has its high bit set, so a checked cast to signed c_long overflows;
	// reinterpret the bits instead (same as the event loop's wakeup socket).
	if windows.ioctlsocket(sock, transmute(windows.c_long)windows.FIONBIO, &nonblock) == windows.SOCKET_ERROR {
		windows.closesocket(sock)
		return windows.INVALID_SOCKET
	}
	return sock
}

// fetch_start_connect kicks off a non-blocking connect on an already-created
// socket and hands off to fetch_register_socket (which watches for writability ==
// connect completion). A non-blocking connect returns WSAEWOULDBLOCK, which is
// expected; any other failure rejects. The v4/v6 entry points differ only in
// address construction, so they share this tail.
@(private = "file")
fetch_start_connect :: proc(
	req: ^Fetch_Request,
	sock: windows.SOCKET,
	addr: ^windows.SOCKADDR_STORAGE_LH,
	addr_len: windows.c_int,
) -> (
	ok: bool,
	err: string,
) {
	if windows.connect(sock, addr, addr_len) == windows.SOCKET_ERROR &&
	   windows.WSAGetLastError() != windows.WSAEWOULDBLOCK {
		windows.closesocket(sock)
		return false, "fetch: connect failed"
	}
	return fetch_register_socket(req, uintptr(sock))
}

// fetch_connect_ip4 / fetch_connect_ip6 open a non-blocking socket and start the
// connect. Both run on the loop thread.
fetch_connect_ip4 :: proc(req: ^Fetch_Request, ip4: net.IP4_Address, port: int) -> (ok: bool, err: string) {
	sock := fetch_new_socket(windows.AF_INET)
	if sock == windows.INVALID_SOCKET do return false, "fetch: could not create socket"
	addr := windows.sockaddr_in {
		sin_family = windows.ADDRESS_FAMILY(windows.AF_INET),
		sin_port = u16be(port),
		sin_addr = {s_addr = transmute(u32)ip4},
	}
	return fetch_start_connect(req, sock, cast(^windows.SOCKADDR_STORAGE_LH)&addr, size_of(addr))
}

fetch_connect_ip6 :: proc(req: ^Fetch_Request, ip6: net.IP6_Address, port: int) -> (ok: bool, err: string) {
	sock := fetch_new_socket(windows.AF_INET6)
	if sock == windows.INVALID_SOCKET do return false, "fetch: could not create socket"
	// net.IP6_Address is [8]u16be, whose memory layout is already the 16
	// network-order bytes sin6_addr expects.
	addr := windows.sockaddr_in6 {
		sin6_family = windows.ADDRESS_FAMILY(windows.AF_INET6),
		sin6_port   = u16be(port),
	}
	addr.sin6_addr.s6_addr = transmute([16]u8)ip6
	return fetch_start_connect(req, sock, cast(^windows.SOCKADDR_STORAGE_LH)&addr, size_of(addr))
}

// fetch_connect_succeeded reports whether the non-blocking connect completed
// without error, read from the socket's SO_ERROR once it signals writable.
fetch_connect_succeeded :: proc(req: ^Fetch_Request) -> bool {
	so_error: windows.c_int
	optlen := windows.c_int(size_of(so_error))
	res := windows.getsockopt(
		windows.SOCKET(req.fd),
		windows.SOL_SOCKET,
		windows.SO_ERROR,
		cast([^]windows.c_char)&so_error,
		&optlen,
	)
	return res != windows.SOCKET_ERROR && so_error == 0
}

// fetch_raw_send writes one chunk to the plaintext socket.
fetch_raw_send :: proc(req: ^Fetch_Request, chunk: []byte) -> (n: int, res: Fetch_IO_Result) {
	sent := windows.send(windows.SOCKET(req.fd), raw_data(chunk), windows.c_int(len(chunk)), 0)
	if sent != windows.SOCKET_ERROR do return int(sent), .Ok
	if windows.WSAGetLastError() == windows.WSAEWOULDBLOCK do return 0, .Would_Block
	return 0, .Failed
}

// fetch_raw_recv reads from the plaintext socket. A 0-byte read is an orderly
// close (.Closed); WSAEWOULDBLOCK means wait for more data.
fetch_raw_recv :: proc(req: ^Fetch_Request, buf: []byte) -> (n: int, res: Fetch_IO_Result) {
	got := windows.recv(windows.SOCKET(req.fd), raw_data(buf), windows.c_int(len(buf)), 0)
	if got > 0 do return int(got), .Ok
	if got == 0 do return 0, .Closed
	if windows.WSAGetLastError() == windows.WSAEWOULDBLOCK do return 0, .Would_Block
	return 0, .Failed
}

// fetch_set_watch_mode points the socket's watch at readability or writability,
// returning false if the re-registration fails (so the caller can fail the request
// instead of stalling forever). The select backend reads watcher.mode when it
// builds each fd_set, but re-registering explicitly (like epoll/kqueue) keeps this
// correct regardless of how the backend tracks interest. A no-op when unchanged.
fetch_set_watch_mode :: proc(loop: ^eventloop.Loop, req: ^Fetch_Request, mode: eventloop.Poll_Mode) -> bool {
	if req.watcher.mode == mode do return true
	eventloop.unwatch_fd(loop, &req.watcher)
	req.watcher.mode = mode
	return eventloop.watch_fd(loop, &req.watcher)
}
