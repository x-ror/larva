package larva_html

import "core:bytes"
import "core:encoding/endian"

// Where to cut the input before handing it to lexbor.
//
// The parser pauses at a script by never letting a slice run past a script's end tag:
// each slice ends right after the `>` of the next `</script` end tag, so when lexbor
// reports that it closed a script (the shim's hook), nothing after the script has been
// parsed. Whether a candidate really closes a script is lexbor's call — this only
// places the cuts, and a cut in the wrong place costs nothing but an extra call.
//
// The scan is resumable: a Source remembers how far it has looked, so input that
// arrives in many small pieces is scanned once, not once per piece.

// SCRIPT_END_TAG is what an end tag that can close a script starts with; it is
// matched ASCII case-insensitively, as the tokenizer does.
@(private = "file")
SCRIPT_END_TAG :: "</script"

// END_TAG_MAX bounds how many bytes of one unterminated `</script…` candidate are held
// back waiting for its `>`. A real end tag is a few bytes long (attributes on an end
// tag are a parse error and carry nothing); past this, the candidate is fed through as
// not being one. Without the bound, one stray `</script ` with no `>` after it would
// hold back the rest of the page. If it was a real end tag after all, the script then
// closes inside a larger slice and the hook counts it (see pump), so nothing is lost
// silently.
@(private = "file")
END_TAG_MAX :: 4096

// "</script" as a little-endian u64, and the mask that folds the six letters to lower
// case. `<` and `/` stay exact: OR-ing 0x20 into them would let 0x1C and 0x0F match. A
// byte ORed with 0x20 equals a lower-case letter only if it is that letter in either
// case, so the fold is ASCII-only, as the tokenizer's is.
@(private = "file")
SCRIPT_END_U64 ::
	u64('<') |
	u64('/') << 8 |
	u64('s') << 16 |
	u64('c') << 24 |
	u64('r') << 32 |
	u64('i') << 40 |
	u64('p') << 48 |
	u64('t') << 56
@(private = "file")
SCRIPT_END_FOLD :: u64(0x2020_2020_2020_0000)

@(private = "file")
Low_Byte_Set :: bit_set[byte(0) ..< 64;u64]
// The HTML spec's ASCII whitespace: tab, LF, FF, CR, space. core:strings.is_ascii_space
// also takes vertical tab, which HTML does not.
@(private = "file")
HTML_SPACE :: Low_Byte_Set{'\t', '\n', '\f', '\r', ' '}
// What may follow the tag name for `</script` to be the script end tag.
@(private = "file")
SCRIPT_END_TERM :: HTML_SPACE + {'/', '>'}

// Source is bytes waiting to be parsed: the network input, or text from
// document.write. Everything before `off` has been handed to lexbor.
@(private)
Source :: struct {
	buf:      [dynamic]byte,
	off:      int,
	// Resumable scan state, all absolute indices into buf.
	scan:     int, // the search for the next candidate resumes here
	tag:      int, // start of a candidate whose `>` is not found yet; -1 when none
	tag_pos:  int, // inside that candidate, the scan resumes here
	quote:    byte, // inside that candidate, the open quote of an attribute value
	after_eq: bool, // inside that candidate, an attribute value may start next
}

@(private = "file")
Match :: enum {
	No,
	Yes,
	Need_More, // `b` ends before it can be told
}

@(private)
source_init :: proc(s: ^Source, allocator := context.allocator) {
	s^ = {
		buf = make([dynamic]byte, allocator),
		tag = -1,
	}
}

@(private)
source_pending :: proc(s: ^Source) -> int {
	return len(s.buf) - s.off
}

// source_reset empties `s`, keeping its storage.
@(private)
source_reset :: proc(s: ^Source) {
	clear(&s.buf)
	s.off, s.scan, s.tag_pos, s.quote, s.after_eq = 0, 0, 0, 0, false
	s.tag = -1
}

// source_compact drops what lexbor has consumed once it is at least half the buffer,
// so the copy is amortized instead of paid on every piece of input.
@(private)
source_compact :: proc(s: ^Source) {
	if s.off == 0 || s.off * 2 < len(s.buf) {
		return
	}

	n := s.off
	remove_range(&s.buf, 0, n)
	s.off = 0
	s.scan = max(s.scan - n, 0)

	if s.tag >= 0 {
		s.tag -= n
		s.tag_pos -= n
	}
}

// next_cut returns how many bytes after `s.off` can be parsed now; 0 means wait for
// more input. `eof` says no more bytes will follow these in this source.
@(private)
next_cut :: proc(s: ^Source, eof: bool) -> int {
	end := len(s.buf)

	if s.tag < 0 {
		s.scan = max(s.scan, s.off)
		search: for s.scan < end {
			k := bytes.index_byte(s.buf[s.scan:], '<')

			if k < 0 {
				s.scan = end
				break
			}

			at := s.scan + k
			switch match_script_end(s.buf[at:]) {
			case .No:
				s.scan = at + 1
				continue
			case .Need_More:
				if eof {
					s.scan = end
					return end - s.off
				}

				s.scan = at
				return at - s.off
			case .Yes:
				s.tag = at
				s.tag_pos = at + len(SCRIPT_END_TAG)
				s.quote, s.after_eq = 0, false
				break search
			}
		}

		if s.tag < 0 {
			return end - s.off
		}
	}

	// Inside a candidate: find its `>`, skipping quoted attribute values, as the
	// tokenizer does in the attribute states of an end tag.
	for s.tag_pos < end {
		if s.quote != 0 {
			k := bytes.index_byte(s.buf[s.tag_pos:end], s.quote)

			if k < 0 {
				s.tag_pos = end
				break
			}

			s.tag_pos += k + 1
			s.quote = 0
			continue
		}

		b := s.buf[s.tag_pos]
		s.tag_pos += 1
		switch b {
		case '>':
			s.tag = -1
			s.scan = s.tag_pos
			return s.tag_pos - s.off
		case '"', '\'':
			if s.after_eq {
				s.quote = b
				s.after_eq = false
			}
		case '=':
			s.after_eq = true
		case '\t', '\n', '\f', '\r', ' ':
		// keeps after_eq: `a = "v"` is one attribute
		case:
			s.after_eq = false
		}
	}

	if eof || s.tag_pos - s.tag > END_TAG_MAX {
		s.tag = -1
		s.scan = end
		return end - s.off
	}

	return s.tag - s.off
}

// match_script_end says whether `b` starts with an end tag named "script": the
// characters of SCRIPT_END_TAG in any ASCII case, then whitespace, `/` or `>`. Anything
// else after the name (`</scripts>`) is a different tag. It runs at every `<` of a
// page, so the common case is one 8-byte compare.
@(private = "file")
match_script_end :: proc(b: []byte) -> Match {
	if len(b) > len(SCRIPT_END_TAG) {
		if endian.unchecked_get_u64le(b) | SCRIPT_END_FOLD != SCRIPT_END_U64 {
			return .No
		}

		return .Yes if b[len(SCRIPT_END_TAG)] in SCRIPT_END_TERM else .No
	}

	needle := SCRIPT_END_TAG
	for i in 0 ..< len(b) {
		ch := b[i]

		if i >= len("</") {
			ch |= 0x20
		}

		if ch != needle[i] {
			return .No
		}
	}

	return .Need_More
}
