// Linux-only: `lava serve` runs its pages on the page dispatcher (serve_other.odin
// refuses to start elsewhere).
#+build linux
package main

import "base:runtime"
import "core:fmt"
import "core:log"
import "core:mem"
import "core:net"
import "core:strconv"
import "core:strings"
import "core:sync"
import "core:testing"
import "core:thread"
import "core:time"
import adapters "lava:pkg/adapters"

// `lava serve` end to end (pkg/adapters, #15): a server on its own thread, driven over a
// loopback socket, fetching from a fixture origin on another. The adapter's contract —
// parameter names, error codes, metadata headers — is its own (serve_contract.odin:
// #15 keeps production's names private), so these tests are its oracle (CLAUDE.md §6);
// the documents are checked for what their scripts did, not against a recording.

// The fixture origin's documents, by path. Each is served whole with Connection: close.
@(private = "file")
FIXTURES := [?]struct {
	path: string,
	body: string,
}{
	// An inline script rewrites #x, and `load` schedules #late 30 ms later: a capture at
	// load lacks it, a selector wait for it has it.
	{
		"/a",
		`<!doctype html><html><head><title>t</title></head><body><p id="x">static</p><script>` +
		`document.getElementById('x').textContent = 'js ran at ' + location.pathname;` +
		`addEventListener('load', () => setTimeout(() => {` +
		`const d = document.createElement('div'); d.id = 'late'; document.body.appendChild(d); }, 30));` +
		`</script></body></html>`,
	},
	// Never idle, so never `load`: only the timeout ends it.
	{"/interval", `<!doctype html><script>setInterval(() => {}, 20)</script>`},
	// One synchronous entry that never returns: only the CPU budget ends it.
	{"/spin", `<!doctype html><script>for (;;) {}</script>`},
	// 500 ms of wall time in one top-level script, CPU or not; #t says when it ran.
	{
		"/wall",
		`<!doctype html><body><p id="t"></p><script>const s = Date.now(); while (Date.now() - s < 500) {}` +
		`document.getElementById('t').textContent = 'ran ' + s + ' ' + Date.now() + ' end';</script></body>`,
	},
	// `load` waits 300 ms for a timer: a request that is in flight for a while.
	{"/slow", `<!doctype html><script>setTimeout(() => { document.body.id = 'slow-done'; }, 300)</script>`},
}

@(private = "file")
Origin :: struct {
	listener: net.TCP_Socket,
	port:     int,
	thread:   ^thread.Thread,
	// Responses sent, so far: a test waits on it to know a request got past navigation.
	served:   int,
}

@(private = "file")
origin_start :: proc(t: ^testing.T) -> (o: ^Origin, ok: bool) {
	listener, err := net.listen_tcp({net.IP4_Loopback, 0})

	if !testing.expectf(t, err == nil, "fixture origin: listen: %v", err) {
		return nil, false
	}

	endpoint, _ := net.bound_endpoint(listener)
	o = new(Origin, runtime.heap_allocator())
	o.listener = listener
	o.port = endpoint.port
	o.thread = thread.create_and_start_with_poly_data(o, origin_serve)
	return o, true
}

// origin_wait_served waits until the origin has sent `n` responses, or 10 s.
@(private = "file")
origin_wait_served :: proc(o: ^Origin, n: int) -> bool {
	start := time.tick_now()
	for sync.atomic_load(&o.served) < n {
		if time.tick_since(start) > 10 * time.Second {
			return false
		}

		time.sleep(2 * time.Millisecond)
	}
	return true
}

@(private = "file")
origin_stop :: proc(o: ^Origin) {
	// Wakes the accept the origin's thread is blocked in.
	net.shutdown(o.listener, .Both)
	thread.join(o.thread)
	thread.destroy(o.thread)
	net.close(o.listener)
	free(o, runtime.heap_allocator())
}

// origin_serve answers one request per connection: /go/<path> redirects to <path>,
// /login sets cookies, /whoami echoes the Cookie header it got, any other path is a
// FIXTURES entry or a 404. It allocates nothing: its thread runs in the default context,
// outside the tests' tracking.
@(private = "file")
origin_serve :: proc(o: ^Origin) {
	for {
		client, _, err := net.accept_tcp(o.listener)

		if err != nil {
			return
		}

		request: [4096]byte
		n := 0
		for !strings.contains(string(request[:n]), "\r\n\r\n") {
			got, rerr := net.recv_tcp(client, request[n:])

			if rerr != nil || got == 0 || n + got == len(request) {
				break
			}

			n += got
		}

		line := strings.truncate_to_byte(string(request[:n]), '\r')
		_, _, after_method := strings.partition(line, " ")
		target, _, _ := strings.partition(after_method, " ")
		_, has_cookie, cookie_rest := strings.partition(string(request[:n]), "\r\nCookie: ")
		sent_cookie := strings.truncate_to_byte(cookie_rest, '\r') if has_cookie != "" else ""
		head: [512]byte
		echo: [1024]byte
		body := ""
		response: string

		if target == "/login" {
			// An HttpOnly cookie the page cannot see, one it can, and one the page's own
			// script sets: all three must reach the session's next request.
			body = `<!doctype html><script>document.cookie = 'pg=p1; path=/'</script>`
			response = fmt.bprintf(
				head[:],
				"HTTP/1.1 200 OK\r\nSet-Cookie: sid=s1; Path=/; HttpOnly\r\nSet-Cookie: vis=v1; Path=/\r\n" +
				"Content-Type: text/html\r\nContent-Length: %d\r\nConnection: close\r\n\r\n",
				len(body),
			)
		} else if target == "/whoami" {
			body = fmt.bprintf(
				echo[:],
				`<!doctype html><body><p id="hdr">%s</p><p id="js"></p><script>` +
				`document.getElementById('js').textContent = 'js:' + document.cookie</script></body>`,
				sent_cookie,
			)
			response = fmt.bprintf(
				head[:],
				"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: %d\r\nConnection: close\r\n\r\n",
				len(body),
			)
		} else if strings.has_prefix(target, "/go/") {
			response = fmt.bprintf(
				head[:],
				"HTTP/1.1 302 Found\r\nLocation: %s\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
				target[len("/go"):],
			)
		} else {
			status := "404 Not Found"
			for f in FIXTURES {
				if f.path == target {
					status = "200 OK"
					body = f.body
				}
			}
			response = fmt.bprintf(
				head[:],
				"HTTP/1.1 %s\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: %d\r\nConnection: close\r\n\r\n",
				status,
				len(body),
			)
		}

		net.send_tcp(client, transmute([]byte)response)
		net.send_tcp(client, transmute([]byte)body)
		net.close(client)
		sync.atomic_add(&o.served, 1)
	}
}

