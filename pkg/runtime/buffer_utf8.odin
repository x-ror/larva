package lava_runtime

import "base:runtime"
import "core:bytes"
import "core:c"
import "core:unicode/utf8"
import jsc "lava:pkg/jsc"

// UTF-8 Buffer codecs and the WHATWG maximal-subpart decoder, split from
// buffer.odin so the main codec file stays under the ~1k-line scannability bar.

buffer_utf8_encode_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 do return make_uint8_array(ctx, nil)

	str, alloc := jsc_value_to_string_or_default(ctx, arguments[0])
	if !alloc do return make_uint8_array(ctx, nil) // empty string
	// Do NOT free `str`: its backing buffer is handed to JSC below.
	return make_uint8_array(ctx, transmute([]byte)str)
}

// emit_utf16 appends a Unicode scalar value to `out` as 1 (BMP) or 2 (surrogate
// pair) UTF-16 code units and returns how many it wrote.
emit_utf16 :: proc "contextless" (out: []u16, cp: u32) -> int {
	if cp <= 0xFFFF {
		out[0] = u16(cp)
		return 1
	}
	c := cp - 0x10000
	out[0] = u16(0xD800 + (c >> 10))
	out[1] = u16(0xDC00 + (c & 0x3FF))
	return 2
}

// decode_utf8_to_utf16_whatwg decodes a UTF-8 byte slice into UTF-16 code units written
// to `out`, implementing the WHATWG "UTF-8 decoder" / Unicode "U+FFFD
// substitution of maximal subparts" rule that Node (V8) follows. The key
// difference from a naive per-byte decode is the handling of an *invalid
// continuation* byte: the in-progress sequence emits a single U+FFFD and the
// offending byte is then re-processed as a potential new lead, so an ill-formed
// subsequence collapses to one replacement rather than one per byte. A naive
// per-byte decoder would instead emit one U+FFFD for each bad byte
// (Buffer.from([0xF0,0x9F]) -> "��", where Node yields "�").
// Embedded NULs are preserved. `out` must hold at least len(data)+1 units: every
// emitted unit is charged to >= 1 consumed input byte, and an astral scalar
// costs 2 units but 4 bytes, so the count never exceeds len(data) (+1 covers the
// trailing replacement for an unfinished sequence at end of input).
decode_utf8_to_utf16_whatwg :: proc "contextless" (data: []byte, out: []u16) -> (n: int) {
	i := 0
	// Fast path: copy the leading ASCII run verbatim. ASCII (and ASCII-heavy
	// mixed text) is the common case for Buffer.toString('utf8'); a byte <= 0x7F
	// decodes to itself, so we skip the state machine until the first non-ASCII
	// byte. The slow loop below has the same shortcut for ASCII that resumes after
	// a multi-byte sequence.
	for i < len(data) && data[i] <= 0x7F {
		out[n] = u16(data[i]); n += 1
		i += 1
	}

	code_point: u32 = 0
	bytes_needed := 0
	bytes_seen := 0
	lower: u8 = 0x80
	upper: u8 = 0xBF

	for i < len(data) {
		b := data[i]
		if bytes_needed == 0 {
			if b <= 0x7F { 	// ASCII resumes after a completed multi-byte sequence
				out[n] = u16(b); n += 1
				i += 1
				continue
			}
			switch {
			case b >= 0xC2 && b <= 0xDF:
				bytes_needed = 1; code_point = u32(b & 0x1F)
				i += 1
			case b >= 0xE0 && b <= 0xEF:
				if b == 0xE0 do lower = 0xA0 // exclude overlong < U+0800
				if b == 0xED do upper = 0x9F // exclude UTF-16 surrogates
				bytes_needed = 2; code_point = u32(b & 0x0F)
				i += 1
			case b >= 0xF0 && b <= 0xF4:
				if b == 0xF0 do lower = 0x90 // exclude overlong < U+10000
				if b == 0xF4 do upper = 0x8F // exclude > U+10FFFF
				bytes_needed = 3; code_point = u32(b & 0x07)
				i += 1
			case:
				// Invalid lead byte (0x80..0xC1, 0xF5..0xFF): one replacement.
				out[n] = 0xFFFD; n += 1
				i += 1
			}
		} else {
			if b < lower || b > upper {
				// Invalid continuation: flush a replacement for the bytes seen so
				// far, reset state, and re-process this byte (do not advance i).
				code_point = 0; bytes_needed = 0; bytes_seen = 0
				lower = 0x80; upper = 0xBF
				out[n] = 0xFFFD; n += 1
			} else {
				lower = 0x80; upper = 0xBF
				code_point = (code_point << 6) | u32(b & 0x3F)
				bytes_seen += 1
				i += 1
				if bytes_seen == bytes_needed {
					// #force_inline: hot path, but keep emit_utf16 a single named unit
					// (no duplicated surrogate-pair logic).
					n += #force_inline emit_utf16(out[n:], code_point)
					code_point = 0; bytes_needed = 0; bytes_seen = 0
				}
			}
		}
	}
	// Unfinished trailing sequence at end of input -> a single replacement.
	if bytes_needed != 0 {
		out[n] = 0xFFFD; n += 1
	}
	return n
}

