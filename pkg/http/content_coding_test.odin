#+build linux
package larva_http

import "core:bytes"
import "core:encoding/json"
import "core:strings"
import "core:testing"
import zlib "vendor:zlib"

// The Content-Encoding fixtures and what Chrome decoded from each: gen.mjs writes
// <name>.in, record-chrome.py records <name>.out (the bytes fetch() returned) or
// <name>.err (a network error).
@(private = "file")
fixtures := #load_directory("testdata/content-coding")

@(private = "file")
Case :: struct {
	name:     string,
	encoding: []string,
	secure:   bool,
}

@(private = "file")
SECURE_URL :: Url {
	https  = true,
	host   = "127.0.0.1",
	port   = 443,
	target = "/",
}

@(private = "file")
INSECURE_URL :: Url {
	host   = "plain.test",
	port   = 80,
	target = "/",
}

// Every fixture decodes to the bytes Chrome produced, or fails where Chrome failed.
@(test)
decodes_as_chrome_does :: proc(t: ^testing.T) {
	cases: []Case
	err := json.unmarshal(fixture(t, "cases.json"), &cases, allocator = context.temp_allocator)
	testing.expectf(t, err == nil, "cases.json: %v", err)
	testing.expect(t, len(cases) > 40, "cases.json lists too few cases")

	for c in cases {
		headers := make([]Header, len(c.encoding), context.temp_allocator)
		for e, i in c.encoding {
			headers[i] = {"Content-Encoding", e}
		}

		// The tracked allocator, not the temp one: every step's buffer but the last must
		// be freed, and the runner reports what is not.
		body := make([dynamic]byte)
		defer delete(body)
		append(&body, ..fixture(t, strings.concatenate({c.name, ".in"}, context.temp_allocator)))
		got := decode_content(&body, headers, SECURE_URL if c.secure else INSECURE_URL, DEFAULT_MAX_BODY_BYTES)

		if want, ok := find_fixture(strings.concatenate({c.name, ".out"}, context.temp_allocator)); ok {
			testing.expectf(t, got == .None, "%s: want the body Chrome decoded, got %v", c.name, got)
			testing.expectf(
				t,
				bytes.equal(body[:], want),
				"%s: want %d bytes %q, got %d bytes %q",
				c.name,
				len(want),
				clip(want),
				len(body),
				clip(body[:]),
			)
		} else {
			_, failed := find_fixture(strings.concatenate({c.name, ".err"}, context.temp_allocator))
			testing.expectf(t, failed, "%s: no recording", c.name)
			testing.expectf(t, got == .Decoding, "%s: Chrome failed it, got %v", c.name, got)
		}
	}
}

// Recorded from Chrome 158 against a local server echoing the header back.
@(test)
accept_encoding_follows_the_secure_context :: proc(t: ^testing.T) {
	SECURE :: "gzip, deflate, br, zstd"
	INSECURE :: "gzip, deflate"
	cases := [?]struct {
		https: bool,
		host:  string,
		want:  string,
	} {
		{true, "example.com", SECURE},
		{true, "127.0.0.1", SECURE},
		{false, "127.0.0.1", SECURE},
		{false, "127.200.1.9", SECURE},
		{false, "::1", SECURE},
		{false, "localhost", SECURE},
		{false, "LocalHost", SECURE},
		{false, "app.localhost", SECURE},
		{false, "plain.test", INSECURE},
		{false, "example.com", INSECURE},
		{false, "128.0.0.1", INSECURE},
		{false, "::2", INSECURE},
		{false, "localhost.example", INSECURE},
		{false, "notlocalhost", INSECURE},
	}

	for c in cases {
		url := Url {
			https = c.https,
			host  = c.host,
		}
		got := accept_encoding(url)
		testing.expectf(t, got == c.want, "https=%v %s: want %q, got %q", c.https, c.host, c.want, got)
	}
}

// The request carries the scheme's Accept-Encoding unless the caller set one.
@(test)
request_offers_what_it_decodes :: proc(t: ^testing.T) {
	out := make([dynamic]byte, context.temp_allocator)
	build_request(&out, "GET", INSECURE_URL, nil, nil)
	testing.expectf(t, strings.contains(string(out[:]), "\r\nAccept-Encoding: gzip, deflate\r\n"), "%s", out[:])

	build_request(&out, "GET", SECURE_URL, nil, nil)
	testing.expectf(t, strings.contains(string(out[:]), "\r\nAccept-Encoding: gzip, deflate, br, zstd\r\n"), "%s", out[:])

	mine := [?]Header{{"accept-encoding", "identity"}}
	build_request(&out, "GET", SECURE_URL, mine[:], nil)
	testing.expectf(t, strings.count(string(out[:]), "ccept-Encoding:") == 0, "%s", out[:])
	testing.expectf(t, strings.contains(string(out[:]), "\r\naccept-encoding: identity\r\n"), "%s", out[:])
}

