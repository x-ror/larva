#+build linux
package lava_runtime

import "base:runtime"
import "core:c"
import jsc "lava:pkg/jsc"
import eventloop "lava:pkg/runtime/eventloop"
import openssl "lava:pkg/tls"

// TLS server state machine for https.createServer (design reviewed in PR #298, implemented in #299).
// Transparent at the native net layer: net.odin wraps an accepted connection in an SSL
// object backed by two BIO_s_mem memory BIOs, so the proactor still owns the socket and
// SSL_read/SSL_write run synchronously on completion-mode buffers (the fetch CLIENT's
// SSL_set_fd model cannot work here — the proactor, not libssl, does the syscalls).
//
//   recv ciphertext → BIO_write(rbio) → SSL_accept / SSL_read → plaintext → on_data
//   socket.write(plaintext) → SSL_write → BIO_read(wbio) → ciphertext → existing send path
//
// The OpenSSL bindings live in tls.odin (shared with the fetch client). This file is the
// Linux-only logic; it references Net_Connection (net.odin, also #+build linux) directly.
//
// INVARIANT (the wbio MUST be drained after EVERY SSL op, not just writes): a TLS 1.3
// server produces OUTBOUND records during SSL_read — NewSessionTicket (late), the reply to
// a peer KeyUpdate (NOT blocked by NO_RENEGOTIATION), and alerts. If those are left in the
// wbio they desync the record layer. tls_pump_wbio enforces the drain at every call site.

// TLS_Step classifies an SSL_accept/SSL_read/SSL_write result. The SSL_get_error read MUST
// happen immediately after the SSL op, before any BIO call, so it reflects that op.
TLS_Step :: enum {
	Ok, // ret > 0: bytes produced / handshake step done
	Want_IO, // WANT_READ/WANT_WRITE: needs more ciphertext (or to flush) — re-arm
	Eof, // clean close_notify, or a bare socket EOF
	Fatal, // a real TLS or socket error
}

tls_step :: proc(ssl: openssl.SSL, ret: c.int) -> TLS_Step {
	if ret > 0 {
		return .Ok
	}

	switch openssl.SSL_get_error(ssl, ret) {
	case openssl.SSL_ERROR_WANT_READ, openssl.SSL_ERROR_WANT_WRITE:
		return .Want_IO
	case openssl.SSL_ERROR_ZERO_RETURN:
		return .Eof
	case openssl.SSL_ERROR_SYSCALL:
		return ret == 0 ? .Eof : .Fatal
	case:
		return .Fatal
	}
}

// tls_no_password_cb is the pem_password_cb. Returning 0 (empty password) makes an ENCRYPTED
// key fail to load — instead of OpenSSL's default callback, which PROMPTS ON THE TERMINAL and
// would hang the server. M1 rejects `passphrase`, so an encrypted key is always an error here.
tls_no_password_cb :: proc "c" (buf: rawptr, size: c.int, rwflag: c.int, u: rawptr) -> c.int {
	return 0
}

// --- per-listener context build (synchronous; throws map to ok=false in the JS binding) ---

// tls_server_ctx_new builds and validates the per-listener SSL_CTX from in-memory PEM. Every
// failure returns ok=false (the binding throws ERR_TLS_*-shaped from https.createServer, which
// is where a Node caller's try/catch expects bad-cert errors). The returned ctx is owned by the
// caller and freed with tls_server_ctx_free on server close.
tls_server_ctx_new :: proc(key: []byte, cert: []byte) -> (ctx: openssl.SSL_CTX, ok: bool) {
	if len(key) == 0 || len(cert) == 0 {
		return nil, false
	}

	method := openssl.TLS_server_method()

	if method == nil {
		return nil, false
	}

	// Build into an explicit local so the cleanup frees the LIVE handle: a named-return + early
	// `return nil, false` would assign ctx=nil BEFORE the defer runs, so the defer would free nil and
	// leak the context. Every failure below is a bare `return` (ctx stays nil, ok stays false) and
	// `c` is freed by the defer; only success assigns ctx = c. Mirrors the client builder.
	c := openssl.SSL_CTX_new(method)

	if c == nil {
		return nil, false
	}

	defer if !ok {
		openssl.SSL_CTX_free(c)
		openssl.ERR_clear_error() // PEM end-of-stream leaves a benign error on the queue; don't strand it
	}

	// Security baseline (design §8): TLS 1.2 floor (also disables SSLv3/TLS1.0/1.1), refuse
	// peer renegotiation, suppress tickets (resumption is deferred — keep it honest + bounded),
	// and release per-SSL buffers when idle so many keep-alive conns stay cheap. SSL_CTX_set_options
	// is a real function (a ctrl(OPTIONS) is a silent no-op on OpenSSL ≥ 1.1.0 — see tls.odin).
	if openssl.SSL_CTX_ctrl(c, openssl.SSL_CTRL_SET_MIN_PROTO_VERSION, openssl.TLS1_2_VERSION, nil) != 1 {
		return
	}

	openssl.SSL_CTX_set_options(c, openssl.SSL_OP_NO_RENEGOTIATION | openssl.SSL_OP_NO_TICKET)
	openssl.SSL_CTX_set_num_tickets(c, 0) // TLS 1.3 tickets (the SSL_OP_NO_TICKET above is TLS 1.2 only)
	openssl.SSL_CTX_ctrl(c, openssl.SSL_CTRL_SET_SESS_CACHE_MODE, openssl.SSL_SESS_CACHE_OFF, nil)
	openssl.SSL_CTX_ctrl(c, openssl.SSL_CTRL_MODE, openssl.SSL_MODE_RELEASE_BUFFERS, nil)

	if !tls_server_load_cert_chain(c, cert) {
		return
	}

	if !tls_server_load_key(c, key) {
		return
	}

	if openssl.SSL_CTX_check_private_key(c) != 1 {return} 	// key must match the leaf cert

	openssl.ERR_clear_error()
	ctx = c
	ok = true
	return
}

