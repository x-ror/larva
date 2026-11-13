package lava_runtime

import "base:intrinsics"
import "base:runtime"
import "core:bytes"
import "core:c"
import "core:mem"
import "core:os"
import "core:strconv"
import "core:strings"
import "core:unicode/utf8"
import jsc "lava:pkg/jsc"

// Native codec backing for the node:buffer built-in. All codecs and byte-ops are
// required Odin primitives reached through the `native` bindings object the loader
// passes as the factory's fourth argument — no JS polyfills in buffer.js. The JS
// layer owns Node API glue and encoding quirks (lenient base64 normalization).

// Codec lookup tables and the SIMD hex/base64 kernels live in buffer_simd.odin.

// bytes_all_ascii reports whether every byte is < 0x80 (NULs allowed), eight
// bytes per step. ASCII content can go into an 8-bit StringImpl byte-for-byte.
bytes_all_ascii :: proc(data: []byte) -> bool {
	i := 0
	for ; i + 8 <= len(data); i += 8 {
		chunk := intrinsics.unaligned_load((^u64)(raw_data(data[i:])))
		if chunk & 0x8080808080808080 != 0 do return false
	}
	for ; i < len(data); i += 1 {
		if data[i] >= 0x80 do return false
	}
	return true
}

// bytes_all_ascii_no_nul is bytes_all_ascii but also rejects 0x00, for callers
// whose fallback path is NUL-truncating (js_string_value) and must not change
// behavior when the fast path is unavailable.
bytes_all_ascii_no_nul :: proc(data: []byte) -> bool {
	i := 0
	for ; i + 8 <= len(data); i += 8 {
		chunk := intrinsics.unaligned_load((^u64)(raw_data(data[i:])))
		has_nul := (chunk - 0x0101010101010101) & ~chunk & 0x8080808080808080
		if chunk & 0x8080808080808080 != 0 || has_nul != 0 do return false
	}
	for ; i < len(data); i += 1 {
		if data[i] >= 0x80 || data[i] == 0 do return false
	}
	return true
}

// ascii_string_value builds a JS string from a NUL-terminated pure-ASCII buffer.
// Fast path: copy straight into an 8-bit StringImpl (jsc.string_alloc8), no
// validation pass. Fallback: JSStringCreateWithUTF8CString (JSC stores pure
// ASCII as 8-bit StringImpl; measured faster on javascriptcoregtk than
// CreateWithCharacters' UTF-16 widen).
@(private = "file")
ascii_string_value :: proc(ctx: jsc.JSContextRef, buf: []byte) -> jsc.JSValueRef {
	if str, dst, ok := jsc.string_alloc8(len(buf) - 1); ok {
		copy(dst, buf[:len(buf) - 1])
		defer jsc.JSStringRelease(str)
		return jsc.JSValueMakeString(ctx, str)
	}
	js_str := jsc.JSStringCreateWithUTF8CString(cstring(raw_data(buf)))
	defer jsc.JSStringRelease(js_str)
	return jsc.JSValueMakeString(ctx, js_str)
}

// String_Read borrows a string argument's storage in whichever width it has:
// direct cell read when possible, else through the C API (which also flattens
// ropes). When `str` is non-nil the caller must JSStringRelease it after the
// last use of the borrowed slice. Package-visible for buffer_utf8.odin etc.
String_Read :: struct {
	s8:  []byte,
	s16: []jsc.JSChar,
	is8: bool,
	str: jsc.JSStringRef,
	ok:  bool,
}

read_string_arg :: proc(ctx: jsc.JSContextRef, v: jsc.JSValueRef) -> (r: String_Read) {
	if s8, ok := jsc.value_chars8(ctx, v); ok {
		r.s8 = s8
		r.is8 = true
		r.ok = true
		return
	}
	if s16, ok := jsc.value_chars16(ctx, v); ok {
		r.s16 = s16
		r.ok = true
		return
	}
	str := jsc.JSValueToStringCopy(ctx, v, nil)
	if str == nil do return
	if s8, ok := jsc.string_chars8(str); ok {
		r.s8 = s8
		r.is8 = true
		r.str = str
		r.ok = true
		return
	}
	length := int(jsc.JSStringGetLength(str))
	chars := jsc.JSStringGetCharactersPtr(str)
	if chars == nil {
		jsc.JSStringRelease(str)
		return
	}
	r.s16 = chars[:length]
	r.str = str
	r.ok = true
	return
}

