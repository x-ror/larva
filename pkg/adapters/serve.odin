#+build linux
package larva_adapters

import "base:runtime"
import "core:encoding/json"
import "core:fmt"
import "core:net"
import "core:os"
import "core:strings"
import "core:sync"
import "core:sys/linux"
import "core:sys/posix"
import "core:time"
import html "lava:pkg/html"
import http "lava:pkg/http"
import cookie "lava:pkg/http/cookie"
import lava "lava:pkg/runtime"
import eventloop "lava:pkg/runtime/eventloop"
import pico "lava:pkg/runtime/picohttpparser"

// `lava serve`: the HTTP crawling adapter's server (#15, roadmap stage 5). An HTTP/1.1
// server on one event loop — the server thread — in front of a page dispatcher's worker
// threads (docs/LARVA.md decision 2). For each `/render` request the server thread:
//
//   1. reads and parses the request head (picohttpparser, already linked for pkg/http);
//   2. fetches the target with pkg/http on its own loop — navigation runs no JS, so it
//      stays on this thread, and the page's VM is only taken once there is a document;
//   3. decodes the body to UTF-8 (html.decode_document, the charset of Content-Type);
//   4. submits the document to the dispatcher as a crawl job (page_crawl.odin), whose
//      worker runs, waits on and captures the page under its CPU budget;
//   5. takes the job back through eventloop.post_async from the worker's on_done, and
//      writes the response.
//
// The server thread never touches JSC: everything JS lives on the workers, and the job
// crosses back as bytes and a copied Result (CLAUDE.md §4: threads touch only their own
// payload; completions come back through post_async).
//
// The one thing both threads touch is the request's cookie jar (a Session's): the
// navigation stores and sends cookies on this thread, the page's fetch, XMLHttpRequest
// and document.cookie on the worker, and two requests of one session may run at once.
// The jar guards itself with a mutex (pkg/http/cookie), the simpler of the two correct
// shapes: a snapshot copied into each page and merged back on completion would have to
// decide whose deletion or overwrite wins when two pages of a session overlap. Only the
// jar's contents are shared; the Session itself — its table entry, refcount and clock —
// is the server thread's alone, and a Conn's reference keeps it alive for as long as
// its page can run (the connection waits for the page, Conn.job).
//
// One request per connection: the response carries `Connection: close` and the server
// closes after writing it (keep-alive is a follow-up). TLS on the listening side is a
// follow-up too; pkg/tls serves pkg/http's client side here.
//
// Shutdown (server_stop, or SIGTERM/SIGINT through serve_stop_on_signals) is graceful:
// the loop's shutdown hook closes the listener and every connection still waiting for its
// request; requests already admitted finish — each bounded by its own timeout — and
// server_run returns once none is left.

// How long a connection may take to send its request head, and the server to write its
// response: a peer that trickles bytes (or reads none) must not hold a connection forever.
@(private = "file")
IO_TIMEOUT_MS :: 10_000
@(private = "file")
READ_CHUNK :: 16 * 1024

Server :: struct {
	cfg:        Server_Config,
	allocator:  runtime.Allocator,
	// The server thread's loop: the listener, connections, navigations and completions.
	// On the heap so the dispatcher's on_done can post to it by pointer whatever moves
	// the Server.
	loop:       ^eventloop.Loop,
	listen_fd:  linux.Fd,
	listener:   eventloop.IO_Watcher,
	// The port listened on (useful with `listen` port 0).
	port:       int,
	dispatcher: lava.Page_Dispatcher,
	// Validates a request's selector before any page is made for it. lexbor's engine,
	// not JSC; this thread's own (an engine is per thread).
	selectors:  html.Selectors,
	conns:      [dynamic]^Conn,
	// Named sessions by id (the key aliases Session.id). Server thread only.
	sessions:   map[string]^Session,
	// Requests admitted and not yet answered: what max_inflight bounds.
	inflight:   int,
	draining:   bool,
	// Set by server_destroy: completions that still arrive free their request and touch
	// neither the connection nor the loop.
	closing:    bool,
	// The signal self-pipe (serve_stop_on_signals); -1 when not installed.
	signal_rd:  linux.Fd,
	signal_w:   eventloop.IO_Watcher,
}

@(private = "file")
Conn_State :: enum {
	Reading,
	Navigating,
	Rendering,
	Writing,
}

