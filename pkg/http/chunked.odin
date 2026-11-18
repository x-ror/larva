package larva_http

import "core:bytes"

// Incremental decoder for `Transfer-Encoding: chunked` (RFC 9112 §7.1). Bytes arrive in
// whatever pieces the socket hands out; any piece can end mid-size-line or mid-CRLF, so
// the state carries across calls.

// Significant hex digits of a chunk size; more is not a real page, and refusing it keeps
// `remaining` from overflowing. Leading zeros do not count.
@(private = "file")
MAX_SIZE_DIGITS :: 15

@(private)
Chunk_State :: enum {
	Size,
	Size_Space, // whitespace after the size: only more of it, `;` or CR may follow
	Extension, // `;name=value` up to the CR
	Size_LF,
	Data,
	Data_CR,
	Data_LF,
	Trailer_Start, // after the last chunk: an empty line, or trailer fields
	Trailer_LF,
	Trailer_Line,
	Done,
}

@(private)
Chunked :: struct {
	state:     Chunk_State,
	remaining: u64, // bytes left in the current chunk
	digits:    int, // significant hex digits read for the current size
	seen:      bool, // the current size has at least one digit
}

// chunked_feed decodes `data`, appending payload bytes to `out`.
//
// Returns:
//   ok false on a framing error. The body is complete once `c.state == .Done`; bytes
//   after that are ignored.
@(private)
chunked_feed :: proc(c: ^Chunked, data: []byte, out: ^[dynamic]byte) -> (ok: bool) {
	for i := 0; i < len(data); i += 1 {
		b := data[i]
		switch c.state {
		case .Size:
			if v, is_hex := hex_value(b); is_hex {
				c.seen = true

				if c.digits > 0 || v != 0 {
					c.digits += 1
				}

				if c.digits > MAX_SIZE_DIGITS {
					return false
				}

				c.remaining = c.remaining * 16 + u64(v)
				continue
			}

			if !c.seen {
				return false
			}

			switch b {
			case ';':
				c.state = .Extension
			case ' ', '\t':
				// RFC 9112 allows whitespace before `;` (BWS), so it is accepted there only.
				c.state = .Size_Space
			case '\r':
				c.state = .Size_LF
			case:
				return false
			}
		case .Size_Space:
			switch b {
			case ' ', '\t':
			case ';':
				c.state = .Extension
			case '\r':
				c.state = .Size_LF
			case:
				return false
			}
		case .Extension:
			switch b {
			case '\r':
				c.state = .Size_LF
			case '\n':
				return false
			}
		case .Size_LF:
			if b != '\n' {
				return false
			}

			c.digits, c.seen = 0, false
			c.state = .Data if c.remaining > 0 else .Trailer_Start
		case .Data:
			n := min(u64(len(data) - i), c.remaining)
			append(out, ..data[i:i + int(n)])
			c.remaining -= n
			i += int(n) - 1

			if c.remaining == 0 {
				c.state = .Data_CR
			}
		case .Data_CR:
			if b != '\r' {
				return false
			}

			c.state = .Data_LF
		case .Data_LF:
			if b != '\n' {
				return false
			}

			c.state = .Size
		case .Trailer_Start:
			// A CRLF here ends the message; anything else starts a trailer field line.
			c.state = .Trailer_LF if b == '\r' else .Trailer_Line
		case .Trailer_LF:
			if b != '\n' {
				return false
			}

			c.state = .Done
		case .Trailer_Line:
			rel := bytes.index_byte(data[i:], '\n')

			if rel < 0 {
				return true
			}

			i += rel
			c.state = .Trailer_Start
		case .Done:
			return true
		}
	}

	return true
}

// core:encoding/hex has the same switch as hex_digit, but private to that package.
@(private = "file")
hex_value :: proc(b: byte) -> (v: byte, ok: bool) {
	switch b {
	case '0' ..= '9':
		return b - '0', true
	case 'a' ..= 'f':
		return b - 'a' + 10, true
	case 'A' ..= 'F':
		return b - 'A' + 10, true
	}

	return 0, false
}
