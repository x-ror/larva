package larva_cookie

import "core:fmt"
import "core:strings"
import "core:testing"

// The Public Suffix List lookups and what the jar does with them. No oracle case can
// carry these: tests/web and tests/dom serve from 127.0.0.1, an IP, which never reaches
// the list. Chrome's side was read off Chrome for Testing 158.0.8127.36 directly, by a
// probe outside the tree: a node server on 127.0.0.1, `--host-resolver-rules=MAP *
// 127.0.0.1`, a 302 from http://<from>/ carrying the Set-Cookie line to http://<read>/,
// whose document.cookie was dumped (--dump-dom). Each `probe` comment below is one such
// run: from, line, read => what document.cookie showed.

@(private = "file", rodata)
PSL_VECTORS := #load("psl/test_psl.txt", string)

// Every vector publicsuffix.org ships (psl/test_psl.txt, CC0), IDN ones through
// domain_to_ascii, as Chrome's host canonicaliser would hand them over.
@(test)
psl_vectors_match_publicsuffix_org :: proc(t: ^testing.T) {
	PREFIX :: "checkPublicSuffix("
	checked := 0
	rest := PSL_VECTORS

	for line in strings.split_lines_iterator(&rest) {
		if !strings.has_prefix(line, PREFIX) || strings.has_prefix(line, PREFIX + "null") {
			continue
		}

		args := line[len(PREFIX):strings.last_index(line, ");")]
		comma := strings.index(args, ", ")
		input := strings.trim(args[:comma], "'")
		want := args[comma + 2:]
		want = "" if want == "null" else strings.trim(want, "'")

		in_buf, want_buf: [256]u8
		ascii_in, ok_in := domain_to_ascii(input, in_buf[:])
		ascii_want, ok_want := domain_to_ascii(want, want_buf[:])
		testing.expectf(t, ok_in && ok_want, "%s: not convertible", line)

		got := registrable_domain(ascii_in)
		testing.expectf(t, strings.equal_fold(got, ascii_want), "%s: got %q, want %q", line, got, ascii_want)
		checked += 1
	}

	// 78 vectors, less the null input: a parse that silently matched nothing would pass.
	testing.expect_value(t, checked, 77)
}

// Where Chrome's registry code is not the PSL algorithm word for word, and the rules
// the jar leans on hardest. Each is what Chrome answered in the probe.
@(test)
registrable_domain_follows_chrome :: proc(t: ^testing.T) {
	cases := [?]struct {
		host, want: string,
	} {
		{"www.example.co.uk", "example.co.uk"},
		{"co.uk", ""},
		{"x.github.io", "x.github.io"},
		{"a.x.github.io", "x.github.io"},
		{"github.io", ""},
		{"x.blogspot.com", "x.blogspot.com"},
		// An unlisted TLD is one label: probe a.b.test, `a=1; Domain=b.test`, a.b.test => a=1.
		{"a.b.test", "b.test"},
		{"test", ""},
		// A wildcard's parent is a suffix: probe kobe.jp, `a=1; Domain=kobe.jp`, x.kobe.jp
		// => "" (host-only), where the PSL algorithm would make kobe.jp registrable.
		{"kobe.jp", ""},
		{"c.kobe.jp", ""},
		{"x.city.kobe.jp", "city.kobe.jp"},
		{"www.ck", "www.ck"},
		{"x.www.ck", "www.ck"},
		{"b.test.ck", "b.test.ck"},
		{"test.ck", ""},
		{"Example.COM", "Example.COM"},
		{"www.example.com.", "example.com."},
		{"127.0.0.1", ""},
		{"[::1]", ""},
		{"", ""},
		{".example.com", ""},
	}

	for c in cases {
		got := registrable_domain(c.host)
		testing.expectf(t, got == c.want, "%q: got %q, want %q", c.host, got, c.want)
	}
}

// RFC 3492 §7.1's samples and the IDNA dot variants; what cannot be converted is
// refused rather than guessed.
@(test)
domain_to_ascii_punycodes_labels :: proc(t: ^testing.T) {
	cases := [?]struct {
		input, want: string,
	} {
		{"example.com", "example.com"},
		{"bücher.example.com", "xn--bcher-kva.example.com"},
		{"BÜCHER.Example.com", "xn--bcher-kva.example.com"},
		{"bücher。example．com", "xn--bcher-kva.example.com"},
		{"食狮.公司.cn", "xn--85x722f.xn--55qx5d.cn"},
		{"中国", "xn--fiqs8s"},
		// RFC 3492 §7.1 (A), Arabic (Egyptian).
		{"ليهمابتكلموشعربي؟", "xn--egbpdaj6bu4bxfgehfvwxn"},
		// RFC 3492 §7.1 (L), mixed basic and non-basic.
		{"3年B組金八先生", "xn--3b-ww4c5e180e575a65lsy2b"},
	}

	for c in cases {
		buf: [256]u8
		got, ok := domain_to_ascii(c.input, buf[:])
		testing.expectf(t, ok && got == c.want, "%q: got %q (%v), want %q", c.input, got, ok, c.want)
	}

	buf: [256]u8
	_, ok := domain_to_ascii("b\xffcher.example", buf[:])
	testing.expect(t, !ok, "invalid UTF-8 converted")
	small: [8]u8
	_, ok = domain_to_ascii("bücher.example", small[:])
	testing.expect(t, !ok, "overflowed the buffer")
}