string_read_len :: proc(r: String_Read) -> int {
	if r.is8 do return len(r.s8)
	return len(r.s16)
}

// hexEncode(u8) -> string. Lowercase hex, matching Buffer.toString('hex').
// Digits are written directly into the result string's 8-bit storage when the
// private constructor is available — one pass, no temp, no UTF-8 re-scan.
buffer_hex_encode_cb :: proc "c" (
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

	n := len(data) * 2
	if str, dst, ok8 := jsc.string_alloc8(n); ok8 {
		hex_write(dst, data)
		defer jsc.JSStringRelease(str)
		return jsc.JSValueMakeString(ctx, str)
	}
	out := make([]byte, n + 1, context.temp_allocator)
	hex_write(out[:n], data)
	out[n] = 0
	return ascii_string_value(ctx, out)
}

@(private = "file")
hex_decode_from :: proc(ctx: jsc.JSContextRef, chars: []$T) -> jsc.JSValueRef {
	if len(chars) < 2 do return make_uint8_array(ctx, nil)
	out := make([]byte, len(chars) / 2, context.allocator)
	n := hex_parse_into(out, chars)
	if n == 0 {
		delete(out, context.allocator)
		return make_uint8_array(ctx, nil)
	}
	return make_uint8_array(ctx, out[:n])
}

buffer_hex_decode_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 do return make_uint8_array(ctx, nil)

	r := read_string_arg(ctx, arguments[0])
	if !r.ok do return make_uint8_array(ctx, nil)
	defer if r.str != nil do jsc.JSStringRelease(r.str)
	if r.is8 do return hex_decode_from(ctx, r.s8)
	return hex_decode_from(ctx, r.s16)
}

// base64Encode(u8) -> string. Standard alphabet with padding, matching
// Buffer.toString('base64'). Written directly into the result string's 8-bit
// storage when the private constructor is available.
buffer_base64_encode_cb :: proc "c" (
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

	n := (len(data) + 2) / 3 * 4
	if str, dst, ok8 := jsc.string_alloc8(n); ok8 {
		base64_write(dst, data)
		defer jsc.JSStringRelease(str)
		return jsc.JSValueMakeString(ctx, str)
	}
	out := make([]byte, n + 1, context.temp_allocator)
	base64_write(out[:n], data)
	out[n] = 0
	return ascii_string_value(ctx, out)
}

// base64Decode(string) -> Uint8Array. The JS layer normalizes the input
// (strips non-alphabet chars, fixes padding) so the string handed here is clean,
// padded standard base64; anything else yields an empty array, matching the old
// core:encoding/base64 error behavior.
buffer_base64_decode_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 do return make_uint8_array(ctx, nil)

	// Same in-place read as hexDecode: base64 input is ASCII by contract.
	r := read_string_arg(ctx, arguments[0])
	if !r.ok do return make_uint8_array(ctx, nil)
	defer if r.str != nil do jsc.JSStringRelease(r.str)
	if r.is8 do return base64_decode_from(ctx, r.s8)
	return base64_decode_from(ctx, r.s16)
}

@(private = "file")
base64_decode_from :: proc(ctx: jsc.JSContextRef, chars: []$T) -> jsc.JSValueRef {
	length := len(chars)
	if length == 0 || length % 4 != 0 do return make_uint8_array(ctx, nil)
	out := make([]byte, length / 4 * 3, context.allocator)
	n, okp := base64_parse(out, chars)
	if !okp {
		delete(out, context.allocator)
		return make_uint8_array(ctx, nil)
	}
	return make_uint8_array(ctx, out[:n])
}

