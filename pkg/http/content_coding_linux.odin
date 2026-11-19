#+build linux
package larva_http

import "core:c"

// libbrotlidec (MIT) and libzstd (BSD-3-Clause), the system's: the codecs Chrome itself
// bundles, so a truncated or trailing stream ends where Chrome's does. Neither has an
// Odin core: or vendor: package.
foreign import brotlidec "system:brotlidec"
foreign import zstd "system:zstd"

// The codings this target decodes.
DECODABLE :: Codings{.Gzip, .Deflate, .Brotli, .Zstd}

// RFC 8878 §3.1.1.1.2 asks an HTTP decoder to support windows up to 8 MiB and lets it
// refuse larger ones; Chrome refuses them (zstd-window-16m). It also bounds the decoder's
// own buffer, which the library would otherwise let grow to 128 MiB.
@(private = "file")
ZSTD_WINDOW_LOG_MAX :: 23

@(private = "file")
ZSTD_D_WINDOW_LOG_MAX :: 100 // ZSTD_d_windowLogMax

@(private = "file")
Brotli_Result :: enum c.int {
	Error            = 0,
	Success          = 1,
	Needs_More_Input = 2,
	Needs_More_Output = 3,
}

@(private = "file")
Zstd_In_Buffer :: struct {
	src:  rawptr,
	size: c.size_t,
	pos:  c.size_t,
}

@(private = "file")
Zstd_Out_Buffer :: struct {
	dst:  rawptr,
	size: c.size_t,
	pos:  c.size_t,
}

@(default_calling_convention = "c", private = "file")
foreign brotlidec {
	BrotliDecoderCreateInstance :: proc(alloc_func, free_func, opaque: rawptr) -> rawptr ---
	BrotliDecoderDestroyInstance :: proc(state: rawptr) ---
	BrotliDecoderDecompressStream :: proc(state: rawptr, available_in: ^c.size_t, next_in: ^[^]byte, available_out: ^c.size_t, next_out: ^[^]byte, total_out: ^c.size_t) -> Brotli_Result ---
}

@(default_calling_convention = "c", private = "file")
foreign zstd {
	ZSTD_createDCtx :: proc() -> rawptr ---
	ZSTD_freeDCtx :: proc(dctx: rawptr) -> c.size_t ---
	ZSTD_DCtx_setParameter :: proc(dctx: rawptr, param: c.int, value: c.int) -> c.size_t ---
	ZSTD_decompressStream :: proc(dctx: rawptr, output: ^Zstd_Out_Buffer, input: ^Zstd_In_Buffer) -> c.size_t ---
	ZSTD_isError :: proc(code: c.size_t) -> c.uint ---
}

// brotli_decode undoes `br`. The first stream's end is the content's end: anything after
// it is ignored (br-trailing-junk), and a stream cut short keeps what it decoded.
@(private)
brotli_decode :: proc(input: []byte, out: ^Sink) -> Error {
	// The library's own malloc: its state never outlives this call.
	state := BrotliDecoderCreateInstance(nil, nil, nil)

	if state == nil {
		return .Body_Too_Large
	}

	defer BrotliDecoderDestroyInstance(state)

	avail_in := c.size_t(len(input))
	next_in := raw_data(input)
	for {
		room, ok := sink_room(out, len(input))

		if !ok {
			return .Body_Too_Large
		}

		avail_out := c.size_t(len(room))
		next_out := raw_data(room)
		result := BrotliDecoderDecompressStream(state, &avail_in, &next_in, &avail_out, &next_out, nil)
		out.n += len(room) - int(avail_out)

		switch result {
		case .Success, .Needs_More_Input:
			return .None
		case .Needs_More_Output:
		case .Error:
			return .Decoding
		}
	}
}

// zstd_decode undoes `zstd`: every frame in turn, as RFC 8878 §3.1 allows several. Bytes
// that do not start a frame fail it (zstd-trailing-junk); a frame cut short keeps what
// it decoded.
@(private)
zstd_decode :: proc(input: []byte, out: ^Sink) -> Error {
	dctx := ZSTD_createDCtx()

	if dctx == nil {
		return .Body_Too_Large
	}

	defer ZSTD_freeDCtx(dctx)

	if ZSTD_isError(ZSTD_DCtx_setParameter(dctx, ZSTD_D_WINDOW_LOG_MAX, ZSTD_WINDOW_LOG_MAX)) != 0 {
		return .Decoding
	}

	in_buf := Zstd_In_Buffer{raw_data(input), c.size_t(len(input)), 0}
	for {
		room, ok := sink_room(out, len(input))

		if !ok {
			return .Body_Too_Large
		}

		out_buf := Zstd_Out_Buffer{raw_data(room), c.size_t(len(room)), 0}
		ret := ZSTD_decompressStream(dctx, &out_buf, &in_buf)
		out.n += int(out_buf.pos)

		if ZSTD_isError(ret) != 0 {
			return .Decoding
		}

		// Input used up and room to spare: the decoder has flushed all it can.
		if in_buf.pos == in_buf.size && out_buf.pos < out_buf.size {
			return .None
		}
	}
}
