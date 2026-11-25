package lava_runtime

import "base:runtime"
import "core:c"
import "core:net"
import "core:strconv"
import "core:strings"
import "core:sync"
import jsc "lava:pkg/jsc"
import eventloop "lava:pkg/runtime/eventloop"
import pico "lava:pkg/runtime/picohttpparser"

// Fetch_Addr is one resolved address in the connect-fallback list (#145). A
// hostname resolves to up to one IPv4 and one IPv6 address (net.resolve); the
// connect path tries them in order (A then AAAA), advancing on failure.
Fetch_Addr :: struct {
	is_v6: bool,
	v4:    net.IP4_Address,
	v6:    net.IP6_Address,
}

// Native backing for the WHATWG `fetch`. The JavaScript surface (Headers /
// Request / Response / Body) lives in js/internal/fetch.js; this file provides
// the single `native.request` primitive it calls, plus the HTTP/1.1 request
// serialization and response parsing. The actual non-blocking socket transport
// is platform code (fetch_linux.odin / fetch_other.odin) so this file stays
// OS-agnostic.
//
// The promise is created in JS — fetch.js wraps native.request in `new
// Promise(...)` and passes the success/failure callbacks in — so the native
// side needs no JSObjectMakeDeferredPromise binding; it simply invokes one of
// those two callbacks exactly once when the request settles.
//
// Scope: http:// and https:// (TLS via a platform TLS backend; see
// fetch_transport.odin) on Linux, macOS, and Windows. DNS is blocking off the loop; the transport runs
// non-blocking on the event loop. Platforms with no transport reject the network
// call entirely. See ROADMAP.

// FETCH_MAX_HEADER_BYTES caps the response head buffer (req.response, which
// accumulates only until the CRLFCRLF terminator). A server that never sends the
// terminator would otherwise grow this without bound — an OOM vector. The body
// itself is streamed (never buffered here), so this bounds the head alone. Set
// generously above any realistic header set.
FETCH_MAX_HEADER_BYTES :: 256 * 1024

// FETCH_MAX_CHUNK_LINE caps a single Transfer-Encoding: chunked size line. The
// carry buffer holds only undecoded framing (size lines + inter-chunk CRLFs),
// never bulk data; a size line that never terminates must not grow it without
// bound. A real chunk-size line is a handful of hex digits, so 16 KiB is ample.
FETCH_MAX_CHUNK_LINE :: 16 * 1024

Fetch_Phase :: enum {
	Connecting,
	TLS_Handshake, // https only: drive SSL_connect between Connecting and Writing
	Writing, // sending the request head (and, for buffered bodies, the body)
	Body_Write, // streaming an upload body incrementally as chunked frames
	Reading,
}

// Chunk_State tracks the incremental Transfer-Encoding: chunked decoder. The body
// arrives in arbitrary socket reads, so the decoder must resume mid-size-line or
// mid-chunk across calls (see fetch_feed_chunked).
Chunk_State :: enum {
	Size, // accumulating the hex chunk-size line up to its CRLF
	Data, // copying chunk_remaining data bytes straight through to the consumer
	Data_CRLF, // consuming the CRLF that terminates a chunk's data
	Done, // saw the zero-length terminator — body complete
}

// Fetch_Request owns everything an in-flight request needs. It outlives the
// native call that created it: the JS callbacks are GC-protected and the struct
// is heap-allocated, settled later from an event-loop I/O callback. A settled
// request is queued onto pending_free and reclaimed on a later request (or at
// teardown). It must outlive two things: an in-flight fetch_drive_read_cb (tracked
// by drive_pending), and — on the pointer-based backends (epoll/kqueue/select) —
// any readiness event already copied into an in-flight platform_poll batch, which
// dispatches via the raw watcher pointer (held two iterations past settle via
// settle_tick). Stale io_uring poll completions can no longer reference it:
// unwatch_fd truly cancels the poll and invalidates its generation token (#183).
Fetch_Request :: struct {
	ctx:               jsc.JSContextRef,
	loop:              ^eventloop.Loop,
	on_response:       jsc.JSObjectRef, // GC-protected JS callback(headersObject) — fires when headers arrive
	on_error:          jsc.JSObjectRef, // GC-protected JS callback(messageString) — pre-headers failure
	on_chunk:          jsc.JSObjectRef, // GC-protected JS callback(Uint8Array) -> bool wantMore (body chunk)
	on_end:            jsc.JSObjectRef, // GC-protected JS callback(errorOrNull) — body complete/errored
	cancel_fn:         jsc.JSObjectRef, // GC-protected cancel handle (private data == this req)
	resume_fn:         jsc.JSObjectRef, // GC-protected resume handle (private data == this req)
	settled:           bool,

	// Streaming request-body (true chunked upload) state. When body_streaming,
	// request_bytes holds ONLY the head (Transfer-Encoding: chunked, no
	// Content-Length); body chunks are pulled one at a time from the JS producer
	// (on_body_drain → push_body_fn) and framed incrementally into body_out. See
	// the body-write state machine in fetch_transport.odin.
	body_streaming:    bool,
	on_body_drain:     jsc.JSObjectRef, // GC-protected: "ready for the next body chunk"
	push_body_fn:      jsc.JSObjectRef, // GC-protected callable(Uint8Array) (private == this req)
	end_body_fn:       jsc.JSObjectRef, // GC-protected callable(errorOrNull) (private == this req)
	body_out:          [dynamic]byte, // the current framed chunk awaiting the socket
	body_out_off:      int, // bytes of body_out already written
	body_end_seen:     bool, // producer signalled end-of-body; terminator pending
	body_term_written: bool, // the zero-size terminating chunk was appended to body_out
	body_idle:         bool, // awaiting the next chunk from the producer (fd unwatched)
	body_loop_held:    bool, // a loop keep-alive is held for the whole body-write phase

	// Owned copies (the JSC-derived strings they came from do not outlive the call).
	// allocator owns every heap allocation below (the struct itself, the cloned
	// strings, and request_bytes). It is captured from the owning Runtime_State at
	// creation rather than read from the ambient context, because these are cloned
	// inside a `proc "c"` (where context is reset to runtime.default_context) but
	// freed by fetch_free_request from TWO contexts — fetch_reclaim_pending (normal
	// operation) and fetch_destroy_pending (teardown). Routing alloc+free through
	// this stored allocator keeps the pair matched regardless of the active context.
	// (The dynamic-array fields response/carry/body_out carry their own bound
	// allocator, so delete() frees them correctly without help here.)
	allocator:         runtime.Allocator,
	url:               string,
	host:              string,
	path:              string,
	method:            string,
	port:              int,
	request_bytes:     []byte,
	write_offset:      int,

	// DNS for a hostname runs on the loop's generic worker pool (#77, fetch_dns.odin):
	// the lookup result lives on a DNS_Job, not on the request, and the connect is
	// driven from dns_resolve_done on the loop thread. While a lookup is outstanding the
	// request is pinned via drive_pending (so a cancel mid-lookup cannot free it under
	// the pending completion).
	//
	// Resolved-address list + cursor (#145): a hostname resolves to up to one IPv4
	// and one IPv6 address (ordered A then AAAA); fetch_advance_connect tries them in
	// turn, advancing on a connect failure and settling an error only when the list
	// is exhausted. A literal host bypasses this (addr_count stays 0, single connect).
	addrs:             [2]Fetch_Addr,
	addr_count:        int,
	addr_index:        int,
	// Back-pointer to this request's outstanding DNS job (nil unless a pool lookup
	// is in flight), so an abort can cancel a still-queued lookup. Set by
	// fetch_dns_submit, cleared by its completion; loop-thread-only.
	dns_job:           ^DNS_Job,
	response:          [dynamic]byte, // accumulates bytes until the header terminator is found
	// Length of `response` passed to picohttpparser on the previous (incomplete) head
	// parse — the `last_len` resume hint, so each read re-scans only new bytes for the
	// CRLFCRLF terminator rather than the whole accumulated head. 0 until the first read.
	head_last_len:     int,
	watcher:           eventloop.IO_Watcher,
	fd:                uintptr,
	has_fd:            bool,
	phase:             Fetch_Phase,

	// Streaming response-body state. The transport delivers status + headers as
	// soon as they are parsed (on_response), then pushes decoded body bytes
	// incrementally (on_chunk) until the framing completes (on_end). No full-body
	// buffer is kept; only a small carry holds undecoded chunked framing bytes.
	headers_done:      bool,
	no_body:           bool, // HEAD / 204 / 304 / … — settle with a null body, no read
	body_is_chunked:   bool,
	body_len:          int, // declared Content-Length; -1 == read until EOF
	body_seen:         int, // body bytes delivered so far (Content-Length accounting)
	body_done:         bool, // framing reached its end (final chunk / Content-Length met)
	chunk_state:       Chunk_State,
	chunk_remaining:   int, // data bytes left in the current chunk (Chunk_State.Data)
	carry:             [dynamic]byte, // undecoded chunked framing bytes spanning reads
	read_paused:       bool, // socket reads suspended for backpressure (consumer saturated)
	want_pause:        bool, // a delivered chunk reported the consumer is full this turn
	drive_pending:     int, // queued drive completions (read resume / body drain) referencing this req
	settle_tick:       u64, // loop iteration at settle; reclaim holds the req two ticks past it

	// TLS state for https:// requests. is_https gates the TLS path in the
	// transport; tls is an opaque per-backend session handle kept as rawptr so this
	// cross-platform struct stays free of any TLS binding, set at handshake start and
	// released by fetch_tls_cleanup in fetch_request_finish.
	is_https:          bool,
	tls:               rawptr,
}

