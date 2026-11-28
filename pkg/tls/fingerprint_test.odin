#+build linux
package lava_tls

import "core:crypto/sha2"
import "core:encoding/hex"
import "core:fmt"
import "core:log"
import "core:slice"
import "core:strings"
import "core:sys/posix"
import "core:testing"

// Larva's ClientHello against Chrome 158's (#6). The oracle is Chrome's own ClientHello,
// recorded raw by scripts/record-tls-hello.mjs (a local TCP echo, Chrome for Testing
// 158 headless) into tests/tls/. Larva's is captured without a server: tls_new_client
// on one end of a socketpair, one SSL_connect step (which writes the ClientHello and
// then wants to read), and the bytes read off the other end.
//
// Compared modulo what is random by design — GREASE values, extension order (Chrome
// permutes it), key shares, the random, SNI — and modulo the two deviations
// pkg/profile names: ALPN offers http/1.1 alone, and no ALPS (17613), until H2 (#7).

@(private = "file")
CHROME_158_HELLO_HEX :: #load("../../tests/tls/chrome-158-linux.clienthello.hex", string)

@(private = "file")
EXT_ALPN :: 16
@(private = "file")
EXT_SNI :: 0
@(private = "file")
EXT_ALPS :: 17613

@(private = "file")
Hello :: struct {
	legacy_version: u16,
	ciphers:        [dynamic]u16,
	exts:           [dynamic]u16,
	bodies:         map[u16][]u8,
	alpn:           [dynamic]string,
	sigalgs:        [dynamic]u16,
	groups:         [dynamic]u16,
	versions:       [dynamic]u16,
}

@(private = "file")
is_grease :: proc(v: u16) -> bool {
	return v & 0x0f0f == 0x0a0a && v >> 8 == v & 0xff
}

@(private = "file")
be16 :: proc(b: []u8, i: int) -> u16 {
	return u16(b[i]) << 8 | u16(b[i + 1])
}

@(private = "file")
list16 :: proc(out: ^[dynamic]u16, body: []u8, off: int) {
	for i := off; i + 1 < len(body); i += 2 {
		append(out, be16(body, i))
	}
}

// parse_hello reads one TLS record holding a ClientHello. Allocations go to the temp
// allocator; the test frees it at the end.
@(private = "file")
parse_hello :: proc(rec: []u8) -> (h: Hello, ok: bool) {
	context.allocator = context.temp_allocator

	if len(rec) < 5 || rec[0] != 22 || 5 + int(be16(rec, 3)) > len(rec) {
		return
	}

	b := rec[5:5 + int(be16(rec, 3))]

	if len(b) < 4 || b[0] != 1 {
		return
	}

	p := 4
	h.legacy_version = be16(b, p)
	p += 2 + 32
	p += 1 + int(b[p])
	cipher_end := p + 2 + int(be16(b, p))
	p += 2

	for ; p < cipher_end; p += 2 {
		append(&h.ciphers, be16(b, p))
	}

	p += 1 + int(b[p])
	ext_end := p + 2 + int(be16(b, p))
	p += 2

	for p < ext_end {
		t := be16(b, p)
		n := int(be16(b, p + 2))
		body := b[p + 4:p + 4 + n]
		p += 4 + n
		append(&h.exts, t)
		h.bodies[t] = body

		switch t {
		case EXT_ALPN:
			for i := 2; i < len(body); {
				l := int(body[i])
				append(&h.alpn, string(body[i + 1:i + 1 + l]))
				i += 1 + l
			}
		case 13:
			list16(&h.sigalgs, body, 2)
		case 10:
			list16(&h.groups, body, 2)
		case 43:
			list16(&h.versions, body, 1)
		}
	}

	return h, p == ext_end
}

@(private = "file")
no_grease :: proc(v: []u16) -> []u16 {
	out := make([dynamic]u16, context.temp_allocator)

	for x in v {
		if !is_grease(x) {
			append(&out, x)
		}
	}

	return out[:]
}

@(private = "file")
count_grease :: proc(v: []u16) -> (n: int) {
	for x in v {
		if is_grease(x) {
			n += 1
		}
	}

	return
}

@(private = "file")
sha12 :: proc(s: string) -> string {
	ctx: sha2.Context_256
	sum: [32]u8
	sha2.init_256(&ctx)
	sha2.update(&ctx, transmute([]u8)s)
	sha2.final(&ctx, sum[:])
	return string(hex.encode(sum[:6], context.temp_allocator))
}

@(private = "file")
hex_list :: proc(v: []u16, sorted: bool) -> string {
	w := slice.clone(v, context.temp_allocator)

	if sorted {
		slice.sort(w)
	}

	sb := strings.builder_make(context.temp_allocator)

	for x, i in w {
		if i > 0 {
			strings.write_byte(&sb, ',')
		}

		fmt.sbprintf(&sb, "%04x", x)
	}

	return strings.to_string(sb)
}

// ja4 is FoxIO's JA4 (TLS over TCP), GREASE dropped from every list, signature
// algorithms included. `drop` names extensions to leave out, which is how a documented
// deviation is applied to Chrome's side before the comparison.
@(private = "file")
ja4 :: proc(h: Hello, alpn: string, drop: []u16 = nil) -> string {
	ciphers := no_grease(h.ciphers[:])
	exts := make([dynamic]u16, context.temp_allocator)

	for e in no_grease(h.exts[:]) {
		if !slice.contains(drop, e) {
			append(&exts, e)
		}
	}

	v := slice.max(no_grease(h.versions[:]))
	ver := v == 0x0304 ? "13" : "12"
	sni := slice.contains(exts[:], EXT_SNI) ? "d" : "i"
	a := fmt.tprintf("t%s%s%02d%02d%c%c", ver, sni, min(len(ciphers), 99), min(len(exts), 99), alpn[0], alpn[len(alpn) - 1])
	c_exts := make([dynamic]u16, context.temp_allocator)

	for e in exts {
		if e != EXT_SNI && e != EXT_ALPN {
			append(&c_exts, e)
		}
	}

	c := fmt.tprintf("%s_%s", hex_list(c_exts[:], true), hex_list(no_grease(h.sigalgs[:]), false))
	return fmt.tprintf("%s_%s_%s", a, sha12(hex_list(ciphers, true)), sha12(c))
}

