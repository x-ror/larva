#+build linux
package larva_http

import "base:runtime"
import "core:c"
import "core:net"
import "core:slice"
import "core:strings"
import "core:sys/linux"
import "core:time"
import cookie "lava:pkg/http/cookie"
import eventloop "lava:pkg/runtime/eventloop"
import pico "lava:pkg/runtime/picohttpparser"
import openssl "lava:pkg/tls"

// One HTTP/1.1 exchange per connection (`Connection: close`), redirects followed on a
// new connection. Connection reuse, HTTP/2 and client profiles come with stage 2
// (docs/LARVA.md decision 3).
//
// The runtime's fetch() (pkg/runtime/fetch*.odin) has its own transport and chunked
// decoder, bound to JS callbacks through Fetch_Request; this one is not, and is the one
// meant to stay. Moving fetch() onto it is stage-2 work.

// Bytes read from the socket per call.
@(private = "file")
READ_CHUNK :: 16 * 1024
// The most of a Content-Length body reserved before its bytes arrive.
@(private = "file")
INITIAL_BODY_RESERVE :: 64 * 1024
// A body under INLINE_DECODE_MAX bytes, encoded with one gzip, deflate or zstd, is decoded
// on the loop thread first, its output capped at INLINE_OUTPUT_MAX: the pool's round trip
// costs more than such a decode. A body that reaches the cap goes to the pool after all,
// from its original bytes. The stall budget the two bounds keep is about 30 us per body on
// the loop thread, three round trips, against 8-10 us saved on every small body.
//
// Measured on one machine (Linux x86-64, -o:speed); node's gzip/deflate level 6, brotli
// default, zstd -3; medians of 15 interleaved batches of 20, then the median of 5
// launches (3 for the long-window zstd). The round trip (decode_start to on_done, pool
// warm) cost 8-10 us more than inline at every size. HTML-like text of about 1 KiB in
// decodes to about 10 KiB: inline 4.2 us gzip, 6.3 deflate, 5.0 zstd, 5.2 br, against
// 13.7-15.0 pooled. That corpus is about 10:1 and fits the cap; at the 2 KiB input bound
// the cap holds only up to about 8:1. Markup more repetitive than that pays the capped
// attempt and then the pool: repetitive table markup at 12.9:1, 2047 bytes in, took 24.0 us
// against 17.8 us sent to the pool directly (perf review of these follow-ups, same method).
//
// The worst cases are bombs, zeros encoded small: gzip 1051 bytes in, deflate 1039, zstd
// 1067 (1042 with an 8 MiB window), br 1681. Uncapped they block for 1.2 ms (gzip, 1 MiB
// out), 1.4 ms (deflate, 1 MiB; slower than gzip on the same output), 16-29 ms (zstd,
// 32 MiB) and 116 ms (br, up to max_body). Capped at 16 KiB, reaching the cap took 25 us
// gzip, 29 us deflate and 11-13 us zstd; at 64 KiB, 87, 102 and 11 us, which is why the cap
// is 16 KiB. At the 2047-byte edge of the input bound the perf review measured 25 us gzip
// and 33 us deflate (42 us its slowest round): deflate sits at the budget and over it. br stays off the loop: a stream
// that declares a large window cost 4.7 ms before its first byte out, capped or not. A
// chain stays off too: every step is a pass and a codec of its own (two gzip steps took
// 29 us capped) and a chain may have ten. The input bound stays beside the cap because the
// cap counts output only: a body of empty deflate blocks produces nothing for its whole
// length, so without a bound on the input the loop thread would read all of it.
@(private = "file")
INLINE_DECODE_MAX :: 2 * 1024
@(private = "file")
INLINE_OUTPUT_MAX :: 16 * 1024

@(private = "file")
State :: enum {
	Starting,
	Resolving,
	Connecting,
	Handshake,
	Writing,
	Reading_Head,
	Reading_Body,
	Decoding, // the body is a pool worker's until on_decoded
}

@(private = "file")
Body_Mode :: enum {
	None,
	Length,
	Chunked,
	Until_Close,
}

