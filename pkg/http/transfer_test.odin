#+build linux
package larva_http

import "base:runtime"
import "core:bytes"
import "core:fmt"
import "core:net"
import "core:strings"
import "core:sync"
import "core:testing"
import "core:thread"
import "core:time"
import eventloop "lava:pkg/runtime/eventloop"

// fetch() end to end: a loopback server (serve_fixtures) sends the content-coding fixtures,
// and the tests drive the transfer through the event loop. Where the decode runs, and
// what destroying the loop under a fetch does, are this client's own and have no oracle.

// fetch() decodes the final response's body: a real request to a loopback server sending
// the recorded fixtures with their Content-Encoding comes back with the bytes Chrome
// decoded, or fails where Chrome failed. 127.0.0.1 is a secure context, so br is offered
// and accepted.
@(test)
fetch_decodes_the_response_body :: proc(t: ^testing.T) {
	server, ok := fixture_server_start(t)

	if !ok {
		return
	}

	defer fixture_server_stop(&server)

	// `redirect` answers 302 to /br/br, its own body gzip-encoded as servers that compress
	// every text/html response send it: the coding is the redirect's, not the final one's.
	cases := [?]struct {
		name:     string,
		encoding: string,
	}{{"gzip", "gzip"}, {"br", "br"}, {"gzip-corrupt", "gzip"}, {"br/br", "redirect"}}

	for c in cases {
		resp: Response
		loop := eventloop.init(real_time = true)
		url := fmt.tprintf("http://127.0.0.1:%d/%s/%s", server.port, c.encoding, c.name)
		err := fetch(&loop, {url = url}, keep_response, &resp)
		testing.expectf(t, err == .None, "%s: fetch: %v", c.name, err)
		eventloop.run(&loop)
		eventloop.destroy(&loop)
		defer response_destroy(&resp)
		name := c.name[strings.last_index_byte(c.name, '/') + 1:]

		if want, ok := find_fixture(strings.concatenate({name, ".out"}, context.temp_allocator)); ok {
			testing.expectf(t, resp.error == .None, "fetch %s: want the body Chrome decoded, got %v", c.name, resp.error)
			testing.expectf(
				t,
				bytes.equal(resp.body[:], want),
				"fetch %s: want %q, got %d bytes %q",
				c.name,
				clip(want),
				len(resp.body),
				clip(resp.body[:]),
			)
		} else {
			testing.expectf(t, resp.error == .Decoding, "fetch %s: Chrome failed it, got %v", c.name, resp.error)
			// A failed response carries the error and the URL, nothing of what was received.
			testing.expectf(
				t,
				resp.status == 0 && len(resp.headers) == 0 && len(resp.body) == 0,
				"fetch %s: failed, yet status %d, %d headers, %d body bytes",
				c.name,
				resp.status,
				len(resp.headers),
				len(resp.body),
			)
		}

		if c.encoding == "redirect" {
			testing.expectf(t, resp.redirects == 1, "fetch %s: want 1 redirect, got %d", c.name, resp.redirects)
		}
	}
}

// Decoding runs off the loop thread with the transfer's timer still armed: a timeout that
// comes due while the body decodes ends the fetch with .Timeout, and the decode, when it
// returns, frees what it held (the runner fails the test on a leak). Every pool worker is
// kept busy first, so the decode is still queued when the timer fires; decoded on the loop
// thread, the body would be ready long before it.
@(test)
fetch_times_out_while_the_body_decodes :: proc(t: ^testing.T) {
	TIMEOUT_MS :: 200
	BUSY :: 600 * time.Millisecond

	server, ok := fixture_server_start(t)

	if !ok {
		return
	}

	defer fixture_server_stop(&server)

	busy :: proc(_: rawptr) {
		time.sleep(BUSY)
	}

	resp: Response
	loop := eventloop.init(real_time = true)
	for _ in 0 ..< eventloop.THREADPOOL_SIZE {
		testing.expect(t, eventloop.pool_submit(&loop, busy, nil), "pool_submit")
	}

	// Above INLINE_DECODE_MAX, so it is the pool's to decode.
	url := fmt.tprintf("http://127.0.0.1:%d/gzip/gzip-incompressible", server.port)
	err := fetch(&loop, {url = url, timeout_ms = TIMEOUT_MS}, keep_response, &resp)
	testing.expectf(t, err == .None, "fetch: %v", err)
	eventloop.run(&loop)
	eventloop.destroy(&loop)
	defer response_destroy(&resp)
	testing.expectf(t, resp.error == .Timeout, "want Timeout while the body decodes, got %v", resp.error)
	testing.expectf(t, len(resp.body) == 0, "a timed-out fetch kept %d body bytes", len(resp.body))
}

