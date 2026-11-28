// Linux-only: the DOM is lexbor's and pkg/http's transport is Linux's.
#+build linux
package main

import "base:runtime"
import "core:fmt"
import "core:mem"
import "core:net"
import "core:strings"
import "core:testing"
import "core:thread"
import "core:time"
import html "lava:pkg/html"
import jsc "lava:pkg/jsc"
import lava "lava:pkg/runtime"
import eventloop "lava:pkg/runtime/eventloop"

// A page with an http(s) URL fetches its `<script src>` over the network
// (pkg/runtime/page_script.odin, docs/LARVA.md roadmap item 1), on its own loop, with the
// parser paused under a parser-blocking script. No recording covers it — tests/dom serves
// its page cases' scripts from disk — so these are Lava-only: order and DOM against what
// HTML specifies, request headers and cookies against what the fixture origin demands,
// and what a page closed with a fetch in flight gives back.

// The fixture origin's scripts. /b.js sets a cookie that /d.js demands, with the script
// request headers, so `d` in the log proves both: the origin answers 403 otherwise, and
// the script never runs.
@(private = "file")
SCRIPTS := [?]struct {
	path: string,
	body: string,
}{
	{"/b.js", `log.push(document.getElementById('after') === null ? 'b:paused' : 'b:late');`},
	{"/d.js", `log.push('d:' + (document.readyState));`},
	{"/a.js", `window.asyncRan = (window.asyncRan || 0) + 1;`},
	{"/latin1.js", "log.push('caf\xe9');"},
}

@(private = "file")
Script_Origin :: struct {
	listener: net.TCP_Socket,
	port:     int,
	thread:   ^thread.Thread,
}

@(private = "file")
script_origin_start :: proc(t: ^testing.T) -> (o: ^Script_Origin, ok: bool) {
	listener, err := net.listen_tcp({net.IP4_Loopback, 0})

	if !testing.expectf(t, err == nil, "fixture origin: listen: %v", err) {
		return nil, false
	}

	endpoint, _ := net.bound_endpoint(listener)
	o = new(Script_Origin, runtime.heap_allocator())
	o.listener = listener
	o.port = endpoint.port
	o.thread = thread.create_and_start_with_poly_data(o, script_origin_serve)
	return o, true
}

@(private = "file")
script_origin_stop :: proc(o: ^Script_Origin) {
	net.shutdown(o.listener, .Both)
	thread.join(o.thread)
	thread.destroy(o.thread)
	net.close(o.listener)
	free(o, runtime.heap_allocator())
}

// script_origin_serve answers one request per connection, serially. /d.js answers 403
// unless the request carries the cookie /b.js set and a script request's headers, with
// the page's URL as Referer. It allocates nothing: its thread runs in the default
// context, outside the tests' tracking.
@(private = "file")
script_origin_serve :: proc(o: ^Script_Origin) {
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

		head := string(request[:n])
		line := strings.truncate_to_byte(head, '\r')
		_, _, after_method := strings.partition(line, " ")
		target, _, _ := strings.partition(after_method, " ")
		status, body, extra := "404 Not Found", "", ""
		content_type := "text/javascript"
		for s in SCRIPTS {
			if s.path == target {
				status, body = "200 OK", s.body
			}
		}

		referer: [128]byte
		page_url := fmt.bprintf(referer[:], "Referer: http://127.0.0.1:%d/dir/page.html\r\n", o.port)

		switch target {
		case "/b.js":
			extra = "Set-Cookie: s=1; Path=/\r\n"
		case "/d.js":
			if !strings.contains(head, "\r\nCookie: s=1\r\n") ||
			   !strings.contains(head, "\r\nSec-Fetch-Dest: script\r\n") ||
			   !strings.contains(head, "\r\nSec-Fetch-Mode: no-cors\r\n") ||
			   !strings.contains(head, "\r\nSec-Fetch-Site: same-origin\r\n") ||
			   !strings.contains(head, page_url) {
				status, body = "403 Forbidden", "log.push('d:headers');"
			}
		case "/latin1.js":
			content_type = "text/javascript; charset=iso-8859-1"
		}

		out: [512]byte
		response := fmt.bprintf(
			out[:],
			"HTTP/1.1 %s\r\nContent-Type: %s\r\n%sContent-Length: %d\r\nConnection: close\r\n\r\n",
			status,
			content_type,
			extra,
			len(body),
		)
		net.send_tcp(client, transmute([]byte)response)
		net.send_tcp(client, transmute([]byte)body)
		net.close(client)
	}
}

// run_network_page runs `markup` as the document at http://127.0.0.1:<port>/dir/page.html
// on a loop of its own, and returns the serialization (context.allocator).
@(private = "file")
run_network_page :: proc(port: int, markup: string) -> string {
	url := fmt.tprintf("http://127.0.0.1:%d/dir/page.html", port)
	loop := eventloop.init(real_time = true)
	result, output := lava.run_html_page(transmute([]byte)markup, url, &loop, origin = url)
	lava.result_destroy(&result)
	return output
}

