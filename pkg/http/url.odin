package larva_http

import "core:strconv"
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
TARGET_ENCODE :: " \"<>`"
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

	if i := strings.index_byte(rest, '#'); i >= 0 {
		rest = rest[:i]
	}

	end := strings.index_any(rest, "/?")
	authority := rest if end < 0 else rest[:end]
	host, port, ok := split_authority(authority)

	if !ok {
		return {}, .Invalid_URL
	}

	if port != 0 {
		u.port = port
	}

	target := "/" if end < 0 else rest[end:]

	if strings.has_prefix(target, "?") {
		target = strings.concatenate({"/", target}, context.temp_allocator)
	}

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
// (RFC 3986 §5.2), dot segments included.
@(private)
resolve_url :: proc(base: string, ref: string, allocator := context.allocator) -> string {
	ref := strings.trim(ref, OWS)

	if has_scheme(ref) {
		return strings.clone(ref, allocator)
	}

	authority_start := strings.index(base, SCHEME_SEP) + len(SCHEME_SEP)

	if strings.has_prefix(ref, "//") {
		return strings.concatenate({base[:authority_start - len("//")], ref}, allocator)
	}

	path_start := strings.index_any(base[authority_start:], "/?#")
	origin := base if path_start < 0 else base[:authority_start + path_start]
	base_path := "/" if path_start < 0 else base[authority_start + path_start:]

	if i := strings.index_any(base_path, "?#"); i >= 0 {
		base_path = base_path[:i]
	}

	if base_path == "" {
		base_path = "/"
	}

	ref_path, suffix := ref, ""

	if i := strings.index_any(ref, "?#"); i >= 0 {
		ref_path, suffix = ref[:i], ref[i:]
	}

	path: string
	switch {
	case ref_path == "":
		path = base_path
	case strings.has_prefix(ref_path, "/"):
		path = ref_path
	case:
		dir := base_path[:strings.last_index_byte(base_path, '/') + 1]
		path = strings.concatenate({dir, ref_path}, context.temp_allocator)
	}

	return strings.concatenate({origin, remove_dot_segments(path), suffix}, allocator)
}

// host_header is the Host value: the port only when it is not the scheme's default.
// Not net.join_port: it runs split_port on the host first, which misreads a bare
// IPv6 literal such as `::1`.
@(private)
host_header :: proc(u: Url, allocator := context.allocator) -> string {
	host := u.host

	if strings.contains_rune(host, ':') {
		host = strings.concatenate({"[", host, "]"}, context.temp_allocator)
	}

	if u.port == (HTTPS_PORT if u.https else HTTP_PORT) {
		return strings.clone(host, allocator)
	}

	port_buf: [len("65535")]byte
	return strings.concatenate({host, ":", strconv.write_int(port_buf[:], i64(u.port), 10)}, allocator)
}

// same_origin decides whether credentials survive a redirect.
@(private)
same_origin :: proc(a, b: Url) -> bool {
	return a.https == b.https && a.port == b.port && ascii_equal_fold(a.host, b.host)
}

// split_authority splits `host[:port]` or `[v6]:port`. port 0 means none was given.
@(private = "file")
split_authority :: proc(authority: string) -> (host: string, port: int, ok: bool) {
	if authority == "" || strings.contains_rune(authority, '@') {
		return "", 0, false
	}

	for b in transmute([]byte)authority {
		if b <= ' ' || b >= 0x7F {
			return "", 0, false
		}
	}

	port_text := ""

	if strings.has_prefix(authority, "[") {
		close := strings.index_byte(authority, ']')

		if close < 0 {
			return "", 0, false
		}

		host = authority[1:close]
		after := authority[close + 1:]
		switch {
		case after == "":
		case strings.has_prefix(after, ":"):
			port_text = after[1:]
		case:
			return "", 0, false
		}
	} else {
		host = authority

		if i := strings.last_index_byte(authority, ':'); i >= 0 {
			host, port_text = authority[:i], authority[i + 1:]
		}

		if strings.contains_any(host, "[]:") {
			return "", 0, false
		}
	}

	if host == "" {
		return "", 0, false
	}

	if port_text == "" {
		return host, 0, true
	}

	// Digits only: strconv also takes `+`, `_` and a base prefix.
	for b in transmute([]byte)port_text {
		if b < '0' || b > '9' {
			return "", 0, false
		}
	}

	n, num_ok := strconv.parse_int(port_text, 10)

	if !num_ok || n < 1 || n > int(max(u16)) {
		return "", 0, false
	}

	return host, n, true
}

// encode_target percent-encodes what may not appear raw on the request line and refuses
// control characters, which no URL serializer emits.
@(private = "file")
encode_target :: proc(target: string, allocator := context.allocator) -> (out: string, ok: bool) {
	hex := HEX_DIGITS
	sb := strings.builder_make(allocator)
	for b in transmute([]byte)target {
		switch {
		case b < ' ' || b == 0x7F:
			strings.builder_destroy(&sb)
			return "", false
		case b >= 0x80 || strings.index_byte(TARGET_ENCODE, b) >= 0:
			strings.write_byte(&sb, '%')
			strings.write_byte(&sb, hex[b >> 4])
			strings.write_byte(&sb, hex[b & 0xF])
		case:
			strings.write_byte(&sb, b)
		}
	}

	return strings.to_string(sb), true
}

// remove_dot_segments is RFC 3986 §5.2.4 for a path that starts with `/`.
@(private = "file")
remove_dot_segments :: proc(path: string) -> string {
	segments := strings.split(path, "/", context.temp_allocator)
	out := make([dynamic]string, 0, len(segments), context.temp_allocator)
	trailing := false
	for seg, i in segments[1:] {
		last := i == len(segments) - 2
		switch seg {
		case ".":
			trailing = last
		case "..":
			if len(out) > 0 {
				pop(&out)
			}

			trailing = last
		case:
			append(&out, seg)
			trailing = false
		}
	}

	joined := strings.concatenate({"/", strings.join(out[:], "/", context.temp_allocator)}, context.temp_allocator)

	if trailing && len(out) > 0 {
		return strings.concatenate({joined, "/"}, context.temp_allocator)
	}

	return joined
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
