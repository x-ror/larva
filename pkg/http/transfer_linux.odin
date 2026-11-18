#+build linux
package larva_http

import "base:runtime"
import "core:c"
import "core:net"
import "core:strconv"
import "core:strings"
import "core:sync"
import "core:sys/linux"
import eventloop "lava:pkg/runtime/eventloop"
import pico "lava:pkg/runtime/picohttpparser"
import openssl "lava:pkg/tls"

// One HTTP/1.1 exchange per connection (`Connection: close`), redirects followed on a
// new connection. Connection reuse, HTTP/2 and client profiles come with stage 2
// (docs/LARVA.md decision 3); this is the transport they will replace.

// Bytes read from the socket per call.
@(private = "file")
READ_CHUNK :: 16 * 1024

// A page larger than this is refused rather than buffered: the server picks the size,
// and the timeout alone does not bound memory on a fast link.
MAX_BODY_BYTES :: 64 * 1024 * 1024

@(private = "file")
State :: enum {
	Resolving,
	Connecting,
	Handshake,
	Writing,
	Reading_Head,
	Reading_Body,
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
	Closed,
	Failed,
}

@(private = "file")
Addr :: struct {
	is_v6: bool,
	v4:    net.IP4_Address,
	v6:    net.IP6_Address,
}

@(private = "file")
Transfer :: struct {
	loop:        ^eventloop.Loop,
	allocator:   runtime.Allocator,
	on_done:     Done_Proc,
	user_data:   rawptr,
	method:      string,
	headers:     []Header,
	body:        []byte,
	url_text:    string,
	url:         Url,
	state:       State,
	addrs:       [2]Addr,
	addr_count:  int,
	addr_index:  int,
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
	dns:         ^DNS_Job,
}

// The lookup runs on the loop's worker pool, because core:net's resolver blocks.
@(private = "file")
DNS_Job :: struct {
	t:          ^Transfer, // nil once the transfer is gone; the job then only frees itself
	host:       string,
	addrs:      [2]Addr,
	addr_count: int,
	cancelled:  bool,
	allocator:  runtime.Allocator,
}

@(private)
transfer_start :: proc(
	loop: ^eventloop.Loop,
	req: Request,
	on_done: Done_Proc,
	user_data: rawptr,
	allocator: runtime.Allocator,
) -> (
	ok: bool,
	err: Error,
) {
	context.allocator = allocator

	if loop == nil || on_done == nil || !request_is_valid(req) {
		return false, .Invalid_Request
	}

	url, url_err := parse_url(req.url)

	if url_err != .None {
		return false, url_err
	}

	t := new(Transfer)
	t^ = {
		loop = loop,
		allocator = allocator,
		on_done = on_done,
		user_data = user_data,
		method = strings.clone(req.method if req.method != "" else "GET"),
		body = clone_bytes(req.body),
		url_text = strings.clone(req.url),
		url = url,
		fd = -1,
		out = make([dynamic]byte),
		head = make([dynamic]byte),
		resp = {allocator = allocator, headers = make([dynamic]Header), body = make([dynamic]byte)},
	}
	t.headers = make([]Header, len(req.headers))
	for h, i in req.headers {
		t.headers[i] = {strings.clone(h.name), strings.clone(h.value)}
	}

	timeout := req.timeout_ms if req.timeout_ms > 0 else DEFAULT_TIMEOUT_MS
	t.timer = eventloop.set_timeout(loop, on_timeout, u64(timeout), t)
	begin(t)
	return true, .None
}

@(private = "file")
request_is_valid :: proc(req: Request) -> bool {
	for b in transmute([]byte)req.method {
		// RFC 9110 token characters; anything else could split the request line.
		if !(('A' <= b && b <= 'Z') ||
			   ('a' <= b && b <= 'z') ||
			   ('0' <= b && b <= '9') ||
			   strings.index_byte("!#$%&'*+-.^_`|~", b) >= 0) {
			return false
		}
	}

	for h in req.headers {
		if h.name == "" || strings.index_any(h.name, ":\r\n \t") >= 0 || strings.index_any(h.value, "\r\n") >= 0 {
			return false
		}
	}

	return true
}