// A server under test, running on its own thread.
@(private = "file")
Served :: struct {
	server: adapters.Server,
	thread: ^thread.Thread,
}

@(private = "file")
serve_start :: proc(t: ^testing.T, cfg: adapters.Server_Config) -> (s: ^Served, ok: bool) {
	cfg := cfg
	cfg.listen = "127.0.0.1:0"
	s = new(Served, runtime.heap_allocator())

	if err := adapters.server_init(&s.server, cfg); err != "" {
		testing.expectf(t, false, "server_init: %s", err)
		free(s, runtime.heap_allocator())
		return nil, false
	}

	s.thread = thread.create_and_start_with_poly_data(&s.server, adapters.server_run)
	return s, true
}

// serve_stop asks for a graceful stop, waits for server_run to return, and destroys.
@(private = "file")
serve_stop :: proc(s: ^Served) {
	adapters.server_stop(&s.server)
	thread.join(s.thread)
	thread.destroy(s.thread)
	adapters.server_destroy(&s.server)
	free(s, runtime.heap_allocator())
}

// Reply is one response as the client read it, up to the server's close. `raw` is on
// the heap (a reply may be read on another thread); the views alias it.
@(private = "file")
Reply :: struct {
	ok:      bool,
	status:  int,
	head:    string,
	body:    string,
	raw:     string,
	elapsed: time.Duration,
}

@(private = "file")
reply_header :: proc(r: Reply, name: string) -> string {
	lines := r.head
	for line in strings.split_lines_iterator(&lines) {
		k, _, v := strings.partition(line, ": ")

		if strings.equal_fold(k, name) {
			return strings.trim_right(v, "\r")
		}
	}

	return ""
}

@(private = "file")
reply_destroy :: proc(r: ^Reply) {
	delete(r.raw, runtime.heap_allocator())
	r^ = {}
}

@(private = "file")
describe :: proc(r: Reply) -> string {
	return fmt.tprintf("status %d, error %q, body %q", r.status, reply_header(r, adapters.HEADER_ERROR), r.body)
}

// request sends `GET <target>` (or another method) and reads to EOF.
@(private = "file")
request :: proc(port: int, target: string, method := "GET") -> (r: Reply) {
	start := time.tick_now()
	sock, err := net.dial_tcp_from_endpoint({net.IP4_Loopback, port})

	if err != nil {
		return
	}

	defer net.close(sock)
	line := fmt.aprintf("%s %s HTTP/1.1\r\nHost: test\r\n\r\n", method, target, allocator = runtime.heap_allocator())
	defer delete(line, runtime.heap_allocator())
	net.send_tcp(sock, transmute([]byte)line)
	buf := make([dynamic]byte, 0, 4096, runtime.heap_allocator())
	chunk: [4096]byte
	for {
		n, rerr := net.recv_tcp(sock, chunk[:])

		if rerr != nil || n == 0 {
			break
		}

		append(&buf, ..chunk[:n])
	}

	r.elapsed = time.tick_since(start)
	r.raw = string(buf[:])
	head, sep, body := strings.partition(r.raw, "\r\n\r\n")

	if sep == "" {
		return
	}

	status_line, _, _ := strings.partition(head, "\r\n")
	_, _, code := strings.partition(status_line, " ")
	r.status, _ = strconv.parse_int(code[:min(3, len(code))], 10)
	r.head = head
	r.body = body
	r.ok = r.status != 0
	return
}

@(private = "file")
render :: proc(port, origin: int, path: string, extra := "") -> Reply {
	url := fmt.tprintf("http://127.0.0.1:%d%s", origin, path)
	return request(port, fmt.tprintf("/render?url=%s%s", net.percent_encode(url, context.temp_allocator), extra))
}