// fetch_cancel_class is a JSClass whose instances carry a ^Fetch_Request as
// private data and are callable — calling them tears down the in-flight request
// without invoking any JS callback (the JS side rejects the promise itself).
// The four streaming-handle classes are created once for the whole process and reused across every
// fetch call. JSClassRef is context-group-independent, so a single shared set is valid across all
// workers (Slice 3a); g_fetch_classes_once makes the lazy creation race-safe when N workers' first
// fetch() calls collide (previously an unsynchronized check-then-set per class). fetch_init_classes
// builds all four together — they're cheap (no I/O) and always needed as a set.
@(private = "file")
g_fetch_cancel_class: jsc.JSClassRef
@(private = "file")
g_fetch_classes_once: sync.Once

@(private = "file")
fetch_init_classes :: proc() {
	cancel_def := jsc.JSClassDefinition {
		class_name       = "FetchCancel",
		call_as_function = fetch_cancel_fn_cb,
	}
	g_fetch_cancel_class = jsc.JSClassCreate(&cancel_def)
	resume_def := jsc.JSClassDefinition {
		class_name       = "FetchResume",
		call_as_function = fetch_resume_fn_cb,
	}
	g_fetch_resume_class = jsc.JSClassCreate(&resume_def)
	push_def := jsc.JSClassDefinition {
		class_name       = "FetchPushBody",
		call_as_function = fetch_push_fn_cb,
	}
	g_fetch_push_class = jsc.JSClassCreate(&push_def)
	end_def := jsc.JSClassDefinition {
		class_name       = "FetchEndBody",
		call_as_function = fetch_end_fn_cb,
	}
	g_fetch_end_class = jsc.JSClassCreate(&end_def)
}

fetch_get_cancel_class :: proc() -> jsc.JSClassRef {
	sync.once_do(&g_fetch_classes_once, fetch_init_classes)
	return g_fetch_cancel_class
}

// fetch_cancel_fn_cb tears down the request without invoking any JS callback.
// The JS caller rejects the promise with signal.reason after calling this. It
// also backs response-body stream cancellation (reader.cancel()): the JS stream
// calls this handle to abort an in-flight body it no longer wants.
fetch_cancel_fn_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	req := cast(^Fetch_Request)jsc.JSObjectGetPrivate(function)

	if req != nil && !req.settled {
		fetch_request_finish(req)
	}

	return jsc.JSValueMakeUndefined(ctx)
}

// fetch_get_resume_class mirrors fetch_get_cancel_class for the streaming-body
// backpressure resume handle: a callable JSObject whose private data is the
// ^Fetch_Request. The JS body stream calls it when a previously-saturated reader
// drains below the high-water mark, so the paused socket read is re-armed.
@(private = "file")
g_fetch_resume_class: jsc.JSClassRef

fetch_get_resume_class :: proc() -> jsc.JSClassRef {
	sync.once_do(&g_fetch_classes_once, fetch_init_classes)
	return g_fetch_resume_class
}

// fetch_resume_fn_cb re-arms a paused body read. A no-op unless the request is
// actually paused, so the stream may call it freely on every read.
fetch_resume_fn_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	req := cast(^Fetch_Request)jsc.JSObjectGetPrivate(function)

	if req != nil {
		fetch_resume_read(req)
	}

	return jsc.JSValueMakeUndefined(ctx)
}

// fetch_get_push_class / fetch_get_end_class mirror the cancel/resume classes for
// the streaming request-body channel: callable JSObjects whose private data is the
// ^Fetch_Request. The JS producer pump calls pushBody(chunk) to hand a body chunk
// to the transport and endBody(errorOrNull) to signal end-of-body (null) or a
// producer error (a string, which aborts the request).
@(private = "file")
g_fetch_push_class: jsc.JSClassRef
@(private = "file")
g_fetch_end_class: jsc.JSClassRef

fetch_get_push_class :: proc() -> jsc.JSClassRef {
	sync.once_do(&g_fetch_classes_once, fetch_init_classes)
	return g_fetch_push_class
}

fetch_get_end_class :: proc() -> jsc.JSClassRef {
	sync.once_do(&g_fetch_classes_once, fetch_init_classes)
	return g_fetch_end_class
}

// fetch_push_fn_cb hands one producer chunk (a Uint8Array) to the transport, which
// frames it as a chunked request-body frame and writes it (with backpressure). A
// nil private (request already settled/freed) or a non-typed-array argument is a
// safe no-op.
fetch_push_fn_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	req := cast(^Fetch_Request)jsc.JSObjectGetPrivate(function)

	if req != nil && !req.settled && argument_count >= 1 {
		if view, ok := typed_array_view(ctx, arguments[0]); ok {
			fetch_push_body(req, view)
		}
	}

	return jsc.JSValueMakeUndefined(ctx)
}

