#+build linux, darwin, windows
package lava_runtime

import "core:net"
import "core:strings"
import jsc "lava:pkg/jsc"
import eventloop "lava:pkg/runtime/eventloop"

// Shared fetch transport for the readiness-based backends (Linux epoll/io_uring,
// Darwin kqueue, Windows select). The connect→[TLS handshake]→write→read state
// machine and the DNS hand-off live here and are TLS-backend-agnostic. Each platform
// supplies only the socket primitives (create/connect, send/recv, SO_ERROR check,
// watch-mode flip, close) in fetch_{linux,darwin,windows}.odin, plus a TLS backend
// (fetch_tls{,_darwin,_stub}.odin) that the https branches delegate to. Targets with
// no transport at all fall back to fetch_other.odin.

// Fetch_IO_Result is the outcome of a raw (plaintext) socket read/write, mapped
// by the platform primitives from the OS error so the state machine stays
// platform-agnostic. .Closed is read-only (recv saw EOF); send never returns it.
Fetch_IO_Result :: enum {
	Ok, // transferred n bytes
	Would_Block, // EAGAIN/EWOULDBLOCK — wait for the next readiness event
	Closed, // orderly peer close (recv returned 0)
	Failed, // a real socket error
}

// fetch_transport_start begins a request. An IPv6/IPv4 literal connects
// synchronously; a hostname is resolved on the bounded DNS pool and the connect is
// deferred to dns_resolve_done (run back on the loop thread via
// post_async). Returns ok=false with a message only for an immediate failure; the
// async path returns ok=true and settles later.
fetch_transport_start :: proc(req: ^Fetch_Request, host: string, port: int) -> (ok: bool, err: string) {
	// Reject https:// up front on backends without TLS (fetch_tls_supported ==
	// false), before any DNS lookup or outbound connect — so an unsupported
	// request fails instantly and locally instead of after network work.
	if req.is_https && !fetch_tls_supported {
		return false, FETCH_HTTPS_UNSUPPORTED_MSG
	}

	// An IPv6 literal host (e.g. "::1") arrives bracket-stripped from
	// parse_http_url and is the only host that can contain a colon.
	if strings.index_byte(host, ':') >= 0 {
		ip6, ip_ok := net.parse_ip6_address(host)

		if !ip_ok {
			return false, "fetch: could not resolve host"
		}

		return fetch_connect_ip6(req, ip6, port)
	}

	// An IPv4 literal needs no lookup — connect on the spot (no worker thread).
	if ip4, ip_ok := net.parse_ip4_address(host); ip_ok {
		return fetch_connect_ip4(req, ip4, port)
	}

	// A hostname: resolve off the loop on the loop's generic worker pool (#77, fetch_dns.odin).
	// drive_pending pins the request so a cancel mid-lookup cannot free it before the completion runs;
	// it must precede the submit (a worker may post the completion before this returns). pool_submit
	// does its own async_begin loop keep-alive (and undoes it on a start failure), so we only unwind
	// our own drive_pending pin here.
	req.drive_pending += 1

	if !fetch_dns_submit(req, host) {
		req.drive_pending -= 1
		return false, "fetch: could not start DNS resolver"
	}

	return true, ""
}

// fetch_register_socket records the connecting socket on the request and watches
// it for writability (connect completion). Loop thread only. The fd is closed via
// the platform fetch_close_fd if the watch registration fails.
fetch_register_socket :: proc(req: ^Fetch_Request, fd: uintptr) -> (ok: bool, err: string) {
	req.fd = fd
	req.has_fd = true
	req.phase = .Connecting
	req.watcher = eventloop.IO_Watcher {
		fd        = fd,
		mode      = .Write, // writable == connect complete (or error via SO_ERROR)
		callback  = fetch_watcher_cb,
		user_data = req,
	}

	if !eventloop.watch_fd(req.loop, &req.watcher) {
		fetch_close_fd(fd)
		req.has_fd = false
		return false, "fetch: could not register socket with the event loop"
	}

	return true, ""
}

// fetch_advance_connect connects to the next address in the resolved list (#145),
// closing the current (failed or not-yet-started) socket first. A hostname resolves
// to an ordered IPv4-then-IPv6 list; a connect failure — synchronous here, or async
// via a failed SO_ERROR check in the Connecting phase — advances to the next entry,
// settling an error only once the list is exhausted. A literal host has an empty
// list (addr_count == 0), so it settles immediately, as before. Loop-thread only.
fetch_advance_connect :: proc(req: ^Fetch_Request) {
	if req.has_fd {
		// Drop the failed attempt's socket before trying another address.
		req.watcher.callback = nil
		eventloop.unwatch_fd(req.loop, &req.watcher)
		fetch_close_fd(req.fd)
		req.has_fd = false
	}

	for req.addr_index < req.addr_count {
		a := req.addrs[req.addr_index]
		req.addr_index += 1
		connected: bool

		if a.is_v6 {
			connected, _ = fetch_connect_ip6(req, a.v6, req.port)
		} else {
			connected, _ = fetch_connect_ip4(req, a.v4, req.port)
		}

		if connected {return} 	// connect initiated; wait for the writable event
		// A synchronous connect failure (socket create / immediate connect error)
		// closed its own socket — fall through to the next address.
	}

	fetch_settle_error(req, "fetch: could not connect to host")
}

