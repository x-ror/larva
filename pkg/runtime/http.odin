package lava_runtime

import "base:runtime"
import "core:c"
import "core:strings"
import jsc "lava:pkg/jsc"
import pico "lava:pkg/runtime/picohttpparser"

// node:http server support — the request-HEAD parser bridge. The protocol surface
// (Server, IncomingMessage, ServerResponse) lives in js/node/http.js on top of
// node:net; this exposes one native primitive, parseRequest(buf, lastLen), that runs
// picohttpparser (phr_parse_request) over the accumulated request bytes and returns one
// flat ARRAY (built with a single JSObjectMakeArray call — the cheapest possible shape
// to hand a fresh compound result across the boundary):
//   [1]                                                   — partial: need more bytes
//   [2]                                                   — malformed head
//   [0, consumed, method, url, minor, name, value, ...]   — head parsed
// `consumed` is the head length (the body offset). All strings are copied into JS here,
// so nothing aliases the input buffer past this call. This binding is platform-agnostic
// (pure parsing); the server itself needs node:net, which is Linux-first.

PARSE_COMPLETE :: 0
PARSE_PARTIAL :: 1
PARSE_ERROR :: 2

make_http_bindings :: proc(ctx: jsc.JSContextRef) -> jsc.JSObjectRef {
	bindings := jsc.JSObjectMake(ctx, nil, nil)
	// Both natives are on the per-request hot path, so they take dedicated host
	// wrappers (no per-call dispatch-table lookup — see buffer_host.odin).
	inject_native_function(ctx, bindings, "parseRequest", http_parse_request_cb, http_parse_request_host)
	// Response-head serialization: same latin1WriteInto as node:buffer (package-local
	// callback). Avoids a Buffer require + intermediate array on every writeHead/end.
	inject_native_function(
		ctx,
		bindings,
		"latin1WriteInto",
		buffer_latin1_write_into_cb,
		buffer_latin1_write_into_host,
	)
	return bindings
}

// http_parse_request_host is the host-call-convention entry point for parseRequest
// (dedicated wrapper; see buffer_host.odin for why the hot natives bake these in).
http_parse_request_host :: proc "c" (g: rawptr, cf: [^]u64) -> i64 {
	return host_dispatch(g, cf, http_parse_request_cb)
}

@(private = "file")
http_parse_status :: proc(ctx: jsc.JSContextRef, state: int) -> jsc.JSValueRef {
	v := js_int_value(ctx, state)
	return cast(jsc.JSValueRef)jsc.JSObjectMakeArray(ctx, 1, &v, nil)
}

// http_parse_request_cb(buf: Uint8Array, lastLen: number) -> result array (see above).
http_parse_request_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 2 do return http_parse_status(ctx, PARSE_ERROR)
	args := arguments[:int(argument_count)]
	// js_int_arg can run JS (valueOf) — read it before borrowing the view; see
	// the note in buffer_utf16le_write_into_cb (buffer.odin).
	last_len := js_int_arg(ctx, args[1])
	view, ok := typed_array_view(ctx, args[0])
	if !ok do return http_parse_status(ctx, PARSE_ERROR)

	hdrs: [pico.MAX_HEADERS]pico.Header
	consumed, minor, num, method, path, res := pico.parse_request(view, last_len, hdrs[:])
	if res == .Partial do return http_parse_status(ctx, PARSE_PARTIAL)
	if res == .Error do return http_parse_status(ctx, PARSE_ERROR)

	// Interleaved [name, value, ...]; RFC 7230 obs-fold continuations (empty name) are
	// merged into the previous value with a single space. NAMES are kept in their
	// received case: req.rawHeaders must preserve it (Node contract), and the JS layer
	// lowercases only the req.headers keys. Values stay raw latin1.
	hdr_list := make([dynamic]string, 0, num * 2, context.temp_allocator)
	last_val_idx := -1
	for i in 0 ..< num {
		h := hdrs[i]
		if h.name == "" {
			if last_val_idx >= 0 {
				cont := strings.trim_space(h.value)
				hdr_list[last_val_idx] = strings.concatenate(
					{hdr_list[last_val_idx], " ", cont},
					context.temp_allocator,
				)
			}
			continue
		}
		append(&hdr_list, h.name)
		append(&hdr_list, strings.trim_space(h.value))
		last_val_idx = len(hdr_list) - 1
	}

	// Build every result value into a MACHINE-STACK array and make the JS array with ONE
	// JSObjectMakeArray call. JSC's conservative GC scans the machine stack + registers
	// (but NOT Odin heap memory), so stack-parked JSValueRefs stay rooted while the rest
	// are created — the one-value-at-a-time SetPropertyAtIndex dance this replaces was
	// only needed because the values used to sit in a temp_allocator (heap) slice.
	//
	// Strings are LATIN-1: HTTP/1 header bytes are binary (obs-text 0x80-0xFF), and Node
	// exposes them as latin1. Routing through the UTF-8 helpers would mis-decode them.
	n := len(hdr_list)
	vals: [5 + 2 * pico.MAX_HEADERS]jsc.JSValueRef
	vals[0] = js_int_value(ctx, PARSE_COMPLETE)
	vals[1] = js_int_value(ctx, consumed)
	vals[2] = latin1_string_from_bytes(ctx, transmute([]byte)method)
	vals[3] = latin1_string_from_bytes(ctx, transmute([]byte)path)
	vals[4] = js_int_value(ctx, minor)
	for i in 0 ..< n {
		// Reuse the buffer codec's dense-ASCII / high-byte latin1 string path.
		vals[5 + i] = latin1_string_from_bytes(ctx, transmute([]byte)hdr_list[i])
	}
	return cast(jsc.JSValueRef)jsc.JSObjectMakeArray(ctx, c.size_t(5 + n), &vals[0], nil)
}
