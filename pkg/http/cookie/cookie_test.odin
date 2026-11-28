package larva_cookie

import "core:fmt"
import "core:mem"
import "core:strings"
import "core:testing"

// The parser and the matcher against what Chrome 158 recorded (tests/dom/cases
// cookie-document-*.page, tests/web/cases cookie-*), plus what no oracle can see: the
// jar's allocator pairing and its refusal reasons.

// 2026-11-28T00:00:00Z, a fixed clock.
@(private = "file")
NOW :: i64(1_795_824_000) * 1_000_000_000

// The page the document.cookie recordings ran on.
@(private = "file")
page :: proc(path: string) -> Source {
	return {secure = is_potentially_trustworthy(false, "127.0.0.1"), host = "127.0.0.1", path = path}
}

@(private = "file")
header :: proc(jar: ^Jar, url: Source, access := Access.Script, site := Site_Context.Same_Site, now := NOW) -> string {
	sb := strings.builder_make(context.temp_allocator)
	cookie_header(jar, url, access, site, now, &sb)
	return strings.to_string(sb)
}

// The steps of tests/dom/cases/cookie-document-basic.page, each with what Chrome's
// document.cookie read back after it.
@(test)
document_cookie_steps_match_chrome :: proc(t: ^testing.T) {
	jar: Jar
	jar_init(&jar)
	defer jar_destroy(&jar)

	url := page("/raw/cookie-document-basic.page")
	steps := [?]struct {
		line, want: string,
	} {
		{"a=1", "a=1"},
		{"b=2", "a=1; b=2"},
		{"a=3", "b=2; a=3"},
		{"b=2", "b=2; a=3"},
		{"b=2; SameSite=Strict", "b=2; a=3"},
		{"  c  =  x y  ; Path=/raw ", "b=2; a=3; c=x y"},
		{"q=\"v w\"", "b=2; a=3; c=x y; q=\"v w\""},
		{"lonely", "b=2; a=3; c=x y; q=\"v w\"; lonely"},
		{"=eq", "b=2; a=3; c=x y; q=\"v w\"; eq"},
		{"=", "b=2; a=3; c=x y; q=\"v w\"; eq"},
		{"", "b=2; a=3; c=x y; q=\"v w\"; eq"},
		{"e=a=b=c", "b=2; a=3; c=x y; q=\"v w\"; eq; e=a=b=c"},
		{"ctl=a\x01b", "b=2; a=3; c=x y; q=\"v w\"; eq; e=a=b=c"},
		{"tab=a\tb", "b=2; a=3; c=x y; q=\"v w\"; eq; e=a=b=c"},
		{"nl=a\nb", "b=2; a=3; c=x y; q=\"v w\"; eq; e=a=b=c"},
		{"del=a\x7fb", "b=2; a=3; c=x y; q=\"v w\"; eq; e=a=b=c"},
		{"ca=1; Path=/r\x01aw", "b=2; a=3; c=x y; q=\"v w\"; eq; e=a=b=c"},
		{";x=1", "b=2; a=3; c=x y; q=\"v w\"; eq; e=a=b=c"},
		{"b=; Max-Age=0", "a=3; c=x y; q=\"v w\"; eq; e=a=b=c"},
		{"a=; Expires=Thu, 01 Jan 1970 00:00:00 GMT", "c=x y; q=\"v w\"; eq; e=a=b=c"},
		{"c=gone; Path=/raw; Max-Age=-5", "q=\"v w\"; eq; e=a=b=c"},
		{"f=1; Expires=Fri, 01 Jan 2100 00:00:00 GMT", "q=\"v w\"; eq; e=a=b=c; f=1"},
		{"g=1; Max-Age=100; Expires=Thu, 01 Jan 1970 00:00:00 GMT", "q=\"v w\"; eq; e=a=b=c; f=1; g=1"},
		{"g2=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=100", "q=\"v w\"; eq; e=a=b=c; f=1; g=1; g2=1"},
		{"h=1; Max-Age=abc", "q=\"v w\"; eq; e=a=b=c; f=1; g=1; g2=1; h=1"},
		{"i=1; Max-Age=+0", "q=\"v w\"; eq; e=a=b=c; f=1; g=1; g2=1; h=1"},
		{"j=1; Expires=never", "q=\"v w\"; eq; e=a=b=c; f=1; g=1; g2=1; h=1; j=1"},
		{"k=1; Expires=Thu, 01-Jan-70 00:00:01 GMT", "q=\"v w\"; eq; e=a=b=c; f=1; g=1; g2=1; h=1; j=1"},
		{"k2=1; Expires=Thu, 01-Jan-69 00:00:01 GMT", "q=\"v w\"; eq; e=a=b=c; f=1; g=1; g2=1; h=1; j=1; k2=1"},
		{"l=1; expires=1 jan 1980 00:00:00", "q=\"v w\"; eq; e=a=b=c; f=1; g=1; g2=1; h=1; j=1; k2=1"},
		{"m=1; Expires=Sat, 01 Jan 1600 00:00:00 GMT", "q=\"v w\"; eq; e=a=b=c; f=1; g=1; g2=1; h=1; j=1; k2=1"},
		{"=eq; Max-Age=0", "q=\"v w\"; e=a=b=c; f=1; g=1; g2=1; h=1; j=1; k2=1"},
	}

	for s, i in steps {
		set_cookie(&jar, url, s.line, .Script, .Same_Site, NOW + i64(i))
		got := header(&jar, url)
		testing.expectf(t, got == s.want, "step %d %q: want %q, got %q", i, s.line, s.want, got)
	}
}