tls_server_ctx_free :: proc(ctx: openssl.SSL_CTX) {
	if ctx != nil {
		openssl.SSL_CTX_free(ctx)
	}
}

// tls_server_load_cert_chain reads every X509 in the PEM: the first is the leaf
// (SSL_CTX_use_certificate, which up-refs — so we drop our ref after), the rest are the chain
// (SSL_CTX_add_extra_chain_cert, i.e. SSL_CTRL_EXTRA_CHAIN_CERT, which TAKES ownership — no free).
@(private = "file")
tls_server_load_cert_chain :: proc(ctx: openssl.SSL_CTX, cert: []byte) -> bool {
	bio := openssl.BIO_new_mem_buf(raw_data(cert), c.int(len(cert)))

	if bio == nil {
		return false
	}

	defer openssl.BIO_free(bio)

	leaf := openssl.PEM_read_bio_X509(bio, nil, tls_no_password_cb, nil)

	if leaf == nil {
		return false
	}

	used := openssl.SSL_CTX_use_certificate(ctx, leaf) == 1
	openssl.X509_free(leaf) // ctx holds its own ref now

	if !used {
		return false
	}

	for {
		x := openssl.PEM_read_bio_X509(bio, nil, tls_no_password_cb, nil)

		if x == nil {break} 	// no more certs (end-of-stream leaves a benign error, cleared by the caller)

		if openssl.SSL_CTX_ctrl(ctx, openssl.SSL_CTRL_EXTRA_CHAIN_CERT, 0, rawptr(x)) != 1 {
			openssl.X509_free(x)
			return false
		}

		// owned by ctx now — must NOT free
	}
	return true
}

@(private = "file")
tls_server_load_key :: proc(ctx: openssl.SSL_CTX, key: []byte) -> bool {
	bio := openssl.BIO_new_mem_buf(raw_data(key), c.int(len(key)))

	if bio == nil {
		return false
	}

	defer openssl.BIO_free(bio)
	pkey := openssl.PEM_read_bio_PrivateKey(bio, nil, tls_no_password_cb, nil)

	if pkey == nil {return false} 	// bad PEM, or encrypted (tls_no_password_cb fails it closed)
	used := openssl.SSL_CTX_use_PrivateKey(ctx, pkey) == 1
	openssl.EVP_PKEY_free(pkey) // ctx holds its own ref now
	return used
}

// --- per-connection lifecycle ------------------------------------------------