// larva_hello captures the ClientHello tls_new_client sends for `host`.
@(private = "file")
larva_hello :: proc(t: ^testing.T, host: string) -> (rec: []u8, ok: bool) {
	fds: [2]posix.FD

	if !testing.expect(t, posix.socketpair(.UNIX, .STREAM, posix.Protocol(0), &fds) == .OK) {
		return
	}

	defer posix.close(fds[0])
	defer posix.close(fds[1])
	// Non-blocking, so SSL_connect writes the ClientHello and returns WANT_READ.
	posix.fcntl(fds[0], .SETFL, posix.O_NONBLOCK)
	ssl := tls_new_client(uintptr(fds[0]), host)

	if !testing.expect(t, ssl != nil, "tls_new_client failed") {
		return
	}

	defer SSL_free(ssl)
	ret := SSL_connect(ssl)
	testing.expect_value(t, SSL_get_error(ssl, ret), SSL_ERROR_WANT_READ)
	buf := make([]u8, 1 << 16, context.temp_allocator)
	n := posix.read(fds[1], raw_data(buf), len(buf))

	if !testing.expect(t, n > 5, "no ClientHello on the wire") {
		return
	}

	return buf[:n], true
}

@(test)
clienthello_matches_chrome_158 :: proc(t: ^testing.T) {
	defer free_all(context.temp_allocator)
	raw, hex_err := hex.decode(transmute([]u8)strings.trim_space(CHROME_158_HELLO_HEX), context.temp_allocator)

	if !testing.expect(t, hex_err == nil, "bad fixture hex") {
		return
	}

	chrome, chrome_ok := parse_hello(raw)
	testing.expect(t, chrome_ok, "fixture is not a ClientHello")
	rec, rec_ok := larva_hello(t, "echo.larva.test")

	if !rec_ok {
		return
	}

	larva, larva_ok := parse_hello(rec)

	if !testing.expect(t, larva_ok, "Larva's ClientHello does not parse") {
		return
	}

	// Ciphers, groups, signature algorithms and versions in Chrome's exact order.
	testing.expect_value(t, hex_list(no_grease(larva.ciphers[:]), false), hex_list(no_grease(chrome.ciphers[:]), false))
	testing.expect_value(t, hex_list(no_grease(larva.groups[:]), false), hex_list(no_grease(chrome.groups[:]), false))
	testing.expect_value(t, hex_list(no_grease(larva.sigalgs[:]), false), hex_list(no_grease(chrome.sigalgs[:]), false))
	testing.expect_value(t, hex_list(no_grease(larva.versions[:]), false), hex_list(no_grease(chrome.versions[:]), false))

	// GREASE where Chrome puts it: first cipher, first group, first version, first
	// signature algorithm, and two extensions. JA4 drops every GREASE value, so this is
	// what notices GREASE switched off.
	testing.expect(t, is_grease(larva.ciphers[0]), "first cipher is not GREASE")
	testing.expect(t, is_grease(larva.groups[0]), "first group is not GREASE")
	testing.expect(t, is_grease(larva.versions[0]), "first version is not GREASE")
	testing.expect(t, is_grease(larva.sigalgs[0]), "first signature algorithm is not GREASE")
	testing.expect_value(t, count_grease(larva.exts[:]), count_grease(chrome.exts[:]))

	// The extension SET is Chrome's less ALPS (the deviation); order is permuted.
	chrome_exts := make([dynamic]u16, context.temp_allocator)

	for e in no_grease(chrome.exts[:]) {
		if e != EXT_ALPS {
			append(&chrome_exts, e)
		}
	}

	testing.expect_value(t, hex_list(no_grease(larva.exts[:]), true), hex_list(chrome_exts[:], true))

	// Fixed-content extensions byte for byte: status_request, ec_point_formats,
	// compress_certificate (brotli), psk_key_exchange_modes, trust_anchors,
	// server_padding, renegotiation_info.
	for e in ([]u16{5, 11, 27, 45, 0xca34, 4832, 0xff01}) {
		testing.expectf(t, slice.equal(larva.bodies[e], chrome.bodies[e]), "extension %04x differs from Chrome's", e)
	}

	// The ALPN deviation, pinned: http/1.1 alone until H2 (#7).
	testing.expect_value(t, len(larva.alpn), 1)

	if len(larva.alpn) == 1 {
		testing.expect_value(t, larva.alpn[0], "http/1.1")
	}

	// JA4: Larva's equals Chrome's with the two deviations applied to Chrome's side.
	larva_ja4 := ja4(larva, "http/1.1")
	chrome_ja4 := ja4(chrome, "http/1.1", {EXT_ALPS})
	testing.expect_value(t, larva_ja4, chrome_ja4)
	log.infof("JA4 chrome %s (as recorded) | chrome less deviations %s | larva %s", ja4(chrome, chrome.alpn[0]), chrome_ja4, larva_ja4)

	// Permutation: a second connection's extension order differs (16! orders).
	rec2, rec2_ok := larva_hello(t, "echo.larva.test")

	if rec2_ok {
		larva2, _ := parse_hello(rec2)
		testing.expect(t, !slice.equal(no_grease(larva.exts[:]), no_grease(larva2.exts[:])), "extension order is not permuted")
	}
}