// tests/dom/cases/cookie-document-attributes.page: which cookies the page at
// /raw/cookie-document-attributes.page sees, in Chrome's order.
@(test)
attributes_match_chrome :: proc(t: ^testing.T) {
	jar: Jar
	jar_init(&jar)
	defer jar_destroy(&jar)

	self := "/raw/cookie-document-attributes.page"
	url := page(self)
	lines := [?]string {
		"d=1",
		"p1=1; Path=/",
		"p2=1; Path=/raw",
		"p3=1; Path=/raw/",
		"p4=1; Path=/ra",
		"p5=1; Path=/other",
		"p6=1; Path=raw",
		"p7=1; Path=",
		fmt.tprintf("p8=1; Path=%s", self),
		fmt.tprintf("p9=1; Path=%s/deeper", self),
		"p10=1; Path=/RAW",
		"d=2; Path=/",
		"dom1=1; Domain=127.0.0.1",
		"dom2=1; Domain=.127.0.0.1",
		"dom3=1; Domain=example.com",
		"dom4=1; Domain=0.0.1",
		"dom5=1; Domain=",
		"dom6=1; Domain=localhost",
		"s1=1; Secure",
		"s2=1; secure=yes",
		"h1=1; HttpOnly",
		"h1=2",
		"ss1=1; SameSite=Strict",
		"ss2=1; SameSite=Lax",
		"ss3=1; SameSite=None",
		"ss4=1; SameSite=None; Secure",
		"ss5=1; SameSite=Bogus",
		"__Secure-a=1",
		"__Secure-b=1; Secure",
		"__Host-c=1; Path=/",
		"__Host-d=1; Secure; Path=/",
		"__secure-e=1",
		"__host-f=1; Path=/",
		"__Secure-g",
		"__Host-h",
		"d=3; Path=/; Secure",
	}

	for line, i in lines {
		set_cookie(&jar, url, line, .Script, .Same_Site, NOW + i64(i))
	}

	want := "p8=1; p3=1; d=1; p2=1; p6=1; p7=1; dom1=1; dom2=1; dom5=1; s1=1; s2=1; h1=2; ss1=1; ss2=1; ss4=1; ss5=1; __Secure-b=1; p1=1; __Host-d=1; d=3"
	got := header(&jar, url)
	testing.expectf(t, got == want, "want %q,\n got %q", want, got)
}

