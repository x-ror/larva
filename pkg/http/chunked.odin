package larva_http

// Incremental decoder for `Transfer-Encoding: chunked` (RFC 9112 §7.1). Bytes arrive in
// whatever pieces the socket hands out; any piece can end mid-size-line or mid-CRLF, so
// the state carries across calls. Line endings are strict CRLF everywhere: a lenient
// decoder reads a body differently from a strict proxy in front of it.

// Significant hex digits of a chunk size; more is not a real page, and refusing it keeps
// `remaining` from overflowing. Leading zeros do not count, but do count as line bytes.
@(private = "file")
MAX_SIZE_DIGITS :: 15
// One size line with its extensions — the same bound the runtime's fetch uses. Without
// it, `0000…` or `5;aaaa…` would grow nothing in the body and never hit max_body.
@(private = "file")
MAX_CHUNK_LINE :: 16 * 1024

@(private)
Chunk_State :: enum {
	Size,
	Size_Space, // whitespace after the size: only more of it, or `;`
	Extension, // `;name=value` up to the CR
	Size_LF,
	Data,
	Data_CR,
	Data_LF,
	Trailer_Start, // after the last chunk: CRLF ends the body, anything else is a field
	Trailer_Line,
	Trailer_Line_LF,
	Trailer_End_LF,
	Done,
}

@(private)
Chunked :: struct {
	state:     Chunk_State,
	remaining: u64, // bytes left in the current chunk
	digits:    int, // significant hex digits of the current size
	seen:      bool, // the current size has at least one digit
	line:      int, // bytes of the current size line
	trailer:   int, // bytes of trailer fields so far
}

// chunked_feed decodes `data`, appending payload bytes to `out`.
//
// Returns:
//   ok false on a framing error or an oversized size line or trailer. The body is
//   complete once `c.state == .Done`; bytes after that are ignored.
@(private)
chunked_feed :: proc(c: ^Chunked, data: []byte, out: ^[dynamic]byte) -> (ok: bool) {
	for i := 0; i < len(data); i += 1 {
		b := data[i]
		switch c.state {
		case .Size, .Size_Space, .Extension, .Size_LF:
			c.line += 1

			if c.line > MAX_CHUNK_LINE {
				return false
			}

			if !size_line_byte(c, b) {
				return false
			}
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
		case .Trailer_Start, .Trailer_Line, .Trailer_Line_LF, .Trailer_End_LF:
			c.trailer += 1

			if c.trailer > MAX_HEAD_BYTES {
				return false
			}

			if !trailer_byte(c, b) {
				return false
			}
		case .Done:
			return true
		}
	}

	return true
}

// size_line_byte takes one byte of `chunk-size [chunk-ext] CRLF`. Whitespace (BWS) is
// allowed only before a `;` (RFC 9112 §7.1.1), so `5  CRLF` is refused.
@(private = "file")
size_line_byte :: proc(c: ^Chunked, b: byte) -> bool {
	#partial switch c.state {
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
			return true
		}

		if !c.seen {
			return false
		}

		switch b {
		case ';':
			c.state = .Extension
		case ' ', '\t':
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

		c.digits, c.seen, c.line = 0, false, 0
		c.state = .Data if c.remaining > 0 else .Trailer_Start
	}

	return true
}

// trailer_byte takes one byte of the trailer section: field lines, each ending in CRLF,
// then a lone CRLF. A bare CR or LF anywhere is refused.
@(private = "file")
trailer_byte :: proc(c: ^Chunked, b: byte) -> bool {
	#partial switch c.state {
	case .Trailer_Start:
		switch b {
		case '\r':
			c.state = .Trailer_End_LF
		case '\n':
			return false
		case:
			c.state = .Trailer_Line
		}
	case .Trailer_Line:
		switch b {
		case '\r':
			c.state = .Trailer_Line_LF
		case '\n':
			return false
		}
	case .Trailer_Line_LF:
		if b != '\n' {
			return false
		}

		c.state = .Trailer_Start
	case .Trailer_End_LF:
		if b != '\n' {
			return false
		}

		c.state = .Done
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
