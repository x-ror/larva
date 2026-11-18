#+build darwin
package lava_runtime

import "core:c"
import eventloop "lava:pkg/runtime/eventloop"

// Darwin (Security.framework / SecureTransport) TLS backend for the fetch
// transport. It provides the fetch TLS surface fetch_transport.odin's https branches
// expect: fetch_tls_supported, FETCH_HTTPS_UNSUPPORTED_MSG, and the
// cleanup/handshake/write/read procs. The session bindings live in tls_darwin.odin;
// req.tls holds an opaque ^Darwin_TLS_Session (as rawptr).

// fetch_tls_supported lets the shared transport reject https:// up front (before
// DNS/connect). True here — SecureTransport ships with macOS.
fetch_tls_supported :: true

// FETCH_HTTPS_UNSUPPORTED_MSG is the rejection message used when TLS is absent.
// Defined in every TLS backend so the transport can name it on every target.
FETCH_HTTPS_UNSUPPORTED_MSG :: "fetch: HTTPS is not yet supported on this platform"

// fetch_tls_cleanup frees the per-request TLS session. Called from
// fetch_request_finish before the underlying fd is closed (the session does not own
// the fd). Safe to call when no session was created.
fetch_tls_cleanup :: proc(req: ^Fetch_Request) {
	if req.tls != nil {
		darwin_tls_free(cast(^Darwin_TLS_Session)req.tls)
		req.tls = nil
	}
}

// fetch_tls_start_handshake creates the client session for an https request (once
// the TCP connect completes) and runs the first handshake step. On a setup failure
// it settles the request with an error.
fetch_tls_start_handshake :: proc(loop: ^eventloop.Loop, req: ^Fetch_Request) {
	sess := darwin_tls_new_client(req.fd, req.host)

	if sess == nil {
		fetch_settle_error(req, "fetch: TLS setup failed")
		return
	}

	req.tls = rawptr(sess)
	req.phase = .TLS_Handshake
	fetch_tls_handshake(loop, req) // try the handshake immediately
}

// Fetch_TLS_Outcome classifies a non-success SSLHandshake/SSLRead/SSLWrite status.
// Mirrors the OpenSSL backend's enum so the transport contract is identical.
Fetch_TLS_Outcome :: enum {
	Pending, // SecureTransport wants more I/O; the watcher has been re-armed
	Eof, // the peer closed (close_notify, or a close without one)
	Fatal, // a real TLS or socket error
}

// fetch_tls_classify maps a non-success OSStatus onto a Fetch_TLS_Outcome, re-arming
// the loop watcher for the direction the session last blocked on (sess.want).
// errSSLWouldBlock is pending; a clean/no-notify close is EOF (the framing layer
// decides whether that is completion or truncation); anything else is fatal.
fetch_tls_classify :: proc(loop: ^eventloop.Loop, req: ^Fetch_Request, status: OSStatus) -> Fetch_TLS_Outcome {
	switch status {
	case errSSLWouldBlock:
		sess := cast(^Darwin_TLS_Session)req.tls
		mode: eventloop.Poll_Mode = sess.want == .Read ? .Read : .Write
		// A failed re-arm becomes Fatal so the caller settles instead of stalling.
		return fetch_set_watch_mode(loop, req, mode) ? .Pending : .Fatal
	case errSSLClosedGraceful, errSSLClosedNoNotify:
		return .Eof
	case:
		return .Fatal
	}
}

// fetch_tls_handshake drives the non-blocking SSLHandshake. On completion it advances
// to Writing and attempts the first send; otherwise it re-arms for the awaited
// direction and returns. Trust is taken over via break-on-auth: SSLHandshake pauses
// with errSSLPeerAuthCompleted once the server certificate arrives, and
// darwin_tls_verify_peer evaluates it against the system trust store (plus any
// SSL_CERT_FILE anchors) and the host/IP — failing closed on a bad or mismatched
// cert before the handshake can finish. An EOF mid-handshake is fatal — there is no
// response to complete yet.
fetch_tls_handshake :: proc(loop: ^eventloop.Loop, req: ^Fetch_Request) {
	sess := cast(^Darwin_TLS_Session)req.tls
	for {
		status := SSLHandshake(sess.ctx)

		if status == errSecSuccess {
			req.phase = .Writing
			fetch_write(loop, req)
			return
		}

		if status == errSSLPeerAuthCompleted {
			// The server cert is in hand; verify it (fail closed), then re-drive the
			// handshake to completion.
			if !darwin_tls_verify_peer(sess, req.host) {
				fetch_settle_error(req, "fetch: TLS certificate verification failed")
				return
			}

			continue
		}

		if fetch_tls_classify(loop, req, status) != .Pending {
			fetch_settle_error(req, "fetch: TLS handshake failed")
		}

		return
	}
}