// tls_server_attach wires an accepted connection for TLS: a per-conn SSL on the shared listener
// ctx, two memory BIOs (ownership transferred to the SSL via set0 — freed by SSL_free), and
// accept state. Returns false if any allocation fails (the caller closes the conn).
tls_server_attach :: proc(conn: ^Net_Connection, ctx: openssl.SSL_CTX) -> bool {
	ssl := openssl.SSL_new(ctx)

	if ssl == nil {
		return false
	}

	rbio := openssl.BIO_new(openssl.BIO_s_mem())
	wbio := openssl.BIO_new(openssl.BIO_s_mem())

	if rbio == nil || wbio == nil {
		if rbio != nil {
			openssl.BIO_free(rbio)
		}

		if wbio != nil {
			openssl.BIO_free(wbio)
		}

		openssl.SSL_free(ssl)
		return false
	}

	openssl.SSL_set0_rbio(ssl, rbio) // ownership → ssl
	openssl.SSL_set0_wbio(ssl, wbio)
	openssl.SSL_set_accept_state(ssl)
	conn.ssl = rawptr(ssl)
	conn.rbio = rawptr(rbio) // retained only for BIO_read/BIO_write; never BIO_free'd separately
	conn.wbio = rawptr(wbio)
	conn.tls = true
	conn.tls_handshaking = true
	return true
}

// tls_server_free_conn frees the SSL session (and, with it, both BIOs) and cancels the handshake
// timer. Called from BOTH free sites (net_maybe_free / net_conn_free_cb), so a conn frees its TLS
// state exactly once regardless of backend. Idempotent.
tls_server_free_conn :: proc(conn: ^Net_Connection) {
	if conn.ssl != nil {
		openssl.SSL_free(cast(openssl.SSL)conn.ssl) // frees rbio + wbio (set0 transferred ownership)
		conn.ssl = nil
		conn.rbio = nil
		conn.wbio = nil
	}

	if conn.handshake_timer != 0 {
		eventloop.clear_timeout(conn.loop, conn.handshake_timer)
		conn.handshake_timer = 0
	}
}

@(private = "file")
tls_server_cancel_handshake_timer :: proc(conn: ^Net_Connection) {
	if conn.handshake_timer != 0 {
		eventloop.clear_timeout(conn.loop, conn.handshake_timer)
		conn.handshake_timer = 0
	}
}

// --- the I/O pump ------------------------------------------------------------

// tls_pump_wbio drains all ciphertext OpenSSL has produced (handshake records, encrypted app
// data, tickets, KeyUpdate replies, close_notify, alerts) and hands it to the existing send path.
// Backend-split: proactor queues into pending_writes + kick_send; readiness into write_queue +
// net_flush. Called after EVERY SSL op — this is the C1 invariant.
tls_pump_wbio :: proc(conn: ^Net_Connection) {
	wbio := cast(openssl.BIO)conn.wbio

	if wbio == nil {
		return
	}

	proactor := net_is_proactor(conn)

	if !proactor {net_compact_write_queue(conn)} 	// drop the sent prefix before appending ciphertext
	wrote := false
	chunk: [16384]byte
	for {
		n := openssl.BIO_read(wbio, raw_data(chunk[:]), c.int(len(chunk)))

		if n <= 0 {
			break
		}

		if proactor {append(&conn.pending_writes, ..chunk[:int(n)])} else {
			append(&conn.write_queue, ..chunk[:int(n)])
		}

		wrote = true
	}

	if !wrote {return} 	// nothing produced: don't kick/flush (a stray net_flush could fire end_after_drain)

	if proactor {net_proactor_kick_send(conn)} else {
		net_flush(conn)
	}
}

// tls_server_on_ciphertext is the recv-side driver: feed inbound ciphertext to the rbio, then
// either advance the handshake or run the decrypt loop. Called from every recv-completion path
// (proactor single-shot / ring / readiness) when conn.tls. The caller re-arms the recv after.
tls_server_on_ciphertext :: proc(conn: ^Net_Connection, cipher: []byte) {
	rbio := cast(openssl.BIO)conn.rbio

	if rbio == nil {
		return
	}

	if len(cipher) > 0 {
		openssl.BIO_write(rbio, raw_data(cipher), c.int(len(cipher))) // copies into the mem BIO
	}

	if conn.tls_handshaking {
		if !tls_server_do_handshake(conn) {return} 	// not yet complete, closed, or fatal

		if conn.closing {
			return
		}

		// handshake just completed — fall through to drain any 0.5-RTT / pipelined app data
	}

	tls_server_read_loop(conn)
}

// tls_server_do_handshake runs one SSL_accept step. Returns true only when the handshake has
// fully completed (so the caller continues into the read loop).
@(private = "file")
tls_server_do_handshake :: proc(conn: ^Net_Connection) -> (done: bool) {
	ssl := cast(openssl.SSL)conn.ssl
	openssl.ERR_clear_error() // clear cross-conn error-queue residue before classifying (see tls_server_read_loop)
	ret := openssl.SSL_accept(ssl)
	step := tls_step(ssl, ret) // capture before any BIO op
	tls_pump_wbio(conn) // send whatever handshake records SSL_accept produced

	if conn.closing {
		return false
	}

	if ret == 1 {
		conn.tls_handshaking = false
		tls_server_cancel_handshake_timer(conn)
		return true
	}
	#partial switch step {
	case .Want_IO:
		return false // need more ciphertext — recv re-arms
	case:
		// Handshake failed or the peer went away before it completed: no close_notify is owed.
		net_close_conn(conn, true)
		return false
	}
}

