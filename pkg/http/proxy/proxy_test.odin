package larva_proxy

import "core:strings"
import "core:testing"

// What `lava serve`'s `proxy` parameter accepts, and the CONNECT request it turns into.
@(test)
parse_accepts_http_proxies_only :: proc(t: ^testing.T) {
	cases := [?]struct {
		url:           string,
		ok:            bool,
		host:          string,
		port:          int,
		authorization: string,
	} {
		{"http://127.0.0.1:3128", true, "127.0.0.1", 3128, ""},
		{"HTTP://proxy.example/", true, "proxy.example", 80, ""},
		{"http://u:p@[::1]:8080", true, "::1", 8080, "Basic dTpw"},
		{"http://us%40er:p%3Ass@h:1", true, "h", 1, "Basic dXNAZXI6cDpzcw=="},
		{"https://h:1", false, "", 0, ""},
		{"socks5://h:1", false, "", 0, ""},
		{"http://h:0", false, "", 0, ""},
		{"http://h:65536", false, "", 0, ""},
		{"http://h/path", false, "", 0, ""},
		{"http://:80", false, "", 0, ""},
		{"http://u:%zz@h", false, "", 0, ""},
	}
	for c in cases {
		p, ok := parse(c.url)
		defer destroy(&p)
		testing.expectf(
			t,
			ok == c.ok && p.host == c.host && p.port == c.port && p.authorization == c.authorization,
			"%s: got %v %v",
			c.url,
			ok,
			p,
		)
	}

	sb := strings.builder_make(context.temp_allocator)
	write_connect(&sb, "::1", 443, "Basic dTpw")
	testing.expect_value(
		t,
		strings.to_string(sb),
		"CONNECT [::1]:443 HTTP/1.1\r\nHost: [::1]:443\r\nProxy-Authorization: Basic dTpw\r\n\r\n",
	)
}