// Parser-blocking, defer and async scripts from the network, in HTML's order: the
// blocking one runs with the parser paused before the markup after it (so #after is not
// there yet), the inline script after it waits for it, the defer one runs once the
// document is parsed and before DOMContentLoaded, and `load` waits for the async one.
// Relative and absolute `src`s both resolve against the page's URL, and a Content-Type
// charset decodes the body.
@(test)
page_network_scripts_run_in_document_order :: proc(t: ^testing.T) {
	o, ok := script_origin_start(t)

	if !ok {
		return
	}

	defer script_origin_stop(o)
	markup := fmt.tprintf(
		`<body><script>var log = [];
document.addEventListener('DOMContentLoaded', function () {{ log.push('dcl'); }});
addEventListener('load', function () {{
  document.body.setAttribute('data-log', log.join(','));
  document.body.setAttribute('data-async', String(window.asyncRan));
}});
</script><script async src="http://127.0.0.1:%d/a.js"></script>
<script src="/b.js"></script><p id="after"></p><script defer src="../d.js"></script><script>log.push('inline');</script>
<script src="/latin1.js"></script></body>`,
		o.port,
	)
	output := run_network_page(o.port, markup)
	defer delete(output)
	testing.expectf(
		t,
		strings.contains(output, `data-log="b:paused,inline,café,d:interactive,dcl"`),
		"the page saw: %s",
		output,
	)
	testing.expectf(t, strings.contains(output, `data-async="1"`), "the async script did not run: %s", output)
}

// A script the origin answers 404 for fires `error` at its element, never runs, and the
// parser goes on with the rest of the document.
@(test)
page_network_script_404_fires_error :: proc(t: ^testing.T) {
	o, ok := script_origin_start(t)

	if !ok {
		return
	}

	defer script_origin_stop(o)
	markup := `<body><script>var r = [];
document.addEventListener('error', function (e) { r.push('error ' + e.target.id); }, true);
document.addEventListener('load', function (e) { if (e.target !== document) r.push('load ' + e.target.id); }, true);
</script><script id=missing src="/missing.js"></script><script id=ok src="/a.js"></script>
<script>r.push('after ' + window.asyncRan); document.body.setAttribute('data-r', r.join(','));</script></body>`
	output := run_network_page(o.port, markup)
	defer delete(output)
	testing.expectf(
		t,
		strings.contains(output, `data-r="error missing,load ok,after 1"`),
		"the page saw: %s",
		output,
	)
}

// A page closed while its parser waits on a script fetch — the origin accepts the
// connection and never answers — cancels the fetch with its loop and gives every byte
// back, through the page's allocator. As a limit kill or a crawl deadline ends one.
@(test)
page_network_script_in_flight_is_freed_with_the_page :: proc(t: ^testing.T) {
	// Never accepted: the connection completes in the backlog and no answer comes.
	listener, err := net.listen_tcp({net.IP4_Loopback, 0})

	if !testing.expectf(t, err == nil, "listen: %v", err) {
		return
	}

	defer net.close(listener)
	endpoint, _ := net.bound_endpoint(listener)
	url := fmt.tprintf("http://127.0.0.1:%d/page.html", endpoint.port)

	track: mem.Tracking_Allocator
	mem.tracking_allocator_init(&track, context.allocator)
	defer mem.tracking_allocator_destroy(&track)
	track.bad_free_callback = mem.tracking_allocator_bad_free_callback_add_to_array

	{
		context.allocator = mem.tracking_allocator(&track)
		page: lava.Page
		loop := new(eventloop.Loop, runtime.heap_allocator())
		defer free(loop, runtime.heap_allocator())
		loop^ = eventloop.init(real_time = true)
		loop.never_block = true

		if !testing.expect(t, lava.page_create(&page, url, loop, origin = url), "page_create failed") {
			result, _ := lava.page_close(&page)
			lava.result_destroy(&result)
			return
		}

		ctx := cast(jsc.JSContextRef)page.ctx
		testing.expect_value(t, lava.dom_install(ctx, page.state), "")
		lava.scripts_attach(&page, "", url, url)

		on_script :: proc(p: ^html.Parser, script: html.Node, user_data: rawptr) {
			lava.scripts_parser_reached(cast(^lava.Page)user_data, script)
		}

		markup := `<script src="/never.js"></script><script defer src="/never-d.js"></script>`
		html.parse_all(&page.state.dom.parser, transmute([]byte)markup, on_script, &page)
		scripts := &page.state.dom.scripts
		testing.expect(
			t,
			scripts.has_pending && scripts.pending.fetch != nil,
			"the blocking script is not waiting on a fetch",
		)

		// Far enough for the request to be written and the read to wait.
		for _ in 0 ..< 20 {
			lava.page_tick(&page)
			time.sleep(time.Millisecond)
		}

		testing.expect(t, scripts.pending.fetch != nil && scripts.pending.fetch.in_flight, "the fetch ended on its own")
		result, _ := lava.page_close(&page)
		lava.result_destroy(&result)
	}

	testing.expectf(t, len(track.allocation_map) == 0, "%d allocations outlived the page", len(track.allocation_map))
	testing.expectf(
		t,
		len(track.bad_free_array) == 0,
		"%d frees of memory the page never allocated",
		len(track.bad_free_array),
	)
}