// utf8Encode(string) -> Uint8Array. JavaScriptCore already produced a UTF-8
// encoding of the JS string (surrogate handling included) when we read it, so we
// just hand those bytes straight to a typed array — ownership of the backing
// buffer transfers to JSC.
buffer_alloc_uninit_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 do return jsc.JSValueMakeNull(ctx)

	n := js_int_arg(ctx, arguments[0])
	array, ok := make_uint8_array_uninit(ctx, n)
	if !ok do return jsc.JSValueMakeNull(ctx)
	return array
}

// DEFAULT_MAX_BUFFER_BYTES is the practical ceiling for a single Buffer / typed
// array allocation when LAVA_MAX_BUFFER_BYTES is unset. Unlike V8 — which throws a
// catchable RangeError when an in-range allocation cannot be satisfied —
// JavaScriptCore aborts the process once a request exceeds what it can allocate.
// The Buffer layer refuses anything past this ceiling with a catchable RangeError
// before JSC ever sees it (raw typed arrays rely on JSC's own throw). 4 GiB on 64-bit
// matches the JSC/Bun array-buffer ceiling; 2 GiB-1 on 32-bit is the addressable
// signed limit. Allocations within the cap that still exhaust RAM remain a
// known JSC-vs-V8 difference.
when size_of(uintptr) >= 8 {
	DEFAULT_MAX_BUFFER_BYTES :: 4294967296.0
} else {
	DEFAULT_MAX_BUFFER_BYTES :: 2147483647.0
}

// max_buffer_alloc_bytes resolves the allocation ceiling, honoring an optional
// LAVA_MAX_BUFFER_BYTES override — for operators who want a tighter bound. A
// malformed, negative, or zero value falls back to the platform default: a
// non-positive ceiling is treated as "unset" here so it matches the JS layer
// (buffer.js ignores a non-positive maxAllocBytes and falls back), rather than
// silently capping every allocation to zero.
max_buffer_alloc_bytes :: proc() -> f64 {
	environ, err := os.environ(context.temp_allocator)
	if err == os.ERROR_NONE {
		for entry in environ {
			idx := strings.index_byte(entry, '=')
			if idx <= 0 do continue
			if entry[:idx] != "LAVA_MAX_BUFFER_BYTES" do continue
			if n, ok := strconv.parse_f64(entry[idx + 1:]); ok && n > 0 {
				return n
			}
			break
		}
	}
	return DEFAULT_MAX_BUFFER_BYTES
}

// compare(a, b) -> -1 | 0 | 1. Native lexicographic byte comparison with the
// shorter-array-is-less tiebreak — the same total order as the JS compareBytes
// fallback, but a single native pass instead of a JS loop. The JS layer only
// routes here once at least one input is past a small size threshold (the FFI
// crossing costs more than a JS loop for tiny buffers). Both views are read in
// place; nothing is allocated.
buffer_compare_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 2 do return js_int_value(ctx, 0)
	a, aok := typed_array_view(ctx, arguments[0])
	b, bok := typed_array_view(ctx, arguments[1])
	if !aok || !bok do return js_int_value(ctx, 0)
	n := min(len(a), len(b))
	for i in 0 ..< n {
		if a[i] < b[i] do return js_int_value(ctx, -1)
		if a[i] > b[i] do return js_int_value(ctx, 1)
	}
	if len(a) < len(b) do return js_int_value(ctx, -1)
	if len(a) > len(b) do return js_int_value(ctx, 1)
	return js_int_value(ctx, 0)
}

