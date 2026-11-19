package larva_http

import "core:bytes"
import "core:c"
import "core:encoding/endian"
import "core:net"
import "core:strings"
import zlib "vendor:zlib"

// The most codings one response may stack. Real servers send one.
MAX_CONTENT_CODINGS :: 16

// Coding is a Content-Encoding this client can decode.
Coding :: enum u8 {
	Gzip,
	Deflate,
	Brotli,
	Zstd,
}

Codings :: bit_set[Coding]

// What Chrome offers outside a secure context, and decodes there.
@(private = "file")
INSECURE_CODINGS :: Codings{.Gzip, .Deflate}

// The first decode step's output, before it has seen how far the input expands.
@(private = "file")
INITIAL_OUTPUT :: 16 * 1024


// zlib's windowBits for a raw deflate stream and for a zlib-wrapped one.
@(private = "file")
RAW_DEFLATE :: -15
@(private = "file")
ZLIB_DEFLATE :: 15

@(private = "file")
Chain :: struct {
	codings: [MAX_CONTENT_CODINGS]Coding,
	n:       int,
}

@(private = "file")
Chain_Kind :: enum {
	Identity, // nothing to undo, or a coding the chain cannot be undone through
	Decode,
	Too_Long,
}

// The gzip FLG byte (RFC 1952 §2.3.1); the reserved bits 5-7 are ignored, as Chrome does.
@(private = "file")
Gzip_Flag :: enum u8 {
	Text,
	Hcrc,
	Extra,
	Name,
	Comment,
}

@(private = "file")
Gzip_Flags :: bit_set[Gzip_Flag;u8]

@(private = "file")
Gzip_Header :: enum {
	Complete,
	Short, // the input ends inside the header
	Invalid,
}

// Sink is a decode step's output: `buf[:n]` is written, the rest is room for the codec.
// Growing it never zeroes, and it never grows past `limit`, one byte over the caller's
// max_body so that a full sink proves the content larger than allowed.
@(private)
Sink :: struct {
	buf:   [dynamic]byte,
	n:     int,
	limit: int,
}

// accept_encoding is the Accept-Encoding a request to `url` carries when the caller sets
// none: the codings `decode_content` will undo for it, in Chrome's order.
//
// Node:
//   Chrome is the oracle (docs/LARVA.md): "gzip, deflate, br, zstd" to https:// and to
//   localhost, "gzip, deflate" to any other http:// host. Recorded from Chrome 158
//   against a local server, by host name: https://127.0.0.1, http://127.0.0.1 and
//   http://plain.test mapped to 127.0.0.1.
// Deviates:
//   A build whose target cannot decode br and zstd (DECODABLE) does not offer them.
@(private)
accept_encoding :: proc(url: Url) -> string {
	if accepted_codings(url) >= {.Brotli, .Zstd} {
		return "gzip, deflate, br, zstd"
	}

	return "gzip, deflate"
}

// accepted_codings is what a response from `url` may be encoded with. A coding outside it
// fails the response, even when this build could decode it.
//
// Node:
//   Chrome fails a br or zstd body from a host it did not offer them to
//   (insecure-br, insecure-zstd in testdata/content-coding).
@(private)
accepted_codings :: proc(url: Url) -> Codings {
	if url.https || is_secure_host(url.host) {
		return DECODABLE
	}

	return INSECURE_CODINGS & DECODABLE
}

