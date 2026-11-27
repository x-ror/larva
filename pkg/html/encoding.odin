package larva_html

import "base:runtime"
import "core:c"

// Charset sniffing and decoding (DOM stage 3c, #11): the bytes a navigation receives
// become the UTF-8 the parser takes. lexbor's encoding module does the work — its BOM
// sniff, label table, <meta> prescan and the WHATWG decoders for every encoding the
// Encoding standard names — through two shim procs (shim/larva_html.c); nothing here
// is a codec. Odin's core: has no legacy codec at all (core:encoding holds UTF-16,
// base64, hex, json…, not windows-1252 or Shift_JIS), and lexbor is already linked.

// Encoding_Source says which step of the sniffing algorithm chose the encoding. The
// values are the shim's LARVA_ENC_* constants.
Encoding_Source :: enum c.int {
	None      = 0,
	BOM       = 1, // a byte order mark: UTF-8, UTF-16LE or UTF-16BE
	Transport = 2, // the charset the caller passed, Content-Type's
	Meta      = 3, // <meta charset> or <meta http-equiv=content-type> in the prescan
	Default   = 4, // nothing said: windows-1252
}

// Encoding is the outcome of sniffing.
Encoding :: struct {
	// The WHATWG name, as `document.characterSet` reports it ("windows-1252",
	// "UTF-8", "Shift_JIS"). Static: lexbor's table owns it.
	name:   string,
	source: Encoding_Source,
}

// decode_document determines the character encoding of a document's bytes and decodes
// them to UTF-8, as a navigation does before parsing.
//
// Params:
//   transport_charset  The transport layer's charset label (Content-Type's `charset`
//                      parameter), "" for none. An unknown label counts as none.
// Returns:
//   The document as UTF-8, allocated with `allocator` (the caller deletes it), the BOM
//   dropped and malformed input replaced by U+FFFD; the encoding and the step that
//   chose it. ok false when lexbor could not allocate, the output could not grow, or
//   off Linux (no lexbor build).
// Chrome:
//   The HTML standard's algorithm in Chrome 158's order — BOM, then Content-Type, then
//   the prescan, then windows-1252 — recorded by navigating to each tests/dom
//   `*.nav*.html` case (tests/dom/README.md); an unlabeled UTF-8 page decodes as
//   windows-1252 there too (charset-default-utf8-bytes.nav).
//   Chrome 158 also honours a <meta> past the first 1024 bytes while the head lasts
//   (charset-meta-late.nav, -late-far.nav; not after <body>, -late-body.nav), and so
//   does the shim, up to the first `<body` (larva_html_sniff says where that differs).
// Deviates:
//   Batch, not streaming: the whole input is decoded before the parser sees any of it.
//   The parent document's encoding, which an iframe inherits, is not modelled: there is
//   no frame yet (stage 3h).
decode_document :: proc(
	data: []byte,
	transport_charset := "",
	allocator := context.allocator,
) -> (
	text: []byte,
	enc: Encoding,
	ok: bool,
) {
	skip: c.size_t
	source: c.int
	data_enc := larva_html_sniff(
		raw_data(data),
		c.size_t(len(data)),
		raw_data(transport_charset),
		c.size_t(len(transport_charset)),
		&skip,
		&source,
	)

	if data_enc == nil {
		return nil, {}, false
	}

	name_len: c.size_t
	name := larva_html_encoding_name(data_enc, &name_len)
	enc = {string(name[:name_len]), Encoding_Source(source)}
	body := data[skip:]

	// Most input stays about its size (ASCII markup), so reserve that and let the sink
	// grow for the rest.
	out := make([dynamic]byte, 0, len(body), allocator)
	write :: proc "c" (ctx: rawptr, piece: [^]u8, n: c.size_t) -> bool {
		context = runtime.default_context()
		sink := cast(^[dynamic]byte)ctx
		// The array carries the caller's allocator from make; the default context is
		// only here to satisfy append's signature.
		_, err := append(sink, ..piece[:n])
		return err == nil
	}

	if !larva_html_decode(data_enc, raw_data(body), c.size_t(len(body)), write, &out) {
		delete(out)
		return nil, enc, false
	}

	return out[:], enc, true
}