@(test)
refusals_say_why :: proc(t: ^testing.T) {
	jar: Jar
	jar_init(&jar)
	defer jar_destroy(&jar)

	https := Source {
		secure = true,
		host   = "www.example.com",
		path   = "/a/b",
	}
	http := Source {
		secure = false,
		host   = "www.example.com",
		path   = "/a/b",
	}
	cases := [?]struct {
		url:    Source,
		line:   string,
		access: Access,
		site:   Site_Context,
		want:   Status,
	} {
		{https, "a=1", .Http, .Same_Site, .Stored},
		{https, "a=; Max-Age=0", .Http, .Same_Site, .Deleted},
		{https, "=", .Http, .Same_Site, .Invalid},
		{https, "a=\x00", .Http, .Same_Site, .Invalid},
		{https, "a=1; Domain=other.com", .Http, .Same_Site, .Bad_Domain},
		{https, "a=1; Domain=com", .Http, .Same_Site, .Bad_Domain},
		{https, "a=1; Domain=ample.com", .Http, .Same_Site, .Bad_Domain},
		{https, "a=1; Domain=café.com", .Http, .Same_Site, .Bad_Domain},
		{http, "a=1; Secure", .Http, .Same_Site, .Insecure},
		{https, "__Host-a=1; Secure; Path=/; Domain=example.com", .Http, .Same_Site, .Prefix},
		{https, "__Host-a=1; Secure", .Http, .Same_Site, .Prefix},
		{https, "h=1; HttpOnly", .Script, .Same_Site, .Http_Only},
		{https, "n=1; SameSite=None", .Http, .Same_Site, .Same_Site_None_Insecure},
		{https, "x=1", .Http, .Cross_Site, .Same_Site_Context},
		{https, "x=1; SameSite=Lax", .Http, .Cross_Site, .Same_Site_Context},
		{https, "x=1; SameSite=None; Secure", .Http, .Cross_Site, .Stored},
		{
			https,
			strings.concatenate(
				{"big=", strings.repeat("v", MAX_NAME_VALUE_BYTES - 2, context.temp_allocator)},
				context.temp_allocator,
			),
			.Http,
			.Same_Site,
			.Too_Large,
		},
		{
			https,
			strings.concatenate(
				{"big=", strings.repeat("v", MAX_NAME_VALUE_BYTES - 3, context.temp_allocator)},
				context.temp_allocator,
			),
			.Http,
			.Same_Site,
			.Stored,
		},
	}

	for c in cases {
		got := set_cookie(&jar, c.url, c.line, c.access, c.site, NOW)
		testing.expectf(t, got == c.want, "%q: want %v, got %v", c.line, c.want, got)
	}
}

// A domain cookie reaches the domain and its subdomains, a host-only cookie its host
// alone; a sibling or a lookalike suffix gets neither.
@(test)
domain_cookies_reach_subdomains :: proc(t: ^testing.T) {
	jar: Jar
	jar_init(&jar)
	defer jar_destroy(&jar)

	from := Source {
		secure = true,
		host   = "www.example.com",
		path   = "/",
	}
	testing.expect_value(t, set_cookie(&jar, from, "d=1; Domain=.Example.com", .Http, .Same_Site, NOW), Status.Stored)
	testing.expect_value(t, set_cookie(&jar, from, "h=1", .Http, .Same_Site, NOW + 1), Status.Stored)

	cases := [?]struct {
		host, want: string,
	} {
		{"www.example.com", "d=1; h=1"},
		{"example.com", "d=1"},
		{"a.b.example.com", "d=1"},
		{"badexample.com", ""},
		{"example.org", ""},
	}
	for c in cases {
		got := header(&jar, {secure = true, host = c.host, path = "/"}, .Http)
		testing.expectf(t, got == c.want, "%s: want %q, got %q", c.host, c.want, got)
	}
}

// Path-match needs a segment boundary: /fx/cookie-echo does not reach /fx/cookie-echo2
// (tests/web/cases/cookie-fetch "path without a boundary").
@(test)
path_match_needs_a_boundary :: proc(t: ^testing.T) {
	testing.expect(t, path_matches("/fx/cookie-echo", "/fx/cookie-echo"))
	testing.expect(t, path_matches("/fx/cookie-echo/x", "/fx/cookie-echo"))
	testing.expect(t, path_matches("/fx/cookie-echo/x", "/fx/"))
	testing.expect(t, !path_matches("/fx/cookie-echo2", "/fx/cookie-echo"))
	testing.expect(t, !path_matches("/fx", "/fx/cookie-echo"))
	testing.expect_value(t, default_path("/fx/cookie-set"), "/fx")
	testing.expect_value(t, default_path("/x"), "/")
	testing.expect_value(t, default_path(""), "/")
	testing.expect_value(t, default_path("x"), "/")
}