@(private = "file")
Conn :: struct {
	s:         ^Server,
	fd:        linux.Fd,
	watcher:   eventloop.IO_Watcher,
	state:     Conn_State,
	head:      [dynamic]byte,
	head_seen: int,
	out:       [dynamic]byte,
	out_off:   int,
	timer:     eventloop.Timer_ID,
	req:       Render_Request,
	// The request's own clock: the deadline is admitted + timeout, navigation included.
	admitted:  time.Tick,
	navigated: time.Tick,
	final_url: string,
	status:    int,
	// The page in flight, while Rendering: the connection waits for it, never the other
	// way round, so the job never outlives the connection it answers.
	job:       ^Render_Job,
	// Counted in Server.inflight.
	counted:   bool,
	// The request's cookie jar's owner, from admission to conn_close: a named session's
	// or the request's own. Holds one reference.
	session:   ^Session,
}

// Session owns the cookie jar its requests share. `id` is "" for a request's own (one
// without `session`), which is never in Server.sessions and goes with its last
// reference. A named one leaves the table when idle past its TTL or evicted as least
// recently used, and is freed once nothing references it any more.
@(private = "file")
Session :: struct {
	id:        string,
	jar:       cookie.Jar,
	refs:      int,
	last_used: time.Tick,
	in_table:  bool,
}

// Render_Job crosses to a worker and back: the crawl job, plus what the worker copies
// out of the page's Result before it is destroyed.
@(private = "file")
Render_Job :: struct {
	conn:     ^Conn,
	loop:     ^eventloop.Loop,
	document: []byte,
	crawl:    lava.Crawl_Job,
	kill:     lava.Kill_Reason,
	status:   lava.Status,
	message:  string,
	rendered: time.Tick,
}

// server_init binds the listener and starts the dispatcher.
//
// Returns:
//   "" on success; otherwise what failed, with nothing left open or allocated.
server_init :: proc(s: ^Server, cfg: Server_Config) -> (err: string) {
	s^ = {}
	s.listen_fd = -1
	s.signal_rd = -1
	s.cfg = cfg
	s.allocator = cfg.allocator.procedure != nil ? cfg.allocator : runtime.heap_allocator()
	context.allocator = s.allocator

	if s.cfg.listen == "" {
		s.cfg.listen = DEFAULT_LISTEN
	}

	if s.cfg.threads <= 0 {
		s.cfg.threads = max(os.get_processor_core_count(), 1)
	}

	if s.cfg.pages_per_thread <= 0 {
		s.cfg.pages_per_thread = DEFAULT_PAGES_PER_THREAD
	}

	if s.cfg.cpu_budget_ms <= 0 {
		s.cfg.cpu_budget_ms = DEFAULT_CPU_BUDGET_MS
	}

	if s.cfg.max_timeout_ms <= 0 {
		s.cfg.max_timeout_ms = DEFAULT_MAX_TIMEOUT_MS
	}

	if s.cfg.default_timeout_ms <= 0 {
		s.cfg.default_timeout_ms = min(DEFAULT_TIMEOUT_MS, s.cfg.max_timeout_ms)
	}

	if s.cfg.session_ttl_ms <= 0 {
		s.cfg.session_ttl_ms = DEFAULT_SESSION_TTL_MS
	}

	if s.cfg.max_sessions <= 0 {
		s.cfg.max_sessions = DEFAULT_MAX_SESSIONS
	}

	if s.cfg.max_inflight <= 0 {
		s.cfg.max_inflight = s.cfg.threads * s.cfg.pages_per_thread * 2
	}

	endpoint, parsed := net.parse_endpoint(s.cfg.listen)

	if !parsed {
		return fmt.tprintf("cannot parse --listen %q: want ip:port", s.cfg.listen)
	}

	sock, listen_err := net.listen_tcp(endpoint)

	if listen_err != nil {
		return fmt.tprintf("cannot listen on %s: %v", s.cfg.listen, listen_err)
	}

	s.listen_fd = linux.Fd(sock)

	if net.set_blocking(sock, false) != nil {
		server_release(s)
		return "cannot make the listening socket non-blocking"
	}

	bound, _ := net.bound_endpoint(sock)
	s.port = bound.port

	if !html.selectors_init(&s.selectors) {
		server_release(s)
		return "cannot create the selector engine"
	}

	s.loop = new(eventloop.Loop)
	s.loop^ = eventloop.init(s.allocator, real_time = true)

	if s.loop.backend != .Native {
		server_release(s)
		return "the event loop has no I/O backend"
	}

	if !lava.page_dispatcher_init(
		&s.dispatcher,
		s.cfg.threads,
		s.cfg.pages_per_thread,
		on_render_done_worker,
		allocator = s.allocator,
	) {
		server_release(s)
		return "cannot start the page dispatcher"
	}

	s.conns = make([dynamic]^Conn, s.allocator)
	s.sessions = make(map[string]^Session, s.allocator)
	s.listener = {
		fd        = uintptr(s.listen_fd),
		mode      = .Read,
		callback  = on_accept,
		user_data = s,
	}

	if !eventloop.watch_fd(s.loop, &s.listener) {
		server_release(s)
		return "cannot watch the listening socket"
	}

	eventloop.set_shutdown_hook(s.loop, on_shutdown, s)
	return ""
}