// The document a request names is fetched (through a redirect), its inline script runs
// against the live DOM, and the response is the serialization once `load` has fired —
// with the final URL, the origin's status and the timing as headers.
@(test)
serve_renders_the_document_after_load :: proc(t: ^testing.T) {
	origin, ok := origin_start(t)

	if !ok {
		return
	}

	defer origin_stop(origin)
	s, started := serve_start(t, {threads = 1})

	if !started {
		return
	}

	defer serve_stop(s)
	r := render(s.server.port, origin.port, "/go/a")
	defer reply_destroy(&r)
	testing.expectf(t, r.status == 200, "want 200: %s", describe(r))
	testing.expectf(
		t,
		strings.contains(r.body, `<p id="x">js ran at /a</p>`),
		"the script's DOM write is missing: %s",
		r.body,
	)
	testing.expectf(t, !strings.contains(r.body, `id="late"`), "captured after the post-load timer: %s", r.body)
	testing.expectf(t, strings.has_prefix(r.body, "<!DOCTYPE html><html>"), "not a serialized document: %q", r.body)
	final := reply_header(r, adapters.HEADER_FINAL_URL)
	testing.expectf(t, final == fmt.tprintf("http://127.0.0.1:%d/a", origin.port), "final URL %q", final)
	testing.expect_value(t, reply_header(r, adapters.HEADER_STATUS), "200")
	timing := reply_header(r, adapters.HEADER_TIMING)
	testing.expectf(
		t,
		strings.contains(timing, "navigate;dur=") &&
		strings.contains(timing, "render;dur=") &&
		strings.contains(timing, "total;dur="),
		"timing header %q",
		timing,
	)
	testing.expect_value(t, reply_header(r, "Content-Type"), "text/html; charset=utf-8")

	// The origin's own status travels as metadata; the page is still rendered.
	missing := render(s.server.port, origin.port, "/nope")
	defer reply_destroy(&missing)
	testing.expectf(t, missing.status == 200, "a 404 page is still a page: %s", describe(missing))
	testing.expect_value(t, reply_header(missing, adapters.HEADER_STATUS), "404")
}

// A selector wait runs past `load`: the element the load listener's timer inserts is in
// the capture with the wait and not without it (above). One that never matches fails as
// soon as the page has nothing left to run, and an invalid one is the caller's error.
@(test)
serve_waits_for_a_selector_after_load :: proc(t: ^testing.T) {
	origin, ok := origin_start(t)

	if !ok {
		return
	}

	defer origin_stop(origin)
	s, started := serve_start(t, {threads = 1})

	if !started {
		return
	}

	defer serve_stop(s)
	r := render(s.server.port, origin.port, "/a", "&selector=%23late")
	defer reply_destroy(&r)
	testing.expectf(t, r.status == 200, "want 200: %s", describe(r))
	testing.expectf(
		t,
		strings.contains(r.body, `<div id="late"></div>`),
		"the waited-for element is missing: %s",
		r.body,
	)

	none := render(s.server.port, origin.port, "/a", "&selector=%23never&timeout=20000")
	defer reply_destroy(&none)
	testing.expectf(
		t,
		none.status == 500 && reply_header(none, adapters.HEADER_ERROR) == "selector_not_found",
		"want selector_not_found: %s",
		describe(none),
	)
	testing.expectf(
		t,
		none.elapsed < 5 * time.Second,
		"an unmatchable wait took %v: it waited for the timeout",
		none.elapsed,
	)

	bad := render(s.server.port, origin.port, "/a", "&selector=%5B%5B")
	defer reply_destroy(&bad)
	testing.expectf(
		t,
		bad.status == 400 && reply_header(bad, adapters.HEADER_ERROR) == "bad_request",
		"want bad_request for an invalid selector: %s",
		describe(bad),
	)
}

// The custom script runs after the waits with _resolve/_reject/_delay in scope; with
// result=script the response is the resolved value as JSON, otherwise the document as
// the script left it. A throw, a rejection or a syntax error is script_error with the
// engine's message.
@(test)
serve_runs_the_custom_script :: proc(t: ^testing.T) {
	origin, ok := origin_start(t)

	if !ok {
		return
	}

	defer origin_stop(origin)
	s, started := serve_start(t, {threads = 1})

	if !started {
		return
	}

	defer serve_stop(s)
	port := s.server.port
	script :: proc(src: string) -> string {
		return net.percent_encode(src, context.temp_allocator)
	}

	value := render(
		port,
		origin.port,
		"/a",
		fmt.tprintf(
			"&result=script&script=%s",
			script(
				"await _delay(5); _resolve({title: document.title, x: document.getElementById('x').textContent, n: [1, 2]});",
			),
		),
	)
	defer reply_destroy(&value)
	testing.expectf(t, value.status == 200, "want 200: %s", describe(value))
	testing.expect_value(t, value.body, `{"title":"t","x":"js ran at /a","n":[1,2]}`)
	testing.expect_value(t, reply_header(value, "Content-Type"), "application/json")

	dom := render(port, origin.port, "/a", fmt.tprintf("&script=%s", script("document.title = 'set'; _resolve();")))
	defer reply_destroy(&dom)
	testing.expectf(
		t,
		dom.status == 200 && strings.contains(dom.body, "<title>set</title>"),
		"the script's write is missing: %s",
		describe(dom),
	)

	cases := [?]struct {
		src:  string,
		want: string,
	} {
		{"throw new TypeError('thrown')", "TypeError: thrown"},
		{"_reject(new Error('rejected'))", "Error: rejected"},
		{"_resolve(1n)", "not JSON-serializable"},
		{"})(", "SyntaxError"},
		// Nothing left to run and never settled: an error now, not at the timeout.
		{"new Promise(() => {})", "never settled"},
	}
	for c in cases {
		r := render(port, origin.port, "/a", fmt.tprintf("&script=%s", script(c.src)))
		defer reply_destroy(&r)
		testing.expectf(
			t,
			r.status == 500 &&
			reply_header(r, adapters.HEADER_ERROR) == "script_error" &&
			strings.contains(r.body, c.want),
			"%q: want script_error with %q: %s",
			c.src,
			c.want,
			describe(r),
		)
	}
}

