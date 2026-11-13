#+build linux
package lava_runtime

import "base:runtime"
import "core:c"
import "core:fmt"
import "core:net"
import "core:os"
import "core:strconv"
import "core:sys/linux"
import jsc "lava:pkg/jsc"
import eventloop "lava:pkg/runtime/eventloop"

// node:net (TCP) — minimal server primitives on the event-loop reactor (M1). This
// is the inbound mirror of fetch's outbound socket transport (fetch_transport.odin /
// fetch_linux.odin): a listening fd is watched for readability (== a pending accept),
// each accepted connection becomes a watched fd advanced by the same IO_Watcher the
// fetch client uses. js/internal/net.js builds the public net.Server / net.Socket
// (EventEmitter) surface on top of the flat primitives exposed by make_net_bindings.
//
// Lifetime: the listener and every connection are watched fds, so watch_fd's
// active_io_count keeps the loop alive while a server listens or a connection is open
// (matching Node — the process does not exit while a server is listening). Because a
// JS handler can close its socket (or the server) synchronously from inside an accept/
// read callback, the native struct is never freed inline: net_close_* unwatches, closes
// the fd, fires the JS 'close', removes the handle from the registry, and DEFERS the
// free to the next tick via async_begin + post_async — so the in-flight callback can
// keep reading conn.closing without a use-after-free. Teardown (net_shutdown_active)
// frees whatever remains while the loop/context are still alive.

NET_READ_CHUNK :: 64 * 1024
NET_DEFAULT_BACKLOG :: 511

// Bound on a TLS handshake (https.createServer): a peer that opens a connection and never
// completes (or dribbles) the handshake holds an fd + SSL + two BIOs with no progress — a
// TLS-layer slowloris that http.js's post-handshake timeouts never see. 30 s is generous for a
// slow-but-legitimate client yet reaps a stalled one. Armed in net_accept_cb, cancelled on
// handshake completion (tls_server.odin) and in both free sites. Overridable via
// LAVA_TLS_HANDSHAKE_TIMEOUT_MS (the smoke uses a short value to exercise the reaper).
TLS_HANDSHAKE_TIMEOUT_MS :: 30_000

@(private = "file")
net_tls_handshake_timeout_ms_cached: u64 = 0

// Racy-but-benign across Slice-3a worker threads (same pattern as net_force_readiness): the
// check-then-write on this package global is an unsynchronized RMW, but every worker reads the same
// env and writes the same value with an aligned store, so the worst case is a redundant recompute.
net_tls_handshake_timeout_ms :: proc() -> u64 {
	if net_tls_handshake_timeout_ms_cached == 0 {
		net_tls_handshake_timeout_ms_cached = TLS_HANDSHAKE_TIMEOUT_MS
		if v := os.get_env("LAVA_TLS_HANDSHAKE_TIMEOUT_MS", context.temp_allocator); v != "" {
			if ms, ok := strconv.parse_int(v); ok && ms > 0 {
				net_tls_handshake_timeout_ms_cached = u64(ms)
			}
		}
	}
	return net_tls_handshake_timeout_ms_cached
}

// Proactor (io_uring completion-mode) tunables — see docs/lava/io-uring-proactor.md (Slice 1b).
// A per-conn recv landing buffer is a real idle-memory cost vs the readiness path's transient
// stack buffer (Slice 2's provided-buffer ring reclaims it), so it is smaller than NET_READ_CHUNK.
NET_PROACTOR_RECV :: 16 * 1024
// Outbound high-water mark: write() reports backpressure (and reads pause) only when this many
// bytes are buffered, NOT merely because a send op is in flight (every io_uring send is async).
NET_WRITE_HWM :: 16 * 1024

// NET_ZC_THRESHOLD: only sends whose UNSENT tail (active_send[off:]) is at least this many bytes use
// SEND_ZC (Slice 3b) — keying off the unsent tail, not total buffered, is intentional: a shrinking
// partial tail correctly flips ZC→plain near the end of a body. Below it the page-pin + extra-CQE
// overhead loses, AND §4's one-notif-RTT serialization (the next write waits for the notification) makes
// the net break-even higher than raw zerocopy. 32 KiB is a PROVISIONAL, uncalibrated default: loopback
// always copies, so the calibrating real-NIC pipelined keep-alive bench (design §9 Q5) is still owed —
// until then prefer leaning HIGHER (a too-high threshold only forgoes a win; a too-low one risks a
// notif-RTT stall on medium bodies). Do not tighten it on loopback numbers.
NET_ZC_THRESHOLD :: 32 * 1024

// A connection's I/O backend, chosen ONCE at start: .Proactor only after a successful first
// submit_recv, else .Readiness (the epoll-style watcher path). close/write/end/shutdown branch
// on this, never on proactor_available or op-ID liveness (both IDs are invalid after EOF on a
// live proactor conn).
Net_IO_Mode :: enum u8 {
	Readiness = 0,
	Proactor, // io_uring completion, per-conn recv_buf (Slice 1b)
	ProactorRing, // io_uring completion, shared provided-buffer ring (Slice 2a) — no recv_buf
}

// net_is_proactor reports whether the connection uses ANY proactor backend (Proactor or
// ProactorRing). The send path + teardown are identical for both, so every shared branch tests
// this — NOT `io_mode == .Proactor` by equality, which would route a ProactorRing conn down the
// readiness path and free it with a kernel recv still armed (UAF). The recv path branches on the
// exact mode (per-conn buffer vs ring).
net_is_proactor :: proc(conn: ^Net_Connection) -> bool {
	return conn.io_mode == .Proactor || conn.io_mode == .ProactorRing
}

// Net_Server owns a listening socket. on_connection is a GC-protected JS callback
// invoked as on_connection(connId) for each accepted connection.
Net_Server :: struct {
	ctx:           jsc.JSContextRef,
	loop:          ^eventloop.Loop,
	id:            u64,
	fd:            uintptr,
	watcher:       eventloop.IO_Watcher,
	on_connection: jsc.JSObjectRef,
	closing:       bool,
	// TLS (https.createServer): when tls, every accepted conn is wrapped via tls_server_attach on
	// this per-listener context. tls_ctx is an ^SSL_CTX built+validated synchronously in
	// https.createServer (carried here as rawptr so this struct need not name the OpenSSL binding);
	// it is freed once, on server close (net_close_server). See tls_server.odin.
	tls:           bool,
	tls_ctx:       rawptr,
}

// Net_Connection owns one accepted socket. The per-connection handlers are registered
// (and GC-protected) by net_start_cb once js/internal/net.js has built its Socket, then
// the read watcher is armed. They are payload-only (the JS handler is already bound to
// its own Socket), so on_data(buf), on_end(), on_close(hadError), on_error(message).
Net_Connection :: struct {
	ctx:                 jsc.JSContextRef,
	loop:                ^eventloop.Loop,
	id:                  u64,
	fd:                  uintptr,
	watcher:             eventloop.IO_Watcher,
	on_data:             jsc.JSObjectRef,
	on_end:              jsc.JSObjectRef,
	on_close:            jsc.JSObjectRef,
	on_error:            jsc.JSObjectRef,
	on_drain:            jsc.JSObjectRef, // proactor: fired when the outbound buffer empties
	// Outbound connect (net.connect): fired exactly once when the non-blocking
	// connect resolves successfully; unprotected + nil'd right after. Zero on
	// accepted (server) connections.
	on_connect:          jsc.JSObjectRef,
	connect_label:       string, // "host:port" for connect error messages; freed with the conn
	handlers_set:        bool,
	// Pending outbound bytes not yet accepted by the kernel send buffer. Bound to the
	// default heap on first append (a proc "c" runs under runtime.default_context); the
	// dynamic array carries that allocator, so delete() frees it correctly anywhere.
	write_queue:         [dynamic]byte,
	write_off:           int, // readiness path: bytes of write_queue already sent (avoids O(N^2) per-partial compaction)
	writing:             bool, // watcher currently in .Write mode (draining a blocked write)
	end_after_drain:     bool, // socket.end() / read EOF: close once write_queue empties
	read_done:           bool, // peer half-closed (read EOF) — never re-arm the read watcher
	closing:             bool,
	// --- TLS (https.createServer; tls_server.odin). All zero on a plaintext conn. The SSL owns
	// rbio/wbio (freed by SSL_free in tls_server_free_conn); rbio/wbio are retained here only for
	// BIO_read/BIO_write and are NEVER freed separately. tls_handshaking gates the recv-side driver
	// (SSL_accept vs SSL_read); handshake_timer bounds a stalled handshake (TLS-layer slowloris). ---
	tls:                 bool,
	tls_handshaking:     bool,
	ssl:                 rawptr,
	rbio:                rawptr,
	wbio:                rawptr,
	handshake_timer:     eventloop.Timer_ID,
	// --- proactor (io_uring completion) state; io_mode == .Proactor ---------------
	io_mode:             Net_IO_Mode,
	recv_buf:            []byte, // reused kernel landing zone (copied per chunk; never JSC no-copy)
	recv_op:             eventloop.Op_ID, // live RECV (OP_ID_INVALID == none in flight)
	send_op:             eventloop.Op_ID, // live SEND
	// active_send is the IMMUTABLE buffer currently submitted to send_op (the op submits
	// active_send[active_send_off:]); pending_writes is the mutable queue appends land in.
	// Both stay [dynamic]byte (a []byte would drop the allocator/capacity) and are ROTATED
	// (swapped + cleared), never reallocated, so a backing the kernel is reading never moves.
	active_send:         [dynamic]byte,
	active_send_off:     int,
	pending_writes:      [dynamic]byte,
	inflight:            int, // submitted-but-not-completed ops; the conn outlives its ops
	want_drain:          bool, // write() returned backpressure; a 'drain' is owed
	silent_close:        bool, // teardown at loop shutdown: free without firing 'close'
	had_error:           bool, // sticky: set true by any net_close_conn(.., true)
	recv_starved:        bool, // ProactorRing: on the state.net_starved_* FIFO after -ENOBUFS (no ring buffer)
	recv_multishot:      bool, // ProactorRing: the live recv_op was armed multishot (attributes its -EINVAL)
	recv_cancel_pending: bool, // ProactorRing: a backpressure cancel is queued for recv_op (suppresses dup cancels)
	// SEND_ZC (Slice 3b): the live send op's per-op state (one send op per conn, so per-conn == per-op).
	send_was_zc:         bool, // the live send_op was submitted SEND_ZC (attributes a -EINVAL/-EOPNOTSUPP)
	zc_unsupported:      bool, // a -EOPNOTSUPP on THIS conn's socket/protocol: deny ZC for this conn only (vs -EINVAL → loop-wide)
	saw_result:          bool, // a SEND_ZC result CQE (more=true) arrived: the terminal is its notification
	zc_err:              i32, // a negative result recorded on a more=true (errored-but-pinned) CQE; surfaced at the terminal
	starved_next:        ^Net_Connection, // intrusive starved-FIFO links (valid only while recv_starved)
	starved_prev:        ^Net_Connection,
}

// make_net_bindings builds the `native` object passed to js/internal/net.js.
make_net_bindings :: proc(ctx: jsc.JSContextRef) -> jsc.JSObjectRef {
	bindings := jsc.JSObjectMake(ctx, nil, nil)
	inject_native_function(ctx, bindings, "listen", net_listen_cb)
	inject_native_function(ctx, bindings, "connect", net_connect_cb)
	inject_native_function(ctx, bindings, "startConnection", net_start_cb)
	inject_native_function(ctx, bindings, "write", net_write_cb)
	inject_native_function(ctx, bindings, "end", net_end_cb)
	inject_native_function(ctx, bindings, "close", net_close_cb)
	inject_native_function(ctx, bindings, "closeServer", net_close_server_cb)
	inject_native_function(ctx, bindings, "serverPort", net_server_port_cb)
	return bindings
}