// server_run serves until a stop has been asked for (server_stop, a signal) and every
// admitted request has been answered. On the server thread, which is the loop's thread
// from here on.
server_run :: proc(s: ^Server) {
	context.allocator = s.allocator
	eventloop.run(s.loop)
}

// server_stop asks the server to stop: no new connection is accepted, connections still
// waiting for their request are closed, admitted requests are answered, then server_run
// returns. Safe from any thread (eventloop.request_shutdown), and idempotent.
server_stop :: proc(s: ^Server) {
	if s.loop != nil {
		eventloop.request_shutdown(s.loop)
	}
}

// server_destroy releases everything the server holds: the dispatcher (its workers
// joined; a page still running is cancelled), every connection, the loop, the
// listener. After server_run returned, or instead of it; on the thread that ran it.
server_destroy :: proc(s: ^Server) {
	context.allocator = s.allocator
	s.closing = true

	// Cancelled pages still report: their completions are posted to the loop, drained
	// here with `closing` set, so each frees its job without answering.
	lava.page_dispatcher_shutdown(&s.dispatcher, cancel = true)

	if s.loop != nil {
		eventloop.drain_async(s.loop)
	}

	// A connection still navigating belongs to its transfer until pkg/http reports it:
	// the loop's destroy (server_release) does, with .Cancelled, and on_navigated closes
	// it then. Every other one closes now.
	i := 0
	for i < len(s.conns) {
		c := s.conns[i]

		if c.state != .Navigating {
			conn_close(c)
			continue
		}

		i += 1
	}

	server_release(s)
}

// server_release closes and frees what init made, in reverse; safe on a partial init.
@(private = "file")
server_release :: proc(s: ^Server) {
	context.allocator = s.allocator
	serve_signals_release(s)
	// Idempotent, and a no-op on a dispatcher init never started.
	lava.page_dispatcher_shutdown(&s.dispatcher, cancel = true)

	if s.loop != nil {
		eventloop.unwatch_fd(s.loop, &s.listener)
		// A navigation still in flight finishes here with .Cancelled (on_navigated sees
		// `closing` and frees its connection).
		s.closing = true
		eventloop.destroy(s.loop)
		free(s.loop)
		s.loop = nil
	}

	if s.listen_fd >= 0 {
		linux.close(s.listen_fd)
		s.listen_fd = -1
	}

	if s.selectors.engine != nil {
		html.selectors_destroy(&s.selectors)
	}

	delete(s.conns)
	s.conns = nil

	// Every connection is gone, so no session is referenced any more.
	for _, session in s.sessions {
		session_free(s, session)
	}

	delete(s.sessions)
	s.sessions = nil
}

// The loop's shutdown hook (eventloop.request_shutdown): stop accepting and close what
// has not been admitted. What is left — navigations, pages, writes — keeps the loop
// alive until it is done.
@(private = "file")
on_shutdown :: proc(loop: ^eventloop.Loop, user_data: rawptr) {
	s := cast(^Server)user_data
	s.draining = true
	eventloop.unwatch_fd(loop, &s.listener)

	if s.listen_fd >= 0 {
		linux.close(s.listen_fd)
		s.listen_fd = -1
	}

	serve_signals_release(s)
	i := 0
	for i < len(s.conns) {
		c := s.conns[i]

		if c.state == .Reading {
			conn_close(c)
			continue
		}

		i += 1
	}
}

