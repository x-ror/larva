package larva_http

import "core:strings"

// core:net.split_url is not used: it parses the query into a map, which loses order and
// repeated keys, and the transport must send the target exactly as given.

HTTP_PORT :: 80
HTTPS_PORT :: 443

@(private = "file")
SCHEME_SEP :: "://"
// Bytes a request target may not carry as they are: they would end the request line or
// split a header. CTLs are refused; these are percent-encoded, as a browser does.
@(private = "file")
TARGET_ENCODE :: Ascii_Set{' ', '"', '<', '>', '`'}
@(private = "file")
AUTHORITY_END :: Ascii_Set{'/', '?'}
@(private = "file")
PATH_END :: Ascii_Set{'/', '?', '#'}
@(private = "file")
QUERY_OR_FRAGMENT :: Ascii_Set{'?', '#'}
@(private = "file")
HEX_DIGITS :: "0123456789ABCDEF"

// Url is an absolute http(s) URL split for the transport. host and target are owned
// (url_destroy): the transport reads them on later loop turns.
@(private)
Url :: struct {
	https:  bool,
	host:   string, // without brackets for an IPv6 literal
	port:   int,
	target: string, // path and query, never empty, percent-encoded; no fragment
}

// parse_url accepts `http://` and `https://` URLs with a host and an optional port.
//
// Deviates: userinfo (`user:pass@`) is refused rather than turned into an Authorization
// header, and so is a non-ASCII host (IDNA comes with the URL work of stage 2). Both are
// how URL-confusion attacks start; a crawler has no need for either.
@(private)
parse_url :: proc(s: string, allocator := context.allocator) -> (u: Url, err: Error) {
	rest: string
	switch {
	case has_prefix_fold(s, "https" + SCHEME_SEP):
		u.https, u.port, rest = true, HTTPS_PORT, s[len("https" + SCHEME_SEP):]
	case has_prefix_fold(s, "http" + SCHEME_SEP):
		u.port, rest = HTTP_PORT, s[len("http" + SCHEME_SEP):]
	case has_scheme(s):
		return {}, .Unsupported_Scheme
	case:
		return {}, .Invalid_URL
	}

	rest = strings.truncate_to_byte(rest, '#')
	end := index_byte_set(rest, AUTHORITY_END)
	authority := rest if end < 0 else rest[:end]
	host, port, ok := split_authority(authority)

	if !ok {
		return {}, .Invalid_URL
	}

	if port != 0 {
		u.port = port
	}

	target := "/" if end < 0 else rest[end:]
	encoded, target_ok := encode_target(target, allocator)

	if !target_ok {
		return {}, .Invalid_URL
	}

	u.host = strings.clone(host, allocator)
	u.target = encoded
	return u, .None
}

@(private)
url_destroy :: proc(u: ^Url, allocator := context.allocator) {
	delete(u.host, allocator)
	delete(u.target, allocator)
	u^ = {}
}

// resolve_url resolves a Location header against the URL that answered with it
// (RFC 3986 §5.2), dot segments included, into one buffer sized up front.
@(private)
resolve_url :: proc(base: string, ref: string, allocator := context.allocator) -> string {
	ref := trim_ows(ref)

	if has_scheme(ref) {
		return strings.clone(ref, allocator)
	}

	// base is a validated http(s) URL, so its first ':' starts "://".
	authority_start := strings.index_byte(base, ':') + len(SCHEME_SEP)

	if strings.has_prefix(ref, "//") {
		return strings.concatenate({base[:authority_start - len("//")], ref}, allocator)
	}

	path_start := index_byte_set(base[authority_start:], PATH_END)
	origin := base if path_start < 0 else base[:authority_start + path_start]
	base_path := "/" if path_start < 0 else base[authority_start + path_start:]

	if i := index_byte_set(base_path, QUERY_OR_FRAGMENT); i >= 0 {
		base_path = base_path[:i]
	}

	if base_path == "" {
		base_path = "/"
	}

	ref_path, suffix := ref, ""

	if i := index_byte_set(ref, QUERY_OR_FRAGMENT); i >= 0 {
		ref_path, suffix = ref[:i], ref[i:]
	}

	dir := ""
	size := len(origin) + len(suffix)
	switch {
	case ref_path == "":
		size += len(base_path)
	case ref_path[0] == '/':
		size += len(ref_path)
	case:
		dir = base_path[:strings.last_index_byte(base_path, '/') + 1]
		size += len(dir) + len(ref_path)
	}

	sb := strings.builder_make(0, size, allocator)
	strings.write_string(&sb, origin)
	switch {
	case ref_path == "":
		write_normalized_path(&sb, base_path)
	case ref_path[0] == '/':
		write_normalized_path(&sb, ref_path)
	case ref_path[0] == '.' || strings.contains(dir, "/.") || strings.contains(ref_path, "/."):
		write_normalized_path(&sb, strings.concatenate({dir, ref_path}, context.temp_allocator))
	case:
		strings.write_string(&sb, dir)
		strings.write_string(&sb, ref_path)
	}

	strings.write_string(&sb, suffix)
	return strings.to_string(sb)
}