// indexOf(haystack, needle, start, forward) -> absolute index | -1. Native byte
// search backing buf.indexOf / lastIndexOf / includes for large buffers, using
// core:bytes' Rabin-Karp instead of the JS O(n*m) double loop. The JS layer keeps
// Node's empty-needle and offset-clamping semantics and only calls here for a
// non-empty needle; `start` is the first index to consider (forward) or the
// highest index a match may start at (backward). Views are read in place.
buffer_index_of_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 4 do return js_int_value(ctx, -1)
	// js_int_arg can run JS (valueOf) — read it before borrowing the views; see
	// the note in buffer_utf16le_write_into_cb.
	start := js_int_arg(ctx, arguments[2])
	forward := jsc.JSValueToBoolean(ctx, arguments[3])
	hay, hok := typed_array_view(ctx, arguments[0])
	needle, nok := typed_array_view(ctx, arguments[1])
	if !hok || !nok do return js_int_value(ctx, -1)
	nlen := len(needle)
	hlen := len(hay)
	if nlen == 0 || nlen > hlen do return js_int_value(ctx, -1)
	if forward {
		s := start
		if s < 0 do s = 0
		if s > hlen do return js_int_value(ctx, -1)
		idx := bytes.index(hay[s:], needle)
		if idx < 0 do return js_int_value(ctx, -1)
		return js_int_value(ctx, s + idx)
	}
	// Backward: search the window [0, start+nlen) so the last match within it
	// starts at the largest k <= start. bytes.last_index returns an absolute index
	// (the window begins at 0) or -1.
	end := start + nlen
	if end > hlen do end = hlen
	if end < nlen do return js_int_value(ctx, -1)
	return js_int_value(ctx, bytes.last_index(hay[:end], needle))
}

// latin1Encode(string) -> Uint8Array. One output byte per UTF-16 code unit,
// low 8 bits only — Node's Buffer.from(str, 'latin1') / 'ascii' (encode side).
buffer_latin1_encode_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 do return make_uint8_array(ctx, nil)

	r := read_string_arg(ctx, arguments[0])
	if !r.ok do return make_uint8_array(ctx, nil)
	defer if r.str != nil do jsc.JSStringRelease(r.str)
	// 8-bit storage IS the latin1 byte sequence — one copy, no widen; 16-bit
	// units are masked to their low byte.
	if r.is8 {
		if len(r.s8) == 0 do return make_uint8_array(ctx, nil)
		out := make([]byte, len(r.s8), context.allocator)
		copy(out, r.s8)
		return make_uint8_array(ctx, out)
	}
	return latin1_bytes_from_units(ctx, r.s16)
}

@(private = "file")
latin1_bytes_from_units :: proc(ctx: jsc.JSContextRef, chars: []jsc.JSChar) -> jsc.JSValueRef {
	if len(chars) == 0 do return make_uint8_array(ctx, nil)
	out := make([]byte, len(chars), context.allocator)
	for u, i in chars {
		out[i] = byte(u & 0xFF)
	}
	return make_uint8_array(ctx, out)
}

// latin1_string_from_bytes builds a JS string where each input byte becomes one
// code point U+0000..U+00FF (ISO-8859-1 / Node 'latin1'). Latin-1 bytes ARE
// 8-bit StringImpl content, so the fast path is a single copy into the result
// string's storage — NULs and high bytes included, no scan. Fallback: pure
// ASCII without NULs takes the dense 8-bit StringImpl path (UTF-8 create);
// anything else goes through CreateWithCharacters so bytes are preserved.
// Shared with the node:http request parser (header name/value/method/url).
latin1_string_from_bytes :: proc(ctx: jsc.JSContextRef, data: []byte) -> jsc.JSValueRef {
	if len(data) == 0 do return js_string_value(ctx, "")
	if str, dst, ok := jsc.string_alloc8(len(data)); ok {
		copy(dst, data)
		defer jsc.JSStringRelease(str)
		return jsc.JSValueMakeString(ctx, str)
	}
	if bytes_all_ascii_no_nul(data) {
		tmp := make([]byte, len(data) + 1, context.temp_allocator)
		copy(tmp, data)
		tmp[len(data)] = 0
		return ascii_string_value(ctx, tmp)
	}
	units := make([]jsc.JSChar, len(data), context.temp_allocator)
	for i in 0 ..< len(data) do units[i] = jsc.JSChar(data[i])
	js_str := jsc.JSStringCreateWithCharacters(raw_data(units), c.size_t(len(data)))
	defer jsc.JSStringRelease(js_str)
	return jsc.JSValueMakeString(ctx, js_str)
}

// latin1Decode(u8) -> string. Buffer.toString('latin1') / 'binary'.
buffer_latin1_decode_cb :: proc "c" (
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
	return latin1_string_from_bytes(ctx, data)
}

