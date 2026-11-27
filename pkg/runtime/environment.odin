package lava_runtime

import "core:strings"
import jsc "lava:pkg/jsc"
import eventloop "lava:pkg/runtime/eventloop"

// setup_page_environment installs the Window globals on a fresh page context: the
// timers, console, queueMicrotask, performance and every Web API global the module
// loader instantiates (install_globals). The page's script runs next; nothing it can
// name is Node's — no `require`, `module`, `process` or `Buffer` (docs/LARVA.md
// decision 1). The pointer to the event loop lives in the global object's private
// data, not in JS.
setup_page_environment :: proc(ctx: jsc.JSContextRef, loop: ^eventloop.Loop) {
	install_globals(ctx, loop)
}

js_string_value :: proc(ctx: jsc.JSContextRef, value: string) -> jsc.JSValueRef {
	// NUL-free ASCII (the overwhelming bridge case: property names, headers,
	// paths) is copied straight into 8-bit string storage with no UTF-8
	// validation pass. NULs stay excluded so the fast path can never differ from
	// the fallback's documented truncate-at-NUL behavior.
	if len(value) > 0 && bytes_all_ascii_no_nul(transmute([]byte)value) {
		if str, dst, ok := jsc.string_alloc8(len(value)); ok {
			copy(dst, value)
			defer jsc.JSStringRelease(str)
			return jsc.JSValueMakeString(ctx, str)
		}
	}

	c_value, err := strings.clone_to_cstring(value, context.temp_allocator)

	if err != nil {
		return jsc.JSValueMakeUndefined(ctx)
	}

	js_str := jsc.JSStringCreateWithUTF8CString(c_value)
	defer jsc.JSStringRelease(js_str)

	return jsc.JSValueMakeString(ctx, js_str)
}

// --- JS string → owned UTF-8 (exact size) ------------------------------------
// Pure codecs live in pkg/jsc/string_utf8.odin; these wrappers allocate.

js_string_ref_to_utf8_owned :: proc(js_string: jsc.JSStringRef) -> (string, bool) {
	if js_string == nil {
		return "", false
	}

	length := int(jsc.JSStringGetLength(js_string))

	if length == 0 {
		return "", false
	}

	// 8-bit storage read directly (GetCharactersPtr would widen the whole string
	// to UTF-16 first).
	if s8, ok8 := jsc.string_chars8(js_string); ok8 {
		return latin1_to_utf8_owned(s8)
	}

	chars := jsc.JSStringGetCharactersPtr(js_string)

	if chars == nil {
		return "", false
	}

	return utf16_to_utf8_owned(chars, length)
}

// latin1_to_utf8_owned copies 8-bit string storage into an owned exact-size
// UTF-8 buffer: ASCII verbatim, Latin-1 high bytes as two UTF-8 bytes each.
@(private = "file")
latin1_to_utf8_owned :: proc(s8: []byte) -> (string, bool) {
	if bytes_all_ascii(s8) {
		buffer := make([]byte, len(s8), context.allocator)
		copy(buffer, s8)
		return string(buffer), true
	}

	n := len(s8)
	for b in s8 {
		if b >= 0x80 {
			n += 1
		}
	}
	buffer := make([]byte, n, context.allocator)
	o := 0
	for b in s8 {
		if b < 0x80 {
			buffer[o] = b
			o += 1
		} else {
			buffer[o] = 0xC0 | (b >> 6)
			buffer[o + 1] = 0x80 | (b & 0x3F)
			o += 2
		}
	}
	return string(buffer), true
}

@(private = "file")
utf16_to_utf8_owned :: proc(chars: [^]jsc.JSChar, length: int) -> (string, bool) {
	// Fast path: pure ASCII (paths, headers, small identifiers). Exact-size copy.
	ascii := true
	for i in 0 ..< length {
		if chars[i] >= 0x80 {
			ascii = false
			break
		}
	}

	if ascii {
		buffer := make([]byte, length, context.allocator)
		for i in 0 ..< length {
			buffer[i] = byte(chars[i])
		}
		return string(buffer), true
	}

	n := jsc.utf16_js_utf8_byte_len(chars, length)

	if n <= 0 {
		return "", false
	}

	buffer := make([]byte, n, context.allocator)
	// Exact-size buffer: the capped writer never truncates here (need always
	// fits), so it yields the same bytes as an uncapped encode.
	written := jsc.utf16_js_to_utf8_capped(chars, length, buffer)

	if written != n {
		delete(buffer, context.allocator)
		return "", false
	}

	return string(buffer), true
}

// jsc_value_to_string_or_default converts a JS value to an owned UTF-8 Odin string
// (caller's allocator). Returns ("", false) for empty / non-convertible values —
// callers treat false as "empty string, no free". Exact UTF-8 size (no 3n+1).
jsc_value_to_string_or_default :: proc(ctx: jsc.JSContextRef, value: jsc.JSValueRef) -> (string, bool) {
	// Flat string values resolve with no C-API call; everything else (ropes,
	// non-strings needing coercion) goes through JSValueToStringCopy.
	if s8, ok := jsc.value_chars8(ctx, value); ok {
		if len(s8) == 0 {
			return "", false
		}

		return latin1_to_utf8_owned(s8)
	}

	if s16, ok := jsc.value_chars16(ctx, value); ok {
		if len(s16) == 0 {
			return "", false
		}

		return utf16_to_utf8_owned(raw_data(s16), len(s16))
	}

	js_string := jsc.JSValueToStringCopy(ctx, value, nil)

	if js_string == nil {
		return "", false
	}

	defer jsc.JSStringRelease(js_string)
	return js_string_ref_to_utf8_owned(js_string)
}
