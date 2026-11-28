// A Domain= attribute's host canonicalisation: Chrome runs it through its URL host
// canonicaliser (UTS-46, then RFC 3492 punycode), so `Domain=bücher.example` from
// `xn--bcher-kva.example` sets a domain cookie (recorded with a --host-resolver-rules
// probe, see psl_test.odin). The URL hosts the jar compares it with arrive already in
// that form from either stack's URL parser.
//
// Reuse (CLAUDE.md §2): core: has no IDNA or punycode (core:crypto/x509 compares
// A-labels as given), vendor: none; the runtime's internal/punycode.js and idna.js are
// JS, and this package serves pkg/http, which has none. libidn2 is on the box only as a
// runtime library (no headers or link name), so linking it is a new dependency for one
// cold attribute. RFC 3492's encoder is under a hundred lines; hand-rolled, step 6.
package larva_cookie

import "core:unicode"
import "core:unicode/utf8"

// The longest canonical Domain= domain_to_ascii writes, and the most code points in one
// label. Beyond either the attribute is refused: no DNS name is that long (253 bytes,
// 63 per label), so nothing it could name would domain-match a host anyway.
@(private)
MAX_ASCII_DOMAIN :: 1024
@(private = "file")
MAX_LABEL_RUNES :: 256

// domain_to_ascii returns `value` as an ASCII host: unchanged when it is ASCII already,
// otherwise each label lowercased (Unicode simple case mapping) and, when it is not
// ASCII, written as `xn--` + punycode into `buf`. The IDNA dot variants (U+3002,
// U+FF0E, U+FF61) separate labels as '.' does. ok is false for invalid UTF-8, a label
// past MAX_LABEL_RUNES, or a result that does not fit `buf`.
//
// Deviates:
//   UTS-46 maps more than case (compatibility forms, NFC, ignored code points); those
//   inputs encode to an A-label no URL host carries, so the cookie is refused where
//   Chrome might store it — the safe direction. Pinned by psl_test.odin.
@(private)
domain_to_ascii :: proc(value: string, buf: []u8) -> (ascii: string, ok: bool) {
	ascii_only := true

	for i in 0 ..< len(value) {
		if value[i] >= 0x80 {
			ascii_only = false
			break
		}
	}

	if ascii_only {
		return value, true
	}

	runes: [MAX_LABEL_RUNES]rune
	n := 0
	w := 0
	non_ascii := false
	rest := value

	for {
		r := rune('.')
		size := 0
		at_end := rest == ""

		if !at_end {
			r, size = utf8.decode_rune_in_string(rest)

			if r == utf8.RUNE_ERROR && size <= 1 {
				return "", false
			}

			rest = rest[size:]
		}

		if r == 0x3002 || r == 0xFF0E || r == 0xFF61 {
			r = '.'
		}

		if r != '.' {
			if n == len(runes) {
				return "", false
			}

			runes[n] = unicode.to_lower(r)
			non_ascii ||= runes[n] >= 0x80
			n += 1
			continue
		}

		// One label ends: copy it as ASCII, or encode it.
		if non_ascii {
			if len(buf) - w < 4 {
				return "", false
			}

			copy(buf[w:], "xn--")
			written, encoded := punycode_encode(runes[:n], buf[w + 4:])

			if !encoded {
				return "", false
			}

			w += 4 + written
		} else {
			if len(buf) - w < n {
				return "", false
			}

			for i in 0 ..< n {
				buf[w + i] = u8(runes[i])
			}

			w += n
		}

		if at_end {
			break
		}

		if w == len(buf) {
			return "", false
		}

		buf[w] = '.'
		w += 1
		n = 0
		non_ascii = false
	}

	return string(buf[:w]), true
}

// punycode_encode is RFC 3492 §6.3 over one label's code points, writing the basic
// code points, a '-' when there were any, then the deltas. Returns the bytes written;
// ok false on overflow of `out` or of the delta arithmetic.
@(private)
punycode_encode :: proc(input: []rune, out: []u8) -> (written: int, ok: bool) {
	BASE :: 36
	T_MIN :: 1
	T_MAX :: 26
	INITIAL_N :: 128
	INITIAL_BIAS :: 72

	w := 0

	for r in input {
		if r < 0x80 {
			if w == len(out) {
				return 0, false
			}

			out[w] = u8(r)
			w += 1
		}
	}

	basic := w
	handled := basic

	if basic > 0 {
		if w == len(out) {
			return 0, false
		}

		out[w] = '-'
		w += 1
	}

	n := INITIAL_N
	delta := 0
	bias := INITIAL_BIAS

	for handled < len(input) {
		m := max(int)
		for r in input {
			if int(r) >= n && int(r) < m {
				m = int(r)
			}
		}

		if m - n > (max(int) - delta) / (handled + 1) {
			return 0, false
		}

		delta += (m - n) * (handled + 1)
		n = m

		for r in input {
			if int(r) < n {
				delta += 1

				if delta == max(int) {
					return 0, false
				}
			}

			if int(r) != n {
				continue
			}

			q := delta
			for k := BASE;; k += BASE {
				t := T_MIN if k <= bias else (T_MAX if k >= bias + T_MAX else k - bias)

				if q < t {
					break
				}

				if w == len(out) {
					return 0, false
				}

				out[w] = punycode_digit(t + (q - t) % (BASE - t))
				w += 1
				q = (q - t) / (BASE - t)
			}

			if w == len(out) {
				return 0, false
			}

			out[w] = punycode_digit(q)
			w += 1
			bias = punycode_adapt(delta, handled + 1, handled == basic)
			delta = 0
			handled += 1
		}

		delta += 1
		n += 1
	}

	return w, true
}

@(private = "file")
punycode_digit :: proc(d: int) -> u8 {
	return u8('a' + d) if d < 26 else u8('0' + d - 26)
}

// punycode_adapt is RFC 3492 §6.1's bias adaptation.
@(private = "file")
punycode_adapt :: proc(delta, num_points: int, first: bool) -> int {
	BASE :: 36
	T_MIN :: 1
	T_MAX :: 26
	SKEW :: 38
	DAMP :: 700

	d := delta / DAMP if first else delta / 2
	d += d / num_points
	k := 0

	for d > ((BASE - T_MIN) * T_MAX) / 2 {
		d /= BASE - T_MIN
		k += BASE
	}

	return k + (BASE - T_MIN + 1) * d / (d + SKEW)
}
