package main

import "core:testing"
import lava_runtime "lava:pkg/runtime"

// Exercises parse_http_url, focusing on IPv6 literal hosts (issue #13) while
// guarding the existing IPv4/hostname/userinfo/query behaviour. The parser
// returns IPv6 hosts bracket-stripped (the connect path wants the bare address;
// build_http_request re-brackets them for the Host header).
@(test)
parse_http_url_cases :: proc(t: ^testing.T) {
	Case :: struct {
		url:    string,
		host:   string,
		port:   int,
		path:   string,
		scheme: string,
		ok:     bool,
	}
	cases := []Case {
		// IPv4 / hostname regressions.
		{"http://example.com/", "example.com", 80, "/", "http", true},
		{"http://example.com:8080/path?q=1", "example.com", 8080, "/path?q=1", "http", true},
		{"https://example.com/", "example.com", 443, "/", "https", true},
		{"http://127.0.0.1:3000/x", "127.0.0.1", 3000, "/x", "http", true},
		{"http://user:pass@example.com:9/p", "example.com", 9, "/p", "http", true},
		// IPv6 literals: brackets stripped, port only after ']'.
		{"http://[::1]/", "::1", 80, "/", "http", true},
		{"http://[::1]:8080/path", "::1", 8080, "/path", "http", true},
		{"http://[2001:db8::1]:443/", "2001:db8::1", 443, "/", "http", true},
		{"https://[::1]/", "::1", 443, "/", "https", true},
		{"http://[::1]", "::1", 80, "/", "http", true},
		{"http://[::1]?q=1", "::1", 80, "?q=1", "http", true},
		{"http://user@[fe80::1]:8080/p", "fe80::1", 8080, "/p", "http", true},
		// Malformed: unterminated bracket and empty host reject.
		{"http://[::1/", "", 0, "", "", false},
		{"http://[]/", "", 0, "", "", false},
		{"ftp://example.com/", "", 0, "", "", false},
		// Junk after the IPv6 literal's closing ']' (only ":port" may follow) rejects.
		{"http://[::1]foo/", "", 0, "", "", false},
		{"http://[::1]x", "", 0, "", "", false},
	}
	for c in cases {
		host, port, path, scheme, ok := lava_runtime.parse_http_url(c.url)
		testing.expectf(t, ok == c.ok, "%s: ok=%v want %v", c.url, ok, c.ok)

		if !c.ok {
			continue
		}

		testing.expectf(t, host == c.host, "%s: host=%q want %q", c.url, host, c.host)
		testing.expectf(t, port == c.port, "%s: port=%d want %d", c.url, port, c.port)
		testing.expectf(t, path == c.path, "%s: path=%q want %q", c.url, path, c.path)
		testing.expectf(t, scheme == c.scheme, "%s: scheme=%q want %q", c.url, scheme, c.scheme)
	}
}

// Exercises fetch_parse_chunk_size: RFC 7230 chunk-size is unsigned hex (1*HEXDIG).
// A signed/empty/non-hex/overflowing field must be rejected so the chunked decoder
// fails the framing rather than advancing on a negative size.
@(test)
fetch_parse_chunk_size_cases :: proc(t: ^testing.T) {
	Case :: struct {
		text: string,
		size: int,
		ok:   bool,
	}
	cases := []Case {
		{"0", 0, true},
		{"a", 10, true},
		{"FF", 255, true},
		{"ff", 255, true},
		{"1000", 4096, true},
		// Rejected: empty, signed, non-hex, and overflow past int range.
		{"", 0, false},
		{"-1", 0, false},
		{"+5", 0, false},
		{"1g", 0, false},
		{"0x10", 0, false}, // the 'x' is not a hex digit
		{"ffffffffffffffff", 0, false}, // 2^64-1 overflows a positive int
	}
	for c in cases {
		size, ok := lava_runtime.fetch_parse_chunk_size(c.text)
		testing.expectf(t, ok == c.ok, "%q: ok=%v want %v", c.text, ok, c.ok)

		if !c.ok {
			continue
		}

		testing.expectf(t, size == c.size, "%q: size=%d want %d", c.text, size, c.size)
	}
}