@(private = "file")
IO :: enum {
	Ok,
	Would_Block_Read,
	Would_Block_Write,
	Closed, // an orderly end: TCP EOF in the clear, or a TLS close_notify
	Unclean_EOF, // TLS without close_notify: no proof the peer meant to stop there
	Failed,
}

@(private = "file")
Transfer :: struct {
	loop:        ^eventloop.Loop,
	allocator:   runtime.Allocator,
	on_done:     Done_Proc,
	user_data:   rawptr,
	method:      string,
	headers:     [dynamic]Header,
	body:        []byte,
	max_body:    int,
	jar:         ^cookie.Jar, // borrowed from the Request; nil for none
	url_text:    string,
	url:         Url,
	state:       State,
	addrs:       [2]net.Address,
	addr_count:  int,
	addr_index:  int,
	dns:         ^DNS_Job,
	decode:      ^Decode_Job,
	fd:          linux.Fd,
	watcher:     eventloop.IO_Watcher,
	ssl:         openssl.SSL,
	out:         [dynamic]byte,
	out_off:     int,
	head:        [dynamic]byte,
	head_parsed: int, // bytes of `head` picohttpparser has already scanned
	mode:        Body_Mode,
	remaining:   int,
	chunked:     Chunked,
	resp:        Response,
	timer:       eventloop.Timer_ID,
	start_id:    eventloop.Timer_ID, // the immediate that runs begin; 0 once it has
	head_total:  int, // head bytes of this response, interim 1xx ones included
}

// transfer_start takes ownership of `url`. The work starts on the next loop turn, so
// on_done never runs inside fetch.
@(private)
transfer_start :: proc(
	loop: ^eventloop.Loop,
	req: Request,
	url: Url,
	on_done: Done_Proc,
	user_data: rawptr,
	allocator: runtime.Allocator,
) -> Error {
	context.allocator = allocator
	t := new(Transfer)
	t^ = {
		loop = loop,
		allocator = allocator,
		on_done = on_done,
		user_data = user_data,
		method = strings.clone(req.method if req.method != "" else "GET"),
		body = slice.clone(req.body),
		max_body = req.max_body_bytes if req.max_body_bytes > 0 else DEFAULT_MAX_BODY_BYTES,
		jar = req.cookie_jar,
		url_text = strings.clone(req.url),
		url = url,
		fd = -1,
		out = make([dynamic]byte),
		head = make([dynamic]byte),
		resp = {allocator = allocator, headers = make([dynamic]Header), body = make([dynamic]byte)},
	}
	t.headers = make([dynamic]Header, 0, len(req.headers))
	for &h in req.headers {
		append(&t.headers, Header{strings.clone(h.name), strings.clone(h.value)})
	}

	timeout := req.timeout_ms if req.timeout_ms > 0 else DEFAULT_TIMEOUT_MS
	// The timer is armed for the transfer's whole life, so its dispose is how a loop
	// destroyed under the transfer reaches it: on_loop_closed.
	t.timer = eventloop.set_timeout(loop, on_timeout, u64(timeout), t, on_loop_closed)

	// 0 only from a loop being destroyed: a fetch started from an on_done that destroy
	// runs. The loop has already run the dispose (finding no timer, it did nothing), so
	// the transfer is undone here and on_done will not run.
	if t.timer == 0 {
		delete(t.resp.headers)
		delete(t.resp.body)
		delete(t.url_text)
		transfer_free(t)
		return .Cancelled
	}

	// Timers run before immediates in a tick, so finish cancels this if the timeout
	// comes first.
	t.start_id = eventloop.set_immediate(loop, on_start, t)
	return .None
}

@(private = "file")
on_start :: proc(loop: ^eventloop.Loop, user_data: rawptr) {
	t := cast(^Transfer)user_data
	t.start_id = 0
	begin(t)
}

// begin opens a connection to t.url: straight away for an IP literal, after a pool
// lookup for a name.
@(private = "file")
begin :: proc(t: ^Transfer) {
	t.addr_count, t.addr_index = 0, 0

	if ip := net.parse_address(t.url.host); ip != nil {
		t.addrs[0], t.addr_count = ip, 1
		connect_next(t)
		return
	}

	t.state = .Resolving

	if !dns_lookup(t.loop, t.url.host, on_resolved, t, &t.dns) {
		finish(t, .DNS)
	}
}