// asciiDecode(u8) -> string. Buffer.toString('ascii'): each byte masked to 7 bits.
// After the mask the alphabet is pure ASCII (possibly with NULs); reuse the
// latin1 builder so NUL/dense-ASCII paths stay correct.
buffer_ascii_decode_cb :: proc "c" (
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

	// Mask in a temp only when a high bit is present; otherwise latin1 path is
	// identical and avoids an extra pass + allocation.
	needs_mask := false
	for b in data {
		if b >= 0x80 {
			needs_mask = true
			break
		}
	}
	if !needs_mask do return latin1_string_from_bytes(ctx, data)

	masked := make([]byte, len(data), context.temp_allocator)
	for b, i in data do masked[i] = b & 0x7F
	return latin1_string_from_bytes(ctx, masked)
}

// utf16leEncode(string) -> Uint8Array. Two LE bytes per UTF-16 code unit
// (surrogates preserved as-is), matching Buffer.from(str, 'utf16le').
buffer_utf16le_encode_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 do return make_uint8_array(ctx, nil)

	r := read_string_arg(ctx, arguments[0])
	if !r.ok do return make_uint8_array(ctx, nil)
	defer if r.str != nil do jsc.JSStringRelease(r.str)
	if r.is8 {
		// 8-bit storage: each unit is a byte, high byte always 0 — no widen pass.
		if len(r.s8) == 0 do return make_uint8_array(ctx, nil)
		out := make([]byte, len(r.s8) * 2, context.allocator)
		for b, i in r.s8 {
			out[i * 2] = b
			out[i * 2 + 1] = 0
		}
		return make_uint8_array(ctx, out)
	}
	return utf16le_bytes_from_units(ctx, r.s16)
}

@(private = "file")
utf16le_bytes_from_units :: proc(ctx: jsc.JSContextRef, chars: []jsc.JSChar) -> jsc.JSValueRef {
	if len(chars) == 0 do return make_uint8_array(ctx, nil)
	out := make([]byte, len(chars) * 2, context.allocator)
	when ODIN_ENDIAN == .Little {
		mem.copy(raw_data(out), raw_data(chars), len(out))
	} else {
		for u, i in chars {
			out[i * 2] = byte(u & 0xFF)
			out[i * 2 + 1] = byte(u >> 8)
		}
	}
	return make_uint8_array(ctx, out)
}

// utf16leDecode(u8) -> string. Pairs of little-endian bytes become UTF-16 units;
// a trailing odd byte is ignored (Node). Built via CreateWithCharacters so
// unpaired surrogates and NULs are preserved.
buffer_utf16le_decode_cb :: proc "c" (
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
	if !ok || len(data) < 2 do return js_string_value(ctx, "")

	n := len(data) / 2
	if str, dst, ok16 := jsc.string_alloc16(n); ok16 {
		utf16le_units_write(dst, data)
		defer jsc.JSStringRelease(str)
		return jsc.JSValueMakeString(ctx, str)
	}
	units := make([]jsc.JSChar, n, context.temp_allocator)
	utf16le_units_write(units, data)
	js_str := jsc.JSStringCreateWithCharacters(raw_data(units), c.size_t(n))
	defer jsc.JSStringRelease(js_str)
	return jsc.JSValueMakeString(ctx, js_str)
}

// utf16le_units_write combines little-endian byte pairs into dst's len(dst)
// UTF-16 code units — on a little-endian host that byte layout IS the u16
// array, so it's a single copy.
@(private = "file")
utf16le_units_write :: proc(dst: []jsc.JSChar, data: []byte) {
	when ODIN_ENDIAN == .Little {
		mem.copy(raw_data(dst), raw_data(data), len(dst) * 2)
	} else {
		for i in 0 ..< len(dst) {
			dst[i] = jsc.JSChar(data[i * 2]) | (jsc.JSChar(data[i * 2 + 1]) << 8)
		}
	}
}