// fetch_watcher_cb advances the request whenever the socket is ready. Connect →
// (TLS handshake for https) → write the whole request → read until EOF, then
// settle. EAGAIN / WANT_* means "not ready, wait for the next event".
fetch_watcher_cb :: proc(loop: ^eventloop.Loop, user_data: rawptr) {
	req := cast(^Fetch_Request)user_data

	if req == nil || req.settled {
		return
	}

	switch req.phase {
	case .Connecting:
		if !fetch_connect_succeeded(req) {
			// This address failed; try the next resolved one (if any) before giving
			// up. A literal host has no list, so this settles immediately (#145).
			fetch_advance_connect(req)
			return
		}

		if req.is_https {
			// TLS is a platform-swappable backend: set up the session and run the first
			// handshake step, settling on its own error if unsupported.
			fetch_tls_start_handshake(loop, req)
			return
		}

		req.phase = .Writing
		fetch_write(loop, req) // socket is writable now, try sending immediately

	case .TLS_Handshake:
		fetch_tls_handshake(loop, req)

	case .Writing:
		fetch_write(loop, req)

	case .Body_Write:
		fetch_write_body_event(loop, req)

	case .Reading:
		fetch_read(loop, req)
	}
}

// fetch_write sends the request bytes over the plaintext socket. When the whole
// request is out it flips the watch to reading. https takes the parallel TLS path
// (fetch_tls_write) supplied by the platform TLS backend.
fetch_write :: proc(loop: ^eventloop.Loop, req: ^Fetch_Request) {
	if req.is_https {
		fetch_tls_write(loop, req)
		return
	}

	for req.write_offset < len(req.request_bytes) {
		chunk := req.request_bytes[req.write_offset:]
		n, res := fetch_raw_send(req, chunk)
		switch res {
		case .Ok:
		case .Would_Block:
			if !fetch_set_watch_mode(loop, req, .Write) {
				fetch_settle_error(req, "fetch: event loop watch failed")
			}

			return // wait for the next writable event
		case .Closed, .Failed:
			fetch_settle_error(req, "fetch: send failed")
			return
		}

		if n <= 0 {
			return
		}

		req.write_offset += n
	}
	fetch_after_write_head(loop, req)
}

// fetch_read streams the response from the plaintext socket: each read is handed
// to fetch_on_recv, which parses the head, then delivers decoded body bytes
// incrementally. The loop stops when fetch_on_recv signals to (request settled,
// body complete, or backpressure pause), when the socket would block (re-arm), or
// on EOF. https takes the parallel TLS path (fetch_tls_read).
fetch_read :: proc(loop: ^eventloop.Loop, req: ^Fetch_Request) {
	if req.is_https {
		fetch_tls_read(loop, req)
		return
	}

	buf: [16384]byte
	for {
		n, res := fetch_raw_recv(req, buf[:])
		switch res {
		case .Ok:
			if !fetch_on_recv(loop, req, buf[:n]) {
				return
			}
		case .Would_Block:
			if !fetch_set_watch_mode(loop, req, .Read) {
				fetch_settle_error(req, "fetch: event loop watch failed")
			}

			return // wait for more data
		case .Closed:
			fetch_eof(req) // EOF — server closed
			return
		case .Failed:
			fetch_settle_error(req, "fetch: receive failed")
			return
		}
	}
}

// ============================================================================
// Streaming request body — true chunked upload (Transfer-Encoding: chunked)
// ============================================================================
//
// Once the request head is on the wire, a streamed body is pulled from the JS
// producer one chunk at a time and framed incrementally — no full-body buffer is
// kept on either side. The flow (half-duplex: the whole request body is sent
// before the response is read):
//
//   fetch_after_write_head → fetch_body_go_idle: defers a producer pull
//     (post_async → fetch_body_drain_cb → on_body_drain). The JS pump reads its
//     source and calls push_body_fn → fetch_push_body, which frames the chunk and
//     flushes it (fetch_pump_body). When the frame fully drains, fetch_body_go_idle
//     pulls the next chunk; a blocked write arms the fd for writability and the
//     writable event (fetch_write_body_event) resumes the flush. Socket write
//     backpressure therefore pauses the producer (the next pull is not scheduled
//     until the current frame drains). end_body_fn → fetch_end_body writes the
//     terminating zero-size chunk and flips to reading the response.
//
// Recursion / liveness: the producer pull is DEFERRED via post_async (mirroring the
// response-read resume in fetch.odin) rather than invoked inline — a synchronous
// invoke would recurse one stack frame per chunk through JSC's microtask auto-drain
// (read → push → drain → pull → read …). post_async breaks that and, paired with
// async_begin + drive_pending, keeps the loop alive across the pull and pins the
// request against reclaim until the deferred completion has run.

