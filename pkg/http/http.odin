package larva_http

import "base:runtime"
import eventloop "lava:pkg/runtime/eventloop"

// Chrome follows at most 20 redirects, as the Fetch standard requires.
MAX_REDIRECTS :: 20
DEFAULT_TIMEOUT_MS :: 30_000
DEFAULT_USER_AGENT :: "larva/0.1"

Header :: struct {
	name:  string,
	value: string,
}

Request :: struct {
	method:     string, // "" is GET
	url:        string,
	headers:    []Header, // added after the defaults; a same-named one replaces the default
	body:       []byte,
	timeout_ms: int, // the whole transfer, redirects included; 0 is DEFAULT_TIMEOUT_MS
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
	Read,
	Malformed_Response,
	Too_Many_Redirects,
	Body_Too_Large,
	Timeout,
	Unsupported, // no transport on this target
}

// Response owns every string and buffer in it, in the allocator the request ran with.
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

// Done_Proc runs once per fetch, on the loop thread. The response is the callee's:
// release it with response_destroy.
Done_Proc :: #type proc(response: Response, user_data: rawptr)

// fetch starts `req` on `loop` and returns at once; `on_done` reports the outcome.
// Everything in `req` is copied, so it need not outlive the call.
//
// Returns:
//   false when the request could not start (a bad URL, an unsupported target); then
//   `on_done` is not called.
fetch :: proc(
	loop: ^eventloop.Loop,
	req: Request,
	on_done: Done_Proc,
	user_data: rawptr = nil,
	allocator := context.allocator,
) -> (
	ok: bool,
	err: Error,
) {
	return transfer_start(loop, req, on_done, user_data, allocator)
}

// header returns the first header named `name`, ASCII case-insensitively.
header :: proc(r: ^Response, name: string) -> (value: string, ok: bool) {
	for h in r.headers {
		if ascii_equal_fold(h.name, name) {
			return h.value, true
		}
	}

	return "", false
}

response_destroy :: proc(r: ^Response) {
	context.allocator = r.allocator
	for h in r.headers {
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