// darwin_tls_write_chunk pushes one buffer's plaintext into the TLS layer, returning
// the OpenSSL-style "fully sent or nothing" result the body/head writers expect:
//
//   - errSecSuccess  : the WHOLE buffer is encrypted AND flushed to the socket;
//                      `consumed` == len(buf). (SSLWrite returns success only once
//                      all records, including any previously-queued ciphertext, hit
//                      the socket.)
//   - errSSLWouldBlock: nothing is reported consumed; the caller re-arms and retries
//                      with the SAME buffer. SecureTransport may have taken part of
//                      the buffer into internal records already, so write_skip
//                      records that prefix and the retry submits only the un-taken
//                      tail — re-submitting the whole buffer would double-encode it.
//                      When the whole buffer is already taken (skip == len) the retry
//                      is a zero-length SSLWrite that just flushes the record queue.
//   - other          : a fatal/closed status, passed through unchanged.
//
// This confines SecureTransport's partial-consume-with-buffering behavior to the TLS
// layer so the shared transport keeps OpenSSL's advance-only-when-sent contract — in
// particular the chunked terminator is never reported sent until its record flushes.
@(private = "file")
darwin_tls_write_chunk :: proc(sess: ^Darwin_TLS_Session, buf: []byte) -> (consumed: int, status: OSStatus) {
	skip := sess.write_skip

	if skip > len(buf) {skip = len(buf)} 	// defensive — buffer is stable across retries
	tail := buf[skip:]
	processed: c.size_t
	st := SSLWrite(sess.ctx, raw_data(tail), c.size_t(len(tail)), &processed)

	if st == errSecSuccess {
		sess.write_skip = 0
		return len(buf), errSecSuccess
	}

	if st == errSSLWouldBlock {
		sess.write_skip = skip + int(processed)
		return 0, errSSLWouldBlock
	}

	return 0, st
}

// fetch_tls_write sends the request bytes as TLS records. When the whole request is
// out it flips the watch to reading. Mirrors the plaintext fetch_write loop; a
// would-block re-arms for the awaited direction (write, or read for a renegotiation).
fetch_tls_write :: proc(loop: ^eventloop.Loop, req: ^Fetch_Request) {
	sess := cast(^Darwin_TLS_Session)req.tls
	for req.write_offset < len(req.request_bytes) {
		chunk := req.request_bytes[req.write_offset:]
		n, status := darwin_tls_write_chunk(sess, chunk)

		if status != errSecSuccess {
			// An EOF/close while still sending the request is a failure, not completion.
			if fetch_tls_classify(loop, req, status) != .Pending {
				fetch_settle_error(req, "fetch: TLS write failed")
			}

			return
		}

		req.write_offset += n
	}
	fetch_after_write_head(loop, req)
}

// fetch_tls_send_chunk writes one request-body frame over TLS, mapping the result
// onto a Fetch_IO_Result for the shared body-write state machine (fetch_body_send).
// want_read distinguishes the awaited direction: a TLS write that needs to read
// first (e.g. a renegotiation mid-write) reports want_read so the fd is armed for
// readability — collapsing both to "write" would spin or deadlock, matching the
// OpenSSL backend's WANT_READ handling. On a would-block nothing is reported
// consumed (write_skip tracks the internal progress), so the caller safely retries
// the same frame slice.
fetch_tls_send_chunk :: proc(req: ^Fetch_Request, chunk: []byte) -> (n: int, res: Fetch_IO_Result, want_read: bool) {
	sess := cast(^Darwin_TLS_Session)req.tls
	consumed, status := darwin_tls_write_chunk(sess, chunk)
	switch status {
	case errSecSuccess:
		return consumed, .Ok, false
	case errSSLWouldBlock:
		return 0, .Would_Block, sess.want == .Read
	case errSSLClosedGraceful, errSSLClosedNoNotify:
		return 0, .Closed, false
	case:
		return 0, .Failed, false
	}
}

// fetch_tls_read decrypts response records and streams them through fetch_on_recv
// (head parse, then incremental body delivery), mirroring the plaintext fetch_read
// loop. SSLRead can return decoded bytes together with errSSLWouldBlock/EOF, so any
// processed bytes are delivered before the status is classified. It stops when
// fetch_on_recv signals to (settled / complete / backpressure pause), when
// SecureTransport wants more I/O, or on EOF.
fetch_tls_read :: proc(loop: ^eventloop.Loop, req: ^Fetch_Request) {
	sess := cast(^Darwin_TLS_Session)req.tls
	buf: [16384]byte
	for {
		processed: c.size_t
		status := SSLRead(sess.ctx, raw_data(buf[:]), c.size_t(len(buf)), &processed)

		if processed > 0 {
			if !fetch_on_recv(loop, req, buf[:int(processed)]) {
				return
			}
		}

		if status == errSecSuccess {
			if processed == 0 {
				// Defensive: success with no data should not happen for a non-empty
				// buffer; re-arm and wait rather than spin.
				if !fetch_set_watch_mode(loop, req, .Read) {
					fetch_settle_error(req, "fetch: event loop watch failed")
				}

				return
			}

			continue // drain any further buffered records
		}

		switch fetch_tls_classify(loop, req, status) {
		case .Pending:
		case .Eof:
			fetch_eof(req) // peer closed
		case .Fatal:
			fetch_settle_error(req, "fetch: TLS read failed")
		}
		return
	}
}
