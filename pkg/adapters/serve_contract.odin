package larva_adapters

import "base:runtime"
import "core:crypto"
import "core:net"
import "core:strconv"
import "core:strings"

// The HTTP crawling adapter's wire contract (#15; docs/LARVA.md decision 5: wire
// protocols stay in adapters). #15 keeps the production caller's exact names in a
// private spec, so the names here are this MVP's own, chosen to be plain and written
// down in one place — this comment — rather than guessed at. Mapping them onto the
// production names is the caller-side adapter's job, or a rename here once that spec is
// shared.
//
// One endpoint, `GET /render?url=<target>[&…]`, query parameters percent-encoded:
//
//   url       required; http or https.
//   wait      `load` (the default and the only value this stage has).
//   selector  a CSS selector list to wait for after `load`.
//   script    a custom script, run after the selector wait (Crawl_Job.script).
//   result    `html` (the default: the serialized document) or `script` (the JSON
//             value the script resolved with; needs `script`).
//   timeout   the hard per-request kill timeout in ms, navigation included
//             (Server_Config.default_timeout_ms when absent, at most max_timeout_ms).
//   token     must equal Server_Config.token when one is configured.
//
// Any other parameter is refused with `unsupported` (501): a feature this stage does not
// have (screenshot, actions, proxy, cookies…) must make the caller fall back to Chrome,
// not quietly return a page without it (#15: "a distinct error code").
//
// A success is 200 with the body and HEADER_FINAL_URL, HEADER_STATUS and Server-Timing.
// A failure is the status ERROR_STATUS gives, HEADER_ERROR naming the code, the same
// metadata headers where they are known, and a one-line text/plain message.

HEADER_ERROR :: "X-Larva-Error"
HEADER_FINAL_URL :: "X-Larva-Final-Url"
HEADER_STATUS :: "X-Larva-Status"
HEADER_TIMING :: "Server-Timing"

RENDER_PATH :: "/render"

// Error_Code is the structured error a failed request reports in HEADER_ERROR.
Error_Code :: enum {
	None,
	// The request is malformed: no or a bad `url`, a bad parameter value, an invalid
	// selector, a head that does not parse.
	Bad_Request,
	// A token is configured and the request's does not match.
	Unauthorized,
	Not_Found,
	Method_Not_Allowed,
	// A parameter or value this stage does not implement; the caller falls back.
	Unsupported,
	// More requests in flight than Server_Config.max_inflight.
	Over_Capacity,
	// The engine could not take the page: shutting down, no VM, a refused worker.
	Engine_Unavailable,
	// The document could not be fetched: DNS, connect, TLS, a bad response, a body that
	// does not decode, too many redirects.
	Navigation_Failed,
	// The request's timeout passed — during navigation or in the page.
	Kill_Timeout,
	// The custom script did not compile, threw, rejected, never settled, or resolved with
	// a value JSON cannot represent.
	Script_Error,
	// The loop went idle after `load` with no element matching the selector.
	Selector_Not_Found,
	// The page was killed by its CPU budget (or another per-page limit).
	Page_Killed,
	// The document could not be captured (serialized).
	Capture_Failed,
}

@(rodata)
ERROR_NAME := [Error_Code]string {
	.None               = "",
	.Bad_Request        = "bad_request",
	.Unauthorized       = "unauthorized",
	.Not_Found          = "not_found",
	.Method_Not_Allowed = "method_not_allowed",
	.Unsupported        = "unsupported",
	.Over_Capacity      = "over_capacity",
	.Engine_Unavailable = "engine_unavailable",
	.Navigation_Failed  = "navigation_failed",
	.Kill_Timeout       = "kill_timeout",
	.Script_Error       = "script_error",
	.Selector_Not_Found = "selector_not_found",
	.Page_Killed        = "page_killed",
	.Capture_Failed     = "capture_failed",
}

@(rodata)
ERROR_STATUS := [Error_Code]int {
	.None               = 200,
	.Bad_Request        = 400,
	.Unauthorized       = 401,
	.Not_Found          = 404,
	.Method_Not_Allowed = 405,
	.Unsupported        = 501,
	.Over_Capacity      = 503,
	.Engine_Unavailable = 503,
	.Navigation_Failed  = 502,
	.Kill_Timeout       = 504,
	.Script_Error       = 500,
	.Selector_Not_Found = 500,
	.Page_Killed        = 500,
	.Capture_Failed     = 500,
}

DEFAULT_LISTEN :: "127.0.0.1:8080"
// #15: "hard kill timeout (default 60 s)".
DEFAULT_TIMEOUT_MS :: 60_000
DEFAULT_MAX_TIMEOUT_MS :: 300_000
// The page's CPU budget: what bounds one synchronous entry the timeout cannot interrupt
// (the deadline is checked between ticks). Below the default timeout on purpose.
DEFAULT_CPU_BUDGET_MS :: 30_000
DEFAULT_PAGES_PER_THREAD :: 8

// Server_Config is what `lava serve` starts a server with. Zero fields take the
// defaults above (server_init fills them).
Server_Config :: struct {
	// `ip:port` to listen on; port 0 picks a free one (Server.port reports it).
	listen:             string,
	// Dispatcher worker threads; 0 is one per core.
	threads:            int,
	pages_per_thread:   int,
	cpu_budget_ms:      int,
	default_timeout_ms: int,
	max_timeout_ms:     int,
	// Requests in flight past which a new one is refused with over_capacity; 0 is
	// threads × pages_per_thread × 2 (one waiting per running).
	max_inflight:       int,
	// When not "", every request must carry `token=<token>`.
	token:              string,
	// Owns everything the server allocates. Used from the dispatcher's worker threads
	// and pkg/http's decode workers too, so it must be thread-safe; zero is the heap.
	allocator:          runtime.Allocator,
}

