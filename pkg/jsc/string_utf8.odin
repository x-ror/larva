package jsc

// Exact-size UTF-16 → UTF-8 for JS string handoff (Node Buffer.from utf8 parity:
// unpaired surrogates → U+FFFD). Contextless pure codecs; owned alloc wrappers
// stay in the runtime and call these.

utf16_js_utf8_byte_len :: proc "contextless" (chars: [^]JSChar, n: int) -> int {
	total := 0
	i := 0
	for i < n {
		u := u32(chars[i])

		if u < 0x80 {
			total += 1
			i += 1
		} else if u < 0x800 {
			total += 2
			i += 1
		} else if u >= 0xD800 && u <= 0xDBFF {
			// High surrogate: pair with a following low, else U+FFFD (3 bytes).
			if i + 1 < n {
				lo := u32(chars[i + 1])

				if lo >= 0xDC00 && lo <= 0xDFFF {
					total += 4 // astral scalar
					i += 2
					continue
				}
			}

			total += 3 // unpaired → U+FFFD
			i += 1
		} else if u >= 0xDC00 && u <= 0xDFFF {
			total += 3 // unpaired low → U+FFFD
			i += 1
		} else {
			total += 3 // BMP non-surrogate
			i += 1
		}
	}
	return total
}

// utf16_js_to_utf8_capped encodes into `out` stopping before exceeding len(out).
// May truncate mid-character at the boundary (Node Buffer.write utf8 behavior).
// Returns bytes written.
utf16_js_to_utf8_capped :: proc "contextless" (chars: [^]JSChar, n: int, out: []byte) -> int {
	cap := len(out)
	o := 0
	i := 0
	for i < n {
		u := u32(chars[i])
		need: int

		// Pre-compute how many bytes this unit (or pair) wants.
		if u < 0x80 {
			need = 1
		} else if u < 0x800 {
			need = 2
		} else if u >= 0xD800 && u <= 0xDBFF {
			if i + 1 < n {
				lo := u32(chars[i + 1])

				if lo >= 0xDC00 && lo <= 0xDFFF {
					need = 4
				} else {
					need = 3
				}
			} else {
				need = 3
			}
		} else if u >= 0xDC00 && u <= 0xDFFF {
			need = 3
		} else {
			need = 3
		}

		if o + need > cap {
			break
		}

		// Encode one scalar / replacement using the uncapped helper on a 4-byte window.
		// Advance i by the whole (paired) code point.
		if u < 0x80 {
			out[o] = byte(u)
			o += 1
			i += 1
		} else if u < 0x800 {
			out[o] = byte(0xC0 | (u >> 6))
			out[o + 1] = byte(0x80 | (u & 0x3F))
			o += 2
			i += 1
		} else if u >= 0xD800 && u <= 0xDBFF {
			if i + 1 < n {
				lo := u32(chars[i + 1])

				if lo >= 0xDC00 && lo <= 0xDFFF {
					cp := 0x10000 + ((u - 0xD800) << 10) + (lo - 0xDC00)
					out[o] = byte(0xF0 | (cp >> 18))
					out[o + 1] = byte(0x80 | ((cp >> 12) & 0x3F))
					out[o + 2] = byte(0x80 | ((cp >> 6) & 0x3F))
					out[o + 3] = byte(0x80 | (cp & 0x3F))
					o += 4
					i += 2
					continue
				}
			}

			out[o] = 0xEF
			out[o + 1] = 0xBF
			out[o + 2] = 0xBD
			o += 3
			i += 1
		} else if u >= 0xDC00 && u <= 0xDFFF {
			out[o] = 0xEF
			out[o + 1] = 0xBF
			out[o + 2] = 0xBD
			o += 3
			i += 1
		} else {
			out[o] = byte(0xE0 | (u >> 12))
			out[o + 1] = byte(0x80 | ((u >> 6) & 0x3F))
			out[o + 2] = byte(0x80 | (u & 0x3F))
			o += 3
			i += 1
		}
	}
	return o
}

// js_string_ref_to_utf8_owned copies a JSStringRef into an owned exact-size UTF-8
// buffer (context.allocator). Returns ("", false) for empty strings (nothing to
// free). Does not Release the JSStringRef — the caller owns that lifetime.