// A small body with one gzip, deflate or zstd coding is decoded on the loop thread, its
// output capped (INLINE_DECODE_MAX, INLINE_OUTPUT_MAX); everything else goes to the pool.
// With every worker kept busy past the timeout, a body sent to the pool times out, and
// one decoded inline is ready at once: the timeout tells the two apart. br and a chain
// stay off the loop whatever their size, and a small body whose output passes the cap is
// handed to the pool, which, once free, still decodes it whole from its original bytes.
@(test)
small_single_coding_bodies_decode_on_the_loop_thread :: proc(t: ^testing.T) {
	TIMEOUT_MS :: 200
	BUSY :: 600 * time.Millisecond

	server, ok := fixture_server_start(t)

	if !ok {
		return
	}

	defer fixture_server_stop(&server)

	busy :: proc(_: rawptr) {
		time.sleep(BUSY)
	}

	cases := [?]struct {
		target:    string,
		busy_pool: bool,
		want:      Error,
		want_len:  int,
	} {
		{"gzip/gzip", true, .None, 20},
		{"deflate/deflate-zlib", true, .None, 20},
		{"zstd/zstd", true, .None, 20},
		{"br/br", true, .Timeout, 0},
		{"deflate,gzip/stack-deflate-gzip", true, .Timeout, 0},
		{"gzip/limit-gzip", true, .Timeout, 0},
		{"gzip/limit-gzip", false, .None, 64 * 1024},
	}

	for c in cases {
		resp: Response
		loop := eventloop.init(real_time = true)

		if c.busy_pool {
			for _ in 0 ..< eventloop.THREADPOOL_SIZE {
				testing.expect(t, eventloop.pool_submit(&loop, busy, nil), "pool_submit")
			}
		}

		url := fmt.tprintf("http://127.0.0.1:%d/%s", server.port, c.target)
		err := fetch(&loop, {url = url, timeout_ms = TIMEOUT_MS}, keep_response, &resp)
		testing.expectf(t, err == .None, "%s: fetch: %v", c.target, err)
		eventloop.run(&loop)
		eventloop.destroy(&loop)
		testing.expectf(
			t,
			resp.error == c.want,
			"%s, pool busy %v: want %v, got %v",
			c.target,
			c.busy_pool,
			c.want,
			resp.error,
		)
		testing.expectf(t, len(resp.body) == c.want_len, "%s: want %d bytes, got %d", c.target, c.want_len, len(resp.body))
		response_destroy(&resp)
	}
}

// Destroying the loop with a fetch in flight finishes it: on_done runs, inside destroy,
// with .Cancelled, and nothing the transfer held is left behind (the runner fails the test
// on a leak). There is no Chrome counterpart: a torn-down engine shows no response at all.
// Each case stops the loop at a different point: before it ran, while the request waits
// on a server that never answers, while the lookup is queued behind busy workers, and
// while the decode is.
@(test)
destroying_the_loop_cancels_a_fetch_in_flight :: proc(t: ^testing.T) {
	BUSY :: 600 * time.Millisecond

	server, ok := fixture_server_start(t)

	if !ok {
		return
	}

	defer fixture_server_stop(&server)

	busy :: proc(_: rawptr) {
		time.sleep(BUSY)
	}

	stop :: proc(loop: ^eventloop.Loop, _: rawptr) {
		eventloop.begin_force_exit(loop)
	}

	Case :: struct {
		name:      string,
		target:    string,
		busy_pool: bool,
		run:       bool,
	}
	cases := [?]Case {
		{"not started", "127.0.0.1:%d/gzip/gzip", false, false},
		{"awaiting the response", "127.0.0.1:%d/stall/none", false, true},
		{"resolving", "localhost:%d/gzip/gzip", true, true},
		{"decoding", "127.0.0.1:%d/gzip/gzip-incompressible", true, true},
	}

	for c in cases {
		resp := Response {
			error = .None,
			status = -1,
		}
		loop := eventloop.init(real_time = true)

		if c.busy_pool {
			for _ in 0 ..< eventloop.THREADPOOL_SIZE {
				testing.expect(t, eventloop.pool_submit(&loop, busy, nil), "pool_submit")
			}
		}

		url := fmt.tprintf(strings.concatenate({"http://", c.target}, context.temp_allocator), server.port)
		err := fetch(&loop, {url = url}, keep_response, &resp)
		testing.expectf(t, err == .None, "%s: fetch: %v", c.name, err)

		if c.run {
			eventloop.set_timeout(&loop, stop, 150)
			eventloop.run(&loop)
		}

		testing.expectf(t, resp.status == -1, "%s: the fetch finished before the loop was destroyed", c.name)
		eventloop.destroy(&loop)
		testing.expectf(t, resp.error == .Cancelled, "%s: want Cancelled from destroy, got %v", c.name, resp.error)
		testing.expectf(t, resp.status == 0, "%s: on_done did not run", c.name)
		response_destroy(&resp)
	}
}