// --- listen / accept ---------------------------------------------------------

// net_listen_cb(port, host, backlog, onConnection) -> serverId. Creates a non-blocking
// listening socket, binds+listens synchronously (so a bind error throws here, matching
// where Node surfaces EADDRINUSE), and watches it for accepts. IPv4-only listener for
// M1; an unparseable/IPv6 host falls back to 0.0.0.0.
net_listen_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 4 {
		if exception != nil do exception^ = make_js_error(ctx, "net.listen requires (port, host, backlog, onConnection)")
		return jsc.JSValueMakeUndefined(ctx)
	}
	args := arguments[:int(argument_count)]
	port := int(jsc.JSValueToNumber(ctx, args[0], nil))
	host, host_alloc := jsc_value_to_string_or_default(ctx, args[1])
	defer if host_alloc do delete(host, context.allocator)
	backlog := int(jsc.JSValueToNumber(ctx, args[2], nil))
	if backlog <= 0 do backlog = NET_DEFAULT_BACKLOG
	on_connection := callback_arg(ctx, args[3])
	if on_connection == nil {
		if exception != nil do exception^ = make_js_error(ctx, "net.listen onConnection must be a function")
		return jsc.JSValueMakeUndefined(ctx)
	}
	loop := get_loop_from_ctx(ctx)
	state := get_state_from_ctx(ctx)
	if loop == nil || state == nil {
		if exception != nil do exception^ = make_js_error(ctx, "net: no event loop is bound to this context")
		return jsc.JSValueMakeUndefined(ctx)
	}

	// Optional 5th arg: a TLS context id (https.createServer → createSecureContext). Consume it from
	// the registry up front and free it via the defer on ANY failure below (bad socket/bind/listen/
	// watch). This means a failed listen never leaks the context AND never needs an 'error'-swallowing
	// JS listener (which would hide EADDRINUSE). Ownership moves to the Net_Server only on success
	// (listen_ok), at which point the defer no-ops and net_close_server owns the free.
	tls_ctx: rawptr = nil
	tls_enabled := false
	if argument_count >= 5 && jsc.JSValueIsNumber(ctx, args[4]) {
		ctx_id := u64(jsc.JSValueToNumber(ctx, args[4], nil))
		if found, ok := state.tls_server_ctxs[ctx_id]; ok {
			tls_ctx = found
			tls_enabled = true
			delete_key(&state.tls_server_ctxs, ctx_id)
		} else {
			if g_multi_worker do net_startup_failed()
			if exception != nil do exception^ = make_js_error(ctx, "net.listen: invalid TLS context handle")
			return jsc.JSValueMakeUndefined(ctx)
		}
	}
	listen_ok := false
	defer if !listen_ok && tls_enabled do tls_server_ctx_free(cast(SSL_CTX)tls_ctx)

	// Multi-worker (Slice 3a): every worker binds the same addr:port and the kernel load-balances
	// connections across them via SO_REUSEPORT. An ephemeral port (0) can't work — each worker would
	// get a DIFFERENT port, silently splitting the server into N single-core servers — so reject it
	// and require an explicit port. net_startup_failed aborts the whole startup (M7): a server that
	// can't come up on one core must not run degraded on the others.
	if g_multi_worker && port == 0 {
		net_startup_failed()
		if exception != nil do exception^ = make_js_error(ctx, "net.listen: an explicit port is required under LAVA_WORKERS>1 (ephemeral port 0 is not supported)")
		return jsc.JSValueMakeUndefined(ctx)
	}

	sfd, sock_err := linux.socket(.INET, .STREAM, {.NONBLOCK}, .TCP)
	if sock_err != .NONE {
		if g_multi_worker do net_startup_failed()
		if exception != nil do exception^ = make_js_error(ctx, "net.listen: could not create socket")
		return jsc.JSValueMakeUndefined(ctx)
	}
	// SO_REUSEADDR so a restart can rebind a port still in TIME_WAIT (best-effort).
	reuse: i32 = 1
	_ = linux.setsockopt(sfd, linux.SOL_SOCKET, linux.Socket_Option.REUSEADDR, &reuse)
	// SO_REUSEPORT for the multi-worker listener group. Unlike REUSEADDR its result MUST be checked:
	// every socket sharing the port must set it, or the group is unsafe (a bind would collide). Surface
	// the failure as a startup abort.
	if g_multi_worker {
		if so_err := linux.setsockopt(
			sfd,
			linux.SOL_SOCKET,
			linux.Socket_Option.REUSEPORT,
			&reuse,
		); so_err != .NONE {
			linux.close(sfd)
			net_startup_failed()
			if exception != nil do exception^ = make_js_error(ctx, "net.listen: SO_REUSEPORT failed")
			return jsc.JSValueMakeUndefined(ctx)
		}
	}

	// Resolve the bind address. An unsupported host must NOT silently fall back to the
	// 0.0.0.0 wildcard — that would expose a server meant for loopback on every
	// interface. M1 binds IPv4 only: accept a numeric IPv4 or "localhost"; reject IPv6
	// literals and anything else (a real resolver is a later milestone).
	ip4 := net.IP4_Address{0, 0, 0, 0}
	if len(host) > 0 && host != "0.0.0.0" {
		resolved := false
		if parsed := net.parse_address(host); parsed != nil {
			#partial switch a in parsed {
			case net.IP4_Address:
				ip4 = a
				resolved = true
			}
		} else if host == "localhost" {
			ip4 = net.IP4_Address{127, 0, 0, 1}
			resolved = true
		}
		if !resolved {
			linux.close(sfd)
			if exception != nil do exception^ = make_js_error(ctx, "net.listen: unsupported host (only numeric IPv4 and 'localhost' are supported)")
			return jsc.JSValueMakeUndefined(ctx)
		}
	}
	addr := linux.Sock_Addr_In {
		sin_family = .INET,
		sin_port   = u16be(u16(port)),
		sin_addr   = transmute([4]u8)ip4,
	}
	if bind_err := linux.bind(sfd, &addr); bind_err != .NONE {
		linux.close(sfd)
		if g_multi_worker do net_startup_failed()
		if exception != nil do exception^ = make_js_error(ctx, "net.listen: bind failed (address in use?)")
		return jsc.JSValueMakeUndefined(ctx)
	}
	if listen_err := linux.listen(sfd, i32(backlog)); listen_err != .NONE {
		linux.close(sfd)
		if g_multi_worker do net_startup_failed()
		if exception != nil do exception^ = make_js_error(ctx, "net.listen: listen failed")
		return jsc.JSValueMakeUndefined(ctx)
	}

	server := new(Net_Server)
	server.ctx = ctx
	server.loop = loop
	server.fd = uintptr(sfd)
	server.on_connection = on_connection
	server.tls = tls_enabled
	server.tls_ctx = tls_ctx
	server.id = state.next_net_id
	state.next_net_id += 1
	jsc.JSValueProtect(ctx, cast(jsc.JSValueRef)on_connection)
	state.net_servers[server.id] = server

	server.watcher = eventloop.IO_Watcher {
		fd        = uintptr(sfd),
		mode      = .Read,
		callback  = net_accept_cb,
		user_data = server,
	}
	if !eventloop.watch_fd(loop, &server.watcher) {
		delete_key(&state.net_servers, server.id)
		jsc.JSValueUnprotect(ctx, cast(jsc.JSValueRef)on_connection)
		linux.close(sfd)
		free(server) // the deferred ctx-free (listen_ok still false) releases server.tls_ctx
		if g_multi_worker do net_startup_failed()
		if exception != nil do exception^ = make_js_error(ctx, "net.listen: could not register listener with the event loop")
		return jsc.JSValueMakeUndefined(ctx)
	}
	listen_ok = true // success: the Net_Server now owns tls_ctx; the defer no-ops
	return jsc.JSValueMakeNumber(ctx, f64(server.id))
}

// net_accept_cb drains the listener's accept backlog (edge-triggered, so loop until
// EAGAIN). Each accepted fd becomes a Net_Connection with NO read watcher yet — the
// read is armed only once JS registers handlers via startConnection, which closes the
// window where data could arrive before the Socket exists. Loop thread.
net_accept_cb :: proc(loop: ^eventloop.Loop, user_data: rawptr) {
	context = runtime.default_context() // allocate Net_Connection on the heap net_maybe_free frees with
	server := cast(^Net_Server)user_data
	if server == nil || server.closing do return
	state := get_state_from_ctx(server.ctx)
	if state == nil do return
	for {
		addr: linux.Sock_Addr_In
		cfd, accept_err := linux.accept(linux.Fd(server.fd), &addr, {.NONBLOCK})
		if accept_err != .NONE do break // EAGAIN (drained) or a transient error — stop this round

		// TCP_NODELAY: disable Nagle so small request/response exchanges aren't stalled by
		// the ~40 ms Nagle + delayed-ACK interaction (the dominant cost on a keep-alive
		// hello-world load). Node/Bun set this by default. Best-effort.
		nodelay: i32 = 1
		_ = linux.setsockopt(cfd, linux.SOL_TCP, linux.Socket_TCP_Option.NODELAY, &nodelay)

		conn := new(Net_Connection)
		conn.ctx = server.ctx
		conn.loop = loop
		conn.fd = uintptr(cfd)
		conn.id = state.next_net_id
		state.next_net_id += 1
		state.net_conns[conn.id] = conn

		// TLS listener: wrap the conn in an SSL session (rbio/wbio memory BIOs) BEFORE 'connection'
		// is emitted, so socket.encrypted is already correct, and arm a handshake-deadline timer (a
		// stalled handshake is a TLS-layer slowloris that http.js's post-handshake timeouts can't
		// bound). The handshake itself is driven by the recv completions armed in net_start_cb.
		if server.tls {
			if !tls_server_attach(conn, cast(SSL_CTX)server.tls_ctx) {
				net_close_conn(conn, true) // SSL/BIO alloc failed — drop this conn (no JS yet)
				continue
			}
			conn.handshake_timer = eventloop.set_timeout(
				loop,
				net_tls_handshake_timeout,
				net_tls_handshake_timeout_ms(),
				conn,
			)
		}

		cid := jsc.JSValueMakeNumber(server.ctx, f64(conn.id))
		net_emit(server.ctx, server.on_connection, &cid, 1)
		if server.closing do break // a 'connection' handler closed the server
	}
}

// net_tls_handshake_timeout fires if a TLS handshake hasn't completed within the deadline. It
// abruptly closes the conn (no close_notify — the session never came up). Zero the timer id FIRST
// (a one-shot frees itself on return, so the free site must not also clear it). Loop thread.
net_tls_handshake_timeout :: proc(loop: ^eventloop.Loop, user_data: rawptr) {
	context = runtime.default_context()
	conn := cast(^Net_Connection)user_data
	if conn == nil do return
	conn.handshake_timer = 0
	if conn.closing || !conn.tls_handshaking do return
	net_emit_error(conn, "tls handshake timeout")
	net_close_conn(conn, true)
}

// --- outbound connect (net.connect) ------------------------------------------

// net_connect_errno_name maps the SO_ERROR of a failed connect to Node's error
// code vocabulary (err.code / the first token after "connect " in the message).
@(private = "file")
net_connect_errno_name :: proc(errno: i32) -> string {
	#partial switch linux.Errno(errno) {
	case .ECONNREFUSED:
		return "ECONNREFUSED"
	case .ETIMEDOUT:
		return "ETIMEDOUT"
	case .EHOSTUNREACH:
		return "EHOSTUNREACH"
	case .ENETUNREACH:
		return "ENETUNREACH"
	case .EADDRNOTAVAIL:
		return "EADDRNOTAVAIL"
	case .EADDRINUSE:
		return "EADDRINUSE"
	case .EACCES:
		return "EACCES"
	case:
		return "EIO"
	}
}

