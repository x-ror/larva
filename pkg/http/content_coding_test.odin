#+build linux
package larva_http

import "core:bytes"
import "core:encoding/json"
import "core:mem"
import "core:strings"
import "core:testing"

// The Content-Encoding fixtures and what Chrome decoded from each: gen.mjs writes
// <name>.in, record-chrome.py records <name>.out (the bytes fetch() returned) or
// <name>.err (a network error).
@(private)
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

// Every URL in testdata/accept-encoding/recorded.json is offered what Chrome offered it
// (record-chrome.py there, a navigation to a local server echoing the header back).
@(test)
accept_encoding_follows_the_secure_context :: proc(t: ^testing.T) {
	Recording :: struct {
		chrome: string,
		cases:  []struct {
			url:             string,
			accept_encoding: string,
		},
	}

	recording: Recording
	err := json.unmarshal(#load("testdata/accept-encoding/recorded.json"), &recording, allocator = context.temp_allocator)
	testing.expectf(t, err == nil, "recorded.json: %v", err)
	testing.expect(t, len(recording.cases) >= 14, "recorded.json lists too few URLs")

	for c in recording.cases {
		url, url_err := parse_url(c.url, context.temp_allocator)
		testing.expectf(t, url_err == .None, "%s: %v", c.url, url_err)
		got := accept_encoding(url)
		testing.expectf(t, got == c.accept_encoding, "%s: want %q, got %q", c.url, c.accept_encoding, got)
	}

	// Lava-only: addresses no local Chrome can be pointed at, pinning that the loopback
	// rules stop at 127.0.0.0/8 and ::1.
	for host in ([]string{"128.0.0.1", "::2"}) {
		got := accept_encoding(Url{host = host})
		testing.expectf(t, got == "gzip, deflate", "http://%s: want %q, got %q", host, "gzip, deflate", got)
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
// the whole body, to learn there is nothing left. The final body's capacity cannot show
// that, as decode_content trims spare capacity before returning; the bytes ever
// allocated can: the input, and one 16 KiB output buffer.
@(test)
zstd_that_fills_the_buffer_does_not_grow_it :: proc(t: ^testing.T) {
	track: mem.Tracking_Allocator
	mem.tracking_allocator_init(&track, context.allocator)
	defer mem.tracking_allocator_destroy(&track)
	allocator := mem.tracking_allocator(&track)

	headers := [?]Header{{"Content-Encoding", "zstd"}}
	input := fixture(t, "zstd-fills-first-buffer.in")
	body := make([dynamic]byte, allocator)
	defer delete(body)
	append(&body, ..input)
	got := decode_content(&body, headers[:], SECURE_URL, DEFAULT_MAX_BODY_BYTES)
	testing.expectf(t, got == .None && len(body) == 16 * 1024, "decode: %v, %d bytes", got, len(body))
	testing.expectf(
		t,
		track.total_memory_allocated <= i64(len(input) + 16 * 1024 + 64),
		"output grew: %d bytes allocated for a 16384-byte body",
		track.total_memory_allocated,
	)
}

// A body that decodes to more than max_body fails as too large, whether the first output
// buffer already overruns it or the decode takes several growths to get there. Without
// the bound a codec handed a full buffer makes no progress and never returns. Larva's
// own limit: Chrome has none, so there is no recording.
@(test)
decoded_output_past_max_body_is_refused :: proc(t: ^testing.T) {
	BIG :: 64 * 1024
	cases := [?]struct {
		name:     string,
		encoding: string,
		max_body: int,
		want:     Error,
		want_len: int,
	} {
		{"gzip", "gzip", 5, .Body_Too_Large, 0},
		{"deflate-zlib", "deflate", 5, .Body_Too_Large, 0},
		{"br", "br", 5, .Body_Too_Large, 0},
		{"zstd", "zstd", 5, .Body_Too_Large, 0},
		// The first buffer is 16 KiB: 40000 is reached only after it has grown twice.
		{"limit-gzip", "gzip", 40_000, .Body_Too_Large, 0},
		{"limit-deflate", "deflate", 40_000, .Body_Too_Large, 0},
		{"limit-br", "br", 40_000, .Body_Too_Large, 0},
		{"limit-zstd", "zstd", 40_000, .Body_Too_Large, 0},
		// The same bodies decode whole under the default bound, so the refusals above
		// are the bound's and not a broken fixture's.
		{"limit-gzip", "gzip", DEFAULT_MAX_BODY_BYTES, .None, BIG},
		{"limit-deflate", "deflate", DEFAULT_MAX_BODY_BYTES, .None, BIG},
		{"limit-br", "br", DEFAULT_MAX_BODY_BYTES, .None, BIG},
		{"limit-zstd", "zstd", DEFAULT_MAX_BODY_BYTES, .None, BIG},
	}

	for c in cases {
		headers := [?]Header{{"Content-Encoding", c.encoding}}
		body := make([dynamic]byte)
		defer delete(body)
		append(&body, ..fixture(t, strings.concatenate({c.name, ".in"}, context.temp_allocator)))
		got := decode_content(&body, headers[:], SECURE_URL, c.max_body)
		testing.expectf(t, got == c.want, "%s, max %d: want %v, got %v", c.name, c.max_body, c.want, got)

		if c.want == .None {
			testing.expectf(t, len(body) == c.want_len, "%s: want %d bytes, got %d", c.name, c.want_len, len(body))
		}
	}
}

// The decoded body is handed over without most of the decoder's slack: content that does
// not compress decodes to about its input's size, a quarter of the first buffer the
// decoder guessed for it, and the caller's allocator would otherwise carry the other
// three quarters for as long as it keeps the body.
@(test)
decoded_body_keeps_little_spare_capacity :: proc(t: ^testing.T) {
	headers := [?]Header{{"Content-Encoding", "gzip"}}
	body := make([dynamic]byte)
	defer delete(body)
	append(&body, ..fixture(t, "gzip-incompressible.in"))
	got := decode_content(&body, headers[:], SECURE_URL, DEFAULT_MAX_BODY_BYTES)
	testing.expectf(t, got == .None && len(body) == 64 * 1024, "decode: %v, %d bytes", got, len(body))
	testing.expectf(t, cap(body) <= len(body) + len(body) / 4, "%d bytes kept for a %d-byte body", cap(body), len(body))
}

@(private)
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

@(private)
clip :: proc(b: []byte) -> string {
	return string(b[:min(len(b), 40)])
}
