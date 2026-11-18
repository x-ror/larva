package jsc

// Immediate int32 JSValues without a C-API round trip. Native bindings decode
// integer arguments (offsets, lengths) with JSValueToNumber and produce integer
// results with JSValueMakeNumber — one locked API call each. On 64-bit JSC an
// int32 is NaN-boxed as a fixed tag OR'd with the zero-extended value; the tag
// is not assumed but derived at first use by XOR-ing JSValueMakeNumber's own
// encodings of several known integers (they must all agree, including a
// negative), so the fast path can never disagree with the API that taught it.
// Doubles, and anything else, report ok=false and take the C-API path.

when ODIN_OS == .Linux {
	// Thread-local probe state: each thread derives the tag against its own
	// (thread-confined) context exactly once. The NaN-box tag is a
	// build-global fact, but re-deriving it per thread is cheap and avoids any
	// cross-thread read of a half-published latch when workers start together.
	@(private = "file", thread_local)
	g_i32_checked: bool
	@(private = "file", thread_local)
	g_i32_ok: bool
	@(private = "file", thread_local)
	g_i32_tag: u64

	@(private = "file")
	ensure_int32 :: proc(ctx: JSContextRef) {
		if g_i32_checked do return
		g_i32_checked = true
		enc :: proc(ctx: JSContextRef, v: i32) -> u64 {
			return transmute(u64)JSValueMakeNumber(ctx, f64(v))
		}
		t5 := enc(ctx, 5) ~ u64(u32(5))
		t7 := enc(ctx, 7) ~ u64(u32(7))
		tbig := enc(ctx, 1234567) ~ u64(u32(1234567))
		tneg := enc(ctx, -3) ~ u64(u32(transmute(u32)i32(-3)))
		if t5 != t7 || t5 != tbig || t5 != tneg do return
		// The tag must live entirely in the high 32 bits, or the decode below
		// could not separate it from the payload.
		if t5 & 0xFFFFFFFF != 0 do return
		g_i32_tag = t5
		g_i32_ok = true
	}

	// value_int32 decodes an int32-typed JS value; ok=false for doubles and
	// non-numbers (fall back to JSValueToNumber).
	value_int32 :: proc(ctx: JSContextRef, value: JSValueRef) -> (v: i32, ok: bool) {
		ensure_int32(ctx)
		if !g_i32_ok do return 0, false
		bits := transmute(u64)value
		if bits & 0xFFFFFFFF_00000000 != g_i32_tag do return 0, false
		return i32(u32(bits & 0xFFFFFFFF)), true
	}

	// make_int32 encodes an int32 as a JS value; ok=false when the probe is
	// unavailable (fall back to JSValueMakeNumber).
	make_int32 :: proc(ctx: JSContextRef, v: i32) -> (value: JSValueRef, ok: bool) {
		ensure_int32(ctx)
		if !g_i32_ok do return nil, false
		return transmute(JSValueRef)(g_i32_tag | u64(transmute(u32)v)), true
	}
} else {
	value_int32 :: proc(_: JSContextRef, _: JSValueRef) -> (v: i32, ok: bool) {
		return 0, false
	}

	make_int32 :: proc(_: JSContextRef, _: i32) -> (value: JSValueRef, ok: bool) {
		return nil, false
	}
}