// fetch_end_fn_cb signals the end of the request body: a null/undefined argument is
// a clean end (write the terminating zero-size chunk), a string is a producer error
// that aborts the request (the fetch promise rejects).
fetch_end_fn_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	req := cast(^Fetch_Request)jsc.JSObjectGetPrivate(function)

	if req != nil && !req.settled {
		is_error :=
			argument_count >= 1 && !jsc.JSValueIsNull(ctx, arguments[0]) && !jsc.JSValueIsUndefined(ctx, arguments[0])

		if is_error {
			msg, alloc := jsc_value_to_string_or_default(ctx, arguments[0])
			defer if alloc {
				delete(msg, context.allocator)
			}
			fetch_settle_error(req, msg)
		} else {
			fetch_end_body(req)
		}
	}

	return jsc.JSValueMakeUndefined(ctx)
}

// fetch_body_hold_loop / fetch_body_release_loop bracket the streaming-upload
// (Body_Write) phase with a single loop keep-alive, so an in-flight chunked upload
// pins the process like Node's outgoing request socket — even while idle awaiting the
// producer, when the fd is unwatched. Idempotent and balanced via body_loop_held:
// held once when the body phase begins (fetch_after_write_head), released once when
// the body finishes (fetch_pump_body) or the request settles (fetch_request_finish).
// Unlike the per-pull async_begin in fetch_body_go_idle, this hold has no matching
// post_async, so it is released directly with async_cancel.
fetch_body_hold_loop :: proc(req: ^Fetch_Request) {
	if req.body_loop_held {
		return
	}

	req.body_loop_held = true
	eventloop.async_begin(req.loop)
}

fetch_body_release_loop :: proc(req: ^Fetch_Request) {
	if !req.body_loop_held {
		return
	}

	req.body_loop_held = false
	eventloop.async_cancel(req.loop)
}

// make_fetch_bindings builds the `native` object handed to js/internal/fetch.js.
make_fetch_bindings :: proc(ctx: jsc.JSContextRef) -> jsc.JSObjectRef {
	bindings := jsc.JSObjectMake(ctx, nil, nil)
	inject_native_function(ctx, bindings, "request", fetch_request_cb)
	return bindings
}

// request(method, url, headerLines, body, onResponse, onError, onChunk, onEnd) —
// start an HTTP request. headerLines is a pre-serialized "Name: Value\r\n" block
// from the JS Headers object; body is a Uint8Array or null/undefined.
//
// Streaming contract (see js/internal/fetch.js):
//   - onResponse({status, statusText, headers, hasBody}) fires once when the
//     response head is parsed — the promise resolves here, before the body.
//   - onChunk(Uint8Array) fires per decoded body chunk and returns a boolean:
//     true to keep reading, false to apply backpressure (pause the socket read).
//   - onEnd(errorOrNull) fires once when the body completes (null) or fails
//     (string) — closing or erroring the response body stream.
//   - onError(message) fires for a pre-headers failure (the promise rejects).
//
// Streaming upload (args 8/9): when streamBody is true the body is sent as
// Transfer-Encoding: chunked rather than buffered — arguments[3] carries no bytes;
// instead onBodyDrain (arg 9) fires when the transport is ready for the next chunk,
// the JS pump hands chunks back through the returned pushBody callable, and signals
// completion / a producer error through endBody.
//
// Returns { cancel, resume[, pushBody, endBody] } native callables: cancel tears
// the request down (abort / reader.cancel); resume re-arms a paused read; pushBody /
// endBody drive the streaming request body. Returns undefined on a synchronous
// reject (bad URL, no loop).
fetch_request_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()

	if argument_count < 8 {
		return jsc.JSValueMakeUndefined(ctx)
	}

	on_response := callback_arg(ctx, arguments[4])
	on_error := callback_arg(ctx, arguments[5])
	on_chunk := callback_arg(ctx, arguments[6])
	on_end := callback_arg(ctx, arguments[7])

	if on_response == nil || on_error == nil || on_chunk == nil || on_end == nil {
		return jsc.JSValueMakeUndefined(ctx)
	}

	// Streaming upload args (8: bool, 9: onBodyDrain). When the body is streamed,
	// arguments[3] carries no bytes — chunks arrive later via push_body_fn.
	stream_body := argument_count >= 9 && jsc.JSValueToBoolean(ctx, arguments[8])
	on_body_drain: jsc.JSObjectRef = nil

	if argument_count >= 10 {
		on_body_drain = callback_arg(ctx, arguments[9])
	}

	if stream_body && on_body_drain == nil {
		fetch_reject_now(ctx, on_error, "fetch: streaming body requires a drain callback")
		return jsc.JSValueMakeUndefined(ctx)
	}

	method, method_alloc := jsc_value_to_string_or_default(ctx, arguments[0])
	defer if method_alloc {
		delete(method, context.allocator)
	}
	url, url_alloc := jsc_value_to_string_or_default(ctx, arguments[1])
	defer if url_alloc {
		delete(url, context.allocator)
	}
	header_lines, header_alloc := jsc_value_to_string_or_default(ctx, arguments[2])
	defer if header_alloc {
		delete(header_lines, context.allocator)
	}

	host, port, path, scheme, ok := parse_http_url(url)

	if !ok {
		fetch_reject_now(ctx, on_error, "fetch: invalid URL")
		return jsc.JSValueMakeUndefined(ctx)
	}

	if scheme != "http" && scheme != "https" {
		fetch_reject_now(ctx, on_error, "fetch: unsupported URL scheme")
		return jsc.JSValueMakeUndefined(ctx)
	}

	loop := get_loop_from_ctx(ctx)

	if loop == nil {
		fetch_reject_now(ctx, on_error, "fetch: no event loop is bound to this context")
		return jsc.JSValueMakeUndefined(ctx)
	}

	// Capture the owning allocator from the Runtime_State (not the ambient proc "c"
	// context) so every clone below is freed through the same allocator at reclaim
	// AND at teardown. Falls back to context.allocator when there is no state, which
	// preserves the historical default-heap behavior.
	state := get_state_from_ctx(ctx)
	alloc := context.allocator

	if state != nil {
		alloc = state.allocator
	}

	// Reclaim any prior settled requests now that we are safely past the loop
	// iterations that settled them.
	if state != nil {
		fetch_reclaim_pending(state)
	}

	body: []byte

	if !stream_body {
		if view, has_body := typed_array_view(ctx, arguments[3]); has_body {
			body = view
		}
	}

	req := new(Fetch_Request, alloc)
	req.allocator = alloc
	req.ctx = ctx
	req.loop = loop
	// Every JS handle the request retains across loop turns goes through
	// js_root_set/js_root_clear (js_root.odin) — the protect and its release are
	// paired by the slot, not by hand at each site.
	js_root_set(ctx, &req.on_response, on_response)
	js_root_set(ctx, &req.on_error, on_error)
	js_root_set(ctx, &req.on_chunk, on_chunk)
	js_root_set(ctx, &req.on_end, on_end)
	req.body_streaming = stream_body
	js_root_set(ctx, &req.on_body_drain, on_body_drain)
	req.body_len = -1
	req.method = strings.clone(method, alloc)
	req.url = strings.clone(url, alloc)
	req.host = strings.clone(host, alloc)
	req.path = strings.clone(path, alloc)
	req.port = port // needed by the deferred connect after async DNS resolves
	req.is_https = scheme == "https"
	// Serialize while the JSC-borrowed `body`/`header_lines` are still valid; the
	// resulting buffer is independent of them.
	req.request_bytes = build_http_request(
		req.method,
		req.host,
		port,
		req.path,
		header_lines,
		body,
		req.is_https,
		stream_body,
		alloc,
	)

	// Build and GC-protect the cancel / resume handles before starting the
	// transport so the JS caller can cancel or resume even if the request settles
	// synchronously.
	cancel_fn := jsc.JSObjectMake(ctx, fetch_get_cancel_class(), req)
	js_root_set(ctx, &req.cancel_fn, cancel_fn)
	resume_fn := jsc.JSObjectMake(ctx, fetch_get_resume_class(), req)
	js_root_set(ctx, &req.resume_fn, resume_fn)
	// The streaming request-body channel: push/end callables backed by this req.
	// Keep local handles (like cancel/resume): a synchronous settle below clears
	// req.push_body_fn/end_body_fn, but the JSObjects stay valid (and become inert
	// no-ops once their private back-pointer is nulled), so the controls object can
	// still expose them.
	push_fn, end_fn: jsc.JSObjectRef

	if stream_body {
		push_fn = jsc.JSObjectMake(ctx, fetch_get_push_class(), req)
		js_root_set(ctx, &req.push_body_fn, push_fn)
		end_fn = jsc.JSObjectMake(ctx, fetch_get_end_class(), req)
		js_root_set(ctx, &req.end_body_fn, end_fn)
	}

	if state != nil {
		fetch_track_active(state, req)
	}

	started, err := fetch_transport_start(req, host, port)

	if !started {
		fetch_settle_error(req, err)
	}

	// The controls object wraps the handles; the JS side reads .cancel / .resume
	// (and .pushBody / .endBody for a streamed body). It is referenced by the JS
	// fetch closure until the request settles, so it needs no independent GC
	// protection (its handle properties are protected).
	controls := jsc.JSObjectMake(ctx, nil, nil)
	set_named(ctx, controls, "cancel", cast(jsc.JSValueRef)cancel_fn)
	set_named(ctx, controls, "resume", cast(jsc.JSValueRef)resume_fn)

	if stream_body {
		set_named(ctx, controls, "pushBody", cast(jsc.JSValueRef)push_fn)
		set_named(ctx, controls, "endBody", cast(jsc.JSValueRef)end_fn)
	}

	return cast(jsc.JSValueRef)controls
}