// tls_server_pump_reads drains any plaintext still buffered in the SSL/rbio (records that were
// decrypted-but-not-yet-emitted because a write backpressured mid-loop). Called from the drain
// transition on BOTH backends (net_proactor_on_drained / conn_write_cb) when reads resume — without
// it, ciphertext already sitting in the rbio (userspace, not the kernel socket buffer) would strand
// with no future recv completion to drive it. A no-op when nothing is buffered (SSL_read → WANT_READ).
tls_server_pump_reads :: proc(conn: ^Net_Connection) {
	if !conn.tls || conn.closing || conn.read_done || conn.tls_handshaking {
		return
	}

	if conn.ssl == nil {
		return
	}

	tls_server_read_loop(conn)
}

// tls_server_read_loop decrypts buffered records, emitting each plaintext chunk as a freshly
// COPIED Uint8Array (never an alias into SSL/BIO memory — JS may retain it). It always pumps the
// wbio after SSL_read (C1: KeyUpdate/ticket/alert records are produced here), re-checks conn.closing
// after every JS emit / pump (a data handler may destroy the socket synchronously), and STOPS
// decrypting on write-backpressure (want_drain on the proactor, writing on readiness) — matching the
// plaintext conn_read_cb, so a backpressured handler isn't flooded with the rest of the rbio. The
// undecrypted remainder resumes via tls_server_pump_reads on the next drain.
@(private = "file")
tls_server_read_loop :: proc(conn: ^Net_Connection) {
	ssl := cast(openssl.SSL)conn.ssl
	// The error queue is thread-local and shared by every conn on this loop: a prior conn's failed op
	// could leave residue that flips this op's SSL_get_error (SYSCALL vs SSL) and misclassify a clean
	// EOF as fatal. Clear before classifying. (A clean SSL_read never pushes, so once per loop is enough.)
	openssl.ERR_clear_error()
	buf: [16384]byte
	for {
		n := openssl.SSL_read(ssl, raw_data(buf[:]), c.int(len(buf)))

		if n > 0 {
			copy_buf := make([]byte, int(n), runtime.heap_allocator()) // freed by jsc_buffer_deallocator, on the heap
			copy(copy_buf, buf[:int(n)])
			arg := make_uint8_array(conn.ctx, copy_buf)
			net_emit(conn.ctx, conn.on_data, &arg, 1)
			tls_pump_wbio(conn) // a record produced during SSL_read (e.g. KeyUpdate reply) must go out

			if conn.closing {return} 	// a data handler destroyed us, or the pump's send failed

			if conn.want_drain || conn.writing {return} 	// backpressure: resume via pump_reads on drain
			continue
		}

		step := tls_step(ssl, n) // capture before the pump
		tls_pump_wbio(conn) // drain replies even on WANT_READ

		if conn.closing {
			return
		}
		#partial switch step {
		case .Want_IO:
			return // need more ciphertext
		case .Eof:
			conn.read_done = true
			net_emit(conn.ctx, conn.on_end, nil, 0)
			return
		case:
			net_emit_error(conn, "tls read error")
			net_close_conn(conn, true)
			return
		}
	}
}

// --- write + orderly close ---------------------------------------------------

// tls_server_write encrypts one plaintext chunk (an app socket.write) and pumps the ciphertext
// out. With a memory wbio, SSL_write accepts the whole buffer (fragmenting into records), so a
// single call suffices. Returns false if the session is closing/failed. The backpressure gate is
// applied by the caller against the BUFFERED CIPHERTEXT, identical to the plaintext path.
tls_server_write :: proc(conn: ^Net_Connection, plaintext: []byte) -> bool {
	if len(plaintext) == 0 {
		return !conn.closing
	}

	ssl := cast(openssl.SSL)conn.ssl
	openssl.ERR_clear_error() // clear cross-conn error-queue residue before classifying (see tls_server_read_loop)
	n := openssl.SSL_write(ssl, raw_data(plaintext), c.int(len(plaintext)))
	step := tls_step(ssl, n) // capture before the pump
	tls_pump_wbio(conn)

	if conn.closing {
		return false
	}
	#partial switch step {
	case .Ok:
		return true
	case .Want_IO:
		// Pre-handshake / mid-renegotiation: SSL_write consumed nothing, so THIS chunk is dropped.
		// Reachable only if an app writes before the handshake completes — node:http never does
		// (it writes a response only after parsing a request, i.e. post-handshake), so it is latent.
		// If a non-http TLS consumer is ever layered on, this must become buffer-and-retry to avoid
		// silent data loss; keep the conn alive for now rather than closing on a benign WANT_READ.
		return true
	case:
		net_close_conn(conn, true)
		return false
	}
}