// max_body bounds the decoded size: exactly max_body decodes, one byte more does not,
// and the largest int a caller may pass does not wrap the bound negative.
@(test)
decoded_size_is_capped :: proc(t: ^testing.T) {
	for name in ([]string{"gzip", "deflate-zlib", "br", "zstd"}) {
		encoding := "deflate" if name == "deflate-zlib" else name
		headers := [?]Header{{"Content-Encoding", encoding}}
		decoded := len("<p>hello decoded</p>")

		for max_body in ([]int{decoded, decoded - 1, max(int)}) {
			body := make([dynamic]byte, context.temp_allocator)
			append(&body, ..fixture(t, strings.concatenate({name, ".in"}, context.temp_allocator)))
			got := decode_content(&body, headers[:], SECURE_URL, max_body)
			want := Error.Body_Too_Large if max_body == decoded - 1 else Error.None
			testing.expectf(t, got == want, "%s, max %d: want %v, got %v", name, max_body, want, got)
		}
	}
}

// A frame that ends exactly as it fills the output buffer is complete: ZSTD_decompressStream
// says so by returning 0. Treating the full buffer as "maybe more" doubles it, copying
// the whole body, to learn there is nothing left.
@(test)
zstd_that_fills_the_buffer_does_not_grow_it :: proc(t: ^testing.T) {
	headers := [?]Header{{"Content-Encoding", "zstd"}}
	body := make([dynamic]byte)
	defer delete(body)
	append(&body, ..fixture(t, "zstd-fills-first-buffer.in"))
	got := decode_content(&body, headers[:], SECURE_URL, DEFAULT_MAX_BODY_BYTES)
	testing.expectf(t, got == .None && len(body) == 16 * 1024, "decode: %v, %d bytes", got, len(body))
	testing.expectf(t, cap(body) == 16 * 1024, "output grew to %d bytes for a 16384-byte body", cap(body))
}

// Deviates from Chrome, which sets no limit: see decode_content.
@(test)
chain_longer_than_the_cap_is_refused :: proc(t: ^testing.T) {
	for n in ([]int{MAX_CONTENT_CODINGS, MAX_CONTENT_CODINGS + 1}) {
		body := make([dynamic]byte, context.temp_allocator)
		append(&body, "<p>deep</p>")
		for _ in 0 ..< n {
			body = zlib_wrap(t, body[:])
		}

		headers := make([]Header, n, context.temp_allocator)
		for &h in headers {
			h = {"Content-Encoding", "deflate"}
		}

		got := decode_content(&body, headers, SECURE_URL, DEFAULT_MAX_BODY_BYTES)

		if n == MAX_CONTENT_CODINGS {
			testing.expectf(t, got == .None && string(body[:]) == "<p>deep</p>", "%d codings: %v %q", n, got, body[:])
		} else {
			testing.expectf(t, got == .Decoding, "%d codings: want Decoding, got %v", n, got)
		}
	}
}

@(private = "file")
zlib_wrap :: proc(t: ^testing.T, data: []byte) -> [dynamic]byte {
	size := zlib.uLongf(zlib.compressBound(zlib.uLong(len(data))))
	out := make([dynamic]byte, int(size), context.temp_allocator)
	rc := zlib.compress(raw_data(out), &size, raw_data(data), zlib.uLong(len(data)))
	testing.expectf(t, rc == zlib.OK, "compress: %d", rc)
	resize(&out, int(size))
	return out
}

@(private = "file")
find_fixture :: proc(name: string) -> ([]byte, bool) {
	for f in fixtures {
		if f.name == name {
			return f.data, true
		}
	}

	return nil, false
}

@(private = "file")
fixture :: proc(t: ^testing.T, name: string) -> []byte {
	data, ok := find_fixture(name)
	testing.expectf(t, ok, "missing fixture %s", name)
	return data
}

@(private = "file")
clip :: proc(b: []byte) -> string {
	return string(b[:min(len(b), 40)])
}