@(private = "file")
on_accept :: proc(loop: ^eventloop.Loop, user_data: rawptr) {
	s := cast(^Server)user_data
	context.allocator = s.allocator
	for {
		addr: linux.Sock_Addr_Any
		fd, err := linux.accept(s.listen_fd, &addr, {.NONBLOCK, .CLOEXEC})

		if err != .NONE {
			// EAGAIN: drained. Anything else (EMFILE, a reset in the backlog) loses only
			// that connection; the listener stays watched.
			return
		}

		c := new(Conn)
		c^ = {
			s     = s,
			fd    = fd,
			state = .Reading,
		}
		c.head = make([dynamic]byte, 0, 1024)
		append(&s.conns, c)
		c.watcher = {
			fd        = uintptr(fd),
			mode      = .Read,
			callback  = on_conn_io,
			user_data = c,
		}

		if !eventloop.watch_fd(loop, &c.watcher) {
			conn_close(c)
			continue
		}

		conn_arm_timer(c)
	}
}

@(private = "file")
on_conn_io :: proc(loop: ^eventloop.Loop, user_data: rawptr) {
	c := cast(^Conn)user_data
	context.allocator = c.s.allocator
	switch c.state {
	case .Reading:
		conn_read(c)
	case .Writing:
		conn_write(c)
	case .Navigating, .Rendering:
	}
}

@(private = "file")
conn_read :: proc(c: ^Conn) {
	buf: [READ_CHUNK]byte
	for {
		n, err := linux.recv(c.fd, buf[:], {})

		if err == .EAGAIN {
			return
		}

		if err != .NONE || n == 0 {
			conn_close(c)
			return
		}

		append(&c.head, ..buf[:n])
		headers: [pico.MAX_HEADERS]pico.Header
		consumed, method, target, _, _, result := pico.parse_request(c.head[:], c.head_seen, headers[:])
		c.head_seen = len(c.head)

		switch result {
		case .Partial:
			if len(c.head) > http.MAX_HEAD_BYTES {
				conn_fail(c, .Bad_Request, "the request head is too large")
				return
			}

			continue
		case .Error:
			conn_fail(c, .Bad_Request, "the request head does not parse")
			return
		case .Complete:
			_ = consumed
			conn_request(c, method, target)
			return
		}
	}
}

// conn_request routes a parsed request head. `method` and `target` alias c.head.
@(private = "file")
conn_request :: proc(c: ^Conn, method, target: string) {
	s := c.s
	path, _, query := strings.partition(target, "?")

	if path != RENDER_PATH {
		conn_fail(c, .Not_Found, "unknown path; the endpoint is GET /render")
		return
	}

	if method != "GET" {
		conn_fail(c, .Method_Not_Allowed, "the endpoint is GET /render")
		return
	}

	req, code, message := parse_render_query(query, s.cfg, s.allocator)

	if code != .None {
		conn_fail(c, code, message)
		return
	}

	c.req = req

	if c.req.selector != "" {
		sel, valid := html.compile(&s.selectors, c.req.selector)

		if !valid {
			conn_fail(c, .Bad_Request, "selector is not a valid selector list")
			return
		}

		html.selector_destroy(&sel)
	}

	if s.draining {
		conn_fail(c, .Engine_Unavailable, "the server is shutting down")
		return
	}

	if s.inflight >= s.cfg.max_inflight {
		conn_fail(c, .Over_Capacity, "too many requests in flight")
		return
	}

	s.inflight += 1
	c.counted = true
	c.admitted = time.tick_now()
	c.session = session_acquire(s, c.req.session, c.admitted)

	if c.req.cookies != "" {
		if message := seed_cookies(&c.session.jar, c.req.url, c.req.cookies); message != "" {
			conn_fail(c, .Bad_Request, message)
			return
		}
	}

	// From here the request's own timeout bounds it; the head timer is done.
	conn_clear_timer(c)
	eventloop.unwatch_fd(s.loop, &c.watcher)
	c.state = .Navigating
	nav_err := http.fetch(
		s.loop,
		{url = c.req.url, timeout_ms = c.req.timeout_ms, cookie_jar = &c.session.jar, proxy = c.req.proxy},
		on_navigated,
		c,
		allocator = s.allocator,
	)

	if nav_err != .None {
		code := Error_Code.Navigation_Failed

		if nav_err == .Invalid_URL || nav_err == .Unsupported_Scheme || nav_err == .Invalid_Request {
			code = .Bad_Request
		}

		conn_fail(c, code, fmt.tprintf("navigation could not start: %v", nav_err))
	}
}