// tls_server_begin_close sends a close_notify (best-effort, unidirectional per RFC 5246 §7.2.1):
// SSL_shutdown queues it into the wbio and tls_pump_wbio sends it. The caller has set
// end_after_drain, so the EXISTING drain-then-close logic hard-closes once the ciphertext flushes
// — no new timer, no reuse of the loop-level drain machinery. A still-handshaking conn has no
// session to shut down (the caller falls straight through to the hard close).
tls_server_begin_close :: proc(conn: ^Net_Connection) {
	if conn.ssl == nil || conn.tls_handshaking {
		return
	}

	openssl.SSL_shutdown(cast(openssl.SSL)conn.ssl)
	tls_pump_wbio(conn)
}

// --- native bindings (the `native` object js/node/https.js receives) -----

// make_https_bindings builds the bindings for node:https. createSecureContext is the synchronous
// throw point Node callers expect (bad PEM / key-cert mismatch / encrypted key all throw from
// https.createServer); it parks the built SSL_CTX in the per-context registry and returns an id
// that net.listen consumes. freeSecureContext releases a context built but never listened on.
make_https_bindings :: proc(ctx: jsc.JSContextRef) -> jsc.JSObjectRef {
	bindings := jsc.JSObjectMake(ctx, nil, nil)
	inject_native_function(ctx, bindings, "createSecureContext", https_create_secure_context_cb)
	inject_native_function(ctx, bindings, "freeSecureContext", https_free_secure_context_cb)
	return bindings
}

// https_create_secure_context_cb(keyPem, certPem) -> contextId. Throws on any failure.
https_create_secure_context_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()

	if argument_count < 2 {
		if exception != nil {
			exception^ = make_js_error(ctx, "https.createServer requires both `key` and `cert`")
		}

		return jsc.JSValueMakeUndefined(ctx)
	}

	args := arguments[:int(argument_count)]
	state := get_state_from_ctx(ctx)

	if state == nil {
		if exception != nil {
			exception^ = make_js_error(ctx, "https: no event loop is bound to this context")
		}

		return jsc.JSValueMakeUndefined(ctx)
	}

	key, key_alloc := jsc_value_to_string_or_default(ctx, args[0])
	defer if key_alloc {
		delete(key, context.allocator)
	}
	cert, cert_alloc := jsc_value_to_string_or_default(ctx, args[1])
	defer if cert_alloc {
		delete(cert, context.allocator)
	}

	ssl_ctx, ok := tls_server_ctx_new(transmute([]byte)key, transmute([]byte)cert)

	if !ok {
		// ERR_TLS_*-shaped: a bad/mismatched/encrypted key or cert. Surfaced synchronously so a
		// caller's try/catch around https.createServer sees it (design §5).
		if exception !=
		   nil {exception^ = make_js_error(ctx, "https.createServer: invalid TLS key or certificate (ERR_TLS_CERT)")}

		return jsc.JSValueMakeUndefined(ctx)
	}

	id := state.next_net_id
	state.next_net_id += 1
	state.tls_server_ctxs[id] = rawptr(ssl_ctx)
	return jsc.JSValueMakeNumber(ctx, f64(id))
}

// https_free_secure_context_cb(contextId): release a context that was built but never consumed by
// listen (https.Server closed before/without listening). A consumed id is already gone from the
// registry (owned by its Net_Server), so this no-ops then.
https_free_secure_context_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()

	if argument_count < 1 {
		return jsc.JSValueMakeUndefined(ctx)
	}

	state := get_state_from_ctx(ctx)

	if state == nil {
		return jsc.JSValueMakeUndefined(ctx)
	}

	id := u64(jsc.JSValueToNumber(ctx, arguments[0], nil))

	if ssl_ctx, ok := state.tls_server_ctxs[id]; ok {
		tls_server_ctx_free(cast(openssl.SSL_CTX)ssl_ctx)
		delete_key(&state.tls_server_ctxs, id)
	}

	return jsc.JSValueMakeUndefined(ctx)
}
