package larva_http

import "core:strings"

// RFC 9110 `tchar`: what a method token may contain.
@(private = "file")
TOKEN_PUNCTUATION :: Ascii_Set{'!', '#', '$', '%', '&', '\'', '*', '+', '-', '.', '^', '_', '`', '|', '~'}

// Dropped when a redirect leaves the origin, as Fetch and Node's undici do: they would
// hand the next host credentials meant for this one.
@(private = "file")
CREDENTIAL_HEADERS :: [?]string{"Authorization", "Cookie", "Proxy-Authorization", "Host"}
// The Fetch standard's "request-body-header names": dropped when a redirect turns the
// request into a GET without a body, or the request would promise a body it never sends.
@(private = "file")
BODY_HEADERS :: [?]string{"Content-Length", "Content-Type", "Content-Encoding", "Content-Language", "Content-Location"}

// Request line, Host and the defaults below, so build_request grows its buffer once.
@(private = "file")
DEFAULT_HEAD_BYTES :: 256

@(private = "file", rodata)
DEFAULT_HEADERS := [?]Header {
	{"User-Agent", DEFAULT_USER_AGENT},
	{"Accept", "*/*"},
	{"Accept-Encoding", ""}, // depends on the URL: accept_encoding
	{"Connection", "close"},
}

// request_is_valid accepts what HTTP/1.1 can carry as given: a method and header names
// made of token characters (RFC 9110 §5.1), header values without control characters
// other than tab (§5.5). Transfer-Encoding is refused: the body is always sent whole,
// with a Content-Length, and the two must not be sent together (RFC 9112 §6.1).
@(private)
request_is_valid :: proc(req: Request) -> bool {
	if req.method != "" && !is_token(req.method) {
		return false
	}

	for &h in req.headers {
		if !is_token(h.name) || ascii_equal_fold(h.name, "Transfer-Encoding") {
			return false
		}

		for b in transmute([]byte)h.value {
			if (b < ' ' && b != '\t') || b == 0x7F {
				return false
			}
		}
	}

	return true
}

// build_request writes the request head and body into `out`, grown once up front. A
// caller's header replaces the default of the same name.
@(private)
build_request :: proc(out: ^[dynamic]byte, method: string, url: Url, headers: []Header, body: []byte) {
	clear(out)
	sb := strings.Builder {
		buf = out^,
	}

	size := len(method) + len(url.target) + len(url.host) + len(body) + DEFAULT_HEAD_BYTES
	for &h in headers {
		size += len(h.name) + len(": \r\n") + len(h.value)
	}

	strings.builder_grow(&sb, size)
	strings.write_string(&sb, method)
	strings.write_byte(&sb, ' ')
	strings.write_string(&sb, url.target)
	strings.write_string(&sb, " HTTP/1.1\r\n")

	if !has_header(headers, "Host") {
		strings.write_string(&sb, "Host: ")
		write_host_header(&sb, url)
		strings.write_string(&sb, "\r\n")
	}

	for d in DEFAULT_HEADERS {
		if !has_header(headers, d.name) {
			value := accept_encoding(url) if d.name == "Accept-Encoding" else d.value
			write_header(&sb, {d.name, value})
		}
	}

	if (len(body) > 0 || method_has_body(method)) && !has_header(headers, "Content-Length") {
		strings.write_string(&sb, "Content-Length: ")
		strings.write_int(&sb, len(body))
		strings.write_string(&sb, "\r\n")
	}

	for &h in headers {
		write_header(&sb, h)
	}

	strings.write_string(&sb, "\r\n")
	strings.write_bytes(&sb, body)
	out^ = sb.buf
}

// drop_headers removes every header named in `names`, freeing its strings and keeping
// the list's allocation, so it is freed with the size it was made with.
@(private)
drop_headers :: proc(headers: ^[dynamic]Header, names: []string) {
	allocator := headers.allocator
	n := 0
	for &h in headers {
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

	resize(headers, n)
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
	for &h in headers {
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
	return ('A' <= b && b <= 'Z') || ('a' <= b && b <= 'z') || ('0' <= b && b <= '9') || b in TOKEN_PUNCTUATION
}

@(private = "file")
is_token :: proc(s: string) -> bool {
	if s == "" {
		return false
	}

	for b in transmute([]byte)s {
		if !is_token_char(b) {
			return false
		}
	}

	return true
}