@(private = "file")
clone_bytes :: proc(b: []byte) -> []byte {
	if len(b) == 0 {
		return nil
	}

	out := make([]byte, len(b))
	copy(out, b)
	return out
}

// begin opens a connection to t.url: straight away for an IP literal, after a pool
// lookup for a name.
@(private = "file")
begin :: proc(t: ^Transfer) {
	t.addr_count, t.addr_index = 0, 0

	if ip4, ok := net.parse_ip4_address(t.url.host); ok {
		t.addrs[0], t.addr_count = {
				v4 = ip4,
			}, 1
		connect_next(t)
		return
	}

	if ip6, ok := net.parse_ip6_address(t.url.host); ok {
		t.addrs[0], t.addr_count = {
				is_v6 = true,
				v6    = ip6,
			}, 1
		connect_next(t)
		return
	}

	t.state = .Resolving
	job := new(DNS_Job, t.allocator)
	job^ = {
		t         = t,
		host      = strings.clone(t.url.host, t.allocator),
		allocator = t.allocator,
	}

	if !eventloop.pool_submit(t.loop, dns_work, dns_done, job, dns_dispose, dns_cancel) {
		dns_free(job)
		finish(t, .DNS)
		return
	}

	t.dns = job
}

@(private = "file")
dns_work :: proc(user_data: rawptr) {
	job := cast(^DNS_Job)user_data

	if sync.atomic_load(&job.cancelled) {
		return
	}

	ep4, ep6, err := net.resolve(job.host)

	if err != nil {
		return
	}

	if ip4, ok := ep4.address.(net.IP4_Address); ok {
		job.addrs[job.addr_count] = {
			v4 = ip4,
		}
		job.addr_count += 1
	}

	if ip6, ok := ep6.address.(net.IP6_Address); ok {
		job.addrs[job.addr_count] = {
			is_v6 = true,
			v6    = ip6,
		}
		job.addr_count += 1
	}
}

@(private = "file")
dns_done :: proc(loop: ^eventloop.Loop, user_data: rawptr) {
	job := cast(^DNS_Job)user_data
	t := job.t
	addrs, count := job.addrs, job.addr_count
	dns_free(job)

	if t == nil {
		return
	}

	t.dns = nil

	if count == 0 {
		finish(t, .DNS)
		return
	}

	t.addrs, t.addr_count = addrs, count
	connect_next(t)
}

@(private = "file")
dns_cancel :: proc(user_data: rawptr) {
	sync.atomic_store(&(cast(^DNS_Job)user_data).cancelled, true)
}

@(private = "file")
dns_dispose :: proc(user_data: rawptr) {
	dns_free(cast(^DNS_Job)user_data)
}

@(private = "file")
dns_free :: proc(job: ^DNS_Job) {
	delete(job.host, job.allocator)
	free(job, job.allocator)
}