// fetch_after_write_head runs once the request head is fully written. A buffered
// body was written with it, so flip straight to reading; a streamed body now pulls
// its first chunk from the producer.
fetch_after_write_head :: proc(loop: ^eventloop.Loop, req: ^Fetch_Request) {
	if !req.body_streaming {
		if !fetch_set_watch_mode(loop, req, .Read) {
			fetch_settle_error(req, "fetch: event loop watch failed")
			return
		}

		req.phase = .Reading // next readable event reads the response
		return
	}

	req.phase = .Body_Write
	// Pin the loop for the whole upload so an in-flight chunked upload keeps the
	// process alive like Node's outgoing socket: while idle (awaiting the producer)
	// the fd is unwatched, so without this hold a body that pauses on a producer not
	// itself backed by loop work could let the loop exit mid-upload. Released when the
	// terminator is sent (fetch_pump_body) or the request settles (fetch_request_finish).
	fetch_body_hold_loop(req)
	fetch_body_go_idle(req) // ask the producer for the first chunk
}

// fetch_write_body_event resumes a blocked frame flush when the socket becomes
// writable. While idle (awaiting the producer) the fd is unwatched, so a delivered
// event always has a partially-written frame to flush.
fetch_write_body_event :: proc(loop: ^eventloop.Loop, req: ^Fetch_Request) {
	if req.body_idle {return} 	// defensive: a stale completion while awaiting the producer
	fetch_pump_body(loop, req)
}

// fetch_push_body frames one producer chunk as a chunked frame and flushes it. The
// pull/push protocol guarantees body_out is empty on entry (one chunk in flight).
// Runs on the loop thread (push_body_fn, from the JS pump).
fetch_push_body :: proc(req: ^Fetch_Request, data: []byte) {
	if req.settled || !req.body_streaming || req.phase != .Body_Write {
		return
	}

	req.body_idle = false

	if len(data) == 0 {
		fetch_body_go_idle(req) // an empty chunk frames to nothing — pull the next
		return
	}

	fetch_frame_chunk(req, data)
	fetch_pump_body(req.loop, req)
}

// fetch_end_body writes the terminating zero-size chunk once the producer is done.
// Runs on the loop thread (end_body_fn) while idle, so body_out is empty;
// fetch_pump_body appends and flushes the terminator, then flips to reading.
fetch_end_body :: proc(req: ^Fetch_Request) {
	if req.settled || !req.body_streaming || req.phase != .Body_Write {
		return
	}

	req.body_idle = false
	req.body_end_seen = true

	// Idle ⇒ nothing pending: drive the terminator now. (If a frame were still in
	// flight, fetch_pump_body's drain would append the terminator itself.)
	if req.body_out_off >= len(req.body_out) {
		fetch_pump_body(req.loop, req)
	}
}

// fetch_pump_body flushes the current frame (body_out) to the socket, then decides
// what comes next: append+flush the terminator if the producer has ended, transition
// to reading once the terminator is out, or pull the next chunk. A blocked write arms
// the fd for writability and returns; the writable event re-enters here.
fetch_pump_body :: proc(loop: ^eventloop.Loop, req: ^Fetch_Request) {
	for {
		for req.body_out_off < len(req.body_out) {
			n, res := fetch_body_send(req, req.body_out[req.body_out_off:])

			if req.settled {return} 	// arming the watcher failed and settled the request
			switch res {
			case .Ok:
				if n <= 0 {
					// A 0-byte success for a non-empty frame should not happen (send /
					// SSL_write never report Ok without progress on a non-empty buffer),
					// but if it did, arm for writability rather than returning with no
					// pending event — a bare return would strand the upload.
					fetch_body_arm(req, .Write)
					return
				}

				req.body_out_off += n
			case .Would_Block:
				return // fetch_body_send armed the fd for the right direction
			case .Closed, .Failed:
				fetch_settle_error(req, "fetch: request body send failed")
				return
			}
		}
		// The current frame is fully written.
		clear(&req.body_out)
		req.body_out_off = 0

		if req.body_term_written {
			// Upload complete: drop the body-phase loop hold and watch for the response.
			fetch_body_release_loop(req)
			fetch_body_arm(req, .Read)
			req.phase = .Reading
			return
		}

		if req.body_end_seen {
			append(&req.body_out, '0', '\r', '\n', '\r', '\n') // terminating zero chunk
			req.body_term_written = true
			continue // loop to flush the terminator
		}

		fetch_body_go_idle(req) // pull the next chunk from the producer
		return
	}
}

