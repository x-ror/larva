package lava_runtime

import "base:runtime"
import "core:c"
import "core:strings"
import "core:time"
import cookie "lava:pkg/http/cookie"
import jsc "lava:pkg/jsc"

// The page's half of the cookie jar (pkg/http/cookie): the natives internal/cookie.js
// calls for fetch(), XMLHttpRequest and document.cookie. The jar is the page's session's
// (Runtime_State.cookie_jar). By default the page is its own session, and its jar is born
// and dies with the Runtime_State (new_runtime_state, destroy_runtime_state), so a page
// reusing a pooled VM starts with none of the previous page's cookies. A `lava serve`
// session that outlives its pages points cookie_jar at its own jar (page_crawl.odin) and
// leaves own_cookie_jar empty.
//
// The URL is parsed in JS, by the page's own URL parser, and arrives as its parts:
// https, host and path. Cold natives (one call per request, or per document.cookie
// access), so the generic host path (CLAUDE.md §4).

// make_cookie_bindings returns internal/cookie's natives: `get` and `set` below, and
// `url`, the page's URL as the embedder gave it ("" for an opaque origin), which the
// module parses once for the page's origin and site.
make_cookie_bindings :: proc(ctx: jsc.JSContextRef, page_url: string) -> jsc.JSObjectRef {
	bindings := jsc.JSObjectMake(ctx, nil, nil)
	set_named(ctx, bindings, "url", js_string_value(ctx, page_url))
	inject_native_function(ctx, bindings, "get", cookie_get_cb, arity = 6, constructible = false)
	inject_native_function(ctx, bindings, "set", cookie_set_cb, arity = 7, constructible = false)
	return bindings
}

// cookie_get_cb answers the cookies a request (or document.cookie) sees.
//
// Params (JS):
//   https, host, path        The request URL's parts.
//   script                   true for document.cookie: HttpOnly cookies stay hidden.
//   siteHttps, siteHost      The page's own URL, "" for an opaque one: a request to
//                            another site carries only SameSite=None cookies.
// Returns:
//   The Cookie header value, "" when nothing matches or the page has no jar.
@(private = "file")
cookie_get_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	state := get_state_from_ctx(ctx)

	if state == nil || state.cookie_jar == nil || argument_count < 6 {
		return js_string_value(ctx, "")
	}

	args := arguments[:argument_count]
	host := cookie_arg(ctx, args[1])
	defer delete(host)
	path := cookie_arg(ctx, args[2])
	defer delete(path)
	site_host := cookie_arg(ctx, args[5])
	defer delete(site_host)

	https := jsc.JSValueToBoolean(ctx, args[0])
	source := cookie.Source {
		secure = cookie.is_potentially_trustworthy(bool(https), host),
		host   = host,
		path   = path,
	}
	access: cookie.Access = .Script if jsc.JSValueToBoolean(ctx, args[3]) else .Http
	site := cookie_site(bool(https), host, bool(jsc.JSValueToBoolean(ctx, args[4])), site_host)

	sb := strings.builder_make(context.temp_allocator)
	cookie.cookie_header(state.cookie_jar, source, access, site, time.to_unix_nanoseconds(time.now()), &sb)
	return js_string_value(ctx, strings.to_string(sb))
}

// cookie_set_cb stores one Set-Cookie value (or one document.cookie assignment).
//
// Params (JS):
//   https, host, path, line, script, siteHttps, siteHost — as cookie_get_cb's, `line`
//   being the set-cookie-string.
// Returns:
//   undefined; a refused line changes nothing, as in Chrome, where neither a
//   Set-Cookie nor document.cookie reports one.
@(private = "file")
cookie_set_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	state := get_state_from_ctx(ctx)

	if state == nil || state.cookie_jar == nil || argument_count < 7 {
		return jsc.JSValueMakeUndefined(ctx)
	}

	args := arguments[:argument_count]
	host := cookie_arg(ctx, args[1])
	defer delete(host)
	path := cookie_arg(ctx, args[2])
	defer delete(path)
	line := cookie_arg(ctx, args[3])
	defer delete(line)
	site_host := cookie_arg(ctx, args[6])
	defer delete(site_host)

	https := bool(jsc.JSValueToBoolean(ctx, args[0]))
	source := cookie.Source {
		secure = cookie.is_potentially_trustworthy(https, host),
		host   = host,
		path   = path,
	}
	access: cookie.Access = .Script if jsc.JSValueToBoolean(ctx, args[4]) else .Http
	site := cookie_site(https, host, bool(jsc.JSValueToBoolean(ctx, args[5])), site_host)
	cookie.set_cookie(state.cookie_jar, source, line, access, site, time.to_unix_nanoseconds(time.now()))
	return jsc.JSValueMakeUndefined(ctx)
}

// cookie_arg copies a string argument out as UTF-8 on the heap ("" for an empty one,
// which owns nothing; delete is a no-op on it). Lone surrogates become U+FFFD, as
// Blink's conversion of a DOMString to the UTF-8 it stores does.
@(private = "file")
cookie_arg :: proc(ctx: jsc.JSContextRef, v: jsc.JSValueRef) -> string {
	s, _ := jsc_value_to_string_or_default(ctx, v)
	return s
}

// cookie_site is the request's Site_Context: same-site with the page, or not. The page
// is the only initiator a request has here: no frame tree, no navigation.
@(private = "file")
cookie_site :: proc(https: bool, host: string, site_https: bool, site_host: string) -> cookie.Site_Context {
	return .Same_Site if cookie.same_site(https, host, site_https, site_host) else .Cross_Site
}