// utf8Decode(u8) -> string. Decodes via the WHATWG UTF-8 decoder
// (decode_utf8_to_utf16_whatwg) and builds the JS string from the code units, because
// JSStringCreateWithUTF8CString would truncate at an embedded NUL — Node keeps
// it. Going through code units (rather than a UTF-8 C string) also lets us apply
// the maximal-subpart replacement rule that Buffer.toString('utf8') / TextDecoder
// require.
buffer_utf8_decode_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 do return js_string_value(ctx, "")

	data, ok := typed_array_view(ctx, arguments[0])
	if !ok || len(data) == 0 do return js_string_value(ctx, "")

	// Pure-ASCII (NULs included): same as latin1 bytes → 8-bit StringImpl.
	if bytes_all_ascii(data) {
		return latin1_string_from_bytes(ctx, data)
	}

	// Fast path: NUL-free multi-byte UTF-8 via JSC's UTF-8 create (strict
	// validate). Empty result means invalid input → WHATWG path below.
	if bytes.index_byte(data, 0) < 0 {
		tmp := make([]byte, len(data) + 1, context.temp_allocator)
		copy(tmp, data)
		tmp[len(data)] = 0
		js_str := jsc.JSStringCreateWithUTF8CString(cstring(raw_data(tmp)))
		if js_str != nil {
			if jsc.JSStringGetLength(js_str) > 0 {
				defer jsc.JSStringRelease(js_str)
				return jsc.JSValueMakeString(ctx, js_str)
			}
			jsc.JSStringRelease(js_str)
		}
	}

	// +1 headroom for a trailing-replacement at end of input (see proc docs).
	units := make([]u16, len(data) + 1, context.temp_allocator)
	n := decode_utf8_to_utf16_whatwg(data, units)

	js_str := jsc.JSStringCreateWithCharacters(raw_data(units), c.size_t(n))
	defer jsc.JSStringRelease(js_str)
	return jsc.JSValueMakeString(ctx, js_str)
}

// allocUninit(size) -> Uint8Array | null. Hands back `size` bytes of native,
// *uninitialized* memory (Node's allocUnsafe semantics) as a NoCopy Uint8Array
// that the JS layer wraps as a Buffer view. Only the unpooled unsafe paths reach
// here (large Buffer.allocUnsafe, Buffer.allocUnsafeSlow); the small
// pooled path stays in JS. Returns null for a non-positive size or an allocation
// failure, so the JS layer falls back to a zero-filled own-backing Buffer (which
// throws for an impossible size, matching Node). The size is already validated by
// assertSize on the JS side; the int() truncation here mirrors Node's allocator
// flooring a fractional request.

buffer_is_valid_utf8_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 do return jsc.JSValueMakeBoolean(ctx, true)
	data, ok := typed_array_view(ctx, arguments[0])
	if !ok do return jsc.JSValueMakeBoolean(ctx, false)
	if len(data) == 0 do return jsc.JSValueMakeBoolean(ctx, true)
	return jsc.JSValueMakeBoolean(ctx, b32(utf8.valid_string(string(data))))
}

// latin1Encode(string) -> Uint8Array. One output byte per UTF-16 code unit,
// low 8 bits only — Node's Buffer.from(str, 'latin1') / 'ascii' (encode side).

buffer_utf8_write_into_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 4 do return jsc.JSValueMakeNumber(ctx, 0)
	// Re-entrancy hazard: the target view must be acquired after every argument
	// coercion — see the note in buffer_utf16le_write_into_cb (buffer.odin).
	src := read_string_arg(ctx, arguments[1])
	if !src.ok do return js_int_value(ctx, 0)
	defer if src.str != nil do jsc.JSStringRelease(src.str)
	slen := string_read_len(src)
	if slen == 0 do return js_int_value(ctx, 0)

	offset := js_int_arg(ctx, arguments[2])
	max := js_int_arg(ctx, arguments[3])

	target, tok := typed_array_view(ctx, arguments[0])
	if !tok do return jsc.JSValueMakeNumber(ctx, 0)
	if offset < 0 do offset = 0
	if offset > len(target) do offset = len(target)
	avail := len(target) - offset
	if max > avail do max = avail
	if max <= 0 do return js_int_value(ctx, 0)

	dst := target[offset:][:max]
	if src.is8 {
		// ASCII 8-bit storage is already UTF-8 — straight capped copy. Latin-1
		// high bytes expand to two UTF-8 bytes each, capped at the boundary.
		if bytes_all_ascii(src.s8) {
			return js_int_value(ctx, copy(dst, src.s8))
		}
		o := 0
		for b in src.s8 {
			if b < 0x80 {
				if o + 1 > len(dst) do break
				dst[o] = b
				o += 1
			} else {
				if o + 2 > len(dst) do break
				dst[o] = 0xC0 | (b >> 6)
				dst[o + 1] = 0x80 | (b & 0x3F)
				o += 2
			}
		}
		return js_int_value(ctx, o)
	}
	n := jsc.utf16_js_to_utf8_capped(raw_data(src.s16), slen, dst)
	return js_int_value(ctx, n)
}

buffer_utf8_byte_length_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 do return jsc.JSValueMakeNumber(ctx, 0)

	src := read_string_arg(ctx, arguments[0])
	if !src.ok do return js_int_value(ctx, 0)
	defer if src.str != nil do jsc.JSStringRelease(src.str)
	// 8-bit storage: no surrogates possible; UTF-8 length is len + one extra
	// byte per Latin-1 high byte.
	if src.is8 {
		n := len(src.s8)
		for b in src.s8 {
			if b >= 0x80 do n += 1
		}
		return js_int_value(ctx, n)
	}
	return js_int_value(ctx, jsc.utf16_js_utf8_byte_len(raw_data(src.s16), len(src.s16)))
}