// Render_Request is a parsed `/render` query. Its strings are owned (allocator).
Render_Request :: struct {
	url:           string,
	selector:      string,
	script:        string,
	script_result: bool,
	timeout_ms:    int,
	allocator:     runtime.Allocator,
}

render_request_destroy :: proc(r: ^Render_Request) {
	delete(r.url, r.allocator)
	delete(r.selector, r.allocator)
	delete(r.script, r.allocator)
	r^ = {}
}

// parse_render_query parses the query string of a `/render` target (after `?`) against
// `cfg`. A parameter given twice is refused: a caller that means one value sends one.
//
// Returns:
//   code .None and the request (strings owned through `allocator`), or the error code
//   and a static message naming the first problem; nothing stays allocated then.
// Deviates:
//   n/a: the contract above is this adapter's own (#15 keeps production's names
//   private). Pinned by cmd/lava/serve_test.odin.
parse_render_query :: proc(
	query: string,
	cfg: Server_Config,
	allocator: runtime.Allocator,
) -> (
	req: Render_Request,
	code: Error_Code,
	message: string,
) {
	req.allocator = allocator
	req.timeout_ms = cfg.default_timeout_ms
	seen: bit_set[Param]
	token := ""
	wait := "load"
	result := "html"
	ok := false

	defer if !ok {
		render_request_destroy(&req)
	}

	rest := query
	for len(rest) > 0 {
		pair: string
		pair, _, rest = strings.partition(rest, "&")

		if pair == "" {
			continue
		}

		raw_name, _, raw_value := strings.partition(pair, "=")
		name, name_ok := query_decode(raw_name, context.temp_allocator)
		value, value_ok := query_decode(raw_value, context.temp_allocator)

		if !name_ok || !value_ok {
			return req, .Bad_Request, "a query parameter is not percent-encoded correctly"
		}

		param, known := param_from_name(name)

		if !known {
			return req,
				.Unsupported,
				"unsupported parameter (this stage serves url, wait, selector, script, result, timeout)"
		}

		if param in seen {
			return req, .Bad_Request, "a query parameter was given twice"
		}

		seen += {param}
		switch param {
		case .Url:
			req.url = strings.clone(value, allocator)
		case .Wait:
			wait = value
		case .Selector:
			req.selector = strings.clone(value, allocator)
		case .Script:
			req.script = strings.clone(value, allocator)
		case .Result:
			result = value
		case .Timeout:
			ms, parsed := strconv.parse_int(value, 10)

			if !parsed || ms <= 0 || ms > cfg.max_timeout_ms {
				return req, .Bad_Request, "timeout must be a whole number of milliseconds within the server's maximum"
			}

			req.timeout_ms = ms
		case .Token:
			token = value
		}
	}

	if cfg.token != "" && !token_matches(token, cfg.token) {
		return req, .Unauthorized, "missing or wrong token"
	}

	if req.url == "" {
		return req, .Bad_Request, "the url parameter is required"
	}

	if !strings.has_prefix(req.url, "http://") && !strings.has_prefix(req.url, "https://") {
		return req, .Bad_Request, "url must be an http or https URL"
	}

	if wait != "load" {
		return req, .Unsupported, "unsupported wait (this stage waits for load only)"
	}

	switch result {
	case "html":
	case "script":
		if req.script == "" {
			return req, .Bad_Request, "result=script needs a script"
		}

		req.script_result = true
	case:
		return req, .Bad_Request, "result must be html or script"
	}

	ok = true
	return req, .None, ""
}

@(private = "file")
Param :: enum {
	Url,
	Wait,
	Selector,
	Script,
	Result,
	Timeout,
	Token,
}

@(private = "file")
param_from_name :: proc(name: string) -> (Param, bool) {
	switch name {
	case "url":
		return .Url, true
	case "wait":
		return .Wait, true
	case "selector":
		return .Selector, true
	case "script":
		return .Script, true
	case "result":
		return .Result, true
	case "timeout":
		return .Timeout, true
	case "token":
		return .Token, true
	}

	return {}, false
}

// query_decode is application/x-www-form-urlencoded's decode of one name or value: `+`
// is a space, then core:net's percent_decode. Not core:net's split_url, which would
// parse the whole query: it keeps one value per name in a map (a repeated parameter
// silently wins or loses) and drops any pair whose value holds a second '='
// (core/net/url.odin:52-55) — an unencoded `url=…?a=b` would vanish instead of failing.
@(private = "file")
query_decode :: proc(s: string, allocator: runtime.Allocator) -> (string, bool) {
	plus, _ := strings.replace_all(s, "+", " ", allocator)
	return net.percent_decode(plus, allocator)
}

// token_matches compares in constant time, so the response time says nothing of how
// much of a guess was right.
@(private = "file")
token_matches :: proc(got, want: string) -> bool {
	return crypto.compare_constant_time(transmute([]byte)got, transmute([]byte)want) == 1
}

// header_safe reports whether `s` can go into a response header value as is: no control
// characters (CR and LF above all), so a value taken from the network — the final URL —
// cannot split the response.
header_safe :: proc(s: string) -> bool {
	for i in 0 ..< len(s) {
		if s[i] < 0x20 || s[i] == 0x7f {
			return false
		}
	}

	return true
}
