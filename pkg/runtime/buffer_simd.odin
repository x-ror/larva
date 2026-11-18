package lava_runtime

import "base:intrinsics"
import "core:simd"

// SIMD/scalar byte-transform layer for the node:buffer codecs: the pure hex and
// base64 encode/decode kernels plus their lookup tables, with no JSC or callback
// dependencies. The codec callbacks (buffer.odin) borrow the input bytes, call
// these to fill an output buffer, and wrap the result as a JS string / typed
// array. Package-visible (not file-private) so those callbacks can reach them.

// Codec lookup tables. Encoders index the alphabet strings directly; the decode
// tables map a byte to its value, 0xFF = not in the alphabet.
@(private)
HEX_DIGITS := "0123456789abcdef"
@(private)
B64_ALPHABET := "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
@(private)
B64URL_ALPHABET := "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
@(private)
g_hex_val: [256]u8
@(private)
g_b64_val: [256]u8

@(init, private)
buffer_codec_tables_init :: proc "contextless" () {
	for i in 0 ..< 256 {
		g_hex_val[i] = 0xFF
		g_b64_val[i] = 0xFF
	}
	for ch, v in "0123456789" do g_hex_val[ch] = u8(v)
	for ch, v in "abcdef" do g_hex_val[ch] = u8(v) + 10
	for ch, v in "ABCDEF" do g_hex_val[ch] = u8(v) + 10
	for ch, v in B64_ALPHABET do g_b64_val[ch] = u8(v)
}

@(private)
U8x16 :: #simd[16]u8
@(private)
U8x8 :: #simd[8]u8

// hex_write encodes 16 input bytes per step: split nibbles, add '0' plus a
// branchless +39 ('a'-'0'-10) for values above 9, and interleave hi/lo digits
// with two static shuffles. Scalar LUT tail for the remainder.
@(private)
hex_write :: proc(dst: []byte, src: []byte) {
	i := 0
	for ; i + 16 <= len(src); i += 16 {
		v := intrinsics.unaligned_load((^U8x16)(raw_data(src[i:])))
		lo := v & cast(U8x16)u8(0x0F)
		hi := simd.shr(v, cast(U8x16)u8(4))
		nine := cast(U8x16)u8(9)
		gap := cast(U8x16)u8(39)
		zero_ch := cast(U8x16)u8('0')
		d_hi := hi + zero_ch + (transmute(U8x16)simd.lanes_gt(hi, nine) & gap)
		d_lo := lo + zero_ch + (transmute(U8x16)simd.lanes_gt(lo, nine) & gap)
		out0 := simd.shuffle(d_hi, d_lo, 0, 16, 1, 17, 2, 18, 3, 19, 4, 20, 5, 21, 6, 22, 7, 23)
		out1 := simd.shuffle(d_hi, d_lo, 8, 24, 9, 25, 10, 26, 11, 27, 12, 28, 13, 29, 14, 30, 15, 31)
		intrinsics.unaligned_store((^U8x16)(raw_data(dst[i * 2:])), out0)
		intrinsics.unaligned_store((^U8x16)(raw_data(dst[i * 2 + 16:])), out1)
	}
	for ; i < len(src); i += 1 {
		b := src[i]
		dst[i * 2] = HEX_DIGITS[b >> 4]
		dst[i * 2 + 1] = HEX_DIGITS[b & 0x0F]
	}
}

// hex_parse_into decodes leading valid hex pairs into out, returning the pair
// count (Node stops at the first invalid pair). Generic over the string's
// storage width; 8-bit input validates and converts 16 chars -> 8 bytes per
// step (any invalid lane defers the rest to the exact scalar loop).
@(private)
hex_parse_into :: proc(out: []byte, chars: []$T) -> int {
	pairs := len(chars) / 2
	i := 0
	when size_of(T) == 1 {
		for ; i * 2 + 16 <= len(chars); i += 8 {
			v := intrinsics.unaligned_load((^U8x16)(raw_data(chars[i * 2:])))
			vd := v - cast(U8x16)u8('0')
			is_digit := transmute(U8x16)simd.lanes_lt(vd, cast(U8x16)u8(10))
			va := (v | cast(U8x16)u8(0x20)) - cast(U8x16)u8('a')
			is_alpha := transmute(U8x16)simd.lanes_lt(va, cast(U8x16)u8(6))
			if simd.reduce_and(is_digit | is_alpha) != 0xFF do break
			vals := (is_digit & vd) | (is_alpha & (va + cast(U8x16)u8(10)))
			ev := simd.shuffle(vals, vals, 0, 2, 4, 6, 8, 10, 12, 14)
			od := simd.shuffle(vals, vals, 1, 3, 5, 7, 9, 11, 13, 15)
			b := simd.shl(ev, cast(U8x8)u8(4)) | od
			intrinsics.unaligned_store((^U8x8)(raw_data(out[i:])), b)
		}
	}
	for ; i < pairs; i += 1 {
		c0 := chars[i * 2]
		c1 := chars[i * 2 + 1]
		when size_of(T) > 1 {
			if c0 >= 256 || c1 >= 256 do return i
		}
		d0 := g_hex_val[c0]
		d1 := g_hex_val[c1]
		if d0 == 0xFF || d1 == 0xFF do return i
		out[i] = d0 << 4 | d1
	}
	return pairs
}