// net_connect_io_cb resolves a pending non-blocking connect: the fd polls
// writable once the handshake finishes (success AND failure both surface this
// way — SO_ERROR distinguishes them). One-shot: the watcher is released before
// any JS runs, so startConnection can arm reads on the same fd. Loop thread.
net_connect_io_cb :: proc(loop: ^eventloop.Loop, user_data: rawptr) {
	context = runtime.default_context()
	conn := cast(^Net_Connection)user_data
	if conn == nil || conn.closing do return
	eventloop.unwatch_fd(loop, &conn.watcher)

	soerr: i32 = 0
	// getsockopt_base directly: the _sock overload's where-clause tests the
	// POINTEE type (a core:sys/linux quirk in this Odin build), so ^i32 never
	// matches it.
	_, _ = linux.getsockopt_base(
		linux.Fd(conn.fd),
		cast(int)linux.SOL_SOCKET,
		linux.Socket_Option.ERROR,
		&soerr,
	)
	if soerr == 0 {
		fn := conn.on_connect
		conn.on_connect = nil
		net_emit(conn.ctx, fn, nil, 0)
		net_unprotect(conn.ctx, fn)
		return
	}
	net_emit_error(
		conn,
		fmt.tprintf("connect %s %s", net_connect_errno_name(soerr), conn.connect_label),
	)
	net_close_conn(conn, true)
}

// net_connect_cb(port, host, onConnected, onError) -> connId. Creates a
// non-blocking IPv4 socket and starts connect(); the connection is registered
// up front (so close() works mid-connect) and watched for writability until the
// connect resolves. On success JS registers its data handlers through the SAME
// startConnection the accept path uses, so client sockets get the full
// proactor/readiness read machinery for free. Same host policy as listen:
// numeric IPv4 or "localhost" (DNS integration is a later milestone).
net_connect_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 4 {
		if exception != nil do exception^ = make_js_error(ctx, "net.connect requires (port, host, onConnected, onError)")
		return jsc.JSValueMakeUndefined(ctx)
	}
	args := arguments[:int(argument_count)]
	port := int(jsc.JSValueToNumber(ctx, args[0], nil))
	host, host_alloc := jsc_value_to_string_or_default(ctx, args[1])
	defer if host_alloc do delete(host, context.allocator)
	on_connected := callback_arg(ctx, args[2])
	on_error := callback_arg(ctx, args[3])
	if on_connected == nil || on_error == nil {
		if exception != nil do exception^ = make_js_error(ctx, "net.connect: onConnected and onError must be functions")
		return jsc.JSValueMakeUndefined(ctx)
	}
	loop := get_loop_from_ctx(ctx)
	state := get_state_from_ctx(ctx)
	if loop == nil || state == nil {
		if exception != nil do exception^ = make_js_error(ctx, "net: no event loop is bound to this context")
		return jsc.JSValueMakeUndefined(ctx)
	}

	// Same policy as net.listen: numeric IPv4 or "localhost" only — never fall
	// back to a wildcard or a resolver silently.
	ip4 := net.IP4_Address{127, 0, 0, 1}
	if len(host) > 0 {
		resolved := false
		if parsed := net.parse_address(host); parsed != nil {
			#partial switch a in parsed {
			case net.IP4_Address:
				ip4 = a
				resolved = true
			}
		} else if host == "localhost" {
			resolved = true
		}
		if !resolved {
			if exception != nil do exception^ = make_js_error(ctx, "net.connect: unsupported host (only numeric IPv4 and 'localhost' are supported)")
			return jsc.JSValueMakeUndefined(ctx)
		}
	}

	cfd, sock_err := linux.socket(.INET, .STREAM, {.NONBLOCK}, .TCP)
	if sock_err != .NONE {
		if exception != nil do exception^ = make_js_error(ctx, "net.connect: could not create socket")
		return jsc.JSValueMakeUndefined(ctx)
	}
	nodelay: i32 = 1
	_ = linux.setsockopt(cfd, linux.SOL_TCP, linux.Socket_TCP_Option.NODELAY, &nodelay)

	addr := linux.Sock_Addr_In {
		sin_family = .INET,
		sin_port   = u16be(u16(port)),
		sin_addr   = transmute([4]u8)ip4,
	}

	conn := new(Net_Connection)
	conn.ctx = ctx
	conn.loop = loop
	conn.fd = uintptr(cfd)
	conn.id = state.next_net_id
	state.next_net_id += 1
	state.net_conns[conn.id] = conn
	conn.on_connect = on_connected
	conn.on_error = on_error
	net_protect(ctx, conn.on_connect)
	net_protect(ctx, conn.on_error)
	conn.connect_label = fmt.aprintf("%s:%d", host, port)

	// EINPROGRESS is the normal non-blocking path; an immediate .NONE (loopback
	// can connect synchronously) still resolves through the writability watcher
	// so JS always receives onConnected AFTER it has the connection id.
	conn_err := linux.connect(cfd, &addr)
	if conn_err != .NONE && conn_err != .EINPROGRESS && conn_err != .EAGAIN {
		// Synchronous failure (e.g. ENETUNREACH). The error must still be
		// delivered asynchronously — JS attaches listeners after this returns —
		// so leave delivery to the watcher: a failed socket polls writable with
		// SO_ERROR set. If even the watcher can't register, fall through below.
	}
	conn.watcher = eventloop.IO_Watcher {
		fd        = conn.fd,
		mode      = .Write,
		callback  = net_connect_io_cb,
		user_data = conn,
	}
	if !eventloop.watch_fd(loop, &conn.watcher) {
		net_emit_error(conn, "net.connect: could not register connection with the event loop")
		net_close_conn(conn, true)
		return jsc.JSValueMakeUndefined(ctx)
	}
	return jsc.JSValueMakeNumber(ctx, f64(conn.id))
}

// --- per-connection handler registration + reads ----------------------------

// net_start_cb(connId, onData, onEnd, onClose, onError) registers the connection's
// handlers (GC-protected) and arms the read watcher. Called by net.js right after it
// builds the Socket for a freshly accepted connection.
net_start_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 5 do return jsc.JSValueMakeUndefined(ctx)
	args := arguments[:int(argument_count)]
	conn := net_get_conn(ctx, args[0])
	if conn == nil || conn.closing do return jsc.JSValueMakeUndefined(ctx)

	conn.on_data = callback_arg(ctx, args[1])
	conn.on_end = callback_arg(ctx, args[2])
	conn.on_close = callback_arg(ctx, args[3])
	conn.on_error = callback_arg(ctx, args[4])
	if argument_count >= 6 do conn.on_drain = callback_arg(ctx, args[5])
	net_protect(ctx, conn.on_data)
	net_protect(ctx, conn.on_end)
	net_protect(ctx, conn.on_close)
	net_protect(ctx, conn.on_error)
	net_protect(ctx, conn.on_drain)
	conn.handlers_set = true

	// Prefer the proactor. The mode is chosen at this FIRST submit only (rev.4): try the shared
	// provided-buffer ring (Slice 2a — no per-conn buffer, the memory moat); if the ring is
	// unavailable, try the 1b per-conn-buffer single-shot; if neither submits, fall back to the
	// readiness watcher. The mode is set ONLY on a successful submit (never count a failed one).
	if !net_force_readiness() && eventloop.proactor_available(conn.loop) {
		if eventloop.bufring_available(conn.loop) {
			id := eventloop.submit_recv_ring(
				conn.loop,
				conn.fd,
				net_recv_ring_complete,
				on_op_dispose,
				conn,
			)
			if id != eventloop.OP_ID_INVALID {
				conn.io_mode = .ProactorRing // no recv_buf — reads draw from the shared ring
				conn.recv_op = id
				conn.inflight += 1
				return jsc.JSValueMakeUndefined(ctx)
			}
		}
		conn.recv_buf = make([]byte, NET_PROACTOR_RECV, context.allocator)
		id := eventloop.submit_recv(
			conn.loop,
			conn.fd,
			conn.recv_buf,
			on_recv_complete,
			on_op_dispose,
			conn,
		)
		if id != eventloop.OP_ID_INVALID {
			conn.io_mode = .Proactor
			conn.recv_op = id
			conn.inflight += 1
			return jsc.JSValueMakeUndefined(ctx)
		}
		delete(conn.recv_buf, context.allocator)
		conn.recv_buf = nil
	}

	conn.io_mode = .Readiness
	conn.watcher = eventloop.IO_Watcher {
		fd        = conn.fd,
		mode      = .Read,
		callback  = conn_read_cb,
		user_data = conn,
	}
	// If the watcher can't be registered (loop resource exhaustion), the conn has an open fd and
	// protected handlers but no I/O — tear it down rather than strand it. (Rare; the handlers are
	// already registered, so 'close' still reports the failure to a listener attached this tick.)
	if !eventloop.watch_fd(conn.loop, &conn.watcher) {
		net_emit_error(conn, "could not register connection with the event loop")
		net_close_conn(conn, true)
	}
	return jsc.JSValueMakeUndefined(ctx)
}

// net_force_readiness reports whether LAVA_NET_FORCE_READINESS is set — a TEST-ONLY switch that
// makes every connection take the epoll/readiness fallback instead of the proactor, so CI can
// exercise both backends on the same (proactor-capable) kernel. Read once and cached.
@(private = "file")
net_force_readiness_state: enum u8 {
	Unknown,
	No,
	Yes,
}

net_force_readiness :: proc() -> bool {
	if net_force_readiness_state == .Unknown {
		net_force_readiness_state =
			os.get_env("LAVA_NET_FORCE_READINESS", context.temp_allocator) != "" ? .Yes : .No
	}
	return net_force_readiness_state == .Yes
}

// --- proactor (io_uring completion) connection I/O ---------------------------
//
// See docs/lava/io-uring-proactor.md (Slice 1b). The connection holds an `inflight` op refcount so
// it OUTLIVES its in-flight recv/send ops; the single free site (net_maybe_free) runs only when
// closing && inflight == 0, so the kernel never touches a freed buffer and {callback XOR dispose}
// fires exactly once per op. All of these run on the loop thread (op completions / disposers).

