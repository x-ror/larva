package larva_http

import "core:strings"
import cookie "lava:pkg/http/cookie"

// A document's subresource requests (a `<script src>`, docs/LARVA.md stage 4): the URL a
// reference names against the document's, and the request headers that depend on where
// the request goes relative to the document. Here because the URL split they need is
// the transport's own (parse_url), which a caller outside the package cannot reach.

// resolve resolves `ref` against `base`, an absolute http(s) URL, the way a Location is
// resolved (resolve_url: RFC 3986 §5.2.2, dot segments removed).
//
// Returns:
//   The URL, allocated with `allocator`; ok false, and nothing allocated, when `base` is
//   not an http(s) URL this transport takes or the result is not one (another scheme —
//   data:, blob:, javascript: — or a malformed authority).
// Deviates:
//   RFC 3986, not the WHATWG URL parser: tabs and newlines inside `ref` are not removed,
//   and a backslash is not a slash. A page's own resolution (`new URL`, internal/url)
//   is the WHATWG one; this one serves only the native subresource loader. Unrecorded.
resolve :: proc(base, ref: string, allocator := context.allocator) -> (url: string, ok: bool) {
	if _, err := parse_url(base, context.temp_allocator); err != .None {
		return "", false
	}

	out := resolve_url(base, ref, allocator)

	if _, err := parse_url(out, context.temp_allocator); err != .None {
		delete(out, allocator)
		return "", false
	}

	return out, true
}

// Subresource_Context is what a subresource request says about where it comes from.
Subresource_Context :: struct {
	// Sec-Fetch-Site: "same-origin", "same-site" or "cross-site".
	site:    string,
	// Referer under Chrome's default policy (strict-origin-when-cross-origin): the
	// document's URL without its fragment to its own origin, its origin elsewhere, and
	// nothing ("") from https to http. In the temp arena.
	referer: string,
}

// subresource_context answers Subresource_Context for a request from `document` (the
// page's URL) to `target`. Both must be http(s) URLs resolve accepts; anything else
// answers cross-site with no referrer.
//
// Chrome:
//   The Fetch standard's Sec-Fetch-Site and Referrer Policy's
//   strict-origin-when-cross-origin, Chrome's default since 85. Unrecorded: tests/dom's
//   fixture server sees requests from one origin only.
subresource_context :: proc(document, target: string) -> Subresource_Context {
	doc, doc_err := parse_url(document, context.temp_allocator)
	to, to_err := parse_url(target, context.temp_allocator)

	if doc_err != .None || to_err != .None {
		return {site = "cross-site"}
	}

	if same_origin(doc, to) {
		return {site = "same-origin", referer = strings.truncate_to_byte(document, '#')}
	}

	out := Subresource_Context {
		site = "same-site" if cookie.same_site(doc.https, doc.host, to.https, to.host) else "cross-site",
	}

	if doc.https && !to.https {
		return out
	}

	sb := strings.builder_make(context.temp_allocator)
	strings.write_string(&sb, "https://" if doc.https else "http://")
	write_host_header(&sb, doc)
	strings.write_byte(&sb, '/')
	out.referer = strings.to_string(sb)
	return out
}
