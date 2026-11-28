// An HTTP proxy both stacks route through: pkg/http's transfers and the runtime's fetch()
// (pkg/runtime/fetch_transport.odin), so a `lava serve` request with a proxy sends its
// navigation and its page's own requests the same way (#9, #15). A package of its own,
// like pkg/http/cookie, so the runtime takes the type without linking pkg/http's codecs.
//
// An http:// target goes to the proxy in absolute-form (`GET http://host/path`, RFC 9112
// §3.2.2); an https:// target goes through a CONNECT tunnel (RFC 9110 §9.3.6), and TLS
// runs end to end inside it, so the proxy sees the host and port and nothing else.
// Either carries `Proxy-Authorization: Basic …` when the proxy URL has credentials.
// Failing to reach the proxy, a CONNECT answered with anything but 2xx, and a 407 to an
// absolute-form request are the proxy's failure, which each stack reports as such
// (pkg/http Error.Proxy), so a caller can tell a bad proxy from a bad site.
package larva_proxy

import "core:encoding/base64"
import "core:net"
import "core:strconv"
import "core:strings"

DEFAULT_PORT :: 80

// Proxy is a parsed proxy URL. Every string is owned (destroy). The zero value is "no
// proxy".
Proxy :: struct {
	// Without brackets for an IPv6 literal; "" for no proxy.
	host:          string,
	port:          int,
	// The Proxy-Authorization value (`Basic <base64(user:pass)>`), "" for none.
	authorization: string,
}

// parse parses `http://[user[:password]@]host[:port][/]`: an http proxy (TLS to the proxy
// itself is not supported), port 80 when absent as for any http URL, the user and
// password percent-decoded before they are encoded for Basic.
//
// Returns:
//   ok false for anything else, with nothing allocated.
parse :: proc(s: string, allocator := context.allocator) -> (p: Proxy, ok: bool) {
	if len(s) < len("http://") || !strings.equal_fold(s[:len("http://")], "http://") {
		return {}, false
	}

	rest := strings.trim_suffix(s[len("http://"):], "/")

	if strings.index_any(rest, "/?#") >= 0 {
		return {}, false
	}

	userinfo := ""

	if at := strings.last_index_byte(rest, '@'); at >= 0 {
		userinfo, rest = rest[:at], rest[at + 1:]
	}

	host, port, authority_ok := split_authority(rest)

	if !authority_ok {
		return {}, false
	}

	auth := ""

	if userinfo != "" {
		decoded, decoded_ok := net.percent_decode(userinfo, context.temp_allocator)

		if !decoded_ok {
			return {}, false
		}

		encoded, enc_err := base64.encode(transmute([]byte)decoded, allocator = context.temp_allocator)

		if enc_err != nil {
			return {}, false
		}

		auth = strings.concatenate({"Basic ", encoded}, allocator)
	}

	return {host = strings.clone(host, allocator), port = port, authorization = auth}, true
}

destroy :: proc(p: ^Proxy, allocator := context.allocator) {
	delete(p.host, allocator)
	delete(p.authorization, allocator)
	p^ = {}
}

clone :: proc(p: Proxy, allocator := context.allocator) -> Proxy {
	if p.host == "" {
		return {}
	}

	return {
		host = strings.clone(p.host, allocator),
		port = p.port,
		authorization = strings.clone(p.authorization, allocator) if p.authorization != "" else "",
	}
}

// write_connect writes the CONNECT request that opens a tunnel to host:port.
write_connect :: proc(sb: ^strings.Builder, host: string, port: int, authorization: string) {
	strings.write_string(sb, "CONNECT ")
	write_authority(sb, host, port)
	strings.write_string(sb, " HTTP/1.1\r\nHost: ")
	write_authority(sb, host, port)
	strings.write_string(sb, "\r\n")
	write_authorization(sb, authorization)
	strings.write_string(sb, "\r\n")
}

// write_authorization writes the Proxy-Authorization header line, nothing for "".
write_authorization :: proc(sb: ^strings.Builder, authorization: string) {
	if authorization != "" {
		strings.write_string(sb, "Proxy-Authorization: ")
		strings.write_string(sb, authorization)
		strings.write_string(sb, "\r\n")
	}
}

// write_authority writes host:port, an IPv6 literal in brackets and the port always
// there (a CONNECT target has no default).
@(private = "file")
write_authority :: proc(sb: ^strings.Builder, host: string, port: int) {
	if strings.index_byte(host, ':') >= 0 {
		strings.write_byte(sb, '[')
		strings.write_string(sb, host)
		strings.write_byte(sb, ']')
	} else {
		strings.write_string(sb, host)
	}

	strings.write_byte(sb, ':')
	strings.write_int(sb, port)
}

// split_authority splits `host[:port]` or `[ipv6][:port]`; the host must be non-empty
// and free of whitespace, the port 1-65535.
@(private = "file")
split_authority :: proc(authority: string) -> (host: string, port: int, ok: bool) {
	port_text := ""

	if strings.has_prefix(authority, "[") {
		close := strings.index_byte(authority, ']')

		if close < 0 {
			return
		}

		host = authority[1:close]

		if _, is_v6 := net.parse_ip6_address(host); !is_v6 {
			return
		}

		after := authority[close + 1:]

		if after != "" {
			if after[0] != ':' {
				return
			}

			port_text = after[1:]
		}
	} else {
		colon := strings.last_index_byte(authority, ':')
		host = authority if colon < 0 else authority[:colon]
		port_text = "" if colon < 0 else authority[colon + 1:]

		if host == "" || strings.index_any(host, " \t\r\n:[]@") >= 0 {
			return
		}
	}

	port = DEFAULT_PORT

	if port_text != "" {
		n, parsed := strconv.parse_int(port_text, 10)

		if !parsed || n < 1 || n > 65535 || port_text[0] == '+' || port_text[0] == '-' {
			return
		}

		port = n
	}

	return host, port, true
}