// A decode a worker has already taken when the loop is destroyed is settled by the pool's
// cancel, not its dispose: the worker may still be inside it. The transfer must still get
// .Cancelled, and the body must be freed once the worker lets go. The worker is held
// deterministically, not by timing: the fetch runs with an allocator that parks the first
// large allocation made off the test's thread (the decode's output buffer) until the test
// releases it, and the loop is torn down in its two halves around that release.
@(test)
destroying_the_loop_cancels_a_decode_a_worker_holds :: proc(t: ^testing.T) {
	server, ok := fixture_server_start(t)

	if !ok {
		return
	}

	defer fixture_server_stop(&server)

	gate := Parking_Allocator {
		backing     = context.allocator,
		test_thread = sync.current_thread_id(),
	}
	allocator := runtime.Allocator{parking_allocator_proc, &gate}

	// Stops the loop once the worker is parked inside the decode.
	// (A bound on the wait, so a fetch that never reaches its decode fails the test below
	// instead of hanging it.)
	stop :: proc(loop: ^eventloop.Loop, user_data: rawptr) {
		gate := cast(^Parking_Allocator)user_data
		gate.reached = sync.sema_wait_with_timeout(&gate.parked, 5 * time.Second)
		eventloop.begin_force_exit(loop)
	}

	resp := Response {
		status = -1,
	}
	loop := eventloop.init(real_time = true)
	url := fmt.tprintf("http://127.0.0.1:%d/gzip/gzip-incompressible", server.port)
	err := fetch(&loop, {url = url}, keep_response, &resp, allocator)
	testing.expectf(t, err == .None, "fetch: %v", err)
	eventloop.set_timeout(&loop, stop, 1, &gate)
	eventloop.run(&loop)

	testing.expect(t, gate.reached, "the decode never reached a worker")
	testing.expectf(t, resp.status == -1, "the fetch finished before the loop was destroyed")
	eventloop.close_begin(&loop)
	testing.expectf(t, resp.error == .Cancelled, "want Cancelled from destroy, got %v", resp.error)
	sync.sema_post(&gate.release)
	eventloop.close_finish(&loop)
	response_destroy(&resp)
}

// An on_done that destroy runs may call fetch again, on the loop being destroyed: the
// fetch is refused with .Cancelled rather than started on a loop that will never run it,
// and nothing of it is left behind.
@(test)
fetch_from_an_on_done_run_by_destroy_is_refused :: proc(t: ^testing.T) {
	Refetch :: struct {
		loop:  ^eventloop.Loop,
		first: Response,
		again: Error,
		calls: int,
	}

	refetch :: proc(resp: Response, user_data: rawptr) {
		r := cast(^Refetch)user_data
		r.first = resp
		r.calls += 1
		r.again = fetch(r.loop, {url = "http://127.0.0.1:9/", timeout_ms = 1}, keep_response, nil)
	}

	loop := eventloop.init(real_time = true)
	r := Refetch {
		loop  = &loop,
		again = .None,
	}
	err := fetch(&loop, {url = "http://127.0.0.1:9/"}, refetch, &r)
	testing.expectf(t, err == .None, "fetch: %v", err)
	eventloop.destroy(&loop)
	testing.expectf(t, r.calls == 1 && r.first.error == .Cancelled, "on_done: %d calls, %v", r.calls, r.first.error)
	testing.expectf(t, r.again == .Cancelled, "a fetch from inside destroy: want Cancelled, got %v", r.again)
	response_destroy(&r.first)
}

@(private = "file")
keep_response :: proc(resp: Response, user_data: rawptr) {
	(cast(^Response)user_data)^ = resp
}

@(private = "file")
Fixture_Server :: struct {
	listener: net.TCP_Socket,
	port:     int,
	thread:   ^thread.Thread,
}