// net_maybe_arm_recv is the SOLE place a RECV is submitted: at most one is ever in flight (two
// kernel ops writing the one recv_buf would corrupt it), and never after EOF, while reads are
// paused by backpressure (want_drain), or during teardown.
// net_maybe_arm_recv returns whether it actually submitted a recv: false when it can't arm right now
// (closing/EOF, a recv already in flight, or write-backpressured) or the submit failed (it then
// closes the conn — and `conn` may already be freed, so the caller must NOT touch it after a false).
net_maybe_arm_recv :: proc(conn: ^Net_Connection) -> bool {
	if conn.closing || conn.read_done do return false
	if conn.recv_op != eventloop.OP_ID_INVALID do return false // a recv is already in flight
	// A 'drain' is owed (write() returned backpressure): keep reads paused until it fires — Node's
	// input-paused-until-'drain' semantics. This is the SINGLE gate for every re-arm path (3b §7): it
	// covers the SEND_ZC result→notif window (buffered drops on the result but 'drain' waits for the
	// notif) and also tightens 2a/1b — reads no longer resume on a partial drain (buffered < HWM)
	// before 'drain'. net_proactor_on_drained clears want_drain BEFORE re-arming, so this never deadlocks.
	if conn.want_drain do return false
	// Defensive HWM backstop. With the want_drain unification above this is effectively redundant —
	// any write that crosses HWM sets want_drain (cleared only on a full drain), so buffered >= HWM
	// implies want_drain and the gate above already returned. Kept as a cheap local guard (no struct
	// state — it used to be a read_paused field, which created a misleading "second backpressure
	// mechanism"); it never independently pauses in proactor mode today.
	if net_proactor_buffered(conn) >= NET_WRITE_HWM do return false
	id: eventloop.Op_ID
	if conn.io_mode == .ProactorRing {
		// Shared ring: no per-conn buffer; the kernel picks one at completion (net_recv_ring_complete).
		id = eventloop.submit_recv_ring(
			conn.loop,
			conn.fd,
			net_recv_ring_complete,
			on_op_dispose,
			conn,
		)
		// Record THIS op's submission mode so its completion can attribute a -EINVAL correctly: a
		// multishot op's -EINVAL means "kernel lacks RECV_MULTISHOT" (fall back); a single-shot op's
		// -EINVAL is a genuine error (close), never a capability signal to re-arm into a loop.
		conn.recv_multishot = eventloop.recv_ring_multishot(conn.loop)
		conn.recv_cancel_pending = false // a fresh op has no backpressure cancel outstanding
	} else {
		id = eventloop.submit_recv(
			conn.loop,
			conn.fd,
			conn.recv_buf,
			on_recv_complete,
			on_op_dispose,
			conn,
		)
	}
	if id == eventloop.OP_ID_INVALID {
		net_emit_error(conn, "read submit failed")
		net_close_conn(conn, true)
		return false
	}
	conn.recv_op = id
	conn.inflight += 1
	return true
}

// net_recv_ring_complete: a provided-buffer-ring RECV completion (Slice 2a single-shot, or 2b
// multishot — `more` true = INTERMEDIATE, the op stays armed; false = TERMINAL). ORDER is
// load-bearing (rev.4): COPY the kernel-selected buffer while we still own it, RECYCLE it
// unconditionally for any buffer-carrying CQE (even when closing — a leaked bid drains the shared
// ring), THEN deliver. The op's lifetime accounting (recv_op clear, re-arm, net_op_finished) happens
// ONLY on the terminal CQE — never per intermediate, or the conn would be freed while the kernel
// still posts CQEs for the live multishot op.
net_recv_ring_complete :: proc(
	loop: ^eventloop.Loop,
	user_data: rawptr,
	res: i32,
	bid: u16,
	has_buf: bool,
	more: bool,
) {
	context = runtime.default_context()
	conn := cast(^Net_Connection)user_data
	if !more {
		conn.recv_op = eventloop.OP_ID_INVALID // terminal: this op is finished
		conn.recv_cancel_pending = false // any backpressure cancel for this op is now consumed
	}

	// (1) copy/feed BEFORE recycle (recycling republishes the buffer; the kernel may overwrite it).
	// For TLS, feed ciphertext into the state machine here (it copies into rbio and emits decrypted
	// plaintext itself), leaving arg nil so the plaintext-delivery step below is skipped.
	arg: jsc.JSValueRef = nil
	if has_buf && res > 0 && !conn.closing {
		if src := eventloop.recv_ring_buf(loop, bid, int(res)); src != nil {
			if conn.tls {
				tls_server_on_ciphertext(conn, src)
			} else {
				copy_buf := make([]byte, len(src), context.allocator)
				copy(copy_buf, src)
				arg = make_uint8_array(conn.ctx, copy_buf)
			}
		}
	}
	// (2) recycle UNCONDITIONALLY for any buffer-carrying CQE (incl. a terminal one), then refill.
	if has_buf {
		eventloop.recv_ring_recycle(loop, bid)
		if state := get_state_from_ctx(conn.ctx); state != nil do net_refill_starved(state)
	}
	// (3) deliver / classify.
	fatal := false
	if !conn.closing {
		if res > 0 {
			if arg != nil do net_emit(conn.ctx, conn.on_data, &arg, 1)
		} else if res == 0 {
			// On a MULTISHOT ring recv the op stays armed across CQEs, so a graceful TLS close arrives
			// as TWO completions — the close_notify (res>0, decrypted to a clean SSL EOF inside
			// tls_server_on_ciphertext, which already set read_done + fired 'end') and then the FIN
			// (res==0, here). Guard on read_done so the FIN does not fire a SECOND 'end'. A plaintext
			// half-close reaches res==0 only once, so the guard is a no-op there.
			if !conn.read_done do net_emit(conn.ctx, conn.on_end, nil, 0)
			conn.read_done = true // EOF (always terminal — F_MORE clear)
		} else if res == -i32(linux.Errno.EINVAL) && conn.recv_multishot {
			// This op was submitted MULTISHOT and the kernel rejected it (has buffer rings but not
			// RECV_MULTISHOT, e.g. Linux 5.19): disable multishot loop-wide; the terminal re-arm below
			// re-arms this conn single-shot. A single-shot -EINVAL is NOT this — it falls through to the
			// fatal branch (close), so a genuine error can never re-arm into an -EINVAL loop.
			eventloop.disable_multishot(loop)
		} else if res == -i32(linux.Errno.ENOBUFS) ||
		   res == -i32(linux.Errno.EINTR) ||
		   res == -i32(linux.Errno.EAGAIN) ||
		   res == -i32(linux.Errno.ECANCELED) {
			// benign/transient — the terminal re-arm path below handles it
		} else {
			net_emit_error(conn, "read error")
			net_close_conn(conn, true)
			fatal = true
		}
	}

	// (4) INTERMEDIATE multishot CQE: the op is still in flight — do NOT re-arm or finish it. If a
	// data handler just pushed write-backpressure, disarm the multishot (its terminal -ECANCELED then
	// re-arms via the drain transition) so reads can't outrun writes past the high-water mark.
	if more {
		net_maybe_pause_multishot(conn)
		return
	}
	// TERMINAL CQE: re-arm (unless EOF/fatal/closing — net_maybe_arm_recv also no-ops while paused),
	// then drop the op's in-flight count LAST (reentrant destroy() inside a handler stays safe).
	if !fatal && !conn.closing && !conn.read_done {
		if res == -i32(linux.Errno.ENOBUFS) {
			net_park_or_rearm(conn)
		} else if res == -i32(linux.Errno.ECANCELED) {
			// This terminal came from net_maybe_pause_multishot disarming for backpressure (a teardown
			// cancel is filtered by !conn.closing above). net_maybe_arm_recv now gates on want_drain
			// itself (3b §7), so the re-arm is unconditional here — it no-ops while a 'drain' is owed.
			net_maybe_arm_recv(conn)
		} else {
			net_maybe_arm_recv(conn)
		}
	}
	net_op_finished(conn)
}

// net_maybe_pause_multishot disarms a multishot ring recv when the connection's outbound buffer has
// crossed the high-water mark, so a slow-writing peer can't make the kernel keep reading unboundedly
// (2a single-shot needs none — it pauses by simply not re-arming). The cancel's terminal -ECANCELED
// CQE drops the op; the drain transition (net_proactor_on_drained) re-arms a fresh recv once the
// outbound buffer empties. recv_cancel_pending suppresses duplicate cancels: this fires from on_data
// AND from net_write_cb, and every racing CQE above the HWM would otherwise queue another ASYNC_CANCEL
// (a syscall + an ignored CQE each). The flag is set only when a cancel was actually queued and is
// cleared on the op's terminal CQE (net_recv_ring_complete) — and per-op (net_maybe_arm_recv), so a
// momentarily-full SQ that dropped the cancel is retried on the next crossing.
net_maybe_pause_multishot :: proc(conn: ^Net_Connection) {
	if conn.io_mode != .ProactorRing || conn.closing do return
	if conn.recv_op == eventloop.OP_ID_INVALID || conn.recv_cancel_pending do return
	if !eventloop.recv_ring_multishot(conn.loop) do return
	if net_proactor_buffered(conn) >= NET_WRITE_HWM {
		conn.recv_cancel_pending = eventloop.cancel_op(conn.loop, conn.recv_op)
	}
}

// NET_RECV_CREDIT_MAX caps banked refill credits at the ring size: there can never be more than that
// many free ring buffers, so a larger bank would over-re-arm a -ENOBUFS burst. It must track
// eventloop's URING_BUFRING_ENTRIES (a different package); they match today, and a mismatch is SAFE —
// too-high only causes a bounded, self-correcting futile re-arm, too-low an extra park woken by the
// next recycle — never a stranded connection.
NET_RECV_CREDIT_MAX :: 256

// --- starved FIFO (intrusive doubly-linked, O(1) enqueue/dequeue/remove) ---

@(private = "file")
net_starved_enqueue :: proc(state: ^Runtime_State, conn: ^Net_Connection) {
	conn.starved_next = nil
	conn.starved_prev = state.net_starved_tail
	if state.net_starved_tail != nil do state.net_starved_tail.starved_next = conn
	else do state.net_starved_head = conn
	state.net_starved_tail = conn
}

@(private = "file")
net_starved_dequeue :: proc(state: ^Runtime_State) -> ^Net_Connection {
	conn := state.net_starved_head
	if conn == nil do return nil
	state.net_starved_head = conn.starved_next
	if state.net_starved_head != nil do state.net_starved_head.starved_prev = nil
	else do state.net_starved_tail = nil
	conn.starved_next, conn.starved_prev = nil, nil
	return conn
}

@(private = "file")
net_starved_unlink :: proc(state: ^Runtime_State, conn: ^Net_Connection) {
	if conn.starved_prev != nil do conn.starved_prev.starved_next = conn.starved_next
	else do state.net_starved_head = conn.starved_next
	if conn.starved_next != nil do conn.starved_next.starved_prev = conn.starved_prev
	else do state.net_starved_tail = conn.starved_prev
	conn.starved_next, conn.starved_prev = nil, nil
}

// net_park_or_rearm handles a ProactorRing -ENOBUFS (no ring buffer was selected). The kernel posted
// this CQE when the ring was empty, but a buffer may have been recycled since: if a credit is banked
// (a recycle that found no parked taker — see net_refill_starved) consume it and re-arm NOW, closing
// the lost-wakeup; otherwise park on the starved FIFO and take a loop-liveness ref (async_begin) so
// the loop cannot exit with our peer's data unread — a future recycle re-arms us.
net_park_or_rearm :: proc(conn: ^Net_Connection) {
	if conn.closing || conn.read_done do return
	// A 'drain' is owed → net_maybe_arm_recv would no-op (it gates on want_drain), so spending a recv
	// credit here would buy nothing and defer another parked conn's re-arm by a recycle. The drain
	// transition (net_proactor_on_drained) re-arms anyway. Mirrors net_refill_starved's want_drain policy.
	if conn.want_drain do return
	state := get_state_from_ctx(conn.ctx)
	if state == nil do return
	if state.net_recv_credits > 0 {
		state.net_recv_credits -= 1
		net_maybe_arm_recv(conn)
		return
	}
	if conn.recv_starved do return // no duplicate insertion
	conn.recv_starved = true
	net_starved_enqueue(state, conn)
	eventloop.async_begin(conn.loop)
}

// net_refill_starved is called once per recycled buffer (one freed buffer). It hands that buffer to
// the FIFO-first parked conn that can actually arm a recv NOW — re-arming exactly one (re-arming all
// would storm, since most would re-fault -ENOBUFS). A conn that can't take the buffer this moment is
// unparked and SKIPPED, NOT charged the wakeup (net_maybe_arm_recv returns false): a closing/EOF conn
// never re-arms, and a write-backpressured conn is re-armed by its own drain transition
// (net_proactor_on_drained), not here — charging either would strand the freed buffer while conns
// behind it stay parked with unread data (Codex review). If no parked conn can arm, the buffer is
// banked as a credit (capped) for a conn that parks before the next recycle, so the wakeup is never lost.
net_refill_starved :: proc(state: ^Runtime_State) {
	for {
		conn := net_starved_dequeue(state)
		if conn == nil do break
		conn.recv_starved = false
		eventloop.async_cancel(conn.loop) // drop the parked liveness ref
		if net_maybe_arm_recv(conn) do return // armed → this conn consumes the wakeup
		// else couldn't arm (closing/EOF/backpressured/submit-failed) — try the next parked conn
	}
	if state.net_recv_credits < NET_RECV_CREDIT_MAX do state.net_recv_credits += 1
}