@(private = "file")
on_resolved :: proc(user_data: rawptr, addrs: [2]net.Address, count: int) {
	t := cast(^Transfer)user_data
	t.dns = nil

	if count == 0 {
		finish(t, .DNS)
		return
	}

	t.addrs, t.addr_count = addrs, count
	connect_next(t)
}

// connect_next tries the next resolved address; out of addresses is a connect error.
@(private = "file")
connect_next :: proc(t: ^Transfer) {
	for t.addr_index < t.addr_count {
		a := t.addrs[t.addr_index]
		t.addr_index += 1
		_, is_v6 := a.(net.IP6_Address)
		fd, err := linux.socket(.INET6 if is_v6 else .INET, .STREAM, {.NONBLOCK, .CLOEXEC}, .TCP)

		if err != .NONE {
			continue
		}

		conn_err: linux.Errno
		switch ip in a {
		case net.IP4_Address:
			sa := linux.Sock_Addr_In {
				sin_family = .INET,
				sin_port   = u16be(t.url.port),
				sin_addr   = transmute([4]u8)ip,
			}
			conn_err = linux.connect(fd, &sa)
		case net.IP6_Address:
			sa := linux.Sock_Addr_In6 {
				sin6_family = .INET6,
				sin6_port   = u16be(t.url.port),
				sin6_addr   = transmute([16]u8)ip,
			}
			conn_err = linux.connect(fd, &sa)
		}

		if conn_err != .NONE && conn_err != .EINPROGRESS && conn_err != .EINTR {
			linux.close(fd)
			continue
		}

		t.fd = fd
		t.state = .Connecting

		if !watch(t, .Write) {
			finish(t, .Connect)
		}

		return
	}

	finish(t, .Connect)
}

@(private = "file")
watch :: proc(t: ^Transfer, mode: eventloop.Poll_Mode) -> bool {
	if t.watcher.watched {
		if t.watcher.mode == mode {
			return true
		}

		eventloop.unwatch_fd(t.loop, &t.watcher)
	}

	t.watcher.fd = uintptr(t.fd)
	t.watcher.mode = mode
	t.watcher.callback = on_io
	t.watcher.user_data = t
	return eventloop.watch_fd(t.loop, &t.watcher)
}

@(private = "file")
on_io :: proc(loop: ^eventloop.Loop, user_data: rawptr) {
	t := cast(^Transfer)user_data
	switch t.state {
	case .Starting, .Resolving, .Decoding:
	case .Connecting:
		so_error: i32
		_, opt_err := linux.getsockopt_base(t.fd, cast(int)linux.SOL_SOCKET, linux.Socket_Option.ERROR, &so_error)

		if opt_err != .NONE || so_error != 0 {
			close_conn(t)
			connect_next(t)
			return
		}

		if !t.url.https {
			start_write(t)
			return
		}

		t.ssl = openssl.tls_new_client(uintptr(t.fd), t.url.host)

		if t.ssl == nil {
			openssl.ERR_clear_error()
			finish(t, .TLS)
			return
		}

		t.state = .Handshake
		handshake(t)
	case .Handshake:
		handshake(t)
	case .Writing:
		write(t)
	case .Reading_Head, .Reading_Body:
		read(t)
	}
}

@(private = "file")
handshake :: proc(t: ^Transfer) {
	openssl.ERR_clear_error()
	ret := openssl.SSL_connect(t.ssl)

	if ret == 1 {
		start_write(t)
		return
	}

	switch openssl.SSL_get_error(t.ssl, ret) {
	case openssl.SSL_ERROR_WANT_READ:
		if !watch(t, .Read) {
			finish(t, .TLS)
		}
	case openssl.SSL_ERROR_WANT_WRITE:
		if !watch(t, .Write) {
			finish(t, .TLS)
		}
	case:
		openssl.ERR_clear_error()
		finish(t, .TLS)
	}
}