// parse_http_url splits an absolute http(s) URL into host, port, path, scheme.
// An IPv6 literal host ([::1]) is returned bracket-stripped (host == "::1");
// build_http_request re-brackets it for the Host header and the Linux transport
// connects over AF_INET6.
parse_http_url :: proc(url: string) -> (host: string, port: int, path: string, scheme: string, ok: bool) {
	rest := url
	switch {
	case strings.has_prefix(rest, "http://"):
		scheme = "http"
		rest = rest[7:]
	case strings.has_prefix(rest, "https://"):
		scheme = "https"
		rest = rest[8:]
	case:
		return "", 0, "", "", false
	}

	// The authority ends at the first '/', '?' or '#'; everything from there is
	// the request target. A query that sits directly after the authority
	// (http://host?x=1) must still produce an origin-form "/?x=1", and the
	// fragment ('#...') is never sent on the wire — build_http_request supplies
	// the leading '/'.
	authority := rest
	path = "/"
	auth_end := len(rest)
	for i in 0 ..< len(rest) {
		c := rest[i]

		if c == '/' || c == '?' || c == '#' {
			auth_end = i
			break
		}
	}

	if auth_end < len(rest) {
		authority = rest[:auth_end]
		target := rest[auth_end:]

		if hash := strings.index_byte(target, '#'); hash >= 0 {
			target = target[:hash]
		}

		path = target if len(target) > 0 else "/"
	}

	// Drop any userinfo (user:pass@host).
	if at := strings.last_index_byte(authority, '@'); at >= 0 {
		authority = authority[at + 1:]
	}

	host = authority
	port = 443 if scheme == "https" else 80

	if len(authority) > 0 && authority[0] == '[' {
		// IPv6 literal (RFC 3986 §3.2.2): the address itself contains colons, so
		// the host is the bytes inside the brackets and a ":port" suffix can only
		// follow the closing ']'. Strip the brackets here — the connect path wants
		// the bare address; build_http_request re-wraps it for the Host header.
		rb := strings.index_byte(authority, ']')

		if rb < 0 {
			return "", 0, "", "", false
		}

		host = authority[1:rb]
		rest_after := authority[rb + 1:]

		if len(rest_after) > 0 {
			// Only a ":port" may follow the IPv6 literal's closing ']' (RFC 3986
			// §3.2.2); any other trailing bytes ("[::1]foo") are malformed. new URL()
			// rejects these, so this parser must too — defense in depth for callers
			// that reach it directly.
			if rest_after[0] != ':' {
				return "", 0, "", "", false
			}

			p, p_ok := parse_authority_port(rest_after[1:])

			if !p_ok {
				return "", 0, "", "", false
			}

			if p >= 0 {
				port = p
			}
		}
	} else if colon := strings.last_index_byte(authority, ':'); colon >= 0 {
		host = authority[:colon]
		p, p_ok := parse_authority_port(authority[colon + 1:])

		if !p_ok {
			return "", 0, "", "", false
		}

		if p >= 0 {
			port = p
		}
	}

	if len(host) == 0 {
		return "", 0, "", "", false
	}

	ok = true
	return
}

// parse_authority_port validates the optional ":port" of an authority. An empty
// string (a bare trailing ':') is valid and keeps the scheme default in place
// (returns -1, true). A non-empty port must be all ASCII digits and fit
// 0..65535 — a non-numeric or out-of-range value is rejected (`ok == false`),
// mirroring the WHATWG URL parser, rather than silently truncating via u16 or
// falling back to port 80/443. The JS layer already validates through `new URL`,
// so this is defense in depth for any caller that reaches the native parser.
parse_authority_port :: proc(s: string) -> (port: int, ok: bool) {
	if len(s) == 0 {
		return -1, true
	}

	for c in transmute([]byte)s {
		if c < '0' || c > '9' {
			return -1, false
		}
	}
	p, p_ok := strconv.parse_int(s)

	if !p_ok || p < 0 || p > 65535 {
		return -1, false
	}

	return p, true
}

// fetch_parse_chunk_size parses an HTTP chunk-size field, which RFC 7230 defines as
// 1*HEXDIG — unsigned hex, no sign. The previous signed strconv.parse_int accepted
// "-1"/"+5" as valid syntax (a negative size then slipped through the decoder
// instead of being rejected as a framing error). This rejects an empty field, any
// non-hex byte (so a sign or stray space fails), and a value that would overflow a
// positive int. Returns (size, true) only for a well-formed non-negative size.
fetch_parse_chunk_size :: proc(s: string) -> (size: int, ok: bool) {
	if len(s) == 0 {
		return 0, false
	}

	v: u64
	limit := u64(max(int))
	for c in transmute([]byte)s {
		d: u64
		switch {
		case c >= '0' && c <= '9':
			d = u64(c - '0')
		case c >= 'a' && c <= 'f':
			d = u64(c - 'a' + 10)
		case c >= 'A' && c <= 'F':
			d = u64(c - 'A' + 10)
		case:
			return 0, false // non-hex byte (sign, space, etc.)
		}

		// Reject a size past the positive int range; such a chunk never legitimately
		// occurs and would otherwise wrap to a negative chunk_remaining.
		if v > (limit - d) / 16 {
			return 0, false
		}

		v = v * 16 + d
	}
	return int(v), true
}