// net_unpark removes a conn from the starved FIFO before it is freed (lifetime safety: a later
// recycle must never walk a freed conn), releasing its liveness ref. O(1).
net_unpark :: proc(state: ^Runtime_State, conn: ^Net_Connection) {
	if !conn.recv_starved do return
	conn.recv_starved = false
	eventloop.async_cancel(conn.loop)
	net_starved_unlink(state, conn)
}

// on_recv_complete: a RECV terminal CQE. Decrement+maybe-free is the LAST act (op_finished),
// after all JS and conn access, so a synchronous destroy() inside on_data cannot free the conn
// out from under this callback (the inflight count is the callback's lifetime reference).
on_recv_complete :: proc(loop: ^eventloop.Loop, user_data: rawptr, res: i32) {
	context = runtime.default_context()
	conn := cast(^Net_Connection)user_data
	conn.recv_op = eventloop.OP_ID_INVALID
	if !conn.closing {
		if res > 0 {
			n := int(res)
			if conn.tls {
				// Feed ciphertext to the TLS state machine (it copies into rbio, drives the
				// handshake or decrypt loop, and emits decrypted plaintext as on_data), then re-arm.
				tls_server_on_ciphertext(conn, conn.recv_buf[:n])
				if !conn.closing do net_maybe_arm_recv(conn)
			} else {
				// Copy out of the reused landing buffer into a JSC-owned Uint8Array (no-copy handoff
				// frees copy_buf on GC). The landing buffer must NOT be handed to JSC — it is reused.
				copy_buf := make([]byte, n, context.allocator)
				copy(copy_buf, conn.recv_buf[:n])
				arg := make_uint8_array(conn.ctx, copy_buf)
				net_emit(conn.ctx, conn.on_data, &arg, 1)
				net_maybe_arm_recv(conn) // its guards handle a handler that closed/paused
			}
		} else if res == 0 {
			// Single-shot can't double-fire (net_maybe_arm_recv gates on read_done after a TLS EOF),
			// but guard for consistency with the ring path: never fire 'end' twice.
			if !conn.read_done do net_emit(conn.ctx, conn.on_end, nil, 0)
			conn.read_done = true // half-close: never re-arm
		} else if res == -i32(linux.Errno.EINTR) || res == -i32(linux.Errno.EAGAIN) {
			net_maybe_arm_recv(conn) // transient — a fresh submit (kernel re-polls), not a spin
		} else if res != -i32(linux.Errno.ECANCELED) {
			net_emit_error(conn, "read error")
			net_close_conn(conn, true)
		}
		// -ECANCELED: our own teardown cancel; no error, just let op_finished reclaim.
	}
	net_op_finished(conn)
}

// net_proactor_buffered: outbound bytes not yet handed to the kernel (unsent active tail + queue).
net_proactor_buffered :: proc(conn: ^Net_Connection) -> int {
	return (len(conn.active_send) - conn.active_send_off) + len(conn.pending_writes)
}

// M3 (test confidence): when LAVA_ZC_STATS is set, emit one-time evidence to stderr distinguishing a real
// SEND_ZC run from a silent plain-path fallback (the smoke asserts on it, so a green gate can never be a
// plain-path run on a ZC-capable kernel — exactly the CI kernels most likely to differ from a dev box).
// Racy-but-benign across workers (a line may print more than once); the smoke only checks presence.
@(private = "file")
g_zc_ok_reported: bool
@(private = "file")
g_zc_engaged_reported: bool
net_zc_stats_note :: proc(loop: ^eventloop.Loop, use_zc: bool) {
	if g_zc_ok_reported && (g_zc_engaged_reported || !use_zc) do return
	if os.get_env("LAVA_ZC_STATS", context.temp_allocator) == "" do return
	if !g_zc_ok_reported {
		g_zc_ok_reported = true
		os.write_string(
			os.stderr,
			eventloop.send_zc_ok(loop) ? "LAVA_ZC: zc_ok=1\n" : "LAVA_ZC: zc_ok=0\n",
		)
	}
	if use_zc && !g_zc_engaged_reported {
		g_zc_engaged_reported = true
		os.write_string(os.stderr, "LAVA_ZC: SEND_ZC engaged\n")
	}
}

// net_proactor_submit submits active_send[off:] (the tail not yet sent) — the SINGLE submitter that
// owns send_op + inflight, choosing SEND_ZC vs a plain copy-SEND. ALL send sites route through it
// (initial kick, partial tail, pending rotation via kick_send, and the ZC fallbacks). Loop thread.
//
// SEND_ZC (3b) is used iff the kernel supports it (zc_ok, probed at init), the caller didn't force
// plain (a transient -ENOBUFS/-EINVAL fallback that must NOT re-pick ZC), and the unsent tail is large
// enough to be worth the page-pin + the notification round-trip. ZC is also denied per-conn after a
// -EOPNOTSUPP on this socket (conn.zc_unsupported — a per-socket/protocol condition, vs -EINVAL which
// latches loop-wide). send_was_zc records the choice so the completion can attribute a -EINVAL/-EOPNOTSUPP;
// saw_result/zc_err are reset per submission (one send op per conn, so this is the per-op reset).
// PRECONDITION: send_op == INVALID (the caller cleared/gated).
net_proactor_submit :: proc(conn: ^Net_Connection, force_plain := false) {
	assert(
		conn.send_op == eventloop.OP_ID_INVALID,
		"net_proactor_submit: a send is already in flight",
	)
	conn.saw_result = false
	conn.zc_err = 0
	buf := conn.active_send[conn.active_send_off:]
	use_zc :=
		!force_plain &&
		!conn.zc_unsupported &&
		eventloop.send_zc_ok(conn.loop) &&
		len(buf) >= NET_ZC_THRESHOLD
	conn.send_was_zc = use_zc
	net_zc_stats_note(conn.loop, use_zc) // M3: env-gated stderr evidence that the SEND_ZC path actually ran
	id: eventloop.Op_ID
	if use_zc {
		id = eventloop.submit_send_zc(
			conn.loop,
			conn.fd,
			buf,
			net_send_zc_complete,
			on_op_dispose,
			conn,
		)
	} else {
		id = eventloop.submit_send(conn.loop, conn.fd, buf, on_send_complete, on_op_dispose, conn)
	}
	if id == eventloop.OP_ID_INVALID {
		net_emit_error(conn, "write submit failed")
		net_close_conn(conn, true)
		return
	}
	conn.send_op = id
	conn.inflight += 1
}

// net_proactor_kick_send rotates pending_writes into active_send and submits, if no send is in
// flight and there is data. Rotation (swap + clear) preserves each backing's allocator/capacity.
net_proactor_kick_send :: proc(conn: ^Net_Connection) {
	if conn.closing do return
	if conn.send_op != eventloop.OP_ID_INVALID do return // a send is already in flight
	if len(conn.pending_writes) == 0 do return
	conn.active_send, conn.pending_writes = conn.pending_writes, conn.active_send
	clear(&conn.pending_writes)
	conn.active_send_off = 0
	net_proactor_submit(conn) // via the choke point — a large rotated chunk gets ZC (3b)
}

// on_send_complete: a SEND terminal CQE. Advances the offset, re-submits a partial tail, rotates
// the next queued chunk, or runs the drain transition when fully drained.
on_send_complete :: proc(loop: ^eventloop.Loop, user_data: rawptr, res: i32) {
	context = runtime.default_context()
	conn := cast(^Net_Connection)user_data
	conn.send_op = eventloop.OP_ID_INVALID
	if !conn.closing {
		if res > 0 {
			conn.active_send_off += int(res)
			if conn.active_send_off < len(conn.active_send) {
				net_proactor_submit(conn) // partial send — re-submit the unsent tail
			} else if len(conn.pending_writes) > 0 {
				net_proactor_kick_send(conn) // active drained; send the queued chunk next
			} else {
				clear(&conn.active_send) // fully drained (keep the backing for reuse)
				conn.active_send_off = 0
				net_proactor_on_drained(conn)
			}
		} else if res == 0 {
			net_emit_error(conn, "write stalled") // zero-progress on a non-empty send
			net_close_conn(conn, true)
		} else if res == -i32(linux.Errno.EINTR) || res == -i32(linux.Errno.EAGAIN) {
			net_proactor_submit(conn) // transient — re-submit the tail (a fresh op)
		} else if res != -i32(linux.Errno.ECANCELED) {
			net_emit_error(conn, "write error")
			net_close_conn(conn, true)
		}
	}
	net_op_finished(conn)
}

// net_send_zc_complete: the send_cb for a SEND_ZC op (Slice 3b) — the TWO-AXIS state machine over
// (more, res). `more` (from IORING_CQE_F_MORE) is the lifetime axis: more=true is the RESULT CQE (pages
// pinned, a notification owed — touch ONLY off/zc_err, then return, INV-1); more=false is the TERMINAL
// (the notification, a single non-pinned CQE, or an error) after which the buffer is free. `res`
// (bytes/-errno) is the SEPARATE classification axis. Mirrors net_recv_ring_complete / on_send_complete
// exactly: clear send_op FIRST, do the buffer decision under !closing, net_op_finished LAST. See
// docs/lava/zerocopy-slice3b-design.md §3.
net_send_zc_complete :: proc(loop: ^eventloop.Loop, user_data: rawptr, res: i32, more: bool) {
	context = runtime.default_context()
	conn := cast(^Net_Connection)user_data
	// INTERMEDIATE (result CQE): pages pinned, notif owed. RECORD ONLY, then return (INV-1) — never
	// finish/clear/free/submit/close here. off advances only on a non-negative result (INV-4); a
	// negative result is an errored-but-pinned send whose error is carried to the terminal.
	if more {
		conn.saw_result = true
		if res >= 0 do conn.active_send_off += int(res)
		else do conn.zc_err = res
		return
	}

	// TERMINAL (more=false): buffer is free. Clear send_op FIRST so a re-entrant write()/kick sees a
	// clear gate; do the buffer decision under !closing; net_op_finished LAST (keeps inflight >= 1
	// across any re-submit, so net_maybe_free can't transiently free the still-needed conn).
	saw := conn.saw_result
	conn.send_op = eventloop.OP_ID_INVALID
	if !conn.closing {
		err: i32 = 0
		if saw {
			err = conn.zc_err // 0 if the result succeeded; <0 if it errored (ignore THIS notif's res — INV-3)
		} else if res > 0 {
			conn.active_send_off += int(res) // single-CQE COPIED success (kernel declined ZC) — advance like plain
		} else if res < 0 {
			err = res // single-CQE pre-transmission error
		}
		if err < 0 { 	// off untouched on any error (INV-4) → a re-send is the exact unsent tail
			if err == -i32(linux.Errno.EINVAL) && conn.send_was_zc {
				eventloop.disable_zc(loop) // missing/rejected opcode is a kernel-wide fact: latch ZC off loop-wide
				net_proactor_submit(conn, force_plain = true) // re-send PLAIN
			} else if err == -i32(linux.Errno.EOPNOTSUPP) && conn.send_was_zc {
				conn.zc_unsupported = true // per-socket/protocol: deny ZC for THIS conn only, leave zc_ok intact
				net_proactor_submit(conn, force_plain = true) // re-send PLAIN
			} else if err == -i32(linux.Errno.ENOBUFS) || err == -i32(linux.Errno.ENOMEM) {
				net_proactor_submit(conn, force_plain = true) // optmem pressure — copy-send, NOT fatal (transient)
			} else if err == -i32(linux.Errno.EINTR) || err == -i32(linux.Errno.EAGAIN) {
				net_proactor_submit(conn) // transient retry — re-picks ZC (unlike ENOBUFS/ENOMEM): safe because
				// EINTR/EAGAIN are pre-transmission (nothing pinned yet) and FAST_POLL bounds the retry
			} else if err != -i32(linux.Errno.ECANCELED) {
				net_emit_error(conn, "write error")
				net_close_conn(conn, true) // fatal (EPIPE, …)
			}
			// -ECANCELED: benign (a non-closing cancel doesn't occur on the send path; closing is guarded)
		} else if !saw && res == 0 {
			net_emit_error(conn, "write stalled") // zero-byte stall (plain-path parity)
			net_close_conn(conn, true)
		} else if conn.active_send_off < len(conn.active_send) {
			net_proactor_submit(conn) // unsent tail (choke point re-picks ZC vs plain)
		} else if len(conn.pending_writes) > 0 {
			net_proactor_kick_send(conn) // rotate + submit via the choke point
		} else {
			clear(&conn.active_send) // fully drained (keep the backing)
			conn.active_send_off = 0
			net_proactor_on_drained(conn)
		}
	}
	conn.saw_result = false // redundant defensive zero — net_proactor_submit is the canonical per-op reset;
	conn.zc_err = 0 // nothing reads these on the closing/free path, but keep them clean for the next op
	net_op_finished(conn) // LAST, unconditional
}