@(private = "file")
start_write :: proc(t: ^Transfer) {
	cookies: strings.Builder

	if t.jar != nil {
		cookies = strings.builder_make(t.allocator)
		now := time.to_unix_nanoseconds(time.now())
		cookie.cookie_header(t.jar, cookie_source(t.url), .Http, .Same_Site, now, &cookies)
	}

	build_request(&t.out, t.method, t.url, t.headers[:], t.body, strings.to_string(cookies))
	strings.builder_destroy(&cookies)
	t.out_off = 0
	t.state = .Writing
	write(t)
}

@(private = "file")
write :: proc(t: ^Transfer) {
	for t.out_off < len(t.out) {
		n, io := send(t, t.out[t.out_off:])
		switch io {
		case .Ok:
			t.out_off += n
		case .Would_Block_Write:
			if !watch(t, .Write) {
				finish(t, .Write)
			}

			return
		case .Would_Block_Read:
			if !watch(t, .Read) {
				finish(t, .Write)
			}

			return
		case .Closed, .Unclean_EOF, .Failed:
			finish(t, .Write)
			return
		}
	}

	t.state = .Reading_Head

	if !watch(t, .Read) {
		finish(t, .Read)
		return
	}

	read(t)
}

@(private = "file")
read :: proc(t: ^Transfer) {
	buf: [READ_CHUNK]byte = ---
	for {
		n, io := recv(t, buf[:])
		switch io {
		case .Ok:
			if !feed(t, buf[:n]) {
				return
			}
		case .Would_Block_Read:
			if !watch(t, .Read) {
				finish(t, .Read)
			}

			return
		case .Would_Block_Write:
			if !watch(t, .Write) {
				finish(t, .Read)
			}

			return
		case .Closed, .Unclean_EOF:
			on_eof(t, io == .Closed)
			return
		case .Failed:
			finish(t, .TLS if t.ssl != nil else .Read)
			return
		}
	}
}

@(private = "file")
send :: proc(t: ^Transfer, data: []byte) -> (n: int, io: IO) {
	if t.ssl != nil {
		openssl.ERR_clear_error()
		ret := openssl.SSL_write(t.ssl, raw_data(data), c.int(min(len(data), int(max(c.int)))))

		if ret > 0 {
			return int(ret), .Ok
		}

		return 0, ssl_io(t, ret)
	}

	sent, err := linux.send(t.fd, data, {.NOSIGNAL})
	#partial switch err {
	case .NONE:
		return sent, .Ok
	case .EAGAIN, .EINTR:
		return 0, .Would_Block_Write
	}

	return 0, .Failed
}

@(private = "file")
recv :: proc(t: ^Transfer, buf: []byte) -> (n: int, io: IO) {
	if t.ssl != nil {
		openssl.ERR_clear_error()
		ret := openssl.SSL_read(t.ssl, raw_data(buf), c.int(len(buf)))

		if ret > 0 {
			return int(ret), .Ok
		}

		return 0, ssl_io(t, ret)
	}

	got, err := linux.recv(t.fd, buf, {})
	#partial switch err {
	case .NONE:
		return got, .Closed if got == 0 else .Ok
	case .EAGAIN, .EINTR:
		return 0, .Would_Block_Read
	}

	return 0, .Failed
}

// ssl_io maps a failed SSL_read/SSL_write. A close_notify is an orderly end. A peer that
// closes TCP without one is common, but proves nothing: anyone on the path can forge the
// FIN, so on_eof accepts it only where the framing shows the body was complete. Anything
// else — a reset, a record that fails to authenticate — is a failure.
@(private = "file")
ssl_io :: proc(t: ^Transfer, ret: c.int) -> IO {
	e := openssl.SSL_get_error(t.ssl, ret)
	reason := openssl.err_get_reason(openssl.ERR_peek_error())
	openssl.ERR_clear_error()
	switch e {
	case openssl.SSL_ERROR_WANT_READ:
		return .Would_Block_Read
	case openssl.SSL_ERROR_WANT_WRITE:
		return .Would_Block_Write
	case openssl.SSL_ERROR_ZERO_RETURN:
		return .Closed
	case openssl.SSL_ERROR_SYSCALL:
		return .Unclean_EOF if ret == 0 else .Failed
	case openssl.SSL_ERROR_SSL:
		return .Unclean_EOF if reason == openssl.SSL_R_UNEXPECTED_EOF_WHILE_READING else .Failed
	}

	return .Failed
}