// The hard timeout covers the whole request: a page that never reaches `load` is
// answered kill_timeout once it passes, not later.
@(test)
serve_times_out_a_page_that_never_loads :: proc(t: ^testing.T) {
	origin, ok := origin_start(t)

	if !ok {
		return
	}

	defer origin_stop(origin)
	s, started := serve_start(t, {threads = 1})

	if !started {
		return
	}

	defer serve_stop(s)
	r := render(s.server.port, origin.port, "/interval", "&timeout=300")
	defer reply_destroy(&r)
	testing.expectf(
		t,
		r.status == 504 && reply_header(r, adapters.HEADER_ERROR) == "kill_timeout",
		"want kill_timeout: %s",
		describe(r),
	)
	testing.expectf(t, r.elapsed >= 300 * time.Millisecond, "answered after %v, before its timeout", r.elapsed)
	testing.expectf(t, r.elapsed < 3 * time.Second, "answered after %v, long past its 300 ms timeout", r.elapsed)
}

// A page that spins in one entry is killed by its CPU budget and reported page_killed;
// the worker it ran on goes on to serve the next request.
@(test)
serve_reports_a_page_killed_by_its_cpu_budget :: proc(t: ^testing.T) {
	origin, ok := origin_start(t)

	if !ok {
		return
	}

	defer origin_stop(origin)
	s, started := serve_start(t, {threads = 1, pages_per_thread = 1, cpu_budget_ms = 200})

	if !started {
		return
	}

	defer serve_stop(s)
	r := render(s.server.port, origin.port, "/spin", "&timeout=30000")
	defer reply_destroy(&r)
	testing.expectf(
		t,
		r.status == 500 && reply_header(r, adapters.HEADER_ERROR) == "page_killed",
		"want page_killed: %s",
		describe(r),
	)
	testing.expectf(t, strings.contains(r.body, "CPU budget"), "the kill's reason is missing: %q", r.body)

	after := render(s.server.port, origin.port, "/a")
	defer reply_destroy(&after)
	testing.expectf(t, after.status == 200, "the worker did not serve on after the kill: %s", describe(after))
}

@(private = "file")
Parallel :: struct {
	port, origin: int,
	path:         string,
	reply:        Reply,
}

@(private = "file")
parallel_render :: proc(p: ^Parallel) {
	url := fmt.aprintf("http://127.0.0.1:%d%s", p.origin, p.path, allocator = runtime.heap_allocator())
	defer delete(url, runtime.heap_allocator())
	target := fmt.aprintf("/render?url=%s", url, allocator = runtime.heap_allocator())
	defer delete(target, runtime.heap_allocator())
	p.reply = request(p.port, target)
}

// Requests run on the dispatcher's threads side by side: four pages that each hold their
// thread for 500 ms of wall time overlap — every one starts before any ends, which pages
// run one after another can never do, however loaded the machine. A request past
// max_inflight is refused over_capacity at once.
@(test)
serve_runs_requests_on_its_threads_concurrently :: proc(t: ^testing.T) {
	origin, ok := origin_start(t)

	if !ok {
		return
	}

	defer origin_stop(origin)
	N :: 4
	s, started := serve_start(t, {threads = N, pages_per_thread = 1})

	if !started {
		return
	}

	// One page per worker first, one after another (ties rotate over the workers): a
	// worker's first page creates its VM, which under load can take long enough to skew
	// the starts this test compares.
	for _ in 0 ..< N {
		warm := render(s.server.port, origin.port, "/a")
		testing.expectf(t, warm.status == 200, "warm-up: %s", describe(warm))
		reply_destroy(&warm)
	}

	jobs: [N]Parallel
	threads: [N]^thread.Thread
	for &j, i in jobs {
		j = {
			port   = s.server.port,
			origin = origin.port,
			path   = "/wall",
		}
		threads[i] = thread.create_and_start_with_poly_data(&j, parallel_render)
	}
	for th in threads {
		thread.join(th)
		thread.destroy(th)
	}
	last_start, first_end := 0, max(int)
	for &j, i in jobs {
		_, _, ran := strings.partition(j.reply.body, "ran ")
		begin_text, _, rest := strings.partition(ran, " ")
		end_text, _, _ := strings.partition(rest, " ")
		begin, begin_ok := strconv.parse_int(begin_text, 10)
		end, end_ok := strconv.parse_int(end_text, 10)
		testing.expectf(t, j.reply.status == 200 && begin_ok && end_ok, "request %d: %s", i, describe(j.reply))
		last_start = max(last_start, begin)
		first_end = min(first_end, end)
		reply_destroy(&j.reply)
	}
	log.infof("%d pages of 500 ms: the last started %d ms before the first ended", N, first_end - last_start)
	testing.expectf(
		t,
		last_start < first_end,
		"the last of %d pages started %d ms after the first ended: they did not run side by side",
		N,
		last_start - first_end,
	)
	serve_stop(s)

	// max_inflight 1: the first request holds the only slot for the 300 ms of its page.
	capped, capped_started := serve_start(t, {threads = 1, max_inflight = 1})

	if !capped_started {
		return
	}

	defer serve_stop(capped)
	served := sync.atomic_load(&origin.served)
	holder := Parallel {
		port   = capped.server.port,
		origin = origin.port,
		path   = "/slow",
	}
	th := thread.create_and_start_with_poly_data(&holder, parallel_render)
	testing.expect(t, origin_wait_served(origin, served + 1), "the holder never reached the origin")
	refused := render(capped.server.port, origin.port, "/a")
	defer reply_destroy(&refused)
	thread.join(th)
	thread.destroy(th)
	defer reply_destroy(&holder.reply)
	testing.expectf(t, holder.reply.status == 200, "the holder: %s", describe(holder.reply))
	testing.expectf(
		t,
		refused.status == 503 && reply_header(refused, adapters.HEADER_ERROR) == "over_capacity",
		"want over_capacity: %s",
		describe(refused),
	)
}