// build_http_request serializes the request line, a Host header, the caller's
// header block, Connection: close (so the server frames the body by closing —
// we then read to EOF), the body framing, and (for a buffered body) the body
// bytes. With chunked=true it emits Transfer-Encoding: chunked and NO body /
// Content-Length — the body is streamed afterward as chunked frames (see the
// body-write state machine in fetch_transport.odin); otherwise it emits a
// Content-Length for a non-empty buffered body. The returned buffer is allocated
// on `alloc` (the owning request's allocator) and owned by the request, so it is
// freed through the same allocator by fetch_free_request.
build_http_request :: proc(
	method, host: string,
	port: int,
	path, header_lines: string,
	body: []byte,
	is_https: bool,
	chunked: bool,
	alloc: runtime.Allocator,
) -> []byte {
	b := strings.builder_make(alloc)
	strings.write_string(&b, method)
	strings.write_byte(&b, ' ')

	// Origin-form request target always begins with '/': a query-only path
	// ("?x=1", from http://host?x=1) gets the slash prepended here.
	if len(path) == 0 || path[0] != '/' {
		strings.write_byte(&b, '/')
	}

	strings.write_string(&b, path)
	strings.write_string(&b, " HTTP/1.1\r\n")

	strings.write_string(&b, "Host: ")
	// An IPv6 literal host arrives bracket-stripped (it is the only host that can
	// contain a colon); RFC 7230 §5.4 requires the Host header to re-wrap it in [].
	host_is_ip6 := strings.index_byte(host, ':') >= 0

	if host_is_ip6 {
		strings.write_byte(&b, '[')
	}

	strings.write_string(&b, host)

	if host_is_ip6 {
		strings.write_byte(&b, ']')
	}

	// Omit the port when it is the scheme's default (Node sends `Host: host`, not
	// `host:80` / `host:443`, when the default port was implicit in the URL).
	default_port := is_https ? 443 : 80

	if port != default_port {
		strings.write_byte(&b, ':')
		strings.write_int(&b, port)
	}

	strings.write_string(&b, "\r\n")

	strings.write_string(&b, header_lines) // each line already ends with \r\n
	strings.write_string(&b, "Connection: close\r\n")

	if chunked {
		// A streamed upload: frame the body with Transfer-Encoding: chunked and emit
		// no Content-Length / body here — chunks follow as chunked frames.
		strings.write_string(&b, "Transfer-Encoding: chunked\r\n")
		strings.write_string(&b, "\r\n")
		return b.buf[:]
	}

	if len(body) > 0 {
		strings.write_string(&b, "Content-Length: ")
		strings.write_int(&b, len(body))
		strings.write_string(&b, "\r\n")
	}

	strings.write_string(&b, "\r\n")

	if len(body) > 0 {
		strings.write_bytes(&b, body)
	}

	return b.buf[:]
}

// fetch_on_recv is the single entry point for every byte read off the socket
// (plaintext and TLS share it). Before the head is parsed it accumulates into
// req.response and watches for the CRLFCRLF terminator; once the head is in it
// hands bytes to the body decoder. Returns whether the caller should keep reading
// this turn — false means the request settled, completed, or paused for
// backpressure, so the read loop must stop.
fetch_on_recv :: proc(loop: ^eventloop.Loop, req: ^Fetch_Request, data: []byte) -> (keep: bool) {
	if !req.headers_done {
		append(&req.response, ..data)
		// One picohttpparser pass over the whole accumulated head: it both detects
		// completeness (Partial until the CRLFCRLF is buffered) and parses, resuming
		// the terminator scan from head_last_len so accumulation stays linear. The
		// returned strings alias req.response and are consumed inside
		// fetch_deliver_headers before any further append (none happens here).
		consumed, status, status_text, headers, is_chunked, content_length, res := parse_http_head(
			req.response[:],
			req.head_last_len,
		)
		req.head_last_len = len(req.response)

		if res == .Partial {
			// A server that never terminates the head must not grow req.response
			// without bound — reject once it crosses the cap.
			if len(req.response) > FETCH_MAX_HEADER_BYTES {
				fetch_settle_error(req, "fetch: response head too large")
				return false
			}

			return true // head still incomplete — read more
		}

		if res == .Error {
			fetch_settle_error(req, "fetch: malformed HTTP response")
			return false
		}

		if !fetch_deliver_headers(req, status, status_text, headers, is_chunked, content_length) {
			return false // settled with an error
		}

		if req.settled {return false} 	// a consumer cancelled inside on_response

		if req.no_body {
			fetch_finish_body(req, "") // HEAD / 204 / 304 — settle with a null body
			return false
		}

		// Body bytes that arrived in the same read as the head.
		return fetch_feed_body(loop, req, req.response[consumed:])
	}

	return fetch_feed_body(loop, req, data)
}

// fetch_feed_body decodes and delivers a slice of body bytes, then reports
// whether the read loop should continue. It stops on completion (final chunk /
// Content-Length met) and on backpressure (the consumer signalled it is full).
fetch_feed_body :: proc(loop: ^eventloop.Loop, req: ^Fetch_Request, data: []byte) -> (keep: bool) {
	fetch_stream_feed(req, data)

	if req.settled {
		return false
	}

	if req.body_done {
		fetch_finish_body(req, "") // clean end of body
		return false
	}

	if req.want_pause {
		req.want_pause = false
		fetch_pause_read(loop, req)
		return false
	}

	return true
}

// fetch_deliver_headers fires on_response with { status, statusText, headers, hasBody }
// from the already-parsed head (see parse_http_head / fetch_on_recv). It establishes
// the body framing (chunked / Content-Length / read-until-EOF) and whether the status
// permits a body at all. `status_text` and `headers` alias req.response and are copied
// into JS values here, so they must not be used after this call. Returns true (the
// header delivery cannot fail on its own; a malformed head is rejected before this).
fetch_deliver_headers :: proc(
	req: ^Fetch_Request,
	status: int,
	status_text: string,
	headers: []string,
	is_chunked: bool,
	content_length: int,
) -> bool {
	req.headers_done = true
	req.body_is_chunked = is_chunked
	req.body_len = content_length
	req.no_body = fetch_status_has_no_body(req.method, status)

	result := jsc.JSObjectMake(req.ctx, nil, nil)
	set_named(req.ctx, result, "status", jsc.JSValueMakeNumber(req.ctx, f64(status)))
	set_named(req.ctx, result, "statusText", js_string_value(req.ctx, status_text))
	set_named(req.ctx, result, "headers", cast(jsc.JSValueRef)build_string_array(req.ctx, headers))
	set_named(req.ctx, result, "hasBody", jsc.JSValueMakeBoolean(req.ctx, !req.no_body))

	arg := cast(jsc.JSValueRef)result
	exception: jsc.JSValueRef
	invoke_user_callback(req.ctx, req.on_response, &arg, 1, &exception)

	if exception != nil {
		report_uncaught(req.ctx, exception)
		mark_async_failed(req.ctx)
	}

	return true
}

