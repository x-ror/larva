package larva_http

import "core:net"
import "core:strconv"
import "core:strings"

// Url is an absolute http(s) URL split for the transport. host and target are owned
// (url_destroy): the transport reads them on later loop turns.
@(private)
Url :: struct {
	https:  bool,
	host:   string, // without brackets for an IPv6 literal
	port:   int,
	target: string, // path and query, never empty; the fragment is dropped
}

// parse_url accepts `http://` and `https://` URLs with a host and an optional port.
// Userinfo is refused: a crawler has no use for it and it is how URL-confusion attacks
// start.
@(private)
parse_url :: proc(s: string, allocator := context.allocator) -> (u: Url, err: Error) {
	rest: string
	switch {
	case has_prefix_fold(s, "https://"):
		u.https, u.port, rest = true, 443, s[len("https://"):]
	case has_prefix_fold(s, "http://"):
		u.port, rest = 80, s[len("http://"):]
	case strings.contains(s, "://"):
		return {}, .Unsupported_Scheme
	case:
		return {}, .Invalid_URL
	}

	if i := strings.index_byte(rest, '#'); i >= 0 {
		rest = rest[:i]
	}

	end := strings.index_any(rest, "/?")
	authority := rest if end < 0 else rest[:end]

	if authority == "" || strings.contains_rune(authority, '@') {
		return {}, .Invalid_URL
	}

	// split_port reports ok with port 0 when the authority has no port.
	host, port, split_ok := net.split_port(authority)

	if !split_ok || port < 0 || port > 65535 {
		return {}, .Invalid_URL
	}

	if port != 0 {
		u.port = port
	}

	host = strings.trim_prefix(strings.trim_suffix(host, "]"), "[")

	if host == "" {
		return {}, .Invalid_URL
	}

	target := "/"

	if end >= 0 {
		target = rest[end:] if rest[end] == '/' else strings.concatenate({"/", rest[end:]}, context.temp_allocator)
	}

	u.host = strings.clone(host, allocator)
	u.target = strings.clone(target, allocator)
	return u, .None
}

@(private)
url_destroy :: proc(u: ^Url, allocator := context.allocator) {
	delete(u.host, allocator)
	delete(u.target, allocator)
	u^ = {}
}

// resolve_url resolves a Location header against the URL that answered with it.
// Absolute and scheme-relative references are taken as given; a path is resolved
// against the base's directory, without dot-segment removal (servers send `..` in a
// Location rarely enough not to matter yet).
@(private)
resolve_url :: proc(base: string, ref: string, allocator := context.allocator) -> string {
	ref := strings.trim_space(ref)
	switch {
	case strings.contains(ref, "://"):
		return strings.clone(ref, allocator)
	case strings.has_prefix(ref, "//"):
		scheme := base[:strings.index(base, "://") + 1]
		return strings.concatenate({scheme, ref}, allocator)
	}

	authority_start := strings.index(base, "://") + 3
	path_start := strings.index_any(base[authority_start:], "/?#")
	origin := base if path_start < 0 else base[:authority_start + path_start]

	if strings.has_prefix(ref, "/") {
		return strings.concatenate({origin, ref}, allocator)
	}

	path := "/" if path_start < 0 else base[authority_start + path_start:]

	if i := strings.index_any(path, "?#"); i >= 0 {
		path = path[:i]
	}

	dir := path[:strings.last_index_byte(path, '/') + 1]

	if strings.has_prefix(ref, "?") {
		dir = path
	}

	return strings.concatenate({origin, dir, ref}, allocator)
}

// host_header is the Host value: the port only when it is not the scheme's default.
@(private)
host_header :: proc(u: Url, allocator := context.allocator) -> string {
	host := u.host

	if strings.contains_rune(host, ':') {
		host = strings.concatenate({"[", host, "]"}, context.temp_allocator)
	}

	if (u.https && u.port == 443) || (!u.https && u.port == 80) {
		return strings.clone(host, allocator)
	}

	buf: [8]byte
	return strings.concatenate({host, ":", strconv.write_int(buf[:], i64(u.port), 10)}, allocator)
}

@(private = "file")
has_prefix_fold :: proc(s, prefix: string) -> bool {
	return len(s) >= len(prefix) && ascii_equal_fold(s[:len(prefix)], prefix)
}