// feed takes response bytes. false means the transfer is finished (or redirected) and
// `t` must not be touched again by the caller. A head that arrives whole in one read,
// as most do, is parsed in place and never copied into t.head.
@(private = "file")
feed :: proc(t: ^Transfer, data: []byte) -> bool {
	if t.state == .Reading_Body {
		return feed_body(t, data)
	}

	buffered := len(t.head) > 0

	if buffered {
		append(&t.head, ..data)
	}

	buf := t.head[:] if buffered else data
	for {
		parsed: [pico.MAX_HEADERS]pico.Header = ---
		consumed, status, reason, count, result := pico.parse_response(buf, t.head_parsed, parsed[:])
		switch result {
		case .Partial:
			if len(buf) > MAX_HEAD_BYTES {
				finish(t, .Head_Too_Large)
				return false
			}

			if !buffered {
				append(&t.head, ..buf)
			}

			t.head_parsed = len(t.head)
			return true
		case .Error:
			finish(t, .Malformed_Response)
			return false
		case .Complete:
		}

		// Interim 1xx heads count too, so an endless stream of them is bounded.
		t.head_total += consumed

		if t.head_total > MAX_HEAD_BYTES {
			finish(t, .Head_Too_Large)
			return false
		}

		// RFC 9110 §15 defines 100..599. A 101 switches protocols, which this client never
		// asks for.
		if status < 100 || status > 599 || status == 101 {
			finish(t, .Malformed_Response)
			return false
		}

		// Interim responses (100 Continue, 103 Early Hints) precede the real one.
		if status < 200 {
			if buffered {
				remove_range(&t.head, 0, consumed)
				buf = t.head[:]
			} else {
				buf = buf[consumed:]
			}

			t.head_parsed = 0
			continue
		}

		return on_head(t, status, reason, parsed[:count], buf[consumed:])
	}
}

// on_head handles a complete head; `tail` is what followed it in the same bytes. A
// redirect is followed before anything is copied out of the head, unless the head has
// obs-fold lines, which have to be joined first.
@(private = "file")
on_head :: proc(t: ^Transfer, status: int, reason: string, headers: []pico.Header, tail: []byte) -> bool {
	folded := false
	for &h in headers {
		if h.name == "" {
			folded = true
			break
		}
	}

	// Before a redirect is followed, so the next hop already sends what this one set.
	// A folded head stores from its joined copy, below.
	if !folded {
		store_cookies(t, headers)
	}

	if !folded && is_redirect(status) {
		if location, ok := find_header(headers, "Location"); ok {
			redirect(t, status, location)
			return false
		}
	}

	context.allocator = t.allocator
	t.resp.status = status
	t.resp.reason = strings.clone(reason)

	if !copy_headers(t, headers) {
		finish(t, .Malformed_Response)
		return false
	}

	if folded {
		store_cookies(t, t.resp.headers[:])
	}

	if folded && is_redirect(status) {
		if location, ok := header(&t.resp, "Location"); ok {
			redirect(t, status, location)
			return false
		}
	}

	mode, length, framing_ok := body_framing(t, status)

	if !framing_ok {
		finish(t, .Malformed_Response)
		return false
	}

	if mode == .Length && length > t.max_body {
		finish(t, .Body_Too_Large)
		return false
	}

	t.mode, t.remaining = mode, length
	t.state = .Reading_Body

	if mode == .None || (mode == .Length && length == 0) {
		finish(t, .None)
		return false
	}

	if mode == .Length {
		// Not all of a large Content-Length up front: the server states it before
		// sending a byte.
		non_zero_reserve(&t.resp.body, min(length, INITIAL_BODY_RESERVE))
	}

	if !feed_body(t, tail) {
		return false
	}

	clear(&t.head)
	return true
}