@(private = "file")
fixture_server_start :: proc(t: ^testing.T) -> (s: Fixture_Server, ok: bool) {
	listener, err := net.listen_tcp({net.IP4_Loopback, 0})

	if !testing.expectf(t, err == nil, "listen: %v", err) {
		return {}, false
	}

	endpoint, _ := net.bound_endpoint(listener)
	return {listener, endpoint.port, thread.create_and_start_with_poly_data(listener, serve_fixtures)}, true
}

@(private = "file")
fixture_server_stop :: proc(s: ^Fixture_Server) {
	// Wakes the accept the server thread is blocked in.
	net.shutdown(s.listener, .Both)
	thread.join(s.thread)
	thread.destroy(s.thread)
	net.close(s.listener)
}

// serve_fixtures answers each connection on `listener` with the fixture its request
// target names, /<content-encoding>/<fixture>, until the listener is shut down.
@(private = "file")
serve_fixtures :: proc(listener: net.TCP_Socket) {
	for {
		client, _, err := net.accept_tcp(listener)

		if err != nil {
			return
		}

		serve_one(client)
		net.close(client)
	}
}

@(private = "file")
serve_one :: proc(client: net.TCP_Socket) {
	request: [4096]byte
	n := 0
	for !strings.contains(string(request[:n]), "\r\n\r\n") {
		got, err := net.recv_tcp(client, request[n:])

		if err != nil || got == 0 || n + got == len(request) {
			return
		}

		n += got
	}

	// "GET /<encoding>/<name> HTTP/1.1"
	line := strings.truncate_to_byte(string(request[:n]), '\r')
	_, _, after_method := strings.partition(line, " /")
	target, _, _ := strings.partition(after_method, " ")
	encoding, _, name := strings.partition(target, "/")
	head: [256]byte

	if encoding == "stall" {
		// Never answer: hold the connection until the client closes it, or for 2 s, so a
		// client that never closes fails its test rather than hanging the server's join.
		net.set_option(client, .Receive_Timeout, 2 * time.Second)
		for {
			got, err := net.recv_tcp(client, request[:])

			if err != nil || got == 0 {
				return
			}
		}
	}

	if encoding == "redirect" {
		body := find_in("gzip")
		response := fmt.bprintf(
			head[:],
			"HTTP/1.1 302 Found\r\nLocation: /%s\r\nContent-Type: text/html\r\nContent-Encoding: gzip\r\nContent-Length: %d\r\nConnection: close\r\n\r\n",
			name,
			len(body),
		)
		net.send_tcp(client, transmute([]byte)response)
		net.send_tcp(client, body)
		return
	}

	body := find_in(name)
	response := fmt.bprintf(
		head[:],
		"HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Encoding: %s\r\nContent-Length: %d\r\nConnection: close\r\n\r\n",
		encoding,
		len(body),
	)
	net.send_tcp(client, transmute([]byte)response)
	net.send_tcp(client, body)
}

// find_in returns `<name>.in` without allocating: the fixture server's thread runs in the
// default context, outside the test's tracking.
@(private = "file")
find_in :: proc(name: string) -> []byte {
	for f in fixtures {
		if strings.has_prefix(f.name, name) && f.name[len(name):] == ".in" {
			return f.data
		}
	}

	return nil
}

// Parking_Allocator forwards to `backing`, except that the first allocation of at least
// 16 KiB made on a thread other than `test_thread` posts `parked` and waits on `release`.
@(private = "file")
Parking_Allocator :: struct {
	backing:     runtime.Allocator,
	test_thread: int,
	parked:      sync.Sema,
	release:     sync.Sema,
	used:        bool,
	reached:     bool,
}

@(private = "file")
parking_allocator_proc :: proc(
	allocator_data: rawptr,
	mode: runtime.Allocator_Mode,
	size, alignment: int,
	old_memory: rawptr,
	old_size: int,
	loc := #caller_location,
) -> (
	[]byte,
	runtime.Allocator_Error,
) {
	gate := cast(^Parking_Allocator)allocator_data
	grows := mode == .Alloc || mode == .Alloc_Non_Zeroed || mode == .Resize || mode == .Resize_Non_Zeroed

	if grows && size >= 16 * 1024 && sync.current_thread_id() != gate.test_thread {
		if !sync.atomic_exchange(&gate.used, true) {
			sync.sema_post(&gate.parked)
			sync.sema_wait(&gate.release)
		}
	}

	return gate.backing.procedure(gate.backing.data, mode, size, alignment, old_memory, old_size, loc)
}