// net_proactor_on_drained runs the reentrancy-safe drain transition: clear want_drain BEFORE
// emitting 'drain' (the listener may write >= HWM again or destroy()), then re-check state and
// re-arm reads / close only against the FRESH state.
net_proactor_on_drained :: proc(conn: ^Net_Connection) {
	resumed := conn.want_drain
	if conn.want_drain {
		conn.want_drain = false
		net_emit(conn.ctx, conn.on_drain, nil, 0)
	}
	if conn.closing do return // a 'drain' listener destroyed the socket
	// TLS: reads may have paused mid-decrypt with plaintext still buffered in the rbio; now that the
	// write drained, decrypt+emit that remainder before re-arming the recv (it lives in userspace, so
	// the recv re-arm alone would never deliver it). No-op if nothing is buffered.
	if conn.tls && resumed {
		tls_server_pump_reads(conn)
		if conn.closing do return
	}
	net_maybe_arm_recv(conn) // recomputes read_paused from the (possibly new) buffered count
	if conn.end_after_drain &&
	   conn.send_op == eventloop.OP_ID_INVALID &&
	   len(conn.pending_writes) == 0 {
		net_close_conn(conn, false)
	}
}

// net_op_finished is every completion's LAST act: drop the op's lifetime reference, then free
// the conn iff it is closing and no op remains.
net_op_finished :: proc(conn: ^Net_Connection) {
	conn.inflight -= 1
	net_maybe_free(conn)
}

// on_op_dispose: an op dropped without a terminal CQE (only at loop destruction). No JS reentry
// here, so it decrements immediately. Both ops carry the same conn; the last one frees it.
on_op_dispose :: proc(user_data: rawptr) {
	context = runtime.default_context()
	net_op_finished(cast(^Net_Connection)user_data)
}

// net_zc_pinned_at_teardown reports whether conn's active_send backing may still be pinned by the kernel
// at teardown: a SEND_ZC whose notification never fired (send_op is still live because we got here via the
// dispose path, not the more=false terminal that clears it). net_maybe_free LEAKS rather than frees such a
// backing (M1/M2 — closing the ring fd does not drop the TCP skb page refs). A pure predicate so the leak
// decision is unit-testable without a real kernel pin (which loopback/AF_UNIX CI can't produce).
net_zc_pinned_at_teardown :: proc(conn: ^Net_Connection) -> bool {
	return conn.send_was_zc && conn.send_op != eventloop.OP_ID_INVALID
}

// net_maybe_free is the SINGLE free site for a proactor conn. It finalizes only on the inflight
// 1->0 transition while closing (NOT idempotent — a call after free would be a UAF; but inflight
// == 0 means no op remains to call it again). The fd is closed BEFORE 'close' is emitted, and the
// conn is dropped from the registry before any JS runs so a reentrant destroy() can't re-enter.
net_maybe_free :: proc(conn: ^Net_Connection) {
	if !conn.closing || conn.inflight > 0 do return
	// Pin the default heap: recv_buf/active_send/pending_writes are allocated under
	// runtime.default_context (the proc"c" entry points) and the conn under net_accept_cb's
	// (also default) context, so free them the same way regardless of the ambient context when
	// this runs (e.g. net_shutdown_active / an Op_Dispose during eventloop.destroy).
	context = runtime.default_context()
	linux.close(linux.Fd(conn.fd))
	if state := get_state_from_ctx(conn.ctx); state != nil {
		delete_key(&state.net_conns, conn.id)
		net_drain_check_complete(state, conn.loop)
	}
	if !conn.silent_close {
		had := jsc.JSValueMakeBoolean(conn.ctx, b32(conn.had_error))
		net_emit(conn.ctx, conn.on_close, &had, 1)
	}
	net_unprotect(conn.ctx, conn.on_data)
	net_unprotect(conn.ctx, conn.on_end)
	net_unprotect(conn.ctx, conn.on_close)
	net_unprotect(conn.ctx, conn.on_error)
	net_unprotect(conn.ctx, conn.on_drain)
	net_unprotect(conn.ctx, conn.on_connect) // closed mid-connect: the success cb never fired
	delete(conn.connect_label)
	delete(conn.recv_buf)
	// M1/M2 (kernel-side UAF): a SEND_ZC whose pages the kernel may STILL hold pinned — its notification
	// never fired, so we reached here via the eventloop.destroy dispose path (the disposer drove inflight
	// to 0), NOT the more=false terminal: send_op is still live and the last send was ZC. Closing the ring
	// fd does NOT drop the TCP skb refs that pin these pages — they release on TX ACK/RST, asynchronously
	// (io_ring_exit_work tears down io_uring state, not live skbs) — and the linux.close above orphans the
	// socket with its retransmit queue intact (default linger). Freeing the backing now would let a later
	// same-heap allocation — a sibling Slice-3a worker shares this address space and heap — overwrite pages
	// the kernel is still transmitting (silent cross-connection corruption). So LEAK the backing: a bounded
	// (≤ teardown-time pinned conns), one-time leak reclaimed by the OS at process exit, safe because the
	// orphaned allocation's address is never reused. The normal path frees it on the notification (send_op
	// == INVALID by then). See docs/lava/zerocopy-slice3b-design.md §6.
	if !net_zc_pinned_at_teardown(conn) {
		delete(conn.active_send)
	}
	delete(conn.pending_writes)
	// Free the TLS session (and, with it, both BIOs) + cancel any handshake timer. OUTSIDE the
	// ZC-pin guard above (which only forgoes active_send): the SSL is never kernel-pinned, so it
	// must always be freed. No-op on a plaintext conn.
	tls_server_free_conn(conn)
	free(conn)
}

// net_close_conn_proactor: mark closing once, wake any op pending on an idle peer via
// shutdown(SHUT_RDWR) (cancel_op alone is best-effort), cancel for promptness, then maybe_free
// (finalizes immediately if no op is in flight — e.g. after a peer EOF). had_error is sticky.
net_close_conn_proactor :: proc(conn: ^Net_Connection, had_error: bool) {
	if had_error do conn.had_error = true // sticky, BEFORE the idempotency guard
	if conn.closing do return
	conn.closing = true
	// Remove from the -ENOBUFS starved list FIRST (lifetime safety: a later recycle must never
	// re-arm/walk a conn that maybe_free is about to free).
	if conn.recv_starved {
		if state := get_state_from_ctx(conn.ctx); state != nil do net_unpark(state, conn)
	}
	linux.shutdown(linux.Fd(conn.fd), .RDWR)
	eventloop.cancel_op(conn.loop, conn.recv_op)
	eventloop.cancel_op(conn.loop, conn.send_op)
	net_maybe_free(conn)
}

// conn_read_cb drains the socket (edge-triggered: read until EAGAIN), delivering each
// chunk to on_data. EOF (recv==0) fires on_end then closes; a read error fires on_error
// then closes. A handler may close the socket synchronously, so after every emit we bail
// if conn.closing — safe because net_close_conn defers the actual free. Loop thread.
conn_read_cb :: proc(loop: ^eventloop.Loop, user_data: rawptr) {
	conn := cast(^Net_Connection)user_data
	// read_done guard: on a TLS conn the EOF is detected INSIDE the state machine (a close_notify
	// arrives as n>0 ciphertext, SSL_read → ZERO_RETURN → on_end), not via the n==0 branch below, so
	// without this guard the peer's subsequent FIN would re-enter here and fire 'end' a second time.
	if conn == nil || conn.closing || conn.read_done do return
	buf: [NET_READ_CHUNK]byte
	for {
		n, recv_err := linux.recv(linux.Fd(conn.fd), buf[:], {})
		if recv_err == .EINTR do continue // interrupted by a signal — retry, not fatal
		if recv_err == .EAGAIN do return // no more data buffered — wait for the next event
		if recv_err != .NONE {
			net_emit_error(conn, "read error")
			net_close_conn(conn, true)
			return
		}
		if n == 0 { 	// peer half-closed (read EOF)
			// Stop the read watcher (EOF is persistent — it would re-fire forever) and
			// fire 'end'. Do NOT close here: this is a true half-close. The peer is done
			// sending, but the write side stays open so the app can still write (an HTTP
			// server writing its response after the client's request FIN). The connection
			// closes only when the app calls socket.end()/destroy() — the 'end' consumer
			// decides. Any in-flight (backpressured) write keeps draining via conn.writing.
			conn.read_done = true
			eventloop.unwatch_fd(conn.loop, &conn.watcher)
			net_emit(conn.ctx, conn.on_end, nil, 0)
			return
		}
		if conn.tls {
			// Feed ciphertext to the TLS state machine (decrypts + emits plaintext on_data, drains
			// any ciphertext via net_flush). Then honor the same closing/backpressure gates below.
			tls_server_on_ciphertext(conn, buf[:n])
		} else {
			// Copy out of the transient stack buffer into a JSC-owned Uint8Array (no-copy
			// handoff frees copy_buf on GC), mirroring fetch_deliver_chunk.
			copy_buf := make([]byte, n, context.allocator)
			copy(copy_buf, buf[:n])
			arg := make_uint8_array(conn.ctx, copy_buf)
			net_emit(conn.ctx, conn.on_data, &arg, 1)
		}
		if conn.closing do return // a data handler closed the socket
		if conn.read_done {
			// TLS close_notify surfaced as a clean EOF inside the state machine (on_end already
			// fired). Unwatch like the n==0 branch so the peer's FIN can't re-fire and double 'end'.
			eventloop.unwatch_fd(conn.loop, &conn.watcher)
			return
		}
		if conn.writing do return // a data handler wrote and hit backpressure — pause reads
	}
}

// --- writes / backpressure ---------------------------------------------------