// Secure cookies go only to a secure URL, HttpOnly ones only to the HTTP stack, and
// SameSite decides what a cross-site request carries.
@(test)
sending_honours_secure_httponly_and_samesite :: proc(t: ^testing.T) {
	jar: Jar
	jar_init(&jar)
	defer jar_destroy(&jar)

	https := Source {
		secure = true,
		host   = "example.com",
		path   = "/",
	}
	lines := [?]string {
		"plain=1",
		"sec=1; Secure",
		"ho=1; HttpOnly",
		"strict=1; SameSite=Strict",
		"lax=1; SameSite=Lax",
		"none=1; SameSite=None; Secure",
	}
	for line, i in lines {
		testing.expect_value(t, set_cookie(&jar, https, line, .Http, .Same_Site, NOW + i64(i)), Status.Stored)
	}

	http := Source {
		secure = false,
		host   = "example.com",
		path   = "/",
	}
	cases := [?]struct {
		url:    Source,
		access: Access,
		site:   Site_Context,
		want:   string,
	} {
		{https, .Http, .Same_Site, "plain=1; sec=1; ho=1; strict=1; lax=1; none=1"},
		{http, .Http, .Same_Site, "plain=1; ho=1; strict=1; lax=1"},
		{https, .Script, .Same_Site, "plain=1; sec=1; strict=1; lax=1; none=1"},
		{https, .Http, .Lax_Navigation, "plain=1; sec=1; ho=1; lax=1; none=1"},
		{https, .Http, .Cross_Site, "none=1"},
		{http, .Http, .Cross_Site, ""},
	}
	for c, i in cases {
		got := header(&jar, c.url, c.access, c.site)
		testing.expectf(t, got == c.want, "case %d: want %q, got %q", i, c.want, got)
	}
}

// A script may not overwrite an HttpOnly cookie, and an insecure source may not shadow a
// Secure one.
@(test)
protected_cookies_stay :: proc(t: ^testing.T) {
	jar: Jar
	jar_init(&jar)
	defer jar_destroy(&jar)

	https := Source {
		secure = true,
		host   = "example.com",
		path   = "/",
	}
	http := Source {
		secure = false,
		host   = "example.com",
		path   = "/",
	}
	testing.expect_value(t, set_cookie(&jar, https, "h=1; HttpOnly", .Http, .Same_Site, NOW), Status.Stored)
	testing.expect_value(t, set_cookie(&jar, https, "h=2", .Script, .Same_Site, NOW), Status.Http_Only)
	testing.expect_value(t, set_cookie(&jar, https, "s=1; Secure", .Http, .Same_Site, NOW), Status.Stored)
	testing.expect_value(t, set_cookie(&jar, http, "s=2", .Http, .Same_Site, NOW), Status.Shadows_Secure)
	testing.expect_value(t, header(&jar, https, .Http), "h=1; s=1")
}

// Expiry: Max-Age and Expires are capped 400 days out, an expired cookie drops out of
// the header, and Max-Age saturates rather than wrapping.
@(test)
expiry_is_capped_and_enforced :: proc(t: ^testing.T) {
	jar: Jar
	jar_init(&jar)
	defer jar_destroy(&jar)

	url := Source {
		secure = true,
		host   = "example.com",
		path   = "/",
	}
	testing.expect_value(
		t,
		set_cookie(&jar, url, "a=1; Max-Age=99999999999999999999999", .Http, .Same_Site, NOW),
		Status.Stored,
	)
	testing.expect_value(t, set_cookie(&jar, url, "b=1; Max-Age=10", .Http, .Same_Site, NOW), Status.Stored)
	testing.expect_value(
		t,
		set_cookie(&jar, url, "c=1; Expires=Fri, 01 Jan 2100 00:00:00 GMT", .Http, .Same_Site, NOW),
		Status.Stored,
	)
	now_s := NOW / NS_PER_SECOND
	testing.expect_value(t, jar.cookies[0].expires, now_s + MAX_EXPIRY_SECONDS)
	testing.expect_value(t, jar.cookies[2].expires, now_s + MAX_EXPIRY_SECONDS)
	testing.expect_value(t, header(&jar, url, .Http, .Same_Site, NOW + 9 * NS_PER_SECOND), "a=1; b=1; c=1")
	testing.expect_value(t, header(&jar, url, .Http, .Same_Site, NOW + 10 * NS_PER_SECOND), "a=1; c=1")
	testing.expect_value(t, len(jar.cookies), 2)
}

@(test)
cookie_dates_parse :: proc(t: ^testing.T) {
	cases := [?]struct {
		s:    string,
		want: i64,
		ok:   bool,
	} {
		{"Thu, 01 Jan 1970 00:00:00 GMT", 0, true},
		{"Wed, 21 Oct 2015 07:28:00 GMT", 1445412480, true},
		{"Thu, 01-Jan-70 00:00:01 GMT", 1, true},
		{"1 jan 1980 00:00:00", 315532800, true},
		{"Sun Nov  6 08:49:37 1994", 784111777, true},
		{"Sat, 01 Jan 1600 00:00:00 GMT", -11644473600, true}, // clamped to 1601
		{"Thu, 31 Feb 2015 00:00:00 GMT", 0, false},
		{"Thu, 01 Jan 2015 24:00:00 GMT", 0, false},
		{"never", 0, false},
		{"01 Jan 2015", 0, false},
	}
	for c in cases {
		got, ok := parse_cookie_date(c.s)
		testing.expectf(t, ok == c.ok && got == c.want, "%q: want %v %v, got %v %v", c.s, c.want, c.ok, got, ok)
	}
}

