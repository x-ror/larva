// Odin bindings + a safe wrapper over picohttpparser (h2o/picohttpparser), a
// zero-copy, single-pass HTTP/1.x head parser. The C source (picohttpparser.c/.h)
// is vendored in this directory under its MIT/Perl dual license; build-native-deps.sh
// compiles it to libpicohttpparser.a, linked via the foreign import below.
//
// Why: it replaces the allocating, line-splitting response-head parser in fetch
// (strings.split + per-header to_lower) with one C pass that returns name/value
// slices ALIASING the input buffer. The same parser serves the future node:net /
// node:http server (phr_parse_request), so this one link is amortized both ways.
//
// LIFETIME: every returned string (msg, header name/value) points INTO `buf`. They
// are valid only until `buf` is mutated or reallocated. fetch accumulates the head
// in a [dynamic]byte that reallocs on append, so callers MUST consume these slices
// (build JS strings / copy) before the next append. See fetch_on_recv.
package picohttpparser

import "core:c"

// Linux-first: build-native-deps.sh produces libpicohttpparser.a for the Linux/macOS
// (cc/ar) link. The Windows build path (scripts/link-windows-local.sh) does NOT yet
// compile picohttpparser, so a Windows link of fetch would fail at this import. That is
// a known, accepted gap while the Windows/macOS CI jobs are disabled (see the Linux-first
// note in .github/workflows/ci.yml). When Windows is restored, compile picohttpparser.c
// with MSVC (cl /c … then lib, as scripts/build-jsc-init-windows.sh does for the JSC
// shim) into build/picohttpparser.lib on the LIB path, and guard this import to use
// `system:picohttpparser.lib` under `when ODIN_OS == .Windows`.
foreign import pico "libpicohttpparser.a"

// Mirror of `struct phr_header` — name/value are pointers INTO the parsed buffer
// (not NUL-terminated), with explicit lengths. A header whose name pointer is nil
// is an RFC 7230 obs-fold continuation of the previous header's value.
phr_header :: struct {
	name:      [^]u8,
	name_len:  c.size_t,
	value:     [^]u8,
	value_len: c.size_t,
}

@(default_calling_convention = "c", link_prefix = "")
foreign pico {
	// Returns: # bytes consumed (head length incl. the terminating CRLFCRLF) on
	// success, -1 on a malformed head, -2 when the head is not yet complete.
	phr_parse_response :: proc(buf: [^]u8, buf_len: c.size_t, minor_version: ^c.int, status: ^c.int, msg: ^[^]u8, msg_len: ^c.size_t, headers: [^]phr_header, num_headers: ^c.size_t, last_len: c.size_t) -> c.int ---
	phr_parse_request :: proc(buf: [^]u8, buf_len: c.size_t, method: ^[^]u8, method_len: ^c.size_t, path: ^[^]u8, path_len: ^c.size_t, minor_version: ^c.int, headers: [^]phr_header, num_headers: ^c.size_t, last_len: c.size_t) -> c.int ---
}

// MAX_HEADERS bounds a single message's header count. picohttpparser fails (-1) if a
// message has more headers than the array it is given; FETCH_MAX_HEADER_BYTES bounds
// total head size separately, so 128 is a generous cap that turns a pathological
// header flood into a clean Error rather than unbounded work.
MAX_HEADERS :: 128

Result :: enum {
	Complete, // head fully parsed; `consumed` is its length incl. CRLFCRLF
	Partial, // terminator not yet buffered — read more, then call again
	Error, // malformed head, or more than MAX_HEADERS headers
}

// Header is an Odin view of one parsed header. name/value ALIAS the input buffer
// (see the package LIFETIME note). An empty `name` marks an obs-fold continuation.
Header :: struct {
	name:  string,
	value: string,
}

// parse_response runs phr_parse_response over `buf` and converts the result into Odin
// views written into `out` (which must be non-empty; at most min(len(out), MAX_HEADERS)
// headers are returned). `last_len` is the length of `buf` passed on the previous
// (Partial) call, or 0 on the first — it lets pico skip re-scanning bytes already known
// not to contain the CRLFCRLF terminator, so accumulation is not quadratic.
//
// On Complete: `consumed` is the head length (incl. terminator), `status`/`msg` are the
// status line, and out[:num] hold the headers (aliasing buf). On Partial/Error the other
// returns are zero/empty.
parse_response :: proc(
	buf: []byte,
	last_len: int,
	out: []Header,
) -> (
	consumed: int,
	status: int,
	msg: string,
	num: int,
	result: Result,
) {
	raw: [MAX_HEADERS]phr_header
	cap := min(len(out), MAX_HEADERS)
	n := c.size_t(cap)
	minor_c, status_c: c.int
	msg_ptr: [^]u8
	msg_len: c.size_t

	ret := phr_parse_response(
		raw_data(buf),
		c.size_t(len(buf)),
		&minor_c,
		&status_c,
		&msg_ptr,
		&msg_len,
		&raw[0],
		&n,
		c.size_t(last_len),
	)
	switch {
	case ret == -1:
		return 0, 0, "", 0, .Error
	case ret == -2:
		return 0, 0, "", 0, .Partial
	}

	num = int(n)
	for i in 0 ..< num {
		h := raw[i]
		name := h.name != nil && h.name_len > 0 ? string(h.name[:h.name_len]) : ""
		value := h.value != nil && h.value_len > 0 ? string(h.value[:h.value_len]) : ""
		out[i] = Header {
			name  = name,
			value = value,
		}
	}
	if msg_ptr != nil && msg_len > 0 {msg = string(msg_ptr[:msg_len])}
	return int(ret), int(status_c), msg, num, .Complete
}

// parse_request is the inbound counterpart for an HTTP/1.x SERVER request head. Same
// shape and lifetime as parse_response: `last_len` is the resume hint, out[:num] hold
// the headers aliasing buf, and on .Complete `consumed` is the head length (incl. the
// terminating CRLFCRLF, i.e. the body offset). `method` and `path` (the request target)
// also alias buf. Used by the node:http server head parser (http.odin).
parse_request :: proc(
	buf: []byte,
	last_len: int,
	out: []Header,
) -> (
	consumed: int,
	minor: int,
	num: int,
	method: string,
	path: string,
	result: Result,
) {
	raw: [MAX_HEADERS]phr_header
	cap := min(len(out), MAX_HEADERS)
	n := c.size_t(cap)
	minor_c: c.int
	method_ptr, path_ptr: [^]u8
	method_len, path_len: c.size_t

	ret := phr_parse_request(
		raw_data(buf),
		c.size_t(len(buf)),
		&method_ptr,
		&method_len,
		&path_ptr,
		&path_len,
		&minor_c,
		&raw[0],
		&n,
		c.size_t(last_len),
	)
	switch {
	case ret == -1:
		return 0, 0, 0, "", "", .Error
	case ret == -2:
		return 0, 0, 0, "", "", .Partial
	}

	num = int(n)
	for i in 0 ..< num {
		h := raw[i]
		name := h.name != nil && h.name_len > 0 ? string(h.name[:h.name_len]) : ""
		value := h.value != nil && h.value_len > 0 ? string(h.value[:h.value_len]) : ""
		out[i] = Header {
			name  = name,
			value = value,
		}
	}
	if method_ptr != nil && method_len > 0 {method = string(method_ptr[:method_len])}
	if path_ptr != nil && path_len > 0 {path = string(path_ptr[:path_len])}
	return int(ret), int(minor_c), num, method, path, .Complete
}