// net_write_cb(connId, data) -> bool. Queues `data` (a Uint8Array/Buffer) and tries to
// flush. Returns false when bytes remain buffered (Node's write() backpressure signal).
net_write_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 2 do return jsc.JSValueMakeBoolean(ctx, true)
	args := arguments[:int(argument_count)]
	conn := net_get_conn(ctx, args[0])
	if conn == nil || conn.closing do return jsc.JSValueMakeBoolean(ctx, false)

	if net_is_proactor(conn) {
		// Hold a lifetime reference for the call: net_proactor_kick_send can fail a submit and
		// synchronously close — and, if no op were in flight, free — the conn; the guard keeps it
		// alive until we have read its state and computed the return (mirrors a completion's ref).
		conn.inflight += 1
		defer net_op_finished(conn)
		if conn.tls {
			// SSL_write the plaintext; tls_server_write drains the resulting ciphertext into
			// pending_writes and kicks the send. The backpressure gate below measures buffered
			// CIPHERTEXT (net_proactor_buffered), identical to the plaintext path.
			if view, ok := typed_array_view(ctx, args[1]); ok && len(view) > 0 {
				if !tls_server_write(conn, view) do return jsc.JSValueMakeBoolean(ctx, false)
			}
		} else {
			if view, ok := typed_array_view(ctx, args[1]); ok && len(view) > 0 {
				append(&conn.pending_writes, ..view)
			}
			net_proactor_kick_send(conn)
		}
		if conn.closing do return jsc.JSValueMakeBoolean(ctx, false)
		if net_proactor_buffered(conn) >= NET_WRITE_HWM {
			conn.want_drain = true // backpressure (Node's write()==false); a 'drain' is owed
			net_maybe_pause_multishot(conn) // a write from outside on_data can backpressure too
			return jsc.JSValueMakeBoolean(ctx, false)
		}
		return jsc.JSValueMakeBoolean(ctx, true)
	}

	if conn.tls {
		// SSL_write + pump (tls_pump_wbio drains ciphertext into write_queue and runs net_flush,
		// which sets conn.writing on backpressure).
		if view, ok := typed_array_view(ctx, args[1]); ok && len(view) > 0 {
			if !tls_server_write(conn, view) do return jsc.JSValueMakeBoolean(ctx, false)
		}
		backpressured := conn.writing
		if backpressured {
			conn.want_drain = true
		} else if !conn.closing && !conn.read_done {
			// The queue drained via THIS write (not conn_write_cb). If a prior write had paused the
			// decrypt loop with records still in the rbio, resume it now — no recv will arrive to
			// drive the leftover (it's in userspace). No-op when nothing is buffered.
			tls_server_pump_reads(conn)
		}
		return jsc.JSValueMakeBoolean(ctx, b32(!backpressured))
	}

	if view, ok := typed_array_view(ctx, args[1]); ok && len(view) > 0 {
		net_compact_write_queue(conn) // drop the sent prefix so backpressure doesn't retain dead bytes
		append(&conn.write_queue, ..view)
	}
	backpressured := net_flush(conn)
	if backpressured do conn.want_drain = true // owe a 'drain' once the queue empties
	return jsc.JSValueMakeBoolean(ctx, b32(!backpressured))
}

// net_compact_write_queue drops the already-sent prefix [0:write_off] from the readiness write
// queue so sustained backpressure (repeated writes / TLS pumps while write_off > 0) doesn't retain
// dead bytes until a full drain. copy is memmove-safe for the overlap; no-op when nothing was sent.
net_compact_write_queue :: proc(conn: ^Net_Connection) {
	if conn.write_off <= 0 do return
	n := copy(conn.write_queue[:], conn.write_queue[conn.write_off:])
	resize(&conn.write_queue, n)
	conn.write_off = 0
}

// net_flush writes as much of write_queue as the kernel accepts. On EAGAIN it arms the
// .Write watcher and reports backpressure; on full drain it restores the .Read watcher
// and, if end() was requested, closes. Returns whether bytes remain buffered.
net_flush :: proc(conn: ^Net_Connection) -> (backpressured: bool) {
	// Send from write_off (the already-sent prefix) rather than compacting after each partial send: a
	// large write draining over many writable callbacks is then O(total bytes), not O(N^2). The prefix
	// is released on full drain (clear below) or dropped when a new write arrives (net_write_cb).
	for conn.write_off < len(conn.write_queue) {
		sent, send_err := linux.send(linux.Fd(conn.fd), conn.write_queue[conn.write_off:], {.NOSIGNAL})
		if send_err == .EINTR do continue // interrupted by a signal — retry, not fatal
		if send_err == .EAGAIN {
			net_set_mode(conn, .Write) // wait for writability, then conn_write_cb drains
			return true
		}
		if send_err != .NONE {
			net_emit_error(conn, "write error")
			net_close_conn(conn, true)
			return true
		}
		if sent <= 0 {
			net_set_mode(conn, .Write) // no progress this time — wait for the next writable event
			return true
		}
		conn.write_off += sent
	}
	clear(&conn.write_queue) // fully drained
	conn.write_off = 0
	// Drained. Restore read interest only if the read side is still open; after a read
	// EOF (read_done) the socket is write-only and about to close.
	if conn.writing && !conn.read_done do net_set_mode(conn, .Read)
	// Fire the owed 'drain' (readiness parity with the proactor path) so a JS writer that
	// stopped on write()==false resumes. Reentrancy-safe: clear before emit (the listener may
	// write again — re-arming want_drain — or destroy()), then bail if it closed us.
	if conn.want_drain {
		conn.want_drain = false
		net_emit(conn.ctx, conn.on_drain, nil, 0)
		if conn.closing do return false
	}
	if conn.end_after_drain do net_close_conn(conn, false)
	return false
}

// conn_write_cb fires when a backpressured socket becomes writable again. Loop thread.
conn_write_cb :: proc(loop: ^eventloop.Loop, user_data: rawptr) {
	conn := cast(^Net_Connection)user_data
	if conn == nil || conn.closing do return
	net_flush(conn)
	// Readiness TLS: once the write fully drains (reads resume — net_flush restored .Read, so
	// conn.writing is clear), decrypt+emit any plaintext that paused in the rbio under backpressure.
	// Done AFTER net_flush returns (not inside it) so the pump's on_data → write → net_flush is a
	// fresh top-level call, never a nested re-entry into the flush we're in.
	if conn.tls && !conn.closing && !conn.writing && !conn.read_done {
		tls_server_pump_reads(conn)
	}
}

// net_set_mode flips the connection watcher between read and write interest (the reactor
// watches one direction at a time). Mirrors fetch_set_watch_mode: unwatch, retarget,
// rewatch. Pausing reads while draining a blocked write is also correct backpressure.
net_set_mode :: proc(conn: ^Net_Connection, mode: eventloop.Poll_Mode) {
	if conn.closing do return
	eventloop.unwatch_fd(conn.loop, &conn.watcher)
	conn.watcher.mode = mode
	conn.watcher.callback = mode == .Write ? conn_write_cb : conn_read_cb
	eventloop.watch_fd(conn.loop, &conn.watcher)
	conn.writing = mode == .Write
}

// net_end_cb(connId): half of socket.end() — flush whatever is queued, then close once
// drained. (M1 closes both directions on end rather than a true SHUT_WR half-close.)
net_end_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 do return jsc.JSValueMakeUndefined(ctx)
	conn := net_get_conn(ctx, arguments[0])
	if conn == nil || conn.closing do return jsc.JSValueMakeUndefined(ctx)
	conn.end_after_drain = true
	if net_is_proactor(conn) {
		// Guarded like net_write_cb: kick / close below may free the conn otherwise.
		conn.inflight += 1
		defer net_op_finished(conn)
		// TLS: queue a close_notify (SSL_shutdown → pump) before draining; the close_notify's send
		// keeps send_op live so the close-if-empty check below defers to on_send_complete. A
		// still-handshaking conn has no session — begin_close no-ops and we hard-close immediately.
		if conn.tls do tls_server_begin_close(conn)
		else do net_proactor_kick_send(conn)
		// Nothing left to drain → close now; otherwise on_send_complete closes once drained.
		if !conn.closing &&
		   conn.send_op == eventloop.OP_ID_INVALID &&
		   len(conn.pending_writes) == 0 {
			net_close_conn(conn, false)
		}
		return jsc.JSValueMakeUndefined(ctx)
	}
	// Readiness: begin_close queues a close_notify (a no-op while still handshaking); net_flush then
	// drains whatever is queued and, on full drain, honors end_after_drain — so a plain conn, a
	// handshaking TLS conn (nothing to send → closes now), and an established TLS conn all converge.
	if conn.tls do tls_server_begin_close(conn)
	if !conn.closing do net_flush(conn)
	return jsc.JSValueMakeUndefined(ctx)
}

// net_close_cb(connId): destroy a socket immediately (Node socket.destroy()).
net_close_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 do return jsc.JSValueMakeUndefined(ctx)
	if conn := net_get_conn(ctx, arguments[0]); conn != nil do net_close_conn(conn, false)
	return jsc.JSValueMakeUndefined(ctx)
}

// net_close_server_cb(serverId): stop accepting; existing connections live on (Node
// server.close semantics).
net_close_server_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 do return jsc.JSValueMakeUndefined(ctx)
	if server := net_get_server(ctx, arguments[0]); server != nil do net_close_server(server)
	return jsc.JSValueMakeUndefined(ctx)
}

// net_server_port_cb(serverId) -> number. The actual bound port (so listen(0) works).
net_server_port_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 do return jsc.JSValueMakeNumber(ctx, 0)
	server := net_get_server(ctx, arguments[0])
	if server == nil do return jsc.JSValueMakeNumber(ctx, 0)
	addr: linux.Sock_Addr_Any
	if linux.getsockname(linux.Fd(server.fd), &addr) != .NONE do return jsc.JSValueMakeNumber(ctx, 0)
	return jsc.JSValueMakeNumber(ctx, f64(u16(addr.port)))
}

// --- teardown helpers --------------------------------------------------------

// net_close_conn tears a connection down once: unwatch, close fd, fire 'close', release
// the protected handlers, drop it from the registry, and DEFER the struct free to the
// next tick (so an in-flight read/write callback can still read conn.closing safely).
// Idempotent. Loop thread.
net_close_conn :: proc(conn: ^Net_Connection, had_error: bool) {
	if conn == nil do return
	if net_is_proactor(conn) {
		net_close_conn_proactor(conn, had_error)
		return
	}
	if conn.closing do return
	conn.closing = true
	eventloop.unwatch_fd(conn.loop, &conn.watcher) // idempotent if never armed
	linux.close(linux.Fd(conn.fd))

	had := jsc.JSValueMakeBoolean(conn.ctx, b32(had_error))
	net_emit(conn.ctx, conn.on_close, &had, 1)
	net_unprotect(conn.ctx, conn.on_data)
	net_unprotect(conn.ctx, conn.on_end)
	net_unprotect(conn.ctx, conn.on_close)
	net_unprotect(conn.ctx, conn.on_error)
	net_unprotect(conn.ctx, conn.on_drain) // net.js always registers onDrain, even on readiness
	net_unprotect(conn.ctx, conn.on_connect) // closed mid-connect: the success cb never fired
	conn.on_data, conn.on_end, conn.on_close, conn.on_error, conn.on_drain, conn.on_connect =
		nil, nil, nil, nil, nil, nil

	if state := get_state_from_ctx(conn.ctx); state != nil {
		delete_key(&state.net_conns, conn.id)
		net_drain_check_complete(state, conn.loop) // readiness path: drain promptly on the last conn close
	}
	eventloop.async_begin(conn.loop)
	eventloop.post_async(conn.loop, net_conn_free_cb, conn)
}

net_conn_free_cb :: proc(loop: ^eventloop.Loop, user_data: rawptr) {
	context = runtime.default_context() // free with the same heap net_accept_cb/proc"c" allocated under
	conn := cast(^Net_Connection)user_data
	delete(conn.connect_label)
	delete(conn.write_queue)
	tls_server_free_conn(conn) // free SSL/BIOs + cancel handshake timer (no-op on a plaintext conn)
	free(conn)
}