// decode_content replaces `body` with the content its Content-Encoding header lines
// describe, undoing the codings from the last listed to the first. The header lines
// themselves are left as the server sent them, as Chrome's Response.headers keeps them.
//
// Params:
//   body      The body as received; grown and freed through its own allocator.
//   max_body  The most decoded bytes any one coding may produce.
// Returns:
//   .None, with the body decoded or left as sent; .Decoding when it does not decode;
//   .Body_Too_Large when a coding would produce more than max_body bytes.
// Node:
//   Chrome 158, recorded through fetch() into testdata/content-coding by
//   record-chrome.py. Header lines are joined and split at commas, each element trimmed
//   and matched ASCII case-insensitively. One element that is not gzip, x-gzip,
//   deflate, br or zstd (identity and an empty element included) leaves the whole body
//   as sent. A stream that ends early yields what it decoded so far; bytes after the
//   end of the first gzip member or brotli stream are ignored, a gzip trailer is not
//   checked, a zlib adler32 is; zstd decodes every frame, refuses trailing bytes and a
//   window over 8 MiB; deflate without a valid zlib header is taken as raw deflate.
// Deviates:
//   A chain longer than MAX_CONTENT_CODINGS fails with .Decoding: each coding may cost
//   a pass over max_body bytes, so an unbounded chain lets a server spend the
//   client's CPU at no cost of its own. Chrome sets no limit. Pinned by
//   chain_longer_than_the_cap_is_refused.
//
// Decoding waits for the whole body rather than running as it arrives: the body is
// buffered whole anyway, and one pass over it keeps a single codec state per step.
// gzip and deflate go through the system zlib rather than core:compress/deflate, which
// decodes a truncated stream one byte past where zlib (and Chrome) stop — 10 bytes for
// gzip-truncated where Chrome yields 9 — and decodes every gzip member, where Chrome
// stops after the first.
@(private)
decode_content :: proc(body: ^[dynamic]byte, headers: []Header, url: Url, max_body: int) -> Error {
	chain, kind := parse_chain(headers)

	switch kind {
	case .Identity:
		return .None
	case .Too_Long:
		return .Decoding
	case .Decode:
	}

	accepted := accepted_codings(url)
	for coding in chain.codings[:chain.n] {
		if coding not_in accepted {
			return .Decoding
		}
	}

	allocator := body.allocator
	// One byte past max_body, saturated: max(int) is a valid max_body_bytes.
	limit := max_body + 1 if max_body < max(int) else max_body
	#reverse for coding in chain.codings[:chain.n] {
		if len(body) == 0 {
			return .None
		}

		out := Sink {
			buf   = make([dynamic]byte, allocator),
			limit = limit,
		}
		err: Error
		switch coding {
		case .Gzip:
			err = gzip_decode(body[:], &out)
		case .Deflate:
			err = deflate_decode(body[:], &out)
		case .Brotli:
			err = brotli_decode(body[:], &out)
		case .Zstd:
			err = zstd_decode(body[:], &out)
		}

		// A stream that ends exactly as it fills the sink has still produced limit bytes.
		if err == .None && out.n > max_body {
			err = .Body_Too_Large
		}

		if err != .None {
			delete(out.buf)
			return err
		}

		resize(&out.buf, out.n)
		delete(body^)
		body^ = out.buf
	}

	return .None
}

// sink_room returns the unwritten part of the sink, growing it first when it is full.
// false means the sink holds `limit` bytes, or the memory to grow it was refused; both
// end the decode as Body_Too_Large, the second because the content is larger than this
// process can hold.
@(private)
sink_room :: proc(s: ^Sink, input_len: int) -> ([]byte, bool) {
	if s.n == len(s.buf) {
		if s.n >= s.limit {
			return nil, false
		}

		// Doubling, from a guess at the input's expansion: amortized O(1) per byte. Written
		// so nothing overflows: s.n < limit, and 2*s.n is s.n plus at most limit - s.n.
		size := max(INITIAL_OUTPUT, s.n + min(s.n, s.limit - s.n))

		if input_len < max(int) / 4 {
			size = max(size, 4 * input_len)
		}

		size = min(size, s.limit)

		if non_zero_resize(&s.buf, size) != nil {
			return nil, false
		}
	}

	return s.buf[s.n:], true
}

// parse_chain reads every Content-Encoding line, in order.
@(private = "file")
parse_chain :: proc(headers: []Header) -> (chain: Chain, kind: Chain_Kind) {
	seen := false
	for &h in headers {
		if !ascii_equal_fold(h.name, "Content-Encoding") {
			continue
		}

		seen = true
		rest := h.value
		for {
			comma := strings.index_byte(rest, ',')
			element := trim_ows(rest if comma < 0 else rest[:comma])
			coding, known := parse_coding(element)

			if !known {
				return {}, .Identity
			}

			if chain.n == MAX_CONTENT_CODINGS {
				return {}, .Too_Long
			}

			chain.codings[chain.n] = coding
			chain.n += 1

			if comma < 0 {
				break
			}

			rest = rest[comma + 1:]
		}
	}

	return chain, .Decode if seen else .Identity
}

@(private = "file")
parse_coding :: proc(s: string) -> (Coding, bool) {
	switch {
	case ascii_equal_fold(s, "gzip"), ascii_equal_fold(s, "x-gzip"):
		return .Gzip, true
	case ascii_equal_fold(s, "deflate"):
		return .Deflate, true
	case ascii_equal_fold(s, "br"):
		return .Brotli, true
	case ascii_equal_fold(s, "zstd"):
		return .Zstd, true
	}

	return {}, false
}

// is_secure_host says whether Chrome treats `host` over http:// as a secure context:
// localhost, a *.localhost name, 127.0.0.0/8 or ::1 (the W3C Secure Contexts
// "potentially trustworthy" hosts).
@(private = "file")
is_secure_host :: proc(host: string) -> bool {
	LOCALHOST :: ".localhost"

	if ascii_equal_fold(host, LOCALHOST[1:]) {
		return true
	}

	if len(host) > len(LOCALHOST) && ascii_equal_fold(host[len(host) - len(LOCALHOST):], LOCALHOST) {
		return true
	}

	if ip4, ok := net.parse_ip4_address(host); ok {
		return ip4[0] == 127
	}

	if ip6, ok := net.parse_ip6_address(host); ok {
		return ip6 == net.IP6_Loopback
	}

	return false
}