// connect_next tries the next resolved address; out of addresses is a connect error.
@(private = "file")
connect_next :: proc(t: ^Transfer) {
	for t.addr_index < t.addr_count {
		a := t.addrs[t.addr_index]
		t.addr_index += 1
		fd, err := linux.socket(.INET6 if a.is_v6 else .INET, .STREAM, {.NONBLOCK, .CLOEXEC}, .TCP)

		if err != .NONE {
			continue
		}

		conn_err: linux.Errno

		if a.is_v6 {
			sa := linux.Sock_Addr_In6 {
				sin6_family = .INET6,
				sin6_port   = u16be(t.url.port),
				sin6_addr   = transmute([16]u8)a.v6,
			}
			conn_err = linux.connect(fd, &sa)
		} else {
			sa := linux.Sock_Addr_In {
				sin_family = .INET,
				sin_port   = u16be(t.url.port),
				sin_addr   = transmute([4]u8)a.v4,
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
	case .Resolving:
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
	build_request(t)
	t.state = .Writing
	write(t)
}

// build_request writes the request head and body into t.out. A caller's header
// replaces the default of the same name.
@(private = "file")
build_request :: proc(t: ^Transfer) {
	clear(&t.out)
	t.out_off = 0
	sb := strings.Builder {
		buf = t.out,
	}
	strings.write_string(&sb, t.method)
	strings.write_byte(&sb, ' ')
	strings.write_string(&sb, t.url.target)
	strings.write_string(&sb, " HTTP/1.1\r\n")

	host := host_header(t.url, context.temp_allocator)
	length_buf: [20]byte
	defaults := [?]Header {
		{"Host", host},
		{"User-Agent", DEFAULT_USER_AGENT},
		{"Accept", "*/*"},
		// Decoding gzip/br/zstd comes with the stage-2 network stack (#9).
		{"Accept-Encoding", "identity"},
		{"Connection", "close"},
		{"Content-Length", strconv.write_int(length_buf[:], i64(len(t.body)), 10)},
	}
	for d in defaults {
		if d.name == "Content-Length" && len(t.body) == 0 && !method_has_body(t.method) {
			continue
		}

		if !has_header(t.headers, d.name) {
			write_header(&sb, d)
		}
	}

	for h in t.headers {
		write_header(&sb, h)
	}

	strings.write_string(&sb, "\r\n")
	strings.write_bytes(&sb, t.body)
	t.out = sb.buf
}

@(private = "file")
write_header :: proc(sb: ^strings.Builder, h: Header) {
	strings.write_string(sb, h.name)
	strings.write_string(sb, ": ")
	strings.write_string(sb, h.value)
	strings.write_string(sb, "\r\n")
}

@(private = "file")
has_header :: proc(headers: []Header, name: string) -> bool {
	for h in headers {
		if ascii_equal_fold(h.name, name) {
			return true
		}
	}

	return false
}

@(private = "file")
method_has_body :: proc(method: string) -> bool {
	return method == "POST" || method == "PUT" || method == "PATCH"
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
		case .Closed, .Failed:
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
	buf: [READ_CHUNK]byte
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
		case .Closed:
			on_eof(t)
			return
		case .Failed:
			finish(t, .Read)
			return
		}
	}
}

@(private = "file")
send :: proc(t: ^Transfer, data: []byte) -> (n: int, io: IO) {
	if t.ssl != nil {
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

// ssl_io maps a failed SSL_read/SSL_write. Many servers close without a TLS
// close_notify, which OpenSSL 3 reports as an error; it is taken as an end of stream
// here, and the body framing (on_eof) decides whether the response was cut short.
@(private = "file")
ssl_io :: proc(t: ^Transfer, ret: c.int) -> IO {
	e := openssl.SSL_get_error(t.ssl, ret)
	openssl.ERR_clear_error()
	switch e {
	case openssl.SSL_ERROR_WANT_READ:
		return .Would_Block_Read
	case openssl.SSL_ERROR_WANT_WRITE:
		return .Would_Block_Write
	case openssl.SSL_ERROR_ZERO_RETURN:
		return .Closed
	case openssl.SSL_ERROR_SYSCALL, openssl.SSL_ERROR_SSL:
		return .Closed if t.state == .Reading_Body || t.state == .Reading_Head else .Failed
	}

	return .Failed
}

// feed takes response bytes. false means the transfer is finished (or redirected)
// and `t` must not be touched again by the caller.
@(private = "file")
feed :: proc(t: ^Transfer, data: []byte) -> bool {
	if t.state == .Reading_Body {
		return feed_body(t, data)
	}

	append(&t.head, ..data)
	for {
		parsed: [pico.MAX_HEADERS]pico.Header
		consumed, status, reason, count, result := pico.parse_response(t.head[:], t.head_parsed, parsed[:])
		switch result {
		case .Partial:
			t.head_parsed = len(t.head)
			return true
		case .Error:
			finish(t, .Malformed_Response)
			return false
		case .Complete:
		}

		// 1xx interim responses (100 Continue, 103 Early Hints) precede the real one.
		if status >= 100 && status < 200 {
			remove_range(&t.head, 0, consumed)
			t.head_parsed = 0
			continue
		}

		return on_head(t, status, reason, parsed[:count], consumed)
	}
}

@(private = "file")
on_head :: proc(t: ^Transfer, status: int, reason: string, headers: []pico.Header, consumed: int) -> bool {
	context.allocator = t.allocator
	t.resp.status = status
	t.resp.reason = strings.clone(reason)
	for h in headers {
		append(&t.resp.headers, Header{strings.clone(h.name), strings.clone(h.value)})
	}

	if location, ok := header(&t.resp, "Location"); ok && is_redirect(status) {
		redirect(t, status, location)
		return false
	}

	t.mode = .Until_Close
	switch {
	case t.method == "HEAD" || status == 204 || status == 304:
		t.mode = .None
	case:
		if te, ok := header(&t.resp, "Transfer-Encoding");
		   ok && strings.contains(strings.to_lower(te, context.temp_allocator), "chunked") {
			t.mode = .Chunked
		} else if cl, has_cl := header(&t.resp, "Content-Length"); has_cl {
			n, num_ok := strconv.parse_int(strings.trim_space(cl), 10)

			if !num_ok || n < 0 {
				finish(t, .Malformed_Response)
				return false
			}

			t.mode, t.remaining = .Length, n
		}
	}

	rest := t.head[consumed:]
	t.state = .Reading_Body

	if t.mode == .None || (t.mode == .Length && t.remaining == 0) {
		finish(t, .None)
		return false
	}

	if !feed_body(t, rest) {
		return false
	}

	clear(&t.head)
	return true
}

@(private = "file")
feed_body :: proc(t: ^Transfer, data: []byte) -> bool {
	switch t.mode {
	case .None:
	case .Length:
		n := min(len(data), t.remaining)
		append(&t.resp.body, ..data[:n])
		t.remaining -= n

		if t.remaining == 0 {
			finish(t, .None)
			return false
		}
	case .Chunked:
		if !chunked_feed(&t.chunked, data, &t.resp.body) {
			finish(t, .Malformed_Response)
			return false
		}

		if t.chunked.state == .Done {
			finish(t, .None)
			return false
		}
	case .Until_Close:
		append(&t.resp.body, ..data)
	}

	if len(t.resp.body) > MAX_BODY_BYTES {
		finish(t, .Body_Too_Large)
		return false
	}

	return true
}

@(private = "file")
on_eof :: proc(t: ^Transfer) {
	switch {
	case t.state == .Reading_Head:
		finish(t, .Read if len(t.head) == 0 else .Malformed_Response)
	case t.mode == .Until_Close:
		finish(t, .None)
	case:
		// Fewer bytes than Content-Length, or chunks without the last one.
		finish(t, .Read)
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

// redirect follows `location` on a fresh connection. As the Fetch standard does: a 303
// becomes a GET, and so does a POST answered with 301 or 302; 307 and 308 keep the
// method and the body.
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
	for h in t.resp.headers {
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

// finish hands the response to the caller and frees the transfer. Callers return
// right after it.
@(private = "file")
finish :: proc(t: ^Transfer, err: Error) {
	context.allocator = t.allocator
	close_conn(t)

	if t.timer != 0 {
		eventloop.clear_timeout(t.loop, t.timer)
	}

	if t.dns != nil {
		// The lookup still runs on a worker; it frees its job when it comes back.
		t.dns.t = nil
	}

	resp := t.resp
	resp.error = err
	resp.url = strings.clone(t.url_text)
	on_done, user_data := t.on_done, t.user_data

	delete(t.method)
	for h in t.headers {
		delete(h.name)
		delete(h.value)
	}

	delete(t.headers)
	delete(t.body)
	delete(t.url_text)
	url_destroy(&t.url)
	delete(t.out)
	delete(t.head)
	free(t)

	on_done(resp, user_data)
}