// fetch_body_send writes one slice of the current frame. On a would-block it arms the
// socket for the direction the transport is waiting on so the readiness event resumes
// the flush — plaintext always wants write, but TLS may want read (a renegotiation
// mid-write), so the arm follows fetch_tls_send_chunk's want_read. https delegates to
// the TLS backend.
fetch_body_send :: proc(req: ^Fetch_Request, chunk: []byte) -> (n: int, res: Fetch_IO_Result) {
	want_read: bool

	if req.is_https {
		n, res, want_read = fetch_tls_send_chunk(req, chunk)
	} else {
		n, res = fetch_raw_send(req, chunk)
	}

	// Stay in .Body_Write whichever direction we arm: the readiness event re-enters
	// fetch_write_body_event, which retries the flush regardless of read/write wake.
	if res == .Would_Block {
		fetch_body_arm(req, want_read ? .Read : .Write)
	}

	return
}

// fetch_frame_chunk builds one Transfer-Encoding: chunked frame —
// "<hex-size>\r\n<data>\r\n" — into body_out (empty on entry).
fetch_frame_chunk :: proc(req: ^Fetch_Request, data: []byte) {
	clear(&req.body_out)
	req.body_out_off = 0
	fetch_append_hex(&req.body_out, len(data))
	append(&req.body_out, '\r', '\n')
	append(&req.body_out, ..data)
	append(&req.body_out, '\r', '\n')
}

// fetch_append_hex appends value as lowercase hex with no leading zeros — the
// chunk-size line of a chunked frame.
fetch_append_hex :: proc(buf: ^[dynamic]byte, value: int) {
	if value == 0 {
		append(buf, '0')
		return
	}

	digits := "0123456789abcdef"
	tmp: [16]byte
	n := value
	i := 0
	for n > 0 {
		tmp[i] = digits[n & 0xf]
		n >>= 4
		i += 1
	}
	for j := i - 1; j >= 0; j -= 1 {
		append(buf, tmp[j])
	}
}

// fetch_body_go_idle parks the request until the producer yields the next chunk:
// drop the socket watch (nothing to write yet) and DEFER a producer pull. The pull
// is deferred (not invoked inline) to break the per-chunk recursion through JSC's
// microtask auto-drain; async_begin keeps the loop alive across the pull and
// drive_pending pins the request against reclaim until the deferred pull has run.
fetch_body_go_idle :: proc(req: ^Fetch_Request) {
	if req.settled {
		return
	}

	req.body_idle = true

	if req.has_fd && req.watcher.watched {
		req.watcher.callback = nil
		eventloop.unwatch_fd(req.loop, &req.watcher)
	}

	req.drive_pending += 1
	eventloop.async_begin(req.loop)
	eventloop.post_async(req.loop, fetch_body_drain_cb, req)
}

// fetch_body_drain_cb runs the deferred producer pull on the loop thread: it invokes
// on_body_drain so the JS pump reads its source and pushes the next chunk. It runs
// even for a request that has since settled (to balance drive_pending) but only
// pulls when still idle in the body-write phase.
fetch_body_drain_cb :: proc(loop: ^eventloop.Loop, user_data: rawptr) {
	req := cast(^Fetch_Request)user_data

	if req == nil {
		return
	}

	req.drive_pending -= 1

	if req.settled || !req.body_idle || req.on_body_drain == nil {
		return
	}

	exception: jsc.JSValueRef
	invoke_user_callback(req.ctx, req.on_body_drain, nil, 0, &exception)

	if exception != nil {
		report_uncaught(req.ctx, exception)
		mark_async_failed(req.ctx)
	}
}

// fetch_body_arm points the socket watch at `mode` and (re)registers it for the
// body-write phase, settling the request if the loop rejects the watch. Arms a fresh
// poll when coming from idle (the fd was unwatched); otherwise just points existing
// interest at the new direction. Drives the frame-flush write arm, the post-terminator
// read arm, and a TLS renegotiation read arm mid-write.
fetch_body_arm :: proc(req: ^Fetch_Request, mode: eventloop.Poll_Mode) {
	if req.settled || !req.has_fd {
		return
	}

	req.watcher.callback = fetch_watcher_cb
	ok: bool

	if req.watcher.watched {
		ok = fetch_set_watch_mode(req.loop, req, mode)
	} else {
		req.watcher.mode = mode
		ok = eventloop.watch_fd(req.loop, &req.watcher)
	}

	if !ok {
		fetch_settle_error(req, "fetch: event loop watch failed")
	}
}