// on_navigated is pkg/http's on_done for the target: hand the document to a worker.
@(private = "file")
on_navigated :: proc(resp: http.Response, user_data: rawptr) {
	resp := resp
	c := cast(^Conn)user_data
	s := c.s
	context.allocator = s.allocator
	defer http.response_destroy(&resp)

	// Inside eventloop.destroy (server_release): the loop is going, the connection with
	// it.
	if s.closing {
		conn_close(c)
		return
	}

	c.navigated = time.tick_now()

	if resp.error != .None {
		if resp.error == .Timeout {
			conn_fail(c, .Kill_Timeout, "the navigation did not finish before the timeout")
		} else if resp.error == .Proxy {
			conn_fail(c, .Proxy_Failed, "the proxy was unreachable, refused the tunnel or asked for credentials")
		} else {
			conn_fail(c, .Navigation_Failed, fmt.tprintf("navigation failed: %v", resp.error))
		}

		return
	}

	c.final_url = strings.clone(resp.url)
	c.status = resp.status
	// Whatever the body's type, it is parsed as HTML: a caller asking a crawler for a
	// JSON or text resource gets it as Chrome's viewer would wrap it — close enough for
	// this stage, and never a refusal.
	text, _, decoded := html.decode_document(resp.body[:], http.charset(&resp), s.allocator)

	if !decoded {
		conn_fail(c, .Navigation_Failed, "the document could not be decoded")
		return
	}

	job := new(Render_Job)
	job.conn = c
	job.loop = s.loop
	job.document = text
	job.crawl = {
		document      = text,
		url           = c.final_url,
		selector      = c.req.selector,
		script        = c.req.script,
		script_result = c.req.script_result,
		deadline      = time.tick_add(c.admitted, time.Duration(c.req.timeout_ms) * time.Millisecond),
		cookie_jar    = &c.session.jar,
		proxy         = c.req.proxy,
		allocator     = s.allocator,
	}
	c.job = job
	c.state = .Rendering
	limits := lava.Page_Limits {
		cpu_budget = f64(s.cfg.cpu_budget_ms) / 1000,
	}
	// Before the submit: a worker may post the completion before submit even returns.
	eventloop.async_begin(s.loop)

	if !lava.page_dispatcher_submit_crawl(&s.dispatcher, &job.crawl, limits, job) {
		eventloop.async_cancel(s.loop)
		c.job = nil
		render_job_free(s, job)
		conn_fail(c, .Engine_Unavailable, "the page dispatcher refused the page")
	}
}

// on_render_done_worker is the dispatcher's on_done, on the worker thread that ran the
// page: copy what the server needs out of the Result, then hand the job to the server's
// loop. Nothing else is touched here.
@(private = "file")
on_render_done_worker :: proc(d: ^lava.Page_Dispatcher, user_data: rawptr, result: lava.Result) {
	result := result
	job := cast(^Render_Job)user_data
	job.kill = result.kill
	job.status = result.status

	if job.crawl.outcome == .None && result.message != "" {
		job.message = strings.clone(result.message, job.crawl.allocator)
	}

	job.rendered = time.tick_now()
	// context.allocator is the dispatcher's here, which owns the Result.
	lava.result_destroy(&result)
	eventloop.post_async(job.loop, on_render_done, job)
}

// on_render_done answers the request its page was for, on the server thread.
@(private = "file")
on_render_done :: proc(loop: ^eventloop.Loop, user_data: rawptr) {
	job := cast(^Render_Job)user_data
	c := job.conn
	s := c.s
	context.allocator = s.allocator
	c.job = nil

	if s.closing {
		render_job_free(s, job)
		conn_close(c)
		return
	}

	crawl := &job.crawl
	switch crawl.outcome {
	case .Ok:
		content_type := crawl.script_result ? "application/json" : "text/html; charset=utf-8"
		conn_respond(c, .None, content_type, crawl.body, job.rendered)
	case .Timeout:
		conn_fail(c, .Kill_Timeout, crawl.message, job.rendered)
	case .Selector_Invalid:
		conn_fail(c, .Bad_Request, crawl.message, job.rendered)
	case .Selector_Not_Found:
		conn_fail(c, .Selector_Not_Found, crawl.message, job.rendered)
	case .Script_Error:
		conn_fail(c, .Script_Error, crawl.message, job.rendered)
	case .Failed:
		conn_fail(c, .Capture_Failed, crawl.message, job.rendered)
	case .None:
		switch job.kill {
		// A heap kill (#151) is a page limit like the CPU budget: page_killed.
		case .Cpu_Budget, .Entry_Limit, .Heap_Limit:
			conn_fail(c, .Page_Killed, job.message, job.rendered)
		case .Cancelled, .Reaping_Full:
			conn_fail(c, .Engine_Unavailable, job.message, job.rendered)
		case .None:
			conn_fail(
				c,
				.Engine_Unavailable,
				job.message != "" ? job.message : "the page ended without a document",
				job.rendered,
			)
		}
	}

	render_job_free(s, job)
}