// Domain= against the list, each case one probe run. A public suffix is refused, unless
// it is the host itself, which stores host-only.
@(test)
domain_attribute_refuses_public_suffixes :: proc(t: ^testing.T) {
	cases := [?]struct {
		from, line, read: string,
		want:             Status,
		sent:             bool,
	} {
		{"www.example.co.uk", "a=1; Domain=co.uk", "www.example.co.uk", .Bad_Domain, false},
		{"www.example.co.uk", "a=1; Domain=.co.uk", "www.example.co.uk", .Bad_Domain, false},
		{"www.example.co.uk", "a=1; Domain=example.co.uk", "other.example.co.uk", .Stored, true},
		{"x.github.io", "a=1; Domain=github.io", "x.github.io", .Bad_Domain, false},
		{"x.github.io", "a=1; Domain=x.github.io", "y.x.github.io", .Stored, true},
		{"x.blogspot.com", "a=1; Domain=blogspot.com", "x.blogspot.com", .Bad_Domain, false},
		{"co.uk", "a=1; Domain=co.uk", "co.uk", .Stored, true},
		{"co.uk", "a=1; Domain=co.uk", "www.co.uk", .Stored, false},
		{"a.b.test", "a=1; Domain=b.test", "c.b.test", .Stored, true},
		{"a.b.test", "a=1; Domain=test", "a.b.test", .Bad_Domain, false},
		{"b.test.ck", "a=1; Domain=test.ck", "b.test.ck", .Bad_Domain, false},
		{"x.www.ck", "a=1; Domain=www.ck", "www.ck", .Stored, true},
		{"x.city.kobe.jp", "a=1; Domain=city.kobe.jp", "city.kobe.jp", .Stored, true},
		{"a.b.kobe.jp", "a=1; Domain=b.kobe.jp", "a.b.kobe.jp", .Bad_Domain, false},
		{"kobe.jp", "a=1; Domain=kobe.jp", "kobe.jp", .Stored, true},
		{"kobe.jp", "a=1; Domain=kobe.jp", "x.kobe.jp", .Stored, false},
		{"localhost", "a=1; Domain=localhost", "localhost", .Stored, true},
		{"xn--bcher-kva.example.com", "a=1; Domain=bücher.example.com", "q.xn--bcher-kva.example.com", .Stored, true},
		{"xn--bcher-kva.example.com", "a=1; Domain=BÜCHER.example.com", "xn--bcher-kva.example.com", .Stored, true},
		{"xn--bcher-kva.example.com", "a=1; Domain=xn--bcher-kva.example.com", "q.xn--bcher-kva.example.com", .Stored, true},
	}

	for c in cases {
		jar: Jar
		jar_init(&jar)
		defer jar_destroy(&jar)

		got := set_cookie(&jar, {secure = true, host = c.from, path = "/"}, c.line, .Http, .Same_Site, NOW_PSL)
		testing.expectf(t, got == c.want, "%s %q: want %v, got %v", c.from, c.line, c.want, got)

		sb := strings.builder_make(context.temp_allocator)
		cookie_header(&jar, {secure = true, host = c.read, path = "/"}, .Http, .Same_Site, NOW_PSL, &sb)
		testing.expectf(
			t,
			(strings.to_string(sb) == "a=1") == c.sent,
			"%s %q read from %s: got %q",
			c.from,
			c.line,
			c.read,
			strings.to_string(sb),
		)
	}
}

// The site is the registrable domain: two github.io sites are two sites for SameSite
// (probe: a SameSite=Strict cookie on c.github.io did not follow a navigation from
// a.github.io; on c.b.test it followed one from a.b.test) and for the per-site limit.
@(test)
sites_are_registrable_domains :: proc(t: ^testing.T) {
	testing.expect(t, !same_site(true, "a.github.io", true, "c.github.io"))
	testing.expect(t, !same_site(true, "a.co.uk", true, "b.co.uk"))
	testing.expect(t, !same_site(true, "a.kobe.jp", true, "c.kobe.jp"))
	testing.expect(t, same_site(true, "a.b.test", true, "c.b.test"))
	testing.expect(t, same_site(true, "www.example.co.uk", true, "example.co.uk"))

	jar: Jar
	jar_init(&jar)
	defer jar_destroy(&jar)

	// A full site on a.github.io must not count b.github.io's cookie, nor purge it.
	a := Source {
		secure = true,
		host   = "a.github.io",
		path   = "/",
	}
	b := Source {
		secure = true,
		host   = "b.github.io",
		path   = "/",
	}
	testing.expect_value(t, set_cookie(&jar, b, "keep=1", .Http, .Same_Site, NOW_PSL), Status.Stored)

	for i in 0 ..< DOMAIN_MAX_COOKIES {
		set_cookie(&jar, a, fmt.tprintf("c%d=1", i), .Http, .Same_Site, NOW_PSL + i64(i + 1))
	}

	testing.expect_value(t, len(jar.cookies), DOMAIN_MAX_COOKIES + 1)

	sb := strings.builder_make(context.temp_allocator)
	cookie_header(&jar, b, .Http, .Same_Site, NOW_PSL, &sb)
	testing.expect_value(t, strings.to_string(sb), "keep=1")
}

// 2026-11-28T00:00:00Z, cookie_test.odin's clock.
@(private = "file")
NOW_PSL :: i64(1_795_824_000) * 1_000_000_000