// base64_simd_groups encodes four 3-byte groups -> 16 chars per step while a
// full 16-byte load is in bounds, returning how much of src/dst it consumed;
// the callers' scalar loops finish the remainder (including padding). The
// 3-byte groups are rearranged into u16 lanes with a static shuffle, sextets
// extracted with per-lane masked shifts (Muła's SSE base64 layout), and mapped
// to ASCII with branchless range offsets: +'A', +6 above 25, -75 above 51,
// then the two alphabet-specific tail constants for indices 62/63.
@(private)
base64_simd_groups :: proc(dst: []byte, src: []byte, sub61: u8, add62: u8) -> (i: int, di: int) {
	for ; i + 16 <= len(src); i += 12 {
		v := intrinsics.unaligned_load((^U8x16)(raw_data(src[i:])))
		g := simd.shuffle(v, v, 1, 0, 2, 1, 4, 3, 5, 4, 7, 6, 8, 7, 10, 9, 11, 10)
		g16 := transmute(#simd[8]u16)g
		t1 := simd.shr(
			g16 & #simd[8]u16{0xFC00, 0x0FC0, 0xFC00, 0x0FC0, 0xFC00, 0x0FC0, 0xFC00, 0x0FC0},
			#simd[8]u16{10, 6, 10, 6, 10, 6, 10, 6},
		)
		t3 := simd.shl(
			g16 & #simd[8]u16{0x03F0, 0x003F, 0x03F0, 0x003F, 0x03F0, 0x003F, 0x03F0, 0x003F},
			#simd[8]u16{4, 8, 4, 8, 4, 8, 4, 8},
		)
		sx := transmute(U8x16)(t1 | t3)
		c := sx + cast(U8x16)u8('A')
		c += transmute(U8x16)simd.lanes_gt(sx, cast(U8x16)u8(25)) & cast(U8x16)u8(6)
		c -= transmute(U8x16)simd.lanes_gt(sx, cast(U8x16)u8(51)) & cast(U8x16)u8(75)
		c -= transmute(U8x16)simd.lanes_gt(sx, cast(U8x16)u8(61)) & cast(U8x16)u8(sub61)
		c += transmute(U8x16)simd.lanes_gt(sx, cast(U8x16)u8(62)) & cast(U8x16)u8(add62)
		intrinsics.unaligned_store((^U8x16)(raw_data(dst[di:])), c)
		di += 16
	}
	return
}

// base64_write_impl fills dst from src using `alphabet` (standard or url-safe)
// and, if `padded`, appends '=' for the final partial group. base64_simd_groups
// handles the full 3->4 groups (alphabet chosen by its 62/63 tail params); this
// finishes the scalar remainder. base64_write / base64url_write specialize it.
@(private)
base64_write_impl :: proc(dst: []byte, src: []byte, alphabet: string, sub61: u8, add62: u8, padded: bool) {
	n := len(src)
	i, di := base64_simd_groups(dst, src, sub61, add62)
	for ; i + 2 < n; i += 3 {
		v := u32(src[i]) << 16 | u32(src[i + 1]) << 8 | u32(src[i + 2])
		dst[di] = alphabet[v >> 18]
		dst[di + 1] = alphabet[v >> 12 & 0x3F]
		dst[di + 2] = alphabet[v >> 6 & 0x3F]
		dst[di + 3] = alphabet[v & 0x3F]
		di += 4
	}
	switch n - i {
	case 1:
		v := u32(src[i]) << 16
		dst[di] = alphabet[v >> 18]
		dst[di + 1] = alphabet[v >> 12 & 0x3F]
		if padded {
			dst[di + 2] = '='
			dst[di + 3] = '='
		}
	case 2:
		v := u32(src[i]) << 16 | u32(src[i + 1]) << 8
		dst[di] = alphabet[v >> 18]
		dst[di + 1] = alphabet[v >> 12 & 0x3F]
		dst[di + 2] = alphabet[v >> 6 & 0x3F]
		if padded do dst[di + 3] = '='
	}
}

// base64_write: standard alphabet, padded (Buffer.toString('base64')).
@(private)
base64_write :: proc(dst: []byte, src: []byte) {
	base64_write_impl(dst, src, B64_ALPHABET, 15, 3, true)
}

// base64url_write: url-safe alphabet, unpadded (Buffer.toString('base64url')).
@(private)
base64url_write :: proc(dst: []byte, src: []byte) {
	base64_write_impl(dst, src, B64URL_ALPHABET, 13, 49, false)
}

// base64_parse decodes clean, padded standard base64 into out (len(chars)/4*3
// capacity), returning bytes written. Padding is only legal in the final group,
// and '=' before a non-'=' is malformed ("x=y="); both fail closed like
// core:encoding/base64 did. Generic over string storage width.
@(private)
base64_parse :: proc(out: []byte, chars: []$T) -> (n: int, ok: bool) {
	groups := len(chars) / 4
	for g in 0 ..< groups {
		s := chars[g * 4:g * 4 + 4]
		when size_of(T) > 1 {
			if s[0] >= 256 || s[1] >= 256 || s[2] >= 256 || s[3] >= 256 do return 0, false
		}
		d0 := g_b64_val[s[0]]
		d1 := g_b64_val[s[1]]
		pad2 := s[2] == '='
		pad3 := s[3] == '='
		d2 := pad2 ? 0 : g_b64_val[s[2]]
		d3 := pad3 ? 0 : g_b64_val[s[3]]
		if d0 == 0xFF ||
		   d1 == 0xFF ||
		   d2 == 0xFF ||
		   d3 == 0xFF ||
		   (pad2 && !pad3) ||
		   ((pad2 || pad3) && g != groups - 1) {
			return 0, false
		}
		v := u32(d0) << 18 | u32(d1) << 12 | u32(d2) << 6 | u32(d3)
		out[n] = byte(v >> 16)
		n += 1
		if !pad2 && !pad3 {
			out[n] = byte(v >> 8)
			out[n + 1] = byte(v)
			n += 2
		} else if !pad2 {
			out[n] = byte(v >> 8)
			n += 1
		}
	}
	return n, true
}
