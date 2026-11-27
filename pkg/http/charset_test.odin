#+build linux
package larva_http

import "core:testing"

// charset feeds pkg/html's sniffing as the transport label; tests/dom's `.nav-<label>`
// cases and `make test-fetch-html-smoke` cover the label reaching the decoder. These
// pin the parameter parse those cannot vary: case, quotes, whitespace, position.
@(test)
charset_reads_the_content_type_parameter :: proc(t: ^testing.T) {
	cases := [?]struct {
		content_type: string,
		want:         string,
	} {
		{"text/html; charset=windows-1252", "windows-1252"},
		{"text/html;CHARSET=\"Shift_JIS\"", "Shift_JIS"},
		{"text/html; q=1 ;  charset = utf-8 ; x=y", "utf-8"},
		{"text/html; charsetx=utf-8", ""},
		{"text/html", ""},
		{"charset=utf-8", ""}, // a type, not a parameter
	}
	for c in cases {
		r := Response {
			headers = make([dynamic]Header, 0, 1, context.temp_allocator),
		}
		append(&r.headers, Header{name = "content-type", value = c.content_type})
		got := charset(&r)
		testing.expectf(t, got == c.want, "%q: want %q, got %q", c.content_type, c.want, got)
	}

	none: Response
	testing.expect(t, charset(&none) == "", "no Content-Type must give no label")
}
