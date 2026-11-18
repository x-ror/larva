package larva_http

import "base:runtime"
import "core:strings"
import eventloop "lava:pkg/runtime/eventloop"
import pico "lava:pkg/runtime/picohttpparser"

// The Fetch standard's redirect limit.
MAX_REDIRECTS :: 20
DEFAULT_TIMEOUT_MS :: 30_000
DEFAULT_USER_AGENT :: "larva/0.1"
// A page larger than this is refused rather than buffered: the server picks the size,
// and the timeout alone does not bound memory on a fast link.
DEFAULT_MAX_BODY_BYTES :: 64 * 1024 * 1024
// Status line and headers together. The same bound the runtime's fetch uses.
MAX_HEAD_BYTES :: 64 * 1024

// RFC 9110 optional whitespace around header values: space and tab only, not every
// Unicode space strings.trim_space would decode and drop.
@(private)
OWS :: " \t"

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
	Body_Too_Large,
	Too_Many_Redirects,
	Timeout,
	No_Transport, // no transport on this target
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
// The response is the callee's: release it with response_destroy.
Done_Proc :: #type proc(response: Response, user_data: rawptr)

// fetch starts `req` on `loop` and returns at once; `on_done` reports the outcome.
// Everything in `req` is copied, so it need not outlive the call.
//
// Returns:
//   .None once `on_done` is guaranteed to run; any other error means the request did
//   not start and `on_done` will not run.
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

// header returns the first header named `name`. Header names compare ASCII
// case-insensitively; core:strings.equal_fold folds Unicode too, so a server's
// `Tranſfer-Encoding` would pass for Transfer-Encoding.
header :: proc(r: ^Response, name: string) -> (value: string, ok: bool) {
	for &h in r.headers {
		if ascii_equal_fold(h.name, name) {
			return h.value, true
		}
	}

	return "", false
}

// is_html says whether the response declares an HTML body, or declares no type at all.
is_html :: proc(r: ^Response) -> bool {
	content_type, ok := header(r, "Content-Type")

	if !ok {
		return true
	}

	media, _, _ := strings.partition(content_type, ";")
	media = strings.trim(media, OWS)
	return ascii_equal_fold(media, "text/html") || ascii_equal_fold(media, "application/xhtml+xml")
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