// What the contract does not serve is refused with its code: an unknown parameter (a
// feature the caller must take elsewhere), a missing url, a wrong path or method, a
// wrong token, an origin that cannot be reached.
@(test)
serve_refuses_what_it_does_not_serve :: proc(t: ^testing.T) {
	origin, ok := origin_start(t)

	if !ok {
		return
	}

	defer origin_stop(origin)
	s, started := serve_start(t, {threads = 1, token = "sesame"})

	if !started {
		return
	}

	defer serve_stop(s)
	port := s.server.port
	url := net.percent_encode(fmt.tprintf("http://127.0.0.1:%d/a", origin.port), context.temp_allocator)
	cases := [?]struct {
		method, target, code: string,
		status:               int,
	} {
		{"GET", fmt.tprintf("/render?url=%s&token=sesame&screenshot=1", url), "unsupported", 501},
		{"GET", fmt.tprintf("/render?url=%s&token=sesame&wait=networkidle", url), "unsupported", 501},
		{"GET", "/render?token=sesame", "bad_request", 400},
		{"GET", "/render?url=ftp%3A%2F%2Fx&token=sesame", "bad_request", 400},
		{"GET", fmt.tprintf("/render?url=%s&token=sesame&timeout=0", url), "bad_request", 400},
		{"GET", fmt.tprintf("/render?url=%s&token=sesame&url=%s", url, url), "bad_request", 400},
		{"GET", fmt.tprintf("/render?url=%s&token=sesame&result=script", url), "bad_request", 400},
		{"GET", fmt.tprintf("/render?url=%s", url), "unauthorized", 401},
		{"GET", fmt.tprintf("/render?url=%s&token=open", url), "unauthorized", 401},
		{"GET", "/other", "not_found", 404},
		{"POST", fmt.tprintf("/render?url=%s&token=sesame", url), "method_not_allowed", 405},
		{"GET", "/render?url=http%3A%2F%2F127.0.0.1%3A1%2F&token=sesame", "navigation_failed", 502},
	}
	for c in cases {
		r := request(port, c.target, c.method)
		defer reply_destroy(&r)
		testing.expectf(
			t,
			r.status == c.status && reply_header(r, adapters.HEADER_ERROR) == c.code,
			"%s %s: want %d %s: %s",
			c.method,
			c.target,
			c.status,
			c.code,
			describe(r),
		)
	}

	r := request(port, fmt.tprintf("/render?url=%s&token=sesame", url))
	defer reply_destroy(&r)
	testing.expectf(t, r.status == 200, "the right token: %s", describe(r))
}

