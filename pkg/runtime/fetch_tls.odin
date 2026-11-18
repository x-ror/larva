#+build linux, windows
package lava_runtime

import "core:c"
import eventloop "lava:pkg/runtime/eventloop"

// OpenSSL TLS backend for the fetch transport on Linux and Windows.
// fetch_transport.odin is kept OpenSSL-free and platform-agnostic; the https
// branches there delegate to the procs in this file, which a platform without a TLS
// backend replaces with reject stubs (fetch_tls_stub.odin). The req.tls handle is an
// opaque ^SSL stored as rawptr so the cross-platform Fetch_Request never names the
// OpenSSL binding.

// fetch_tls_supported lets the shared transport reject https:// up front (before
// DNS/connect) on backends that have no TLS. True here — OpenSSL is available.
fetch_tls_supported :: true

// FETCH_HTTPS_UNSUPPORTED_MSG is the rejection message used when TLS is absent.
// Defined in both TLS backends so the transport can name it on every target.
FETCH_HTTPS_UNSUPPORTED_MSG :: "fetch: HTTPS is not yet supported on this platform"

// fetch_tls_cleanup frees the per-request SSL session. Called from
// fetch_request_finish before the underlying fd is closed (SSL_free does not
// close the fd). Safe to call when no TLS session was created.
fetch_tls_cleanup :: proc(req: ^Fetch_Request) {
	if req.tls != nil {
		SSL_free(cast(SSL)req.tls)
		req.tls = nil
	}
}

// fetch_tls_start_handshake creates the client SSL session for an https request
// (called once the TCP connect completes) and runs the first handshake step. On a
// setup failure it settles the request with an error.
fetch_tls_start_handshake :: proc(loop: ^eventloop.Loop, req: ^Fetch_Request) {
	ssl := tls_new_client(req.fd, req.host)
	if ssl == nil {
		fetch_settle_error(req, "fetch: TLS setup failed")
		return
	}
	req.tls = rawptr(ssl)
	req.phase = .TLS_Handshake
	fetch_tls_handshake(loop, req) // try the handshake immediately
}

// Fetch_TLS_Outcome classifies a non-positive SSL_connect/SSL_read/SSL_write result.
Fetch_TLS_Outcome :: enum {
	Pending, // OpenSSL wants more I/O; the watcher has been re-armed
	Eof, // the peer closed (clean close_notify, or an EOF without one)
	Fatal, // a real TLS or socket error
}

// fetch_tls_classify maps an SSL op's SSL_get_error onto a Fetch_TLS_Outcome,
// re-arming the loop watcher for WANT_READ/WANT_WRITE. ZERO_RETURN is a clean
// close_notify; SSL_ERROR_SYSCALL with ret == 0 is an EOF without one (common
// for HTTP/1.1 Connection: close), while ret < 0 is a genuine syscall failure
// and stays Fatal so truncation is not silently treated as completion.
fetch_tls_classify :: proc(loop: ^eventloop.Loop, req: ^Fetch_Request, ret: c.int) -> Fetch_TLS_Outcome {
	switch SSL_get_error(cast(SSL)req.tls, ret) {
	case SSL_ERROR_WANT_READ:
		// A failed re-arm becomes Fatal so the caller settles instead of stalling.
		return fetch_set_watch_mode(loop, req, .Read) ? .Pending : .Fatal
	case SSL_ERROR_WANT_WRITE:
		return fetch_set_watch_mode(loop, req, .Write) ? .Pending : .Fatal
	case SSL_ERROR_ZERO_RETURN:
		return .Eof
	case SSL_ERROR_SYSCALL:
		return ret == 0 ? .Eof : .Fatal
	case:
		return .Fatal
	}
}

// fetch_tls_handshake drives the non-blocking SSL_connect. On completion it
// advances to Writing and attempts the first send; otherwise it re-arms the
// watcher for the direction OpenSSL is waiting on and returns. Certificate and
// hostname verification are enforced by the context (SSL_VERIFY_PEER) and
// SSL_set1_host, so a bad/mismatched cert surfaces here as a handshake failure.
// An EOF mid-handshake is fatal — there is no response to complete yet.
fetch_tls_handshake :: proc(loop: ^eventloop.Loop, req: ^Fetch_Request) {
	ret := SSL_connect(cast(SSL)req.tls)
	if ret == 1 {
		req.phase = .Writing
		fetch_write(loop, req)
		return
	}
	if fetch_tls_classify(loop, req, ret) != .Pending {
		fetch_settle_error(req, "fetch: TLS handshake failed")
	}
}

// fetch_tls_write sends the request bytes as TLS records. When the whole request
// is out it flips the watch to reading. Mirrors the plaintext fetch_write loop.
fetch_tls_write :: proc(loop: ^eventloop.Loop, req: ^Fetch_Request) {
	for req.write_offset < len(req.request_bytes) {
		chunk := req.request_bytes[req.write_offset:]
		n := SSL_write(cast(SSL)req.tls, raw_data(chunk), c.int(len(chunk)))
		if n <= 0 {
			// An EOF while still sending the request is a failure, not completion,
			// so .Eof falls in with .Fatal here.
			if fetch_tls_classify(loop, req, n) != .Pending {
				fetch_settle_error(req, "fetch: TLS write failed")
			}
			return
		}
		req.write_offset += int(n)
	}
	fetch_after_write_head(loop, req)
}

// fetch_tls_send_chunk writes one request-body frame over TLS, mapping the
// SSL_write result onto a Fetch_IO_Result for the shared body-write state machine
// (fetch_body_send). A non-positive return classifies as Would_Block (OpenSSL wants
// more I/O), Closed (clean/EOF), or Failed. want_read distinguishes the direction
// OpenSSL is waiting on: a WANT_READ (e.g. a renegotiation mid-write) needs the fd
// armed for readability, a WANT_WRITE for writability — collapsing both to "write"
// would spin on writable events, or deadlock when the send buffer is full and the
// peer's renegotiation bytes can only be read.
fetch_tls_send_chunk :: proc(req: ^Fetch_Request, chunk: []byte) -> (n: int, res: Fetch_IO_Result, want_read: bool) {
	ret := SSL_write(cast(SSL)req.tls, raw_data(chunk), c.int(len(chunk)))
	if ret > 0 do return int(ret), .Ok, false
	switch SSL_get_error(cast(SSL)req.tls, ret) {
	case SSL_ERROR_WANT_READ:
		return 0, .Would_Block, true
	case SSL_ERROR_WANT_WRITE:
		return 0, .Would_Block, false
	case SSL_ERROR_ZERO_RETURN:
		return 0, .Closed, false
	case SSL_ERROR_SYSCALL:
		return 0, ret == 0 ? .Closed : .Failed, false
	case:
		return 0, .Failed, false
	}
}

// fetch_tls_read decrypts response records and streams them through fetch_on_recv
// (head parse, then incremental body delivery), mirroring the plaintext
// fetch_read loop. It stops when fetch_on_recv signals to (settled / complete /
// backpressure pause), when OpenSSL wants more I/O, or on EOF.
fetch_tls_read :: proc(loop: ^eventloop.Loop, req: ^Fetch_Request) {
	buf: [16384]byte
	for {
		n := SSL_read(cast(SSL)req.tls, raw_data(buf[:]), c.int(len(buf)))
		if n <= 0 {
			switch fetch_tls_classify(loop, req, n) {
			case .Pending:
			case .Eof:
				fetch_eof(req) // peer closed
			case .Fatal:
				fetch_settle_error(req, "fetch: TLS read failed")
			}
			return
		}
		if !fetch_on_recv(loop, req, buf[:int(n)]) do return
	}
}