// fetch_status_has_no_body mirrors the WHATWG/HTTP rule that 1xx, 204, 205, 304
// and any response to HEAD carry no message body. Used to deliver a null
// response.body and settle without waiting for body bytes (Node parity).
fetch_status_has_no_body :: proc(method: string, status: int) -> bool {
	if method == "HEAD" {
		return true
	}

	switch status {
	case 101, 103, 204, 205, 304:
		return true
	}
	return false
}

// fetch_deliver_chunk copies `bytes` into a fresh JSC-owned Uint8Array and invokes
// on_chunk; the boolean it returns ("keep reading") is recorded in want_pause so
// the read loop can suspend when the consumer is saturated. The copy is required
// because `bytes` aliases the transient socket / carry buffer.
fetch_deliver_chunk :: proc(req: ^Fetch_Request, bytes: []byte) {
	if len(bytes) == 0 {
		return
	}

	copy_buf := make([]byte, len(bytes), runtime.heap_allocator()) // freed by jsc_buffer_deallocator, on the heap
	copy(copy_buf, bytes)
	arg := make_uint8_array(req.ctx, copy_buf)
	exception: jsc.JSValueRef
	result := invoke_user_callback(req.ctx, req.on_chunk, &arg, 1, &exception)

	if exception != nil {
		report_uncaught(req.ctx, exception)
		mark_async_failed(req.ctx)
		return
	}

	// A falsey return (desiredSize <= 0) asks the transport to apply backpressure.
	if result != nil && !bool(jsc.JSValueToBoolean(req.ctx, result)) {
		req.want_pause = true
	}
}

// fetch_finish_body ends a streaming body: it fires on_end(errorOrNull) — null on
// a clean completion, the message string on a failure (which errors the JS body
// stream) — then tears the request down. message == "" is the clean case.
fetch_finish_body :: proc(req: ^Fetch_Request, message: string) {
	if req.settled {
		return
	}

	arg: jsc.JSValueRef = len(message) == 0 ? jsc.JSValueMakeNull(req.ctx) : js_string_value(req.ctx, message)
	exception: jsc.JSValueRef
	// Callback BEFORE finish, preserving the async-count invariant: the socket is
	// still watched here, so a chained fetch() inside the body's consumer keeps the
	// loop's in-flight count ≥ 1 across the teardown.
	invoke_user_callback(req.ctx, req.on_end, &arg, 1, &exception)

	if exception != nil {
		report_uncaught(req.ctx, exception)
		mark_async_failed(req.ctx)
	}

	fetch_request_finish(req)
}

// fetch_eof handles an orderly peer close. A close before the head is a failure; a
// close once the body framing is satisfied (or for read-until-EOF framing) is a
// clean end; a close mid-body under a declared length or chunked framing is a
// truncation that Node surfaces as "terminated".
fetch_eof :: proc(req: ^Fetch_Request) {
	if req.settled {
		return
	}

	if !req.headers_done {
		fetch_settle_error(req, "fetch: connection closed before headers")
		return
	}

	switch {
	case req.body_is_chunked:
		fetch_finish_body(req, req.body_done ? "" : "fetch: terminated")
	case req.body_len >= 0:
		fetch_finish_body(req, req.body_seen >= req.body_len ? "" : "fetch: terminated")
	case:
		fetch_finish_body(req, "") // read-until-EOF: the close is the end of the body
	}
}

// fetch_settle_error rejects a request that has not yet delivered its head
// (on_error → the fetch promise rejects). Once the head is out the promise has
// already resolved, so a later failure errors the response-body stream via
// fetch_finish_body instead.
fetch_settle_error :: proc(req: ^Fetch_Request, message: string) {
	if req.settled {
		fetch_request_finish(req)
		return
	}

	if req.headers_done {
		fetch_finish_body(req, message)
		return
	}

	arg := js_string_value(req.ctx, message)
	exception: jsc.JSValueRef
	invoke_user_callback(req.ctx, req.on_error, &arg, 1, &exception)

	if exception != nil {
		report_uncaught(req.ctx, exception)
		mark_async_failed(req.ctx)
	}

	fetch_request_finish(req)
}

// fetch_pause_read suspends socket reading for backpressure: it stops the watcher
// (clearing the callback so the io_uring drain will not re-arm it, and dropping
// the registration so the loop's I/O count falls). An unconsumed body therefore
// stops keeping the loop alive — matching Node, where an abandoned response body
// does not pin the process. fetch_resume_read re-arms when the consumer drains.
fetch_pause_read :: proc(loop: ^eventloop.Loop, req: ^Fetch_Request) {
	if req.read_paused || !req.has_fd {
		return
	}

	req.read_paused = true
	req.watcher.callback = nil
	eventloop.unwatch_fd(loop, &req.watcher)
}

// fetch_resume_read re-arms a paused read (called from the JS body stream when its
// reader drains below the high-water mark). Besides re-registering the watcher it
// kicks one read on the next loop turn via post_async, so any bytes already
// buffered in the TLS layer — which raise no fresh socket-readable event — are
// flushed. A no-op unless actually paused, so the stream may call it on every read.
fetch_resume_read :: proc(req: ^Fetch_Request) {
	if req.settled || !req.read_paused || !req.has_fd {
		return
	}

	req.read_paused = false
	req.watcher.callback = fetch_watcher_cb
	req.watcher.mode = .Read
	eventloop.watch_fd(req.loop, &req.watcher)
	// Drive one read on the next loop turn so any transport-buffered (TLS) bytes
	// that raise no fresh socket event still flow. drive_pending keeps the request
	// pinned (fetch_reclaim_pending will not free it) until the queued completion
	// has run, so the raw pointer post_async carries can never be freed under it.
	req.drive_pending += 1
	eventloop.async_begin(req.loop)
	eventloop.post_async(req.loop, fetch_drive_read_cb, req)
}

// fetch_drive_read_cb drives one read at the top of a loop turn after a resume, so
// transport-buffered (TLS) bytes that will not raise a socket event still flow. It
// runs even for a request that has since settled (to balance drive_pending), but
// only touches the socket when the request is still actively reading.
fetch_drive_read_cb :: proc(loop: ^eventloop.Loop, user_data: rawptr) {
	req := cast(^Fetch_Request)user_data

	if req == nil {
		return
	}

	req.drive_pending -= 1

	if req.settled || req.read_paused {
		return
	}

	if !req.has_fd || req.phase != .Reading {
		return
	}

	fetch_watcher_cb(loop, req)
}

// fetch_reject_now rejects before a Fetch_Request exists (bad URL, no loop).
fetch_reject_now :: proc(ctx: jsc.JSContextRef, on_error: jsc.JSObjectRef, message: string) {
	arg := js_string_value(ctx, message)
	exception: jsc.JSValueRef
	jsc.JSObjectCallAsFunction(ctx, on_error, nil, 1, &arg, &exception)
}

