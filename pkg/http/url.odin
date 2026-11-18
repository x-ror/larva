package larva_http

import "core:net"
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
// RFC 3986 reg-name: unreserved, pct-encoded and sub-delims characters.
@(private = "file")
HOST_CHARS :: Ascii_Set {
	'a',
	'b',
	'c',
	'd',
	'e',
	'f',
	'g',
	'h',
	'i',
	'j',
	'k',
	'l',
	'm',
	'n',
	'o',
	'p',
	'q',
	'r',
	's',
	't',
	'u',
	'v',
	'w',
	'x',
	'y',
	'z',
	'A',
	'B',
	'C',
	'D',
	'E',
	'F',
	'G',
	'H',
	'I',
	'J',
	'K',
	'L',
	'M',
	'N',
	'O',
	'P',
	'Q',
	'R',
	'S',
	'T',
	'U',
	'V',
	'W',
	'X',
	'Y',
	'Z',
	'0',
	'1',
	'2',
	'3',
	'4',
	'5',
	'6',
	'7',
	'8',
	'9',
	'-',
	'.',
	'_',
	'~',
	'%',
	'!',
	'$',
	'&',
	'\'',
	'(',
	')',
	'*',
	'+',
	',',
	';',
	'=',
}
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
		// `http:host` or `https:/x` is a broken http URL, not another scheme.
		scheme := s[:strings.index_byte(s, ':')]
		is_http := ascii_equal_fold(scheme, "http") || ascii_equal_fold(scheme, "https")
		return {}, .Invalid_URL if is_http else .Unsupported_Scheme
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

// resolve_url resolves a Location header against the URL that answered with it (RFC 3986
// §5.2.2), dot segments removed in every case, into one buffer sized up front.
@(private)
resolve_url :: proc(base: string, ref: string, allocator := context.allocator) -> string {
	ref := trim_ows(ref)

	if has_scheme(ref) {
		return normalize_absolute(ref, allocator)
	}

	// base is a validated http(s) URL, so its first ':' starts "://".
	authority_start := strings.index_byte(base, ':') + len(SCHEME_SEP)

	if strings.has_prefix(ref, "//") {
		absolute := strings.concatenate({base[:authority_start - len("//")], ref}, context.temp_allocator)
		return normalize_absolute(absolute, allocator)
	}

	path_start := index_byte_set(base[authority_start:], PATH_END)
	origin := base if path_start < 0 else base[:authority_start + path_start]
	base_rest := "/" if path_start < 0 else base[authority_start + path_start:]
	base_path, base_query := base_rest, ""

	if i := index_byte_set(base_rest, QUERY_OR_FRAGMENT); i >= 0 {
		base_path = base_rest[:i]

		if base_rest[i] == '?' {
			base_query = strings.truncate_to_byte(base_rest[i:], '#')
		}
	}

	if base_path == "" {
		base_path = "/"
	}

	ref_path, suffix := ref, ""

	if i := index_byte_set(ref, QUERY_OR_FRAGMENT); i >= 0 {
		ref_path, suffix = ref[:i], ref[i:]
	}

	// An empty path without a query of its own keeps the base's query: `#top` against
	// `/s?q=1` is `/s?q=1#top`.
	if ref_path == "" && !strings.has_prefix(suffix, "?") {
		suffix = strings.concatenate({base_query, suffix}, context.temp_allocator)
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

// normalize_absolute copies an absolute URL with dot segments removed from its path. A
// URL that is not hierarchical (`mailto:x`) is copied as it is; parse_url rejects it.
@(private = "file")
normalize_absolute :: proc(url: string, allocator := context.allocator) -> string {
	sep := strings.index(url, SCHEME_SEP)

	if sep < 0 {
		return strings.clone(url, allocator)
	}

	authority_start := sep + len(SCHEME_SEP)
	path_start := index_byte_set(url[authority_start:], PATH_END)

	if path_start < 0 || url[authority_start + path_start] != '/' {
		return strings.clone(url, allocator)
	}

	path_start += authority_start
	path_end := len(url)

	if i := index_byte_set(url[path_start:], QUERY_OR_FRAGMENT); i >= 0 {
		path_end = path_start + i
	}

	sb := strings.builder_make(0, len(url), allocator)
	strings.write_string(&sb, url[:path_start])
	write_normalized_path(&sb, url[path_start:path_end])
	strings.write_string(&sb, url[path_end:])
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
// over the port. Inside brackets must be an IPv6 address; a name may hold only RFC 3986
// reg-name characters, so `evil.com\path` and the like, read differently by other URL
// parsers, are refused. port 0 means none was given; a port is digits only, 1 to 65535.
@(private = "file")
split_authority :: proc(authority: string) -> (host: string, port: int, ok: bool) {
	if authority == "" {
		return "", 0, false
	}

	port_text := ""

	if authority[0] == '[' {
		close := strings.index_byte(authority, ']')

		if close < 0 {
			return "", 0, false
		}

		host = authority[1:close]

		if strings.index_byte(host, '[') >= 0 {
			return "", 0, false
		}

		if _, is_v6 := net.parse_ip6_address(host); !is_v6 {
			return "", 0, false
		}

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
			if b == ':' {
				if colon >= 0 {
					return "", 0, false
				}

				colon = i
			} else if colon < 0 && !(b in HOST_CHARS) {
				return "", 0, false
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