// copy_headers clones the parsed headers into the response. An obs-fold line (empty
// name) continues the previous value; RFC 9112 §5.2 has a user agent join it with a
// space. A fold before any header is malformed.
@(private = "file")
copy_headers :: proc(t: ^Transfer, headers: []pico.Header) -> bool {
	context.allocator = t.allocator
	non_zero_reserve(&t.resp.headers, len(headers))
	for &h in headers {
		if h.name != "" {
			append(&t.resp.headers, Header{strings.clone(h.name), strings.clone(h.value)})
			continue
		}

		if len(t.resp.headers) == 0 {
			return false
		}

		prev := &t.resp.headers[len(t.resp.headers) - 1]
		joined := strings.concatenate({prev.value, " ", trim_ows(h.value)})
		delete(prev.value)
		prev.value = joined
	}

	return true
}

// body_framing applies RFC 9112 §6.3: no body for HEAD, 204 and 304; with
// Transfer-Encoding, chunked only when it is the final coding (of the last such
// header, the lines forming one list), else read to close; otherwise a Content-Length
// whose copies and list items all agree, digits only; else read to close.
@(private = "file")
body_framing :: proc(t: ^Transfer, status: int) -> (mode: Body_Mode, length: int, ok: bool) {
	if t.method == "HEAD" || status == 204 || status == 304 {
		return .None, 0, true
	}

	#reverse for &h in t.resp.headers {
		if !ascii_equal_fold(h.name, "Transfer-Encoding") {
			continue
		}

		last := h.value

		if i := strings.last_index_byte(last, ','); i >= 0 {
			last = last[i + 1:]
		}

		return .Chunked if ascii_equal_fold(trim_ows(last), "chunked") else .Until_Close, 0, true
	}

	found := false
	for &h in t.resp.headers {
		if !ascii_equal_fold(h.name, "Content-Length") {
			continue
		}

		// RFC 9110 §8.6: `42, 42`, as a proxy may join repeated headers, is one length.
		values := h.value
		for part in strings.split_iterator(&values, ",") {
			n, num_ok := parse_length(trim_ows(part))

			if !num_ok || (found && n != length) {
				return .None, 0, false
			}

			found, length = true, n
		}
	}

	return .Length if found else .Until_Close, length, true
}

// parse_length takes digits only, in one pass with an overflow check: strconv also
// accepts a sign, `_` and a base prefix.
@(private = "file")
parse_length :: proc(s: string) -> (n: int, ok: bool) {
	if s == "" {
		return 0, false
	}

	for b in transmute([]byte)s {
		if b < '0' || b > '9' {
			return 0, false
		}

		d := int(b - '0')

		if n > (max(int) - d) / 10 {
			return 0, false
		}

		n = n * 10 + d
	}

	return n, true
}

@(private = "file")
feed_body :: proc(t: ^Transfer, data: []byte) -> bool {
	switch t.mode {
	case .None:
	case .Length:
		n := min(len(data), t.remaining)
		append(&t.resp.body, ..data[:n])
		t.remaining -= n
	case .Chunked:
		if !chunked_feed(&t.chunked, data, &t.resp.body) {
			finish(t, .Malformed_Response)
			return false
		}
	case .Until_Close:
		// Checked before the append: past the cap, growing the buffer would double it.
		if len(data) > t.max_body - len(t.resp.body) {
			finish(t, .Body_Too_Large)
			return false
		}

		append(&t.resp.body, ..data)
	}

	if len(t.resp.body) > t.max_body {
		finish(t, .Body_Too_Large)
		return false
	}

	if (t.mode == .Length && t.remaining == 0) || (t.mode == .Chunked && t.chunked.state == .Done) {
		finish(t, .None)
		return false
	}

	return true
}

@(private = "file")
on_eof :: proc(t: ^Transfer, clean: bool) {
	switch {
	case t.state == .Reading_Head:
		finish(t, .Read if len(t.head) == 0 else .Malformed_Response)
	case t.mode == .Until_Close:
		// The connection's end is the body's end, so only a proven end will do.
		finish(t, .None if clean else .TLS)
	case:
		// Fewer bytes than Content-Length, or chunks without the last one.
		finish(t, .Read)
	}
}