// utf16leWriteInto(target, string, offset, maxLength) -> bytesWritten. Writes
// LE code units into the caller's buffer; maxLength is in bytes and floored to
// an even count (Node never writes a half unit).
buffer_utf16le_write_into_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 4 do return jsc.JSValueMakeNumber(ctx, 0)
	// Argument-read order is load-bearing: read_string_arg / js_int_arg can run
	// arbitrary JS (toString/valueOf on a non-primitive), which may detach or
	// resize the target's ArrayBuffer. The borrowed target view must therefore be
	// acquired LAST, with no JS-reachable call between it and the write. (String
	// borrows are immune: string storage is immutable and pinned by the retained
	// ref / the live argument.)
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
	// Even byte count only — half a code unit is never written.
	max = max - (max % 2)
	if max <= 0 do return js_int_value(ctx, 0)

	n_units := max / 2
	if n_units > slen do n_units = slen
	dst := target[offset:]
	if src.is8 {
		for i in 0 ..< n_units {
			dst[i * 2] = src.s8[i]
			dst[i * 2 + 1] = 0
		}
	} else {
		when ODIN_ENDIAN == .Little {
			mem.copy(raw_data(dst), raw_data(src.s16), n_units * 2)
		} else {
			for i in 0 ..< n_units {
				u := src.s16[i]
				dst[i * 2] = byte(u & 0xFF)
				dst[i * 2 + 1] = byte(u >> 8)
			}
		}
	}
	return js_int_value(ctx, n_units * 2)
}

// latin1WriteInto(target, string, offset, maxLength) -> bytesWritten. Copies the
// low byte of each UTF-16 code unit of `string` into `target` at `offset`, up to
// maxLength / remaining space — the in-place form of latin1Encode used by
// Buffer.write('latin1'/'ascii') and node:http response-head serialization
// (writeLatin1Into / head coalesce). No intermediate Uint8Array.
buffer_latin1_write_into_cb :: proc "c" (
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
	// coercion — see the note in buffer_utf16le_write_into_cb.
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
	n := slen
	if n > max do n = max
	if n > avail do n = avail
	if n <= 0 do return js_int_value(ctx, 0)

	dst := target[offset:][:n]
	// 8-bit storage IS the latin1 byte sequence — straight copy.
	if src.is8 {
		copy(dst, src.s8)
	} else {
		for i in 0 ..< n {
			dst[i] = byte(src.s16[i] & 0xFF)
		}
	}
	return js_int_value(ctx, n)
}

// utf8WriteInto(target, string, offset, maxLength) -> bytesWritten. Encodes the
// JS string's UTF-16 units straight into the caller's Buffer at offset — no
// intermediate owned string / Uint8Array. Truncation may cut mid-character at
// the maxLength / remaining-space boundary (Node parity); the JS layer sets
// maxLength so the returned count matches the prior strToBytes-then-copy path.
buffer_base64url_encode_cb :: proc "c" (
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

	// Unpadded: exact output length is known up front.
	n := len(data)
	rem := n % 3
	out_len := n / 3 * 4
	switch rem {
	case 1:
		out_len += 2
	case 2:
		out_len += 3
	}
	if str, dst, ok8 := jsc.string_alloc8(out_len); ok8 {
		base64url_write(dst, data)
		defer jsc.JSStringRelease(str)
		return jsc.JSValueMakeString(ctx, str)
	}
	out := make([]byte, out_len + 1, context.temp_allocator)
	base64url_write(out[:out_len], data)
	out[out_len] = 0
	return ascii_string_value(ctx, out)
}

buffer_base64_byte_length_cb :: proc "c" (
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
	len := string_read_len(src)
	if len == 0 do return js_int_value(ctx, 0)
	// Only the final two characters matter.
	if src.is8 {
		if src.s8[len - 1] == '=' {
			len -= 1
			if len > 0 && src.s8[len - 1] == '=' do len -= 1
		}
	} else {
		if src.s16[len - 1] == '=' {
			len -= 1
			if len > 0 && src.s16[len - 1] == '=' do len -= 1
		}
	}
	return js_int_value(ctx, (len * 3) >> 2)
}