@(private = "file")
render_job_free :: proc(s: ^Server, job: ^Render_Job) {
	context.allocator = s.allocator
	delete(job.document)
	delete(job.crawl.body)
	delete(job.crawl.message)
	delete(job.message)
	free(job)
}

// conn_fail answers with an error code; `rendered` is when the page ended, zero when it
// never ran.
@(private = "file")
conn_fail :: proc(c: ^Conn, code: Error_Code, message: string, rendered := time.Tick{}) {
	body := fmt.tprintf("%s: %s\n", ERROR_NAME[code], message)
	conn_respond(c, code, "text/plain; charset=utf-8", body, rendered)
}

// conn_respond queues the whole response and starts writing it.
@(private = "file")
conn_respond :: proc(c: ^Conn, code: Error_Code, content_type, body: string, rendered: time.Tick) {
	s := c.s
	b := strings.builder_make(0, 512 + len(body), s.allocator)
	status := ERROR_STATUS[code]
	fmt.sbprintf(&b, "HTTP/1.1 %d %s\r\n", status, reason_phrase(status))
	fmt.sbprintf(&b, "Content-Type: %s\r\nContent-Length: %d\r\nConnection: close\r\n", content_type, len(body))

	if code != .None {
		fmt.sbprintf(&b, "%s: %s\r\n", HEADER_ERROR, ERROR_NAME[code])
	}

	if c.final_url != "" && header_safe(c.final_url) {
		fmt.sbprintf(&b, "%s: %s\r\n", HEADER_FINAL_URL, c.final_url)
	}

	if c.status != 0 {
		fmt.sbprintf(&b, "%s: %d\r\n", HEADER_STATUS, c.status)
	}

	// write_json takes the jar's lock: a page of the same session still running stores
	// its cookies before or after this snapshot, never in the middle of it.
	if c.session != nil {
		jar_json := strings.builder_make(context.temp_allocator)
		cookie.write_json(&c.session.jar, time.to_unix_nanoseconds(time.now()), &jar_json)

		if header_safe(strings.to_string(jar_json)) {
			fmt.sbprintf(&b, "%s: %s\r\n", HEADER_COOKIES, strings.to_string(jar_json))
		}
	}

	if c.counted {
		now := time.tick_now()
		total := time.duration_milliseconds(time.tick_diff(c.admitted, now))
		fmt.sbprintf(&b, "%s: ", HEADER_TIMING)

		if c.navigated != {} {
			fmt.sbprintf(
				&b,
				"navigate;dur=%.1f, ",
				time.duration_milliseconds(time.tick_diff(c.admitted, c.navigated)),
			)
		}

		if rendered != {} && c.navigated != {} {
			fmt.sbprintf(&b, "render;dur=%.1f, ", time.duration_milliseconds(time.tick_diff(c.navigated, rendered)))
		}

		fmt.sbprintf(&b, "total;dur=%.1f\r\n", total)
	}

	strings.write_string(&b, "\r\n")
	strings.write_string(&b, body)
	delete(c.out)
	c.out = b.buf
	c.out_off = 0
	c.state = .Writing
	conn_uncount(c)
	eventloop.unwatch_fd(s.loop, &c.watcher)
	c.watcher = {
		fd        = uintptr(c.fd),
		mode      = .Write,
		callback  = on_conn_io,
		user_data = c,
	}
	conn_clear_timer(c)
	conn_arm_timer(c)
	conn_write(c)

	// A connection that wrote everything at once has been closed by conn_write; one that
	// has more to write waits for its socket. Either way the watch must exist only for
	// the latter.
}

@(private = "file")
conn_write :: proc(c: ^Conn) {
	for c.out_off < len(c.out) {
		n, err := linux.send(c.fd, c.out[c.out_off:], {.NOSIGNAL})

		if err == .EAGAIN {
			if !c.watcher.watched && !eventloop.watch_fd(c.s.loop, &c.watcher) {
				conn_close(c)
			}

			return
		}

		if err != .NONE {
			conn_close(c)
			return
		}

		c.out_off += n
	}

	// The whole response is out; the half-close lets the peer read to EOF before the
	// descriptor goes.
	linux.shutdown(c.fd, .WR)
	conn_close(c)
}