// store_cookies hands every Set-Cookie of a response head to the transfer's jar, in
// order, as the HTTP stack (HttpOnly allowed) of a navigation the user typed: same-site
// with its own URL, so every SameSite value stores.
//
// Deviates: Chrome treats a navigation whose redirect chain crossed sites as cross-site
// for SameSite=Strict cookies; each hop here is same-site with itself. Not recorded (the
// fixture server has one site); stage 2's navigation work owns it.
@(private = "file")
store_cookies :: proc(t: ^Transfer, headers: []pico.Header) {
	if t.jar == nil {
		return
	}

	now := time.to_unix_nanoseconds(time.now())
	source := cookie_source(t.url)
	for &h in headers {
		if ascii_equal_fold(h.name, "Set-Cookie") {
			cookie.set_cookie(t.jar, source, h.value, .Http, .Same_Site, now)
		}
	}
}

// cookie_source is the jar's view of a URL: its host, its path without the query, and
// whether it is a secure context.
@(private = "file")
cookie_source :: proc(u: Url) -> cookie.Source {
	return {
		secure = cookie.is_potentially_trustworthy(u.https, u.host),
		host = u.host,
		path = strings.truncate_to_byte(u.target, '?'),
	}
}

@(private = "file")
is_redirect :: proc(status: int) -> bool {
	switch status {
	case 301, 302, 303, 307, 308:
		return true
	}

	return false
}

// redirect follows `location` on a fresh connection, as the Fetch standard does: a 303
// becomes a GET, and so does a POST answered with 301 or 302, dropping the body and its
// headers; 307 and 308 keep both. Credentials go no further than their origin.
@(private = "file")
redirect :: proc(t: ^Transfer, status: int, location: string) {
	context.allocator = t.allocator

	if t.resp.redirects >= MAX_REDIRECTS {
		finish(t, .Too_Many_Redirects)
		return
	}

	next := resolve_url(t.url_text, location)
	url, err := parse_url(next)

	if err != .None {
		delete(next)
		finish(t, err)
		return
	}

	if (status == 303 && t.method != "HEAD") || ((status == 301 || status == 302) && t.method == "POST") {
		delete(t.method)
		t.method = strings.clone("GET")
		delete(t.body)
		t.body = nil
		drop_headers(&t.headers, body_headers())
	}

	if !same_origin(t.url, url) {
		drop_headers(&t.headers, credential_headers())
	}

	close_conn(t)
	reset_response(t)
	t.resp.redirects += 1
	url_destroy(&t.url)
	delete(t.url_text)
	t.url, t.url_text = url, next
	begin(t)
}

@(private = "file")
reset_response :: proc(t: ^Transfer) {
	context.allocator = t.allocator
	for &h in t.resp.headers {
		delete(h.name)
		delete(h.value)
	}

	clear(&t.resp.headers)
	clear(&t.resp.body)
	delete(t.resp.reason)
	t.resp.reason = ""
	t.resp.status = 0
	clear(&t.head)
	t.head_parsed = 0
	t.head_total = 0
	t.chunked = {}
	t.mode = .None
	t.remaining = 0
}

@(private = "file")
close_conn :: proc(t: ^Transfer) {
	if t.watcher.watched {
		eventloop.unwatch_fd(t.loop, &t.watcher)
	}

	t.watcher = {}

	if t.ssl != nil {
		openssl.SSL_free(t.ssl)
		t.ssl = nil
	}

	if t.fd >= 0 {
		linux.close(t.fd)
		t.fd = -1
	}
}

@(private = "file")
on_timeout :: proc(loop: ^eventloop.Loop, user_data: rawptr) {
	t := cast(^Transfer)user_data
	t.timer = 0
	finish(t, .Timeout)
}

// decodes_inline says whether a body of `n` encoded bytes is first decoded on the loop
// thread: see INLINE_DECODE_MAX.
@(private = "file")
decodes_inline :: proc(chain: Chain, n: int) -> bool {
	return n < INLINE_DECODE_MAX && chain.n == 1 && chain.codings[0] in Codings{.Gzip, .Deflate, .Zstd}
}