// Everything the server owns — connections, requests, navigations, jobs, the dispatcher
// and every page's state and Result — goes through the allocator it was given and comes
// back: none outstanding and no bad free once server_destroy returns, whatever way each
// request ended.
@(test)
serve_allocations_pair_through_its_allocator :: proc(t: ^testing.T) {
	track: mem.Tracking_Allocator
	mem.tracking_allocator_init(&track, runtime.heap_allocator())
	defer mem.tracking_allocator_destroy(&track)
	// Recorded, not a panic: a bad free must fail this test, not the whole run.
	track.bad_free_callback = mem.tracking_allocator_bad_free_callback_add_to_array
	origin, ok := origin_start(t)

	if !ok {
		return
	}

	defer origin_stop(origin)
	s, started := serve_start(t, {threads = 2, cpu_budget_ms = 200, allocator = mem.tracking_allocator(&track)})

	if !started {
		return
	}

	port := s.server.port
	ends := [?]struct {
		path, extra: string,
		status:      int,
	} {
		{"/go/a", "&selector=%23late", 200},
		{"/a", "&result=script&script=_resolve(document.title)", 200},
		{"/a", "&script=throw%20new%20Error('x'.repeat(64))", 500},
		{"/interval", "&timeout=200", 504},
		{"/spin", "", 500},
		{"/a", "&selector=%23never", 500},
		{"/a", "&selector=%5B%5B", 400},
		{"/a", "&nope=1", 501},
		// A session's jar outlives its request (freed by server_destroy); a request's own
		// goes with it.
		{"/login", "&session=x&cookies=a%3D1", 200},
		{"/login", "&cookies=a%3D1", 200},
		{"/a", "&cookies=__Host-x%3D1", 400},
		// The proxy is parsed, cloned into the transfer and freed with both.
		{"/a", "&proxy=http%3A%2F%2Fu%3Ap%40127.0.0.1%3A1", 502},
	}
	for e in ends {
		r := render(port, origin.port, e.path, e.extra)
		testing.expectf(t, r.status == e.status, "%s%s: want %d: %s", e.path, e.extra, e.status, describe(r))
		reply_destroy(&r)
	}
	nav := request(port, "/render?url=http%3A%2F%2F127.0.0.1%3A1%2F")
	testing.expectf(t, nav.status == 502, "unreachable origin: %s", describe(nav))
	reply_destroy(&nav)
	serve_stop(s)

	sync.lock(&track.mutex)
	outstanding := len(track.allocation_map)
	bad := len(track.bad_free_array)
	sync.unlock(&track.mutex)
	testing.expect(
		t,
		track.total_allocation_count > 0,
		"nothing went through the server's allocator: the test proves nothing",
	)
	testing.expectf(t, outstanding == 0, "the server leaked %d allocations on its allocator", outstanding)
	testing.expectf(t, bad == 0, "the server made %d bad free(s) on its allocator", bad)
}

// A stop is graceful: the request in flight is answered, the listener is closed at once
// (a new connection is refused), and server_run returns once the last answer is out.
// On one runner thread it also gives back every descriptor it opened — listener,
// connections, its loop, the dispatcher's workers and their VMs' — once destroyed.
@(test)
serve_stops_gracefully_and_releases_everything :: proc(t: ^testing.T) {
	origin, ok := origin_start(t)

	if !ok {
		return
	}

	defer origin_stop(origin)
	// Round 0 warms JSC's one-time process descriptors up, which no server could close.
	before := 0
	for round in 0 ..< 2 {
		before = fd_census()
		s, started := serve_start(t, {threads = 2})

		if !started {
			return
		}

		port := s.server.port
		inflight := Parallel {
			port   = port,
			origin = origin.port,
			path   = "/slow",
		}
		served := sync.atomic_load(&origin.served)
		th := thread.create_and_start_with_poly_data(&inflight, parallel_render)
		// Past navigation: the request is admitted, its page about to run.
		testing.expect(t, origin_wait_served(origin, served + 1), "the request never reached the origin")
		adapters.server_stop(&s.server)
		thread.join(s.thread)
		thread.destroy(s.thread)
		thread.join(th)
		thread.destroy(th)
		testing.expectf(
			t,
			inflight.reply.status == 200 && strings.contains(inflight.reply.body, `id="slow-done"`),
			"round %d: the request in flight at the stop: %s",
			round,
			describe(inflight.reply),
		)
		reply_destroy(&inflight.reply)
		late := request(port, "/render?url=http%3A%2F%2F127.0.0.1%2F")
		testing.expectf(t, !late.ok, "round %d: a connection after the stop was answered: %s", round, describe(late))
		reply_destroy(&late)
		adapters.server_destroy(&s.server)
		free(s, runtime.heap_allocator())
	}

	when RUNNER_THREADS != 1 {
		log.info("descriptor census skipped: /proc/self/fd is process-wide; needs -define:ODIN_TEST_THREADS=1")
	} else {
		after := fd_census()
		testing.expectf(t, after == before, "the server left %d descriptors open", after - before)
	}
}

// element_text returns what the serialized document holds between `<p id="<id>">` and
// the next `</p>`, or "<missing>".
@(private = "file")
element_text :: proc(body, id: string) -> string {
	open := fmt.tprintf(`<p id="%s">`, id)
	at := strings.index(body, open)

	if at < 0 {
		return "<missing>"
	}

	rest := body[at + len(open):]
	return rest[:max(strings.index(rest, "</p>"), 0)]
}