// write_host_header writes the Host value: an IPv6 literal in brackets, the port only
// when it is not the scheme's default.
@(private)
write_host_header :: proc(sb: ^strings.Builder, u: Url) {
	if strings.index_byte(u.host, ':') >= 0 {
		strings.write_byte(sb, '[')
		strings.write_string(sb, u.host)
		strings.write_byte(sb, ']')
	} else {
		strings.write_string(sb, u.host)
	}

	if u.port != (HTTPS_PORT if u.https else HTTP_PORT) {
		strings.write_byte(sb, ':')
		strings.write_int(sb, u.port)
	}
}

// same_origin decides whether credentials survive a redirect.
@(private)
same_origin :: proc(a, b: Url) -> bool {
	return a.https == b.https && a.port == b.port && ascii_equal_fold(a.host, b.host)
}

// split_authority splits `host[:port]` or `[v6]:port` in one pass over the bytes and one
// over the port. port 0 means none was given; a port is digits only, 1 to 65535.
@(private = "file")
split_authority :: proc(authority: string) -> (host: string, port: int, ok: bool) {
	if authority == "" {
		return "", 0, false
	}

	port_text := ""

	if authority[0] == '[' {
		close := -1
		for b, i in transmute([]byte)authority {
			if b <= ' ' || b >= 0x7F || b == '@' {
				return "", 0, false
			}

			if b == ']' && close < 0 {
				close = i
			}
		}

		if close < 0 {
			return "", 0, false
		}

		host = authority[1:close]
		after := authority[close + 1:]
		switch {
		case after == "":
		case after[0] == ':':
			port_text = after[1:]
		case:
			return "", 0, false
		}
	} else {
		colon := -1
		for b, i in transmute([]byte)authority {
			if b <= ' ' || b >= 0x7F || b == '@' || b == '[' || b == ']' {
				return "", 0, false
			}

			if b == ':' {
				if colon >= 0 {
					return "", 0, false
				}

				colon = i
			}
		}

		host = authority if colon < 0 else authority[:colon]

		if colon >= 0 {
			port_text = authority[colon + 1:]
		}
	}

	if host == "" {
		return "", 0, false
	}

	if port_text == "" {
		return host, 0, true
	}

	n := 0
	for b in transmute([]byte)port_text {
		if b < '0' || b > '9' {
			return "", 0, false
		}

		n = n * 10 + int(b - '0')

		if n > int(max(u16)) {
			return "", 0, false
		}
	}

	if n < 1 {
		return "", 0, false
	}

	return host, n, true
}

// encode_target percent-encodes what may not appear raw on the request line, refuses
// control characters (no URL serializer emits them), and turns a bare `?query` into
// `/?query`. Runs that need no escaping are copied whole.
@(private = "file")
encode_target :: proc(target: string, allocator := context.allocator) -> (out: string, ok: bool) {
	prepend_slash := len(target) > 0 && target[0] == '?'
	sb := strings.builder_make(0, len(target) + int(prepend_slash), allocator)

	if prepend_slash {
		strings.write_byte(&sb, '/')
	}

	hex := HEX_DIGITS
	start := 0
	for b, i in transmute([]byte)target {
		switch {
		case b < ' ' || b == 0x7F:
			strings.builder_destroy(&sb)
			return "", false
		case b >= 0x80 || b in TARGET_ENCODE:
			strings.write_string(&sb, target[start:i])
			escaped := [3]byte{'%', hex[b >> 4], hex[b & 0xF]}
			strings.write_bytes(&sb, escaped[:])
			start = i + 1
		}
	}

	strings.write_string(&sb, target[start:])
	return strings.to_string(sb), true
}

// write_normalized_path writes `path`, which starts with `/`, with its dot segments
// removed (RFC 3986 §5.2.4). A path without "/." has none and is copied as it is.
@(private = "file")
write_normalized_path :: proc(sb: ^strings.Builder, path: string) {
	if !strings.contains(path, "/.") {
		strings.write_string(sb, path)
		return
	}

	segments := strings.split(path, "/", context.temp_allocator)
	out := segments[1:]
	n := 0
	trailing := false
	for seg, i in segments[1:] {
		last := i == len(segments) - 2
		switch seg {
		case ".":
			trailing = last
		case "..":
			if n > 0 {
				n -= 1
			}

			trailing = last
		case:
			out[n] = seg
			n += 1
			trailing = false
		}
	}

	if n == 0 {
		strings.write_byte(sb, '/')
		return
	}

	for seg in out[:n] {
		strings.write_byte(sb, '/')
		strings.write_string(sb, seg)
	}

	if trailing {
		strings.write_byte(sb, '/')
	}
}

// has_scheme tests for RFC 3986 `scheme ":"` at the start: ALPHA *( ALPHA / DIGIT /
// "+" / "-" / "." ) ":", before any `/`, `?` or `#`. `/login?next=https://x` has none.
@(private = "file")
has_scheme :: proc(s: string) -> bool {
	for i in 0 ..< len(s) {
		b := s[i]
		switch {
		case 'a' <= ascii_lower(b) && ascii_lower(b) <= 'z':
		case i > 0 && (('0' <= b && b <= '9') || b == '+' || b == '-' || b == '.'):
		case i > 0 && b == ':':
			return true
		case:
			return false
		}
	}

	return false
}

@(private = "file")
has_prefix_fold :: proc(s, prefix: string) -> bool {
	return len(s) >= len(prefix) && ascii_equal_fold(s[:len(prefix)], prefix)
}
