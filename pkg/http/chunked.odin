package larva_http

// Incremental decoder for `Transfer-Encoding: chunked` (RFC 9112 §7.1). Bytes arrive
// in whatever pieces the socket hands out; any piece can end mid-size-line or
// mid-CRLF, so the state carries across calls.

@(private)
Chunk_State :: enum {
	Size,
	Extension, // `;name=value` after the size, up to the CRLF
	Size_LF,
	Data,
	Data_CR,
	Data_LF,
	Trailer, // trailer field lines, ended by an empty line
	Trailer_Line,
	Done,
}

@(private)
Chunked :: struct {
	state:     Chunk_State,
	remaining: u64, // bytes left in the current chunk
	digits:    int, // hex digits read for the current size
}

// A chunk size wider than this is not a real page; refusing it keeps `remaining` from
// overflowing.
@(private = "file")
MAX_SIZE_DIGITS :: 15

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
				c.digits += 1

				if c.digits > MAX_SIZE_DIGITS {
					return false
				}

				c.remaining = c.remaining * 16 + u64(v)
			} else if c.digits == 0 {
				return false
			} else if b == ';' || b == ' ' || b == '\t' {
				c.state = .Extension
			} else if b == '\r' {
				c.state = .Size_LF
			} else {
				return false
			}
		case .Extension:
			if b == '\r' {
				c.state = .Size_LF
			}
		case .Size_LF:
			if b != '\n' {
				return false
			}

			c.digits = 0
			c.state = .Data if c.remaining > 0 else .Trailer
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
		case .Trailer:
			// An empty line ends the message; anything else is a trailer field.
			c.state = .Done if b == '\n' else .Trailer_Line

			if b == '\r' {
				c.state = .Trailer
			}
		case .Trailer_Line:
			if b == '\n' {
				c.state = .Trailer
			}
		case .Done:
			return true
		}
	}

	return true
}

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