// Requests naming one session share its cookie jar: what request 1's response set —
// HttpOnly or not — and what its page's script set through document.cookie are sent with
// request 2's navigation, and the non-HttpOnly ones are what request 2's page reads off
// document.cookie. Another session, or no session, sees none of it. Seed cookies are in
// the jar before navigation, and the captured-cookies header lists the whole jar,
// HttpOnly included.
@(test)
serve_sessions_share_cookies_across_requests :: proc(t: ^testing.T) {
	origin, ok := origin_start(t)

	if !ok {
		return
	}

	defer origin_stop(origin)
	s, started := serve_start(t, {threads = 2})

	if !started {
		return
	}

	defer serve_stop(s)
	port := s.server.port

	login := render(port, origin.port, "/login", "&session=alice")
	defer reply_destroy(&login)
	testing.expectf(t, login.status == 200, "login: %s", describe(login))
	captured := reply_header(login, adapters.HEADER_COOKIES)
	testing.expectf(
		t,
		strings.contains(
			captured,
			`{"name":"sid","value":"s1","domain":"127.0.0.1","path":"/","expires":-1,"httpOnly":true,"secure":false,"session":true}`,
		) &&
		strings.contains(captured, `"name":"vis"`) &&
		strings.contains(captured, `"name":"pg"`),
		"captured cookies %q",
		captured,
	)

	again := render(port, origin.port, "/whoami", "&session=alice")
	defer reply_destroy(&again)
	testing.expectf(t, again.status == 200, "whoami: %s", describe(again))
	testing.expect_value(t, element_text(again.body, "hdr"), "sid=s1; vis=v1; pg=p1")
	testing.expect_value(t, element_text(again.body, "js"), "js:vis=v1; pg=p1")

	for extra in ([]string{"", "&session=bob"}) {
		other := render(port, origin.port, "/whoami", extra)
		defer reply_destroy(&other)
		testing.expectf(t, other.status == 200, "whoami%s: %s", extra, describe(other))
		testing.expectf(
			t,
			element_text(other.body, "hdr") == "",
			"whoami%s got the session's cookies: %s",
			extra,
			other.body,
		)
		testing.expect_value(t, reply_header(other, adapters.HEADER_COOKIES), "[]")
	}

	seeded := render(port, origin.port, "/whoami", "&cookies=a%3D1%3B%20b%3D2")
	defer reply_destroy(&seeded)
	testing.expect_value(t, element_text(seeded.body, "hdr"), "a=1; b=2")
	testing.expect_value(t, element_text(seeded.body, "js"), "js:a=1; b=2")

	json_seed := render(port, origin.port, "/whoami", "&cookies=%5B%22h%3D3%3B%20HttpOnly%22%5D")
	defer reply_destroy(&json_seed)
	testing.expect_value(t, element_text(json_seed.body, "hdr"), "h=3")
	testing.expect_value(t, element_text(json_seed.body, "js"), "js:")

	// __Host- without Secure is refused by the jar: the caller's error, not a page
	// without the cookie. So are a session id with a space and a JSON array of numbers.
	for extra in ([]string{"&cookies=__Host-x%3D1", "&session=a%20b", "&cookies=%5B1%5D"}) {
		bad := render(port, origin.port, "/whoami", extra)
		defer reply_destroy(&bad)
		testing.expectf(
			t,
			bad.status == 400 && reply_header(bad, adapters.HEADER_ERROR) == "bad_request",
			"%s: want 400 bad_request: %s",
			extra,
			describe(bad),
		)
	}
}

// A session past its TTL, or the least recently used one past max_sessions, is
// forgotten: its next request starts with an empty jar.
@(test)
serve_sessions_expire_and_evict :: proc(t: ^testing.T) {
	origin, ok := origin_start(t)

	if !ok {
		return
	}

	defer origin_stop(origin)

	{
		s, started := serve_start(t, {threads = 1, max_sessions = 1})

		if !started {
			return
		}

		defer serve_stop(s)
		port := s.server.port
		a := render(port, origin.port, "/whoami", "&session=a&cookies=k%3Da")
		reply_destroy(&a)
		b := render(port, origin.port, "/whoami", "&session=b&cookies=k%3Db")
		reply_destroy(&b)
		kept := render(port, origin.port, "/whoami", "&session=b")
		defer reply_destroy(&kept)
		testing.expectf(t, element_text(kept.body, "hdr") == "k=b", "b lost its jar: %s", describe(kept))
		evicted := render(port, origin.port, "/whoami", "&session=a")
		defer reply_destroy(&evicted)
		testing.expectf(t, element_text(evicted.body, "hdr") == "", "a survived its eviction: %s", describe(evicted))
	}

	{
		s, started := serve_start(t, {threads = 1, session_ttl_ms = 1})

		if !started {
			return
		}

		defer serve_stop(s)
		port := s.server.port
		a := render(port, origin.port, "/whoami", "&session=a&cookies=k%3Da")
		testing.expect_value(t, element_text(a.body, "hdr"), "k=a")
		reply_destroy(&a)
		time.sleep(5 * time.Millisecond)
		expired := render(port, origin.port, "/whoami", "&session=a")
		defer reply_destroy(&expired)
		testing.expectf(t, element_text(expired.body, "hdr") == "", "a outlived its TTL: %s", describe(expired))
	}
}

// The proxy fixture's credentials, `u:p`, as Basic.
@(private = "file")
PROXY_AUTH :: "Proxy-Authorization: Basic dTpw\r\n"

// A fixture HTTP proxy: it answers absolute-form requests itself (a document whose
// script fetches /data, and /data naming the target it was asked for), answers CONNECT
// with 200 and then closes (no TLS server behind it: the handshake fails), and answers
// 407 to a request without PROXY_AUTH. It records the last CONNECT request line.
@(private = "file")
Proxy_Fixture :: struct {
	listener:     net.TCP_Socket,
	port:         int,
	thread:       ^thread.Thread,
	mutex:        sync.Mutex,
	last_connect: [256]byte,
	connect_len:  int,
}

@(private = "file")
proxy_start :: proc(t: ^testing.T) -> (p: ^Proxy_Fixture, ok: bool) {
	listener, err := net.listen_tcp({net.IP4_Loopback, 0})

	if !testing.expectf(t, err == nil, "fixture proxy: listen: %v", err) {
		return nil, false
	}

	endpoint, _ := net.bound_endpoint(listener)
	p = new(Proxy_Fixture, runtime.heap_allocator())
	p.listener = listener
	p.port = endpoint.port
	p.thread = thread.create_and_start_with_poly_data(p, proxy_serve)
	return p, true
}