@(private = "file")
conn_close :: proc(c: ^Conn) {
	s := c.s
	context.allocator = s.allocator

	// A page still running for it is the job's: the connection waits (Conn.job). Only
	// server_destroy reaches here with one — after the dispatcher reported it — so this
	// is a guard, not a path.
	if c.job != nil {
		return
	}

	conn_uncount(c)
	conn_clear_timer(c)

	if s.loop != nil {
		eventloop.unwatch_fd(s.loop, &c.watcher)
	}

	linux.close(c.fd)
	for x, i in s.conns {
		if x == c {
			unordered_remove(&s.conns, i)
			break
		}
	}

	if c.session != nil {
		session_release(s, c.session)
		c.session = nil
	}

	render_request_destroy(&c.req)
	delete(c.head)
	delete(c.out)
	delete(c.final_url)
	free(c)
}

// session_acquire returns the session named `id` with a reference taken, made on first
// use, or a fresh unnamed one for id "". Idle sessions past their TTL are swept first,
// and a new named one evicts the least recently used when the table is full: both are
// O(sessions), on a table max_sessions bounds, once per admitted request.
@(private = "file")
session_acquire :: proc(s: ^Server, id: string, now: time.Tick) -> ^Session {
	context.allocator = s.allocator
	ttl := time.Duration(s.cfg.session_ttl_ms) * time.Millisecond
	stale := make([dynamic]^Session, 0, 0, context.temp_allocator)
	for _, session in s.sessions {
		if session.refs == 0 && time.tick_diff(session.last_used, now) > ttl {
			append(&stale, session)
		}
	}

	for session in stale {
		session_drop(s, session)
	}

	session: ^Session

	if id != "" {
		session = s.sessions[id]
	}

	if session == nil {
		if id != "" && len(s.sessions) >= s.cfg.max_sessions {
			oldest: ^Session
			for _, x in s.sessions {
				if oldest == nil || time.tick_diff(x.last_used, oldest.last_used) > 0 {
					oldest = x
				}
			}

			session_drop(s, oldest)
		}

		session = new(Session)
		cookie.jar_init(&session.jar, s.allocator)

		if id != "" {
			session.id = strings.clone(id)
			session.in_table = true
			s.sessions[session.id] = session
		}
	}

	session.refs += 1
	session.last_used = now
	return session
}

@(private = "file")
session_release :: proc(s: ^Server, session: ^Session) {
	session.refs -= 1
	session.last_used = time.tick_now()

	if session.refs == 0 && !session.in_table {
		session_free(s, session)
	}
}

// session_drop takes a session out of the table; it is freed now when unreferenced, or
// by its last session_release.
@(private = "file")
session_drop :: proc(s: ^Server, session: ^Session) {
	delete_key(&s.sessions, session.id)
	session.in_table = false

	if session.refs == 0 {
		session_free(s, session)
	}
}

@(private = "file")
session_free :: proc(s: ^Server, session: ^Session) {
	context.allocator = s.allocator
	cookie.jar_destroy(&session.jar)
	delete(session.id)
	free(session)
}

// seed_cookies stores a request's `cookies` parameter in `jar` as if `url` had set
// them (serve_contract.odin): a JSON array of set-cookie-strings, or `name=value` pairs
// joined by `;`. Returns "" or the message of the bad_request it is.
@(private = "file")
seed_cookies :: proc(jar: ^cookie.Jar, url, cookies: string) -> string {
	now := time.to_unix_nanoseconds(time.now())
	text := strings.trim_space(cookies)

	if strings.has_prefix(text, "[") {
		lines: []string

		if json.unmarshal_string(text, &lines, allocator = context.temp_allocator) != nil {
			return "cookies must be a JSON array of strings or name=value pairs"
		}

		for line in lines {
			if message := seed_one(jar, url, line, now); message != "" {
				return message
			}
		}

		return ""
	}

	rest := text
	for pair in strings.split_iterator(&rest, ";") {
		pair := strings.trim_space(pair)

		if pair == "" {
			continue
		}

		if !strings.contains_rune(pair, '=') {
			return "cookies must be a JSON array of strings or name=value pairs"
		}

		if message := seed_one(jar, url, pair, now); message != "" {
			return message
		}
	}

	return ""
}

@(private = "file")
seed_one :: proc(jar: ^cookie.Jar, url, line: string, now: i64) -> string {
	status, err := http.set_cookie_for_url(jar, url, line, now)

	if err != .None {
		return "url is not a URL the cookies can be scoped to"
	}

	if status != .Stored {
		return fmt.tprintf("a seed cookie was refused (%v): %q", status, line)
	}

	return ""
}

