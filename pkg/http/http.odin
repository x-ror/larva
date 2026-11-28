package larva_http

import "base:runtime"
import "core:strings"
import cookie "lava:pkg/http/cookie"
import profile "lava:pkg/profile"
import eventloop "lava:pkg/runtime/eventloop"
import pico "lava:pkg/runtime/picohttpparser"

// The Fetch standard's redirect limit.
MAX_REDIRECTS :: 20
DEFAULT_TIMEOUT_MS :: 30_000
// The default client profile's (pkg/profile), so the header and what a page reads off
// navigator.userAgent are one string.
DEFAULT_USER_AGENT :: profile.DEFAULT_USER_AGENT
// A page larger than this is refused rather than buffered: the server picks the size,
// and the timeout alone does not bound memory on a fast link.
DEFAULT_MAX_BODY_BYTES :: 64 * 1024 * 1024
// Status line and headers together. The same bound the runtime's fetch uses.
MAX_HEAD_BYTES :: 64 * 1024

// A set of ASCII bytes, tested with `b in set`; any byte >= 128 is simply not in it.
@(private)
Ascii_Set :: bit_set[byte(0) ..< 128;u128]

// The parser's {name, value} pair, reused rather than declared twice. Headers in a
// Request or Response are owned copies, not views into a parse buffer.
Header :: pico.Header

Request :: struct {
	method:         string, // "" is GET
	url:            string,
	headers:        []Header, // a caller header replaces the default of the same name
	body:           []byte,
	timeout_ms:     int, // the whole transfer, redirects included; 0 is DEFAULT_TIMEOUT_MS
	max_body_bytes: int, // 0 is DEFAULT_MAX_BODY_BYTES
	// The session's cookies (pkg/http/cookie), or nil to send and keep none. Every hop of
	// the transfer, redirects included, stores the Set-Cookie it answers with before
	// following it, and sends the Cookie header the jar then holds for its URL — unless
	// `headers` carries a Cookie of its own, which wins on every hop that keeps it. The
	// jar is borrowed: it must outlive on_done, and only the loop thread may touch it
	// while the transfer runs.
	cookie_jar:     ^cookie.Jar,
}

Error :: enum {
	None,
	Invalid_URL,
	Invalid_Request, // a method or header that would break the request framing
	Unsupported_Scheme,
	DNS,
	Connect,
	TLS,
	Write,
	Read, // the connection closed before a response, or before the body was complete
	Malformed_Response,
	Head_Too_Large,
	Body_Too_Large, // as received, or as decoded from its Content-Encoding
	Decoding, // the body does not decode per its Content-Encoding (Chrome's ERR_CONTENT_DECODING_FAILED)
	Too_Many_Redirects,
	Timeout,
	No_Transport, // no transport on this target
	// The loop was destroyed before the response was complete; also what fetch returns
	// when called on a loop being destroyed.
	// Deviates: no Chrome counterpart (a torn-down engine shows no response at all), so
	// this is the client's own report. Pinned by destroying_the_loop_cancels_a_fetch_in_flight.
	Cancelled,
}

// Response owns every string and buffer in it, in the allocator the request ran with.
// status, headers and body describe the final response and are empty unless
// error == .None.
Response :: struct {
	error:     Error,
	status:    int,
	reason:    string,
	headers:   [dynamic]Header,
	body:      [dynamic]byte,
	url:       string, // after redirects
	redirects: int,
	allocator: runtime.Allocator,
}

// Done_Proc runs once per fetch, on the loop thread, never from inside fetch itself.
// The response is the callee's: release it with response_destroy. When the loop is
// destroyed with the fetch in flight, it runs from inside eventloop.destroy (close_begin)
// with .Cancelled; the loop is gone by then, so it must not call into it.
Done_Proc :: #type proc(response: Response, user_data: rawptr)

// fetch starts `req` on `loop` and returns at once; `on_done` reports the outcome.
// Everything in `req` is copied, so it need not outlive the call.
//
// Params:
//   allocator  Owns the Response and everything the transfer holds. A body with a
//              Content-Encoding is decoded on the loop's worker pool, through this
//              allocator, so it must be safe to use from another thread (the heap, a
//              mem.Tracking_Allocator; not context.temp_allocator or an unguarded
//              arena). It must outlive eventloop.destroy, not only the loop's run:
//              a decode the timeout overtook frees through it when it returns, after
//              on_done, and a decode a worker was running when the loop closed is freed
//              by that worker once the decode returns — within close_finish for a
//              loop's private pool, any time later for a shared one.
//
// Returns:
//   .None once `on_done` is guaranteed to run; any other error means the request did
//   not start and `on_done` will not run: .Cancelled when `loop` is being destroyed (a
//   fetch from an on_done that destroy runs).
fetch :: proc(
	loop: ^eventloop.Loop,
	req: Request,
	on_done: Done_Proc,
	user_data: rawptr = nil,
	allocator := context.allocator,
) -> Error {
	assert(loop != nil && on_done != nil)

	if !request_is_valid(req) {
		return .Invalid_Request
	}

	url, err := parse_url(req.url, allocator)

	if err != .None {
		return err
	}

	return transfer_start(loop, req, url, on_done, user_data, allocator)
}

