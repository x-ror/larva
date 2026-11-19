#+build linux
package larva_http

import "core:c"
import "core:encoding/endian"

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

// The frames zstd_decode hands the library, by the little-endian u32 that opens one
// (RFC 8878 §3.1.1, §3.1.2): a zstd frame, or a skippable frame whose magic's low four
// bits are free. A libzstd built with legacy support, as Debian's and Ubuntu's are, also
// decodes the v0.5-v0.7 formats (0xFD2FB525..0xFD2FB527), and those decoders ignore
// ZSTD_d_windowLogMax, sizing their window from the frame header up to 128 MiB. Chrome's
// bundled zstd has no legacy support and fails such a body (zstd-legacy-v07).
@(private = "file")
ZSTD_MAGIC :: 0xFD2FB528
@(private = "file")
ZSTD_SKIPPABLE_MAGIC :: 0x184D2A50

@(private = "file")
Brotli_State :: distinct rawptr

@(private = "file")
Zstd_DCtx :: distinct rawptr

@(private = "file")
Zstd_D_Parameter :: enum c.int {
	Window_Log_Max = 100, // ZSTD_d_windowLogMax
}

@(private = "file")
Brotli_Result :: enum c.int {
	Error            = 0,
	Success          = 1,
	Needs_More_Input = 2,
	Needs_More_Output = 3,
}

@(private = "file")
Zstd_In_Buffer :: struct {
	src:  [^]byte,
	size: c.size_t,
	pos:  c.size_t,
}

@(private = "file")
Zstd_Out_Buffer :: struct {
	dst:  [^]byte,
	size: c.size_t,
	pos:  c.size_t,
}

@(default_calling_convention = "c", private = "file")
foreign brotlidec {
	BrotliDecoderCreateInstance :: proc(alloc_func, free_func, opaque: rawptr) -> Brotli_State ---
	BrotliDecoderDestroyInstance :: proc(state: Brotli_State) ---
	BrotliDecoderDecompressStream :: proc(state: Brotli_State, available_in: ^c.size_t, next_in: ^[^]byte, available_out: ^c.size_t, next_out: ^[^]byte, total_out: ^c.size_t) -> Brotli_Result ---
}

@(default_calling_convention = "c", private = "file")
foreign zstd {
	ZSTD_createDCtx :: proc() -> Zstd_DCtx ---
	ZSTD_freeDCtx :: proc(dctx: Zstd_DCtx) -> c.size_t ---
	ZSTD_DCtx_setParameter :: proc(dctx: Zstd_DCtx, param: Zstd_D_Parameter, value: c.int) -> c.size_t ---
	ZSTD_decompressStream :: proc(dctx: Zstd_DCtx, output: ^Zstd_Out_Buffer, input: ^Zstd_In_Buffer) -> c.size_t ---
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

// zstd_decode undoes `zstd`: every frame in turn, as RFC 8878 §3.1 allows several, a
// skippable one included (zstd-skippable-then-frame). Bytes that do not start a frame
// fail it (zstd-trailing-junk), as does a legacy frame (zstd-legacy-v07); a frame cut
// short keeps what it decoded.
@(private)
zstd_decode :: proc(input: []byte, out: ^Sink) -> Error {
	dctx := ZSTD_createDCtx()

	if dctx == nil {
		return .Body_Too_Large
	}

	defer ZSTD_freeDCtx(dctx)

	if ZSTD_isError(ZSTD_DCtx_setParameter(dctx, .Window_Log_Max, ZSTD_WINDOW_LOG_MAX)) != 0 {
		return .Decoding
	}

	in_buf := Zstd_In_Buffer{raw_data(input), c.size_t(len(input)), 0}
	// The library stops at the end of each frame and returns 0 there, so the next call
	// starts the next frame: that is where its magic is checked.
	frame_start := true
	for {
		if frame_start && !zstd_frame_is_current(input[in_buf.pos:]) {
			return .Decoding
		}

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

		// Input used up, and either the last frame is complete and flushed (0, zstd.h's
		// contract) or there is room to spare, so the decoder has flushed all it can.
		// Testing only the room would grow a buffer the frame ended exactly in.
		if in_buf.pos == in_buf.size && (ret == 0 || out_buf.pos < out_buf.size) {
			return .None
		}

		frame_start = ret == 0
	}
}

// zstd_frame_is_current says whether `rest` opens a zstd or a skippable frame. Fewer than
// four bytes are left to the library, which itself refuses a prefix of any other magic,
// a legacy one included (libzstd 1.5.7, probed with 2 and 3 trailing bytes).
@(private = "file")
zstd_frame_is_current :: proc(rest: []byte) -> bool {
	magic, ok := endian.get_u32(rest, .Little)
	return !ok || magic == ZSTD_MAGIC || magic & ~u32(0xF) == ZSTD_SKIPPABLE_MAGIC
}