@(private = "file")
conn_uncount :: proc(c: ^Conn) {
	if c.counted {
		c.counted = false
		c.s.inflight -= 1
	}
}

@(private = "file")
conn_arm_timer :: proc(c: ^Conn) {
	c.timer = eventloop.set_timeout(c.s.loop, on_conn_timeout, IO_TIMEOUT_MS, c)
}

@(private = "file")
conn_clear_timer :: proc(c: ^Conn) {
	if c.timer != 0 && c.s.loop != nil && !c.s.loop.destroyed {
		eventloop.clear_timeout(c.s.loop, c.timer)
	}

	c.timer = 0
}

@(private = "file")
on_conn_timeout :: proc(loop: ^eventloop.Loop, user_data: rawptr) {
	c := cast(^Conn)user_data
	c.timer = 0
	conn_close(c)
}

@(private = "file")
reason_phrase :: proc(status: int) -> string {
	switch status {
	case 200:
		return "OK"
	case 400:
		return "Bad Request"
	case 401:
		return "Unauthorized"
	case 404:
		return "Not Found"
	case 405:
		return "Method Not Allowed"
	case 500:
		return "Internal Server Error"
	case 501:
		return "Not Implemented"
	case 502:
		return "Bad Gateway"
	case 503:
		return "Service Unavailable"
	case 504:
		return "Gateway Timeout"
	}

	return "Unknown"
}

// The write end of the signal self-pipe, read by the handler: process-wide, since a
// signal disposition is (docs/GLOBAL-STATE.md). -1 when no server listens for signals.
@(private = "file")
signal_pipe_w: i32 = -1

// serve_stop_on_signals makes SIGTERM and SIGINT stop `s` gracefully (server_stop).
// The handler only writes a byte to a pipe — write(2) is async-signal-safe, a mutex
// (request_shutdown's) is not — and the pipe's read end, watched on the server's loop,
// asks for the stop on the loop thread. Unreffed, so it never keeps the loop alive.
// One server per process at a time; the dispositions are restored to the default by
// server_destroy or when the shutdown begins.
//
// Returns:
//   false when the pipe or a handler could not be installed; nothing is left installed.
serve_stop_on_signals :: proc(s: ^Server) -> bool {
	fds: [2]linux.Fd

	if linux.pipe2(&fds, {.CLOEXEC, .NONBLOCK}) != .NONE {
		return false
	}

	s.signal_rd = fds[0]
	sync.atomic_store(&signal_pipe_w, i32(fds[1]))
	act := posix.sigaction_t {
		sa_handler = on_signal,
	}

	if posix.sigaction(.SIGTERM, &act, nil) != .OK || posix.sigaction(.SIGINT, &act, nil) != .OK {
		serve_signals_release(s)
		return false
	}

	s.signal_w = {
		fd        = uintptr(s.signal_rd),
		mode      = .Read,
		callback  = on_signal_pipe,
		user_data = s,
		unref     = true,
	}

	if !eventloop.watch_fd(s.loop, &s.signal_w) {
		serve_signals_release(s)
		return false
	}

	return true
}

@(private = "file")
on_signal :: proc "c" (sig: posix.Signal) {
	fd := sync.atomic_load(&signal_pipe_w)

	if fd >= 0 {
		b := [1]u8{1}
		linux.write(linux.Fd(fd), b[:])
	}
}

@(private = "file")
on_signal_pipe :: proc(loop: ^eventloop.Loop, user_data: rawptr) {
	eventloop.request_shutdown(loop)
}

// serve_signals_release restores the default dispositions, then closes the pipe; the
// handler reads the write end atomically, so a late signal writes nowhere.
@(private = "file")
serve_signals_release :: proc(s: ^Server) {
	if s.signal_rd < 0 {
		return
	}

	dfl := posix.sigaction_t {
		sa_handler = cast(proc "c" (_: posix.Signal))posix.SIG_DFL,
	}
	posix.sigaction(.SIGTERM, &dfl, nil)
	posix.sigaction(.SIGINT, &dfl, nil)

	if s.loop != nil {
		eventloop.unwatch_fd(s.loop, &s.signal_w)
	}

	w := sync.atomic_exchange(&signal_pipe_w, -1)

	if w >= 0 {
		linux.close(linux.Fd(w))
	}

	linux.close(s.signal_rd)
	s.signal_rd = -1
}