@(private = "file")
proxy_stop :: proc(p: ^Proxy_Fixture) {
	net.shutdown(p.listener, .Both)
	thread.join(p.thread)
	thread.destroy(p.thread)
	net.close(p.listener)
	free(p, runtime.heap_allocator())
}

@(private = "file")
proxy_last_connect :: proc(p: ^Proxy_Fixture) -> string {
	sync.guard(&p.mutex)
	return strings.clone(string(p.last_connect[:p.connect_len]), context.temp_allocator)
}

@(private = "file")
proxy_serve :: proc(p: ^Proxy_Fixture) {
	for {
		client, _, err := net.accept_tcp(p.listener)

		if err != nil {
			return
		}

		request: [4096]byte
		n := 0
		for !strings.contains(string(request[:n]), "\r\n\r\n") {
			got, rerr := net.recv_tcp(client, request[n:])

			if rerr != nil || got == 0 || n + got == len(request) {
				break
			}

			n += got
		}

		head := string(request[:n])
		line := strings.truncate_to_byte(head, '\r')
		method, _, after_method := strings.partition(line, " ")
		target, _, _ := strings.partition(after_method, " ")
		out: [1024]byte
		body: [512]byte
		response: string

		if method == "CONNECT" {
			sync.lock(&p.mutex)
			p.connect_len = copy(p.last_connect[:], line)
			sync.unlock(&p.mutex)
		}

		switch {
		case !strings.contains(head, PROXY_AUTH):
			response = "HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
		case method == "CONNECT":
			response = "HTTP/1.1 200 Connection established\r\n\r\n"
		case strings.has_suffix(target, "/data"):
			text := fmt.bprintf(body[:], "proxied %s", target)
			response = fmt.bprintf(
				out[:],
				"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s",
				len(text),
				text,
			)
		case:
			text :=
				`<!doctype html><body><p id="f">pending</p><script>fetch('http://127.0.0.1:1/data')` +
				`.then((r) => r.text()).then((t) => { document.getElementById('f').textContent = t; })</script></body>`
			response = fmt.bprintf(
				out[:],
				"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s",
				len(text),
				text,
			)
		}

		net.send_tcp(client, transmute([]byte)response)
		net.close(client)
	}
}

// proxy_param is `&proxy=http://<credentials>@127.0.0.1:<port>`, encoded.
@(private = "file")
proxy_param :: proc(credentials: string, port: int) -> string {
	url := fmt.tprintf("http://%s@127.0.0.1:%d", credentials, port)
	return fmt.tprintf("&proxy=%s", net.percent_encode(url, context.temp_allocator))
}

// A request with `proxy` goes through it: the document in absolute-form with the
// credentials, the page's own fetch() too (the target's port is 1, where nothing
// listens, so nothing went direct), and an https target through CONNECT with the
// credentials. A proxy that wants other credentials, or cannot be reached, is
// proxy_failed — not navigation_failed.
@(test)
serve_routes_through_a_proxy :: proc(t: ^testing.T) {
	px, ok := proxy_start(t)

	if !ok {
		return
	}

	defer proxy_stop(px)
	s, started := serve_start(t, {threads = 1})

	if !started {
		return
	}

	defer serve_stop(s)
	port := s.server.port
	via := proxy_param("u:p", px.port)
	doc := net.percent_encode("http://127.0.0.1:1/doc", context.temp_allocator)
	secure := net.percent_encode("https://example.test/x", context.temp_allocator)

	r := request(port, fmt.tprintf("/render?url=%s%s", doc, via))
	defer reply_destroy(&r)
	testing.expectf(t, r.status == 200, "through the proxy: %s", describe(r))
	testing.expect_value(t, element_text(r.body, "f"), "proxied http://127.0.0.1:1/data")

	tls := request(port, fmt.tprintf("/render?url=%s%s", secure, via))
	defer reply_destroy(&tls)
	testing.expect_value(t, proxy_last_connect(px), "CONNECT example.test:443 HTTP/1.1")
	testing.expectf(
		t,
		tls.status == 502 && reply_header(tls, adapters.HEADER_ERROR) == "navigation_failed",
		"no TLS server behind the tunnel: %s",
		describe(tls),
	)

	wrong := proxy_param("u:x", px.port)
	for target in ([]string{doc, secure}) {
		denied := request(port, fmt.tprintf("/render?url=%s%s", target, wrong))
		defer reply_destroy(&denied)
		testing.expectf(
			t,
			denied.status == 502 && reply_header(denied, adapters.HEADER_ERROR) == "proxy_failed",
			"%s with the wrong credentials: %s",
			target,
			describe(denied),
		)
	}

	gone := request(port, fmt.tprintf("/render?url=%s&proxy=http%%3A%%2F%%2F127.0.0.1%%3A1", doc))
	defer reply_destroy(&gone)
	testing.expectf(
		t,
		gone.status == 502 && reply_header(gone, adapters.HEADER_ERROR) == "proxy_failed",
		"an unreachable proxy: %s",
		describe(gone),
	)

	bad := request(port, fmt.tprintf("/render?url=%s&proxy=socks5%%3A%%2F%%2Fx", doc))
	defer reply_destroy(&bad)
	testing.expectf(t, bad.status == 400, "a socks proxy: %s", describe(bad))
}