// fetch_request_finish tears down a settled request: stop the watcher, close the
// socket, release the GC-protected callbacks. The struct is queued onto
// pending_free rather than freed here because three things may still read it after
// it settles: the io_uring drain loop (to decide re-arm right after the callback
// returns), an in-flight fetch_drive_read_cb holding a raw pointer (drive_pending),
// and — on the pointer-based backends (epoll/kqueue/select) — a readiness event for
// it already sitting in the in-flight platform_poll batch, which dispatches via the
// raw watcher pointer. Reclaim waits all three out (drive_pending + settle_tick; see
// fetch_reclaim_pending). Clearing req.watcher.callback below makes the request
// inert immediately; unwatch_fd then truly cancels the io_uring poll (#183).
fetch_request_finish :: proc(req: ^Fetch_Request) {
	if req.settled {
		return
	}

	// A DNS lookup may still be outstanding on the pool. We do NOT block to join it
	// (the pool owns the worker lifetime); the request stays pinned via drive_pending
	// — bumped at submit — so the pending completion finds live memory, sees
	// req.settled, and reclaims it. See fetch_dns.odin. If the lookup is still
	// queued, cancel it so the worker skips the blocking resolve rather than doing
	// network work for an aborted fetch (and holding the loop alive until it returns).
	if req.dns_job != nil {
		fetch_dns_cancel_job(req.dns_job)
	}

	req.settled = true
	// Stamp the settle iteration so fetch_reclaim_pending holds this request a couple
	// of loop ticks — past the in-flight platform_poll batch that may still carry a
	// readiness event for it on the pointer-based backends.
	req.settle_tick = eventloop.iteration_count(req.loop)

	if state := get_state_from_ctx(req.ctx); state != nil {
		fetch_untrack_active(state, req)
	}

	// Clearing the callback stops the io_uring drain from re-arming this watcher
	// with live work; the epoll path is removed outright by unwatch_fd.
	req.watcher.callback = nil
	// Free the TLS session (if any) before closing the fd it was bound to.
	fetch_tls_cleanup(req)

	if req.has_fd {
		eventloop.unwatch_fd(req.loop, &req.watcher)
		fetch_close_fd(req.fd)
		req.has_fd = false
	}

	js_root_clear(req.ctx, &req.on_response)
	js_root_clear(req.ctx, &req.on_error)
	js_root_clear(req.ctx, &req.on_chunk)
	js_root_clear(req.ctx, &req.on_end)
	// The JS body stream retains cancel/resume (via Response.body) long after the
	// request settles, so sever the private back-pointer BEFORE dropping the GC
	// root: a later cancel()/pull() then reads a nil private and no-ops rather
	// than dereferencing freed memory. JS keeps the object alive while reachable.
	js_root_clear_private(req.ctx, &req.cancel_fn)
	js_root_clear_private(req.ctx, &req.resume_fn)
	// Release the body-write phase loop hold if it is still held — i.e. the request
	// settled mid-upload, before the terminator went out. Idempotent with the release
	// on the normal completion path in fetch_pump_body.
	fetch_body_release_loop(req)

	// Drop the streaming request-body channel's GC roots. As with cancel/resume, the
	// JS pump may still hold pushBody/endBody after the request settles.
	js_root_clear(req.ctx, &req.on_body_drain)
	js_root_clear_private(req.ctx, &req.push_body_fn)
	js_root_clear_private(req.ctx, &req.end_body_fn)

	if state := get_state_from_ctx(req.ctx); state != nil {
		append(&state.pending_free, req)
	}
}

fetch_track_active :: proc(state: ^Runtime_State, req: ^Fetch_Request) {
	if state == nil || req == nil {
		return
	}

	append(&state.active_fetches, req)
}

fetch_untrack_active :: proc(state: ^Runtime_State, req: ^Fetch_Request) {
	if state == nil || req == nil {
		return
	}

	for i in 0 ..< len(state.active_fetches) {
		if state.active_fetches[i] == req {
			// active_fetches is an unordered bag (membership only — used for teardown),
			// so swap-remove the slot in O(1) rather than shifting the tail.
			unordered_remove(&state.active_fetches, i)
			return
		}
	}
}

// fetch_shutdown_active stops every in-flight request without invoking its JS
// callbacks. It is used while the JS context is still alive but eval is already
// returning (for example after a top-level throw). DNS lookups run on the loop's
// generic worker pool now (fetch_dns.odin), so quiescing the resolver is no longer
// this function's job: the loop's teardown (close_begin / close_finish) closes its pool client
// and runs dns_resolve_dispose for any job whose completion will not fire, the same as
// fs and node:dns. We only settle the requests here.
//
// Idempotent and intentionally called from several teardown entry points (eval's
// deferred teardown, destroy_runtime_state, and fetch_destroy_pending): each
// fetch_request_finish untracks its request, so a second pass sees an empty set.
fetch_shutdown_active :: proc(state: ^Runtime_State) {
	if state == nil {
		return
	}

	for len(state.active_fetches) > 0 {
		req := state.active_fetches[0]
		fetch_request_finish(req)
	}
}

// fetch_free_request releases a settled request's owned allocations. The cloned
// strings, request_bytes, and the struct itself are freed through req.allocator —
// the allocator they were created with — so the alloc/free pair stays matched
// whether this runs from fetch_reclaim_pending (normal op) or fetch_destroy_pending
// (teardown). response/carry/body_out carry their own bound allocator, so plain
// delete() frees them correctly.
@(private = "file")
fetch_free_request :: proc(req: ^Fetch_Request) {
	delete(req.method, req.allocator)
	delete(req.url, req.allocator)
	delete(req.host, req.allocator)
	delete(req.path, req.allocator)

	if req.request_bytes != nil {
		delete(req.request_bytes, req.allocator)
	}

	delete(req.response)
	delete(req.carry)
	delete(req.body_out)
	free(req, req.allocator)
}

// fetch_reclaim_pending frees every settled request awaiting cleanup. Called at the
// start of each new request so retention stays bounded to roughly the in-flight set
// rather than growing until teardown.
//
// A request is kept (reclaimed on a later pass) while either of two things may still
// reference its memory:
//   1. drive_pending > 0 — an in-flight fetch_drive_read_cb still holds a raw pointer
//      to it (the completion is queued on the loop's async queue, runs on a later tick).
//   2. Fewer than two loop iterations have elapsed since it settled. On the pointer-
//      based backends (epoll/kqueue/select) a readiness event for the request can be
//      sitting in an in-flight platform_poll batch that dispatches via the raw watcher
//      pointer captured before unwatch; because the settling callback runs mid-batch
//      (the microtask checkpoint fires inside the dispatch, and a synchronous fetch()
//      from JS reaches here while that batch is still being walked), freeing too early
//      lets a later batch entry dereference freed memory. Two iterations is the window
//      the pre-#198 transport used and is proven safe across all three pointer-based
//      backends; io_uring is independently safe via generation tokens (a stale
//      completion maps to a released slot and is dropped), so there the hold is just a
//      cheap, uniform safety margin rather than a correctness requirement.
fetch_reclaim_pending :: proc(state: ^Runtime_State) {
	kept := 0
	for req in state.pending_free {
		within_stale_window := eventloop.iteration_count(req.loop) - req.settle_tick < 2

		if req.drive_pending > 0 || within_stale_window {
			state.pending_free[kept] = req
			kept += 1
			continue
		}

		fetch_free_request(req)
	}
	resize(&state.pending_free, kept)
}

