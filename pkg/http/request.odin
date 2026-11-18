package larva_http

import "core:strconv"
import "core:strings"

// RFC 9110 `tchar`: what a method token may contain.
@(private = "file")
TOKEN_PUNCTUATION :: "!#$%&'*+-.^_`|~"
// A header name may not hold these; a header value may not hold CR or LF.
@(private = "file")
NAME_FORBIDDEN :: ":\r\n \t"
@(private = "file")
VALUE_FORBIDDEN :: "\r\n"

// Dropped when a redirect leaves the origin, as Fetch and Node's undici do: they would
// hand the next host credentials meant for this one.
@(private = "file")
CREDENTIAL_HEADERS :: [?]string{"Authorization", "Cookie", "Proxy-Authorization", "Host"}
// The Fetch standard's "request-body-header names": dropped when a redirect turns the
// request into a GET without a body, or the request would promise a body it never sends.
@(private = "file")
BODY_HEADERS :: [?]string{"Content-Length", "Content-Type", "Content-Encoding", "Content-Language", "Content-Location"}

@(private)
request_is_valid :: proc(req: Request) -> bool {
	for b in transmute([]byte)req.method {
		if !is_token_char(b) {
			return false
		}
	}

	for h in req.headers {
		if h.name == "" ||
		   strings.index_any(h.name, NAME_FORBIDDEN) >= 0 ||
		   strings.index_any(h.value, VALUE_FORBIDDEN) >= 0 {
			return false
		}
	}

	return true
}

// build_request writes the request head and body into `out`. A caller's header replaces
// the default of the same name.
@(private)
build_request :: proc(out: ^[dynamic]byte, method: string, url: Url, headers: []Header, body: []byte) {
	clear(out)
	sb := strings.Builder {
		buf = out^,
	}
	strings.write_string(&sb, method)
	strings.write_byte(&sb, ' ')
	strings.write_string(&sb, url.target)
	strings.write_string(&sb, " HTTP/1.1\r\n")

	length_buf: [len("18446744073709551615")]byte
	defaults := [?]Header {
		{"Host", host_header(url, context.temp_allocator)},
		{"User-Agent", DEFAULT_USER_AGENT},
		{"Accept", "*/*"},
		// Decoding gzip/br/zstd comes with the stage-2 network stack (#9).
		{"Accept-Encoding", "identity"},
		{"Connection", "close"},
	}
	for d in defaults {
		if !has_header(headers, d.name) {
			write_header(&sb, d)
		}
	}

	if (len(body) > 0 || method_has_body(method)) && !has_header(headers, "Content-Length") {
		write_header(&sb, {"Content-Length", strconv.write_int(length_buf[:], i64(len(body)), 10)})
	}

	for h in headers {
		write_header(&sb, h)
	}

	strings.write_string(&sb, "\r\n")
	strings.write_bytes(&sb, body)
	out^ = sb.buf
}

// drop_headers removes every header named in `names`, freeing its strings.
@(private)
drop_headers :: proc(headers: []Header, names: []string, allocator := context.allocator) -> []Header {
	n := 0
	for h in headers {
		drop := false
		for name in names {
			if ascii_equal_fold(h.name, name) {
				drop = true
				break
			}
		}

		if drop {
			delete(h.name, allocator)
			delete(h.value, allocator)
			continue
		}

		headers[n] = h
		n += 1
	}

	return headers[:n]
}

@(private)
credential_headers :: proc() -> []string {
	@(static) names := CREDENTIAL_HEADERS
	return names[:]
}

@(private)
body_headers :: proc() -> []string {
	@(static) names := BODY_HEADERS
	return names[:]
}

@(private = "file")
write_header :: proc(sb: ^strings.Builder, h: Header) {
	strings.write_string(sb, h.name)
	strings.write_string(sb, ": ")
	strings.write_string(sb, h.value)
	strings.write_string(sb, "\r\n")
}

@(private = "file")
has_header :: proc(headers: []Header, name: string) -> bool {
	for h in headers {
		if ascii_equal_fold(h.name, name) {
			return true
		}
	}

	return false
}

@(private = "file")
method_has_body :: proc(method: string) -> bool {
	return method == "POST" || method == "PUT" || method == "PATCH"
}

@(private = "file")
is_token_char :: proc(b: byte) -> bool {
	return(
		('A' <= b && b <= 'Z') ||
		('a' <= b && b <= 'z') ||
		('0' <= b && b <= '9') ||
		strings.index_byte(TOKEN_PUNCTUATION, b) >= 0 \
	)
}