buffer_swap_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 2 do return jsc.JSValueMakeUndefined(ctx)
	// js_int_arg can run JS (valueOf) — read it before borrowing the view; see
	// the note in buffer_utf16le_write_into_cb.
	width := js_int_arg(ctx, arguments[1])
	if width != 2 && width != 4 && width != 8 do return jsc.JSValueMakeUndefined(ctx)
	data, ok := typed_array_view(ctx, arguments[0])
	if !ok do return jsc.JSValueMakeUndefined(ctx)
	n := len(data)
	if n % width != 0 do return jsc.JSValueMakeUndefined(ctx)

	switch width {
	case 2:
		for i := 0; i < n; i += 2 {
			data[i], data[i + 1] = data[i + 1], data[i]
		}
	case 4:
		for i := 0; i < n; i += 4 {
			data[i], data[i + 3] = data[i + 3], data[i]
			data[i + 1], data[i + 2] = data[i + 2], data[i + 1]
		}
	case 8:
		for i := 0; i < n; i += 8 {
			for j in 0 ..< 4 {
				data[i + j], data[i + 7 - j] = data[i + 7 - j], data[i + j]
			}
		}
	}
	return jsc.JSValueMakeUndefined(ctx)
}

make_buffer_bindings :: proc(ctx: jsc.JSContextRef) -> jsc.JSObjectRef {
	bindings := jsc.JSObjectMake(ctx, nil, nil)
	inject_native_function(ctx, bindings, "hexEncode", buffer_hex_encode_cb, buffer_hex_encode_host)
	inject_native_function(ctx, bindings, "hexDecode", buffer_hex_decode_cb, buffer_hex_decode_host)
	inject_native_function(ctx, bindings, "base64Encode", buffer_base64_encode_cb, buffer_base64_encode_host)
	inject_native_function(ctx, bindings, "base64Decode", buffer_base64_decode_cb, buffer_base64_decode_host)
	inject_native_function(ctx, bindings, "base64urlEncode", buffer_base64url_encode_cb, buffer_base64url_encode_host)
	inject_native_function(ctx, bindings, "utf8Encode", buffer_utf8_encode_cb, buffer_utf8_encode_host)
	inject_native_function(ctx, bindings, "utf8Decode", buffer_utf8_decode_cb, buffer_utf8_decode_host)
	inject_native_function(ctx, bindings, "latin1Encode", buffer_latin1_encode_cb, buffer_latin1_encode_host)
	inject_native_function(ctx, bindings, "latin1Decode", buffer_latin1_decode_cb, buffer_latin1_decode_host)
	inject_native_function(ctx, bindings, "asciiDecode", buffer_ascii_decode_cb, buffer_ascii_decode_host)
	inject_native_function(ctx, bindings, "latin1WriteInto", buffer_latin1_write_into_cb, buffer_latin1_write_into_host)
	inject_native_function(ctx, bindings, "utf16leEncode", buffer_utf16le_encode_cb, buffer_utf16le_encode_host)
	inject_native_function(ctx, bindings, "utf16leDecode", buffer_utf16le_decode_cb, buffer_utf16le_decode_host)
	inject_native_function(ctx, bindings, "utf16leWriteInto", buffer_utf16le_write_into_cb, buffer_utf16le_write_into_host)
	inject_native_function(ctx, bindings, "utf8WriteInto", buffer_utf8_write_into_cb, buffer_utf8_write_into_host)
	// Cold natives: generic host trampoline (no dedicated *_host wrapper).
	inject_native_function(ctx, bindings, "utf8ByteLength", buffer_utf8_byte_length_cb)
	inject_native_function(ctx, bindings, "base64ByteLength", buffer_base64_byte_length_cb)
	inject_native_function(ctx, bindings, "swapInPlace", buffer_swap_cb)
	inject_native_function(ctx, bindings, "allocUninit", buffer_alloc_uninit_cb)
	inject_native_function(ctx, bindings, "compare", buffer_compare_cb)
	inject_native_function(ctx, bindings, "indexOf", buffer_index_of_cb)
	inject_native_function(ctx, bindings, "isValidUtf8", buffer_is_valid_utf8_cb)
	set_named(ctx, bindings, "maxAllocBytes", jsc.JSValueMakeNumber(ctx, max_buffer_alloc_bytes()))
	return bindings
}