// fetch_destroy_pending reclaims and releases the backing store at teardown. The
// loop is dead here, so any queued drive completions will never run — freeing a
// request with drive_pending > 0 is therefore safe (nothing can dereference it).
fetch_destroy_pending :: proc(state: ^Runtime_State) {
	fetch_shutdown_active(state)
	for req in state.pending_free {
		fetch_free_request(req)
	}
	clear(&state.pending_free)
	delete(state.pending_free)
	delete(state.active_fetches)
}

// parse_http_head runs picohttpparser over the accumulated response buffer. It both
// detects completeness and parses in one pass — no separate header-terminator scan.
// `last_len` is the length of `buf` on the previous (Partial) call (0 on the first),
// the picohttpparser resume hint that keeps accumulation linear. On .Complete it
// returns `consumed` (the head length incl. the CRLFCRLF, i.e. the body offset), the
// status code/text, an interleaved [name, value, ...] header list, and the body
// framing (chunked / Content-Length, -1 when absent). Every returned string ALIASES
// `buf`; the caller (fetch_on_recv -> fetch_deliver_headers) copies them into JS
// values before `buf` is mutated. .Partial means read more; .Error is a malformed head.
parse_http_head :: proc(
	buf: []byte,
	last_len: int,
) -> (
	consumed: int,
	status: int,
	status_text: string,
	headers: []string,
	is_chunked: bool,
	content_length: int,
	result: pico.Result,
) {
	content_length = -1
	raw: [pico.MAX_HEADERS]pico.Header
	n_consumed, code, msg, n, res := pico.parse_response(buf, last_len, raw[:])
	result = res

	if res != .Complete {
		return
	}

	consumed = n_consumed
	status = code
	status_text = msg

	// Interleaved [name, value, ...] for build_string_array. picohttpparser already
	// returns name/value as zero-copy slices into buf with leading OWS stripped; we
	// trim trailing OWS and unfold obs-fold continuations (reported with an empty name).
	hdr_list := make([dynamic]string, 0, n * 2, context.temp_allocator)
	last_val_idx := -1
	for i in 0 ..< n {
		h := raw[i]

		if h.name == "" {
			// RFC 7230 obs-fold continuation: append (single space) to the previous
			// value rather than drop it. Deprecated, but unfolding avoids silent
			// corruption — the historical HTTP/1.1 interpretation.
			if last_val_idx >= 0 {
				cont := strings.trim_space(h.value)
				hdr_list[last_val_idx] = strings.concatenate(
					{hdr_list[last_val_idx], " ", cont},
					context.temp_allocator,
				)
			}

			continue
		}

		value := strings.trim_space(h.value)
		append(&hdr_list, h.name)
		append(&hdr_list, value)
		last_val_idx = len(hdr_list) - 1

		// Case-insensitive name match without lowercasing every header (equal_fold
		// allocates nothing); only the rare Transfer-Encoding value is lowercased.
		if strings.equal_fold(h.name, "transfer-encoding") {
			lvalue := strings.to_lower(value, context.temp_allocator)

			if strings.contains(lvalue, "chunked") {
				is_chunked = true
			}
		} else if strings.equal_fold(h.name, "content-length") {
			if cl, cl_ok := strconv.parse_int(value); cl_ok {
				content_length = cl
			}
		}
	}
	headers = hdr_list[:]
	return
}

// fetch_stream_feed decodes a slice of raw body bytes and delivers the decoded
// payload to the consumer (fetch_deliver_chunk), setting req.body_done when the
// framing completes. Chunked bodies route through the incremental de-chunker;
// identity / Content-Length bodies are delivered straight through, bounded by the
// declared length. Extra bytes past a satisfied Content-Length are ignored.
fetch_stream_feed :: proc(req: ^Fetch_Request, data: []byte) {
	if req.body_is_chunked {
		fetch_feed_chunked(req, data)
		return
	}

	remaining := data

	if req.body_len >= 0 {
		want := req.body_len - req.body_seen

		if want <= 0 {
			req.body_done = true
			return
		}

		if len(remaining) > want {
			remaining = remaining[:want]
		}
	}

	if len(remaining) > 0 {
		fetch_deliver_chunk(req, remaining)
		req.body_seen += len(remaining)
	}

	if req.body_len >= 0 && req.body_seen >= req.body_len {
		req.body_done = true
	}
}

// fetch_feed_chunked is the incremental Transfer-Encoding: chunked decoder. It
// appends incoming bytes to req.carry (which holds only undecoded framing — size
// lines and the inter-chunk CRLFs, never bulk data), then consumes as many
// complete units as possible, delivering chunk data straight through. The decoder
// resumes mid-size-line or mid-chunk across reads via req.chunk_state /
// req.chunk_remaining. The zero-length chunk sets req.body_done.
fetch_feed_chunked :: proc(req: ^Fetch_Request, data: []byte) {
	append(&req.carry, ..data)
	buf := req.carry[:]
	pos := 0

	loop: for {
		switch req.chunk_state {
		case .Size:
			line_end := -1
			for j := pos; j + 1 < len(buf); j += 1 {
				if buf[j] == '\r' && buf[j + 1] == '\n' {
					line_end = j
					break
				}
			}

			if line_end < 0 {
				// A chunk-size line that never terminates must not grow carry
				// without bound — fail the body as a framing violation.
				if len(buf) - pos > FETCH_MAX_CHUNK_LINE {
					fetch_finish_body(req, "fetch: terminated")
					return
				}

				break loop // size line not complete yet
			}

			size_str := string(buf[pos:line_end])

			if semi := strings.index_byte(size_str, ';'); semi >= 0 {
				size_str = size_str[:semi]
			}

			size, size_ok := fetch_parse_chunk_size(strings.trim_space(size_str))

			if !size_ok {
				// Malformed chunk size (non-hex, signed, empty, or overflowing) —
				// fail the body stream as a truncation.
				fetch_finish_body(req, "fetch: terminated")
				return
			}

			pos = line_end + 2

			if size == 0 {
				req.body_done = true
				req.chunk_state = .Done
				break loop
			}

			req.chunk_remaining = size
			req.chunk_state = .Data

		case .Data:
			avail := len(buf) - pos
			take := min(avail, req.chunk_remaining)

			if take > 0 {
				fetch_deliver_chunk(req, buf[pos:pos + take])

				if req.settled {
					return
				}

				pos += take
				req.chunk_remaining -= take
			}

			if req.chunk_remaining > 0 {break loop} 	// need more data
			req.chunk_state = .Data_CRLF

		case .Data_CRLF:
			if len(buf) - pos < 2 {break loop} 	// CRLF not fully arrived

			// RFC 7230: chunk data is always followed by CRLF. A different byte pair
			// means the framing is corrupt — fail rather than resync on garbage.
			if buf[pos] != '\r' || buf[pos + 1] != '\n' {
				fetch_finish_body(req, "fetch: terminated")
				return
			}

			pos += 2 // skip the chunk-terminating CRLF
			req.chunk_state = .Size

		case .Done:
			break loop
		}
	}

	// Drop the consumed prefix; keep only the unparsed tail in carry. Bulk chunk
	// data never lingers here — it is delivered as it is consumed.
	if pos > 0 {
		remove_range(&req.carry, 0, pos)
	}
}