// gzip_decode undoes `gzip` as Chrome does: the header parsed here, the first member's
// deflate data inflated raw, and the trailer and anything after it ignored.
@(private = "file")
gzip_decode :: proc(input: []byte, out: ^Sink) -> Error {
	offset, header := gzip_header(input)

	switch header {
	case .Short:
		return .None
	case .Invalid:
		return .Decoding
	case .Complete:
	}

	return inflate(input[offset:], RAW_DEFLATE, out)
}

// deflate_decode undoes `deflate`: RFC 9110 means a zlib stream, and a raw deflate
// stream is what some servers send instead. A valid zlib header decides, as in Chrome.
@(private = "file")
deflate_decode :: proc(input: []byte, out: ^Sink) -> Error {
	window := c.int(RAW_DEFLATE)

	// RFC 1950 §2.2: method 8, window at most 32 KiB, and CMF*256+FLG a multiple of 31.
	if len(input) >= 2 && input[0] & 0x0F == zlib.DEFLATED && input[0] >> 4 <= 7 && (u16(input[0]) << 8 | u16(input[1])) % 31 == 0 {
		window = ZLIB_DEFLATE
	}

	return inflate(input, window, out)
}

// gzip_header returns the offset of a gzip member's deflate data (RFC 1952 §2.3).
@(private = "file")
gzip_header :: proc(input: []byte) -> (offset: int, result: Gzip_Header) {
	MAGIC :: [3]byte{0x1F, 0x8B, 8} // ID1, ID2, CM = deflate

	magic := MAGIC
	n := min(len(input), len(magic))

	if !bytes.equal(input[:n], magic[:n]) {
		return 0, .Invalid
	}

	// ID1 ID2 CM FLG MTIME(4) XFL OS
	offset = 10

	if len(input) < offset {
		return 0, .Short
	}

	flags := transmute(Gzip_Flags)input[3]

	if .Extra in flags {
		xlen, ok := endian.get_u16(input[offset:], .Little)

		if !ok {
			return 0, .Short
		}

		offset += 2 + int(xlen)
	}

	if .Name in flags {
		offset = skip_zero_terminated(input, offset)
	}

	if .Comment in flags {
		offset = skip_zero_terminated(input, offset)
	}

	if .Hcrc in flags {
		offset += 2
	}

	if offset > len(input) {
		return 0, .Short
	}

	return offset, .Complete
}

// skip_zero_terminated returns the offset past the NUL that ends a field at `from`, or
// one past the end of `input` when there is none.
@(private = "file")
skip_zero_terminated :: proc(input: []byte, from: int) -> int {
	// A truncated FEXTRA can already have put `from` past the end.
	if from >= len(input) {
		return len(input) + 1
	}

	nul := bytes.index_byte(input[from:], 0)
	return len(input) + 1 if nul < 0 else from + nul + 1
}

// inflate runs zlib over the whole of `input`. Running out of input is not an error: the
// stream was cut short and keeps what it decoded, as in Chrome. Bytes after the end of
// the stream are ignored.
@(private = "file")
inflate :: proc(input: []byte, window: c.int, out: ^Sink) -> Error {
	strm: zlib.z_stream

	switch zlib.inflateInit2(&strm, window) {
	case zlib.OK:
	case zlib.MEM_ERROR:
		return .Body_Too_Large
	case:
		return .Decoding
	}

	defer zlib.inflateEnd(&strm)

	rest := input
	for {
		if strm.avail_in == 0 && len(rest) > 0 {
			n := min(len(rest), int(max(zlib.uInt)))
			strm.next_in, strm.avail_in = raw_data(rest), zlib.uInt(n)
			rest = rest[n:]
		}

		room, ok := sink_room(out, len(input))

		if !ok {
			return .Body_Too_Large
		}

		room_len := min(len(room), int(max(zlib.uInt)))
		strm.next_out, strm.avail_out = raw_data(room), zlib.uInt(room_len)
		ret := zlib.inflate(&strm, zlib.NO_FLUSH)
		out.n += room_len - int(strm.avail_out)

		switch ret {
		case zlib.STREAM_END:
			return .None
		case zlib.OK, zlib.BUF_ERROR:
			// Room left over with no input to come: everything decodable is out.
			if strm.avail_in == 0 && len(rest) == 0 && strm.avail_out > 0 {
				return .None
			}
		case zlib.MEM_ERROR:
			// Refused memory reads as too large, as in brotli_decode and zstd_decode.
			return .Body_Too_Large
		case:
			// DATA_ERROR (corrupt data, a bad adler32), NEED_DICT.
			return .Decoding
		}
	}
}