// on_loop_closed finishes a transfer whose loop is being destroyed under it, with
// .Cancelled: it is the dispose of the transfer's timer, which eventloop.close_begin runs
// for a timer still armed. No more ticks will come, so the immediate that would start the
// transfer is gone with them. A pool job the transfer was waiting for has already been
// settled by then (close_begin closes the pool client first), and its cancel or dispose cleared t.dns or
// t.decode, so finish does not reach into freed memory.
//
// A zero t.timer means finish itself is clearing the timer: nothing to do.
@(private = "file")
on_loop_closed :: proc(user_data: rawptr) {
	t := cast(^Transfer)user_data

	if t.timer == 0 {
		return
	}

	t.timer = 0
	t.start_id = 0
	finish(t, .Cancelled)
}

// on_decoded takes the decoded body back from the pool and finishes the transfer with it.
@(private = "file")
on_decoded :: proc(user_data: rawptr, body: [dynamic]byte, err: Error) {
	t := cast(^Transfer)user_data
	t.decode = nil
	delete(t.resp.body)
	t.resp.body = body
	finish(t, err)
}

// finish hands the response to the caller and frees the transfer, or first hands a body
// that needs decoding to the pool, after which on_decoded calls it again. Either way
// callers return right after it. On an error the response keeps only the error and the
// URL.
@(private = "file")
finish :: proc(t: ^Transfer, err: Error) {
	context.allocator = t.allocator
	err := err
	close_conn(t)

	// Only a final response gets here with a body: a redirect's is dropped unread. What
	// needs no decoding, or fails on its headers alone, is settled here; the rest goes to
	// the pool with the timer still armed, and comes back through on_decoded.
	if err == .None && t.state != .Decoding {
		chain: Chain
		chain, err = plan_decoding(t.resp.headers[:], t.url)

		if err == .None && chain.n > 0 && len(t.resp.body) > 0 {
			decoded := false

			if decodes_inline(chain, len(t.resp.body)) {
				// A single step that fails leaves the body as it was, so one that hits
				// the cap hands the pool the original bytes.
				cap := min(INLINE_OUTPUT_MAX, t.max_body)
				err = run_decoding(&t.resp.body, chain, cap)
				decoded = err != .Body_Too_Large || cap == t.max_body
			}

			if !decoded {
				if decode_start(t.loop, &t.resp.body, chain, t.max_body, on_decoded, t, &t.decode) {
					t.state = .Decoding
					return
				}

				// No worker could be started: decoding here only delays the loop.
				err = run_decoding(&t.resp.body, chain, t.max_body)
			}
		}
	}

	// Zeroed before the clear: clear_timeout runs the dispose, on_loop_closed, which
	// reads a zero timer as "the transfer is already finishing".
	if timer := t.timer; timer != 0 {
		t.timer = 0
		eventloop.clear_timeout(t.loop, timer)
	}

	if t.start_id != 0 {
		eventloop.clear_immediate(t.loop, t.start_id)
	}

	// The lookup or decode may still run on a worker; the job frees itself when it comes
	// back, or when the loop drops it.
	if t.dns != nil {
		dns_detach(t.dns)
		t.dns = nil
	}

	if t.decode != nil {
		decode_detach(t.decode)
		t.decode = nil
	}

	if err != .None {
		reset_response(t)
	}

	resp := t.resp
	resp.error = err
	resp.url = t.url_text
	on_done, user_data := t.on_done, t.user_data
	transfer_free(t)
	on_done(resp, user_data)
}

// transfer_free frees what the transfer holds beyond the response, and the transfer.
@(private = "file")
transfer_free :: proc(t: ^Transfer) {
	context.allocator = t.allocator
	delete(t.method)
	for &h in t.headers {
		delete(h.name)
		delete(h.value)
	}

	delete(t.headers)
	delete(t.body)
	url_destroy(&t.url)
	delete(t.out)
	delete(t.head)
	free(t)
}