// net_close_server stops accepting and frees the listener (deferred, since a 'connection'
// handler may close the server from inside net_accept_cb). Existing connections are left
// running, exactly like Node's server.close().
net_close_server :: proc(server: ^Net_Server) {
	if server == nil || server.closing do return
	server.closing = true
	eventloop.unwatch_fd(server.loop, &server.watcher)
	linux.close(linux.Fd(server.fd))
	net_unprotect(server.ctx, server.on_connection)
	server.on_connection = nil
	// Free the per-listener SSL_CTX (unlike the client's process-global g_tls_ctx). Existing TLS
	// connections keep their own SSL (per-conn, freed at their own teardown); SSL_CTX is refcounted,
	// so freeing it here while conns still hold SSL_new references is safe.
	if server.tls {
		tls_server_ctx_free(cast(SSL_CTX)server.tls_ctx)
		server.tls = false
		server.tls_ctx = nil
	}
	if state := get_state_from_ctx(server.ctx); state != nil do delete_key(&state.net_servers, server.id)
	eventloop.async_begin(server.loop)
	eventloop.post_async(server.loop, net_server_free_cb, server)
}

net_server_free_cb :: proc(loop: ^eventloop.Loop, user_data: rawptr) {
	free(cast(^Net_Server)user_data)
}

// net_shutdown_active closes every live server and connection while the loop/context are
// still alive, WITHOUT invoking JS 'close' (eval is already returning). Called from eval's
// pre-destroy teardown, mirroring fetch_shutdown_active. The deferred frees it posts are
// dropped with the async_queue at eventloop.destroy (their pointers never dereferenced).
// NET_DRAIN_TIMEOUT_MS bounds the graceful-drain window: once stop is requested the loop stops
// accepting and lets in-flight connections finish, but no longer than this, after which the deferred
// hard teardown (net_shutdown_active) resets whatever remains. (A fixed bound for v1; configurable
// later — design §9.)
NET_DRAIN_TIMEOUT_MS :: 10_000

// net_drain_begin is the loop's Shutdown_Hook (registered per-eval, Linux only). It runs ONCE on the
// loop thread the first time a stop is observed: stop accepting (close every listener), then let
// in-flight connections finish. force_exit is flipped when the last connection closes (net_maybe_free)
// or the drain timeout fires — at which point run() returns and the deferred net_shutdown_active resets
// the rest. No JS runs here (the process is exiting); listeners are closed without firing 'close'.
net_drain_begin :: proc(loop: ^eventloop.Loop, user_data: rawptr) {
	context = runtime.default_context()
	state := cast(^Runtime_State)user_data
	if state == nil {
		eventloop.begin_force_exit(loop)
		return
	}
	state.draining = true
	// Stop accepting: unwatch + close each listener fd. Leave the Net_Server in the map — the final
	// net_shutdown_active frees it (it skips already-closing servers, so no double close).
	for _, server in state.net_servers {
		if server.closing do continue
		server.closing = true
		eventloop.unwatch_fd(server.loop, &server.watcher)
		linux.close(linux.Fd(server.fd))
		net_unprotect(server.ctx, server.on_connection)
	}
	// Nothing in flight -> exit now; otherwise let connections drain, bounded by the timeout.
	if len(state.net_conns) == 0 {
		eventloop.begin_force_exit(loop)
		return
	}
	state.drain_timer = eventloop.set_timeout(loop, net_drain_timeout, NET_DRAIN_TIMEOUT_MS, state)
}

// net_drain_check_complete: during a graceful drain, if this was the last in-flight connection, the
// drain is done — cancel the bounded-drain timeout and force the loop to exit (run() returns and the
// deferred teardown runs). Called from BOTH connection free sites — net_maybe_free (proactor) and
// net_close_conn (readiness) — so a readiness-mode server drains promptly instead of always waiting the
// full timeout. loop outlives the connection, so it is safe to touch here.
net_drain_check_complete :: proc(state: ^Runtime_State, loop: ^eventloop.Loop) {
	if state == nil || !state.draining || len(state.net_conns) != 0 do return
	if state.drain_timer != 0 {
		eventloop.clear_timeout(loop, state.drain_timer)
		state.drain_timer = 0
	}
	eventloop.begin_force_exit(loop)
}

@(private = "file")
net_drain_timeout :: proc(loop: ^eventloop.Loop, user_data: rawptr) {
	state := cast(^Runtime_State)user_data
	if state != nil do state.drain_timer = 0 // fired; nothing left to cancel
	eventloop.begin_force_exit(loop)
}

net_shutdown_active :: proc(state: ^Runtime_State) {
	if state == nil do return
	context = runtime.default_context() // alloc/free conns + buffers on the default heap (see net_maybe_free)
	// Iterated DIRECTLY, not through a snapshot. net_maybe_free deletes the freed
	// proactor conn from net_conns, and Odin documents that as safe:
	// base/runtime/core_builtin.odin at delete_key — "It is safe to use
	// `delete_key` while iterating a map"; erase is tombstone-only and relocates
	// nothing. Only INSERTING during a range can resize and skip elements, and the
	// only two inserts into net_conns are the accept and connect paths
	// (net_accept_cb / net_connect_cb), neither of which is reachable from this
	// body — teardown runs no JS and accepts nothing.
	for _, conn in state.net_conns {
		if net_is_proactor(conn) {
			// ALWAYS silence + unprotect the proactor conn (no JS during teardown), whether it is
			// freshly closing or was ALREADY closing with a live op — otherwise that op's later
			// Op_Dispose reaches net_maybe_free with silent_close==false and fires the JS 'close'
			// mid-destroy. Clearing the handlers also makes maybe_free's unprotect a no-op.
			conn.silent_close = true
			net_unprotect(conn.ctx, conn.on_data)
			net_unprotect(conn.ctx, conn.on_end)
			net_unprotect(conn.ctx, conn.on_close)
			net_unprotect(conn.ctx, conn.on_error)
			net_unprotect(conn.ctx, conn.on_drain)
			conn.on_data, conn.on_end, conn.on_close, conn.on_error, conn.on_drain =
				nil, nil, nil, nil, nil
			if conn.recv_starved {
				conn.recv_starved = false // the whole starved list is cleared after this loop
				eventloop.async_cancel(conn.loop) // balance the parked liveness ref
			}
			if !conn.closing {
				// Not yet closing: wake any op pending on an idle peer + cancel for promptness.
				conn.closing = true
				linux.shutdown(linux.Fd(conn.fd), .RDWR)
				eventloop.cancel_op(conn.loop, conn.recv_op)
				eventloop.cancel_op(conn.loop, conn.send_op)
			}
			// Cancel an armed handshake timer NOW (loop still alive) so a deferred Op_Dispose free
			// during eventloop.destroy doesn't clear_timeout against a torn-down timer heap.
			if conn.handshake_timer != 0 {
				eventloop.clear_timeout(conn.loop, conn.handshake_timer)
				conn.handshake_timer = 0
			}
			// Zero-inflight (e.g. post-EOF, no op/disposer) finalizes now; a live-op conn is a
			// no-op here and is freed by its Op_Dispose during eventloop.destroy, which the
			// deferred teardown runs BEFORE destroy_runtime_state deletes net_conns (so the
			// disposer's delete_key stays valid).
			net_maybe_free(conn)
			continue
		}
		if conn.closing do continue // readiness: already torn down; its deferred free is dropped at destroy
		conn.closing = true
		eventloop.unwatch_fd(conn.loop, &conn.watcher)
		linux.close(linux.Fd(conn.fd))
		net_unprotect(conn.ctx, conn.on_data)
		net_unprotect(conn.ctx, conn.on_end)
		net_unprotect(conn.ctx, conn.on_close)
		net_unprotect(conn.ctx, conn.on_error)
		net_unprotect(conn.ctx, conn.on_drain)
		delete(conn.write_queue)
		tls_server_free_conn(conn) // free SSL/BIOs + cancel handshake timer (no-op on a plaintext conn)
		free(conn)
	}
	clear(&state.net_conns) // live-op proactor conns (if any) are freed by their Op_Dispose
	state.net_starved_head, state.net_starved_tail = nil, nil // FIFO emptied (conns freed above / by disposer)
	for _, server in state.net_servers {
		// Free the per-listener SSL_CTX for every server about to be cleared (TLS or not, closing or
		// not) so a drain_begin-closed listener doesn't leak its context at teardown.
		if server.tls {
			tls_server_ctx_free(cast(SSL_CTX)server.tls_ctx)
			server.tls_ctx = nil
		}
		// COUPLING: net_drain_begin (graceful drain) may already have unwatched + closed this listener
		// and set closing=true; skip it here to avoid a double unwatch/close. The two functions agree on
		// this flag — a listener is unwatched+closed exactly once, by whichever runs first.
		if server.closing do continue
		server.closing = true
		eventloop.unwatch_fd(server.loop, &server.watcher)
		linux.close(linux.Fd(server.fd))
		net_unprotect(server.ctx, server.on_connection)
		free(server)
	}
	clear(&state.net_servers)
}

// net_destroy_state releases the registry backing once everything is shut down.
net_destroy_state :: proc(state: ^Runtime_State) {
	if state == nil do return
	net_shutdown_active(state)
	delete(state.net_servers)
	delete(state.net_conns)
	// Free any TLS contexts still parked in the registry (createServer without a successful listen);
	// listened ones moved to their Net_Server and were freed in net_shutdown_active.
	for _, ctx_ptr in state.tls_server_ctxs do tls_server_ctx_free(cast(SSL_CTX)ctx_ptr)
	delete(state.tls_server_ctxs)
	// net_starved is an intrusive list (head/tail pointers, no backing allocation) — nothing to free.
}

// --- small helpers -----------------------------------------------------------

net_get_conn :: proc(ctx: jsc.JSContextRef, id_val: jsc.JSValueRef) -> ^Net_Connection {
	state := get_state_from_ctx(ctx)
	if state == nil do return nil
	id := u64(jsc.JSValueToNumber(ctx, id_val, nil))
	if conn, ok := state.net_conns[id]; ok do return conn
	return nil
}

net_get_server :: proc(ctx: jsc.JSContextRef, id_val: jsc.JSValueRef) -> ^Net_Server {
	state := get_state_from_ctx(ctx)
	if state == nil do return nil
	id := u64(jsc.JSValueToNumber(ctx, id_val, nil))
	if server, ok := state.net_servers[id]; ok do return server
	return nil
}

net_protect :: proc(ctx: jsc.JSContextRef, fn: jsc.JSObjectRef) {
	if fn != nil do jsc.JSValueProtect(ctx, cast(jsc.JSValueRef)fn)
}

net_unprotect :: proc(ctx: jsc.JSContextRef, fn: jsc.JSObjectRef) {
	if fn != nil do jsc.JSValueUnprotect(ctx, cast(jsc.JSValueRef)fn)
}

net_emit :: proc(
	ctx: jsc.JSContextRef,
	fn: jsc.JSObjectRef,
	args: [^]jsc.JSValueRef,
	argc: c.size_t,
) {
	if fn == nil do return
	exception: jsc.JSValueRef
	invoke_user_callback(ctx, fn, args, argc, &exception)
	if exception != nil {
		report_uncaught(ctx, exception)
		mark_async_failed(ctx)
	}
}

net_emit_error :: proc(conn: ^Net_Connection, message: string) {
	if conn.on_error == nil do return
	arg := js_string_value(conn.ctx, message)
	net_emit(conn.ctx, conn.on_error, &arg, 1)
}