// set_cookie_for_url stores one set-cookie-string in `jar` as if `url`'s response had
// sent it in a Set-Cookie header: the HTTP stack's access (HttpOnly allowed), same-site
// with its own URL. What a caller seeds a session with before the first navigation.
//
// Returns:
//   The jar's verdict, or the URL's parse error (the jar is then untouched).
set_cookie_for_url :: proc(
	jar: ^cookie.Jar,
	url: string,
	line: string,
	now_ns: i64,
) -> (
	status: cookie.Status,
	err: Error,
) {
	u := parse_url(url, context.temp_allocator) or_return
	return cookie.set_cookie(jar, cookie_source(u), line, .Http, .Same_Site, now_ns), .None
}

// cookie_source is the jar's view of a URL: its host, its path without the query, and
// whether it is a secure context.
@(private)
cookie_source :: proc(u: Url) -> cookie.Source {
	return {
		secure = cookie.is_potentially_trustworthy(u.https, u.host),
		host = u.host,
		path = strings.truncate_to_byte(u.target, '?'),
	}
}

// header returns the first header named `name`. Header names compare ASCII
// case-insensitively; core:strings.equal_fold folds Unicode too, so a server's
// `Tranſfer-Encoding` would pass for Transfer-Encoding.
header :: proc(r: ^Response, name: string) -> (value: string, ok: bool) {
	return find_header(r.headers[:], name)
}

// is_html says whether the response declares an HTML body, or declares no type at all.
is_html :: proc(r: ^Response) -> bool {
	content_type, ok := header(r, "Content-Type")

	if !ok {
		return true
	}

	media := trim_ows(strings.truncate_to_byte(content_type, ';'))
	return ascii_equal_fold(media, "text/html") || ascii_equal_fold(media, "application/xhtml+xml")
}

// charset returns the `charset` parameter of the response's Content-Type, unquoted:
// the transport-layer encoding label the HTML sniffing algorithm (pkg/html
// decode_document) ranks below a BOM and above <meta>. "" when there is none. A view
// into the header; label validity is the decoder's call, not this one's.
//
// Simpler than the Fetch standard's "extract a MIME type": the last Content-Type header
// is not preferred over an earlier one and a quoted value keeps its backslash escapes.
// Neither shape appears in tests/dom's corpus; a real labeled page carries one header
// and a bare token.
charset :: proc(r: ^Response) -> string {
	content_type, ok := header(r, "Content-Type")

	if !ok {
		return ""
	}

	rest := content_type
	for {
		semi := strings.index_byte(rest, ';')

		if semi < 0 {
			return ""
		}

		rest = rest[semi + 1:]
		param := trim_ows(strings.truncate_to_byte(rest, ';'))
		eq := strings.index_byte(param, '=')

		if eq < 0 || !ascii_equal_fold(trim_ows(param[:eq]), "charset") {
			continue
		}

		value := trim_ows(param[eq + 1:])

		if len(value) >= 2 && value[0] == '"' && value[len(value) - 1] == '"' {
			value = value[1:len(value) - 1]
		}

		return value
	}
}

response_destroy :: proc(r: ^Response) {
	context.allocator = r.allocator
	for &h in r.headers {
		delete(h.name)
		delete(h.value)
	}

	delete(r.headers)
	delete(r.body)
	delete(r.reason)
	delete(r.url)
	r^ = {}
}

@(private)
ascii_equal_fold :: proc(a, b: string) -> bool {
	if len(a) != len(b) {
		return false
	}

	for i in 0 ..< len(a) {
		if ascii_lower(a[i]) != ascii_lower(b[i]) {
			return false
		}
	}

	return true
}

@(private)
ascii_lower :: proc(b: byte) -> byte {
	return b + ('a' - 'A') if 'A' <= b && b <= 'Z' else b
}

// trim_ows drops RFC 9110 optional whitespace, space and tab, from both ends. Bytewise:
// strings.trim decodes UTF-8 and would drop every Unicode space.
@(private)
trim_ows :: proc(s: string) -> string {
	lo, hi := 0, len(s)
	for lo < hi && (s[lo] == ' ' || s[lo] == '\t') {
		lo += 1
	}

	for hi > lo && (s[hi - 1] == ' ' || s[hi - 1] == '\t') {
		hi -= 1
	}

	return s[lo:hi]
}

@(private)
index_byte_set :: proc(s: string, set: Ascii_Set) -> int {
	for b, i in transmute([]byte)s {
		if b in set {
			return i
		}
	}

	return -1
}

@(private)
find_header :: proc(headers: []Header, name: string) -> (value: string, ok: bool) {
	for &h in headers {
		if ascii_equal_fold(h.name, name) {
			return h.value, true
		}
	}

	return "", false
}