// tests/dom/cases/cookie-document-limits.page: the 181st cookie on a site purges it to
// 150, the oldest first; 400 sets leave k247..k399.
@(test)
a_full_site_purges_its_oldest :: proc(t: ^testing.T) {
	jar: Jar
	jar_init(&jar)
	defer jar_destroy(&jar)

	url := page("/raw/cookie-document-limits.page")
	set_cookie(&jar, url, "pa=1; Path=/x", .Script, .Same_Site, NOW)
	jumps := strings.builder_make(context.temp_allocator)
	last := 1
	for i in 0 ..< 400 {
		set_cookie(&jar, url, fmt.tprintf("k%d=%d", i, i), .Script, .Same_Site, NOW + i64(i) + 1)

		if len(jar.cookies) != last + 1 {
			fmt.sbprintf(&jumps, "%d:%d ", i, len(jar.cookies))
		}

		last = len(jar.cookies)
	}

	testing.expect_value(
		t,
		strings.to_string(jumps),
		"179:150 210:150 241:150 272:150 303:150 334:150 365:150 396:150 ",
	)
	testing.expect_value(t, jar.cookies[0].name, "k247")
}

// The jar allocates and frees through the allocator it captured, never the ambient one:
// the runtime sets cookies from `proc "c"` natives, whose context is not the page's. A
// panic allocator stands in for the ambient one, and the tracking allocator must end
// empty with no bad free.
@(test)
jar_uses_only_its_allocator :: proc(t: ^testing.T) {
	track: mem.Tracking_Allocator
	mem.tracking_allocator_init(&track, context.allocator)
	defer mem.tracking_allocator_destroy(&track)

	jar: Jar
	jar_init(&jar, mem.tracking_allocator(&track))

	{
		context.allocator = mem.panic_allocator()
		url := Source {
			secure = true,
			host   = "example.com",
			path   = "/",
		}
		set_cookie(&jar, url, "a=1", .Http, .Same_Site, NOW)
		set_cookie(&jar, url, "a=2", .Http, .Same_Site, NOW) // replaced
		set_cookie(&jar, url, "b=1; Max-Age=1", .Http, .Same_Site, NOW)
		set_cookie(&jar, url, "a=; Max-Age=0", .Http, .Same_Site, NOW) // deleted
		for i in 0 ..< 70 {
			// past the header's fixed buffer of matches, so it spills
			line := fmt.bprintf(make([]byte, 32, context.temp_allocator), "m%d=1", i)
			set_cookie(&jar, url, line, .Http, .Same_Site, NOW)
		}

		sb := strings.builder_make(context.temp_allocator)
		testing.expect(t, cookie_header(&jar, url, .Http, .Same_Site, NOW + 2 * NS_PER_SECOND, &sb))
		testing.expect(t, !strings.contains(strings.to_string(sb), "b=1"))
		testing.expect_value(t, len(jar.cookies), 70)
	}

	jar_destroy(&jar)
	testing.expect_value(t, len(track.allocation_map), 0)
	testing.expect_value(t, len(track.bad_free_array), 0)
}

@(test)
site_keys_and_trust :: proc(t: ^testing.T) {
	testing.expect_value(t, site_key("a.b.example.com"), "example.com")
	testing.expect_value(t, site_key("127.0.0.1"), "127.0.0.1")
	testing.expect_value(t, site_key("localhost"), "localhost")
	testing.expect(t, same_site(true, "a.example.com", true, "b.example.com"))
	testing.expect(t, !same_site(false, "a.example.com", true, "a.example.com"))
	testing.expect(t, !same_site(true, "", true, "example.com"))
	testing.expect(t, is_potentially_trustworthy(false, "127.9.9.9"))
	testing.expect(t, is_potentially_trustworthy(false, "[::1]"))
	testing.expect(t, is_potentially_trustworthy(false, "app.localhost"))
	testing.expect(t, !is_potentially_trustworthy(false, "example.com"))
	testing.expect(t, !is_potentially_trustworthy(false, "128.0.0.1"))
}
