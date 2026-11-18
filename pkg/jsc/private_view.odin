package jsc

import "core:c"

// Direct JSArrayBufferView reads. Resolving a typed array's bytes through the
// public C API costs 3–4 locked calls per native invocation (type check,
// length, bytes pointer, byte offset — plus the gtk byteOffset bug workaround,
// issue #68). The view cell itself holds everything needed: the JSCell type
// byte identifies a Uint8Array (any Structure — Buffer subclasses included),
// m_vector points at the view's first byte (base + byteOffset, always), and
// m_length is the element count.
//
// Nothing about the layout is hardcoded: at first use three Uint8Arrays are
// created over backing stores whose addresses and lengths we chose, and the
// field offsets are discovered by scanning the cells for those known values
// (the type byte's offset within the JSCell header — structureID u32,
// indexingType u8, type u8 — is the one fixed assumption, unchanged in JSC for
// many years). All three cells must agree or the fast path stays disabled and
// callers keep using the C API.
//
// m_length is only the length for a view whose length is FIXED at construction.
// A view over a resizable ArrayBuffer (ES2024) is not: a length-tracking one
// (`new Uint8Array(rab)`) stores 0 and derives its length from the buffer on
// every access, and a fixed-length one keeps its constructed length after the
// buffer shrinks below it, where the spec reads it as out of bounds (length 0).
// Trusting the field handed natives an empty view for the first and bytes past
// the buffer's end for the second. JSC tells the kinds apart by the view's mode
// byte (m_mode), so the probe also locates that byte and records the values it
// takes on plain fixed-length views; any other value falls back to the C API,
// whose byteLength follows the spec for every mode.

// JSCell header: [structureID u32][indexingTypeAndMisc u8][type u8][flags u8][cellState u8].
JSCELL_TYPE_OFFSET :: 5

// A 64-bit JSValueRef is the NaN-boxed JSValue bit pattern; a GC cell is an
// 8-aligned pointer with the top 16 bits clear, while every immediate
// (int32/double/undefined/null/booleans) has bits in this mask set. Used only
// as a conservative pre-filter before dereferencing — a false negative just
// means the C-API fallback.
VALUE_NOT_CELL_MASK :: u64(0xFFFF_0000_0000_0007)

// MAX_VIEW_LENGTH bounds a plausible Uint8Array length; a probed length above
// this can only be a mis-read cell field, so typed_array_bytes rejects it and
// the C API handles that value instead. Well above any real Buffer (JSC caps
// typed arrays far below 2^33).
MAX_VIEW_LENGTH :: 0x1_0000_0000

when ODIN_OS == .Linux {
	// Thread-local: probing must run on the (thread-confined) context that will
	// later be read, and the cell offsets — though a build-global fact — are
	// re-derived once per worker thread to avoid a shared latch being seen
	// half-published during concurrent worker startup.
	@(private = "file", thread_local) g_view_checked: bool
	@(private = "file", thread_local) g_view_ok: bool
	@(private = "file", thread_local) g_view_type: u8
	@(private = "file", thread_local) g_vec_off: uintptr
	@(private = "file", thread_local) g_len_off: uintptr
	@(private = "file", thread_local) g_len_u64: bool
	// m_mode byte offset and the three values it takes on a fixed-length view
	// over a non-resizable buffer (JSC: Fast, Oversize, Wasteful). Values are
	// recorded from probe views rather than hardcoded, like the offsets above.
	@(private = "file", thread_local) g_mode_off: uintptr
	@(private = "file", thread_local) g_mode_fixed: [3]u8

	// Immortal backing stores for the probe views (nil deallocator): distinct
	// addresses and lengths so field offsets are identified by value. The `_off`
	// view (backed by g_probe_d, viewed at a non-zero byteOffset) disambiguates a
	// genuine 64-bit length from a 32-bit length whose adjacent (zero) field the
	// wide read would otherwise fold in — see ensure_view.
	@(private = "file", thread_local) g_probe_a: [40]byte
	@(private = "file", thread_local) g_probe_b: [24]byte
	@(private = "file", thread_local) g_probe_c: [56]byte
	@(private = "file", thread_local) g_probe_d: [64]byte

	@(private = "file")
	ensure_view :: proc(ctx: JSContextRef) {
		if g_view_checked do return
		// Soft failures (nil create) leave g_view_checked false so a later call
		// retries. Layout disagreements after successful allocates latch closed.

		a := JSObjectMakeTypedArrayWithBytesNoCopy(ctx, .Uint8Array, &g_probe_a[0], len(g_probe_a), nil, nil, nil)
		if a == nil do return
		JSValueProtect(ctx, JSValueRef(a))
		defer JSValueUnprotect(ctx, JSValueRef(a))
		b := JSObjectMakeTypedArrayWithBytesNoCopy(ctx, .Uint8Array, &g_probe_b[0], len(g_probe_b), nil, nil, nil)
		if b == nil do return
		JSValueProtect(ctx, JSValueRef(b))
		defer JSValueUnprotect(ctx, JSValueRef(b))
		cc := JSObjectMakeTypedArrayWithBytesNoCopy(ctx, .Uint8Array, &g_probe_c[0], len(g_probe_c), nil, nil, nil)
		if cc == nil do return
		JSValueProtect(ctx, JSValueRef(cc))
		defer JSValueUnprotect(ctx, JSValueRef(cc))

		pa, pb, pc := uintptr(rawptr(a)), uintptr(rawptr(b)), uintptr(rawptr(cc))
		ty := (^u8)(pa + JSCELL_TYPE_OFFSET)^
		if (^u8)(pb + JSCELL_TYPE_OFFSET)^ != ty || (^u8)(pc + JSCELL_TYPE_OFFSET)^ != ty {
			g_view_checked = true
			return
		}
		vec_off: uintptr
		vec_found := false
		for cand: uintptr = 8; cand <= 120; cand += 8 {
			if (^rawptr)(pa + cand)^ == rawptr(&g_probe_a[0]) &&
			   (^rawptr)(pb + cand)^ == rawptr(&g_probe_b[0]) &&
			   (^rawptr)(pc + cand)^ == rawptr(&g_probe_c[0]) {
				vec_off = cand
				vec_found = true
				break
			}
		}
		if !vec_found {
			g_view_checked = true
			return
		}

		// Length is size_t on 64-bit JSC builds with large typed arrays, u32 on
		// older ones — try the wider read first. byteOffset is 0 on all three
		// probe views, so it can never collide with these length values.
		len_off: uintptr
		len_found := false
		len_u64 := false
		for cand: uintptr = 8; cand <= 120; cand += 8 {
			if cand == vec_off do continue
			if (^u64)(pa + cand)^ == len(g_probe_a) &&
			   (^u64)(pb + cand)^ == len(g_probe_b) &&
			   (^u64)(pc + cand)^ == len(g_probe_c) {
				len_off = cand
				len_found = true
				len_u64 = true
				break
			}
		}
		if !len_found {
			for cand: uintptr = 8; cand <= 124; cand += 4 {
				if cand >= vec_off && cand < vec_off + 8 do continue
				if (^u32)(pa + cand)^ == len(g_probe_a) &&
				   (^u32)(pb + cand)^ == len(g_probe_b) &&
				   (^u32)(pc + cand)^ == len(g_probe_c) {
					len_off = cand
					len_found = true
					break
				}
			}
		}
		if !len_found {
			g_view_checked = true
			return
		}
		// Disambiguate the width with a view at a NON-ZERO byteOffset. All three
		// probes above have byteOffset 0, so if m_length is really u32 with an
		// adjacent u32 byteOffset, a u64 read at len_off equals the length anyway
		// (0 in the upper half) and len_u64 latches true wrongly. For a real
		// offset view the wide read would be length | (byteOffset<<32) — a huge
		// value. Build one (offset 16, length 32 over g_probe_d) and require the
		// chosen mode to read exactly 32 with m_vector == base+16; downgrade to
		// u32 (or disable) otherwise.
		{
			OFF :: 16
			LEN :: 32
			ab := JSObjectMakeArrayBufferWithBytesNoCopy(ctx, &g_probe_d[0], len(g_probe_d), nil, nil, nil)
			if ab == nil do return // soft
			JSValueProtect(ctx, JSValueRef(ab))
			defer JSValueUnprotect(ctx, JSValueRef(ab))
			global := JSContextGetGlobalObject(ctx)
			u8_name := JSStringCreateWithUTF8CString("Uint8Array")
			defer JSStringRelease(u8_name)
			u8_ctor := JSObjectGetProperty(ctx, global, u8_name, nil)
			if u8_ctor == nil || !JSValueIsObject(ctx, u8_ctor) {
				g_view_checked = true
				return
			}
			args := [3]JSValueRef {
				JSValueRef(ab),
				JSValueMakeNumber(ctx, f64(OFF)),
				JSValueMakeNumber(ctx, f64(LEN)),
			}
			ov := JSObjectCallAsConstructor(ctx, JSObjectRef(u8_ctor), 3, &args[0], nil)
			if ov == nil do return // soft
			JSValueProtect(ctx, JSValueRef(ov))
			defer JSValueUnprotect(ctx, JSValueRef(ov))
			pv := uintptr(rawptr(ov))
			if (^u8)(pv + JSCELL_TYPE_OFFSET)^ != ty {
				g_view_checked = true
				return
			}
			// m_vector already includes byteOffset.
			if (^rawptr)(pv + vec_off)^ != rawptr(&g_probe_d[OFF]) {
				g_view_checked = true
				return
			}
			read := len_u64 ? int((^u64)(pv + len_off)^) : int((^u32)(pv + len_off)^)
			if read != LEN {
				// Wide read folded in byteOffset; the field is really u32.
				if len_u64 && int((^u32)(pv + len_off)^) == LEN {
					len_u64 = false
				} else {
					g_view_checked = true
					return
				}
			}
		}

		mode_off, mode_fixed, mode_state := probe_view_mode(ctx, ty, vec_off, len_off, {pa, pb, pc})
		switch mode_state {
		case .Soft:
			return
		case .Mismatch:
			g_view_checked = true
			return
		case .Found:
		}

		g_view_type = ty
		g_vec_off = vec_off
		g_len_off = len_off
		g_len_u64 = len_u64
		g_mode_off = mode_off
		g_mode_fixed = mode_fixed
		g_view_ok = true
		g_view_checked = true
	}

	@(private = "file")
	Mode_Probe :: enum u8 {
		Found,
		Soft,     // an allocation or constructor call failed; retry on a later call
		Mismatch, // layout did not discriminate; latch the fast path closed
	}

	// probe_view_mode finds the byte that separates a fixed-length Uint8Array
	// from one over a resizable buffer. The fixed-length side covers every
	// allocation mode a plain Uint8Array can be in: `wasteful` holds the NoCopy
	// probes from ensure_view (external or ArrayBuffer-backed storage), and
	// `new Uint8Array(4)` / `new Uint8Array(4096)` are the small (GC-inline) and
	// large (out-of-line, above JSC's 1000-byte fast-size limit) kinds that
	// Buffer.alloc and friends produce. Those two must come from the JS
	// constructor: JSObjectMakeTypedArray backs every view with an ArrayBuffer,
	// so it only ever yields the wasteful mode (measured on gtk 6.0/2.52.6: all
	// three read 88 at m_mode, where the JS-made small and large views read 16
	// and 48). The resizable side — a length-tracking view and a fixed-length
	// view over a resizable buffer — has no C API at all (no maxByteLength).
	//
	// The candidate byte must agree across the four wasteful views and read a
	// value on both resizable views that none of the fixed kinds uses. Scanning
	// starts past m_vector and m_length; the first match wins, which is m_mode
	// in every layout that has one (it follows m_byteOffset, which the offset
	// probe's 16 rules out). Nothing else in the cell varies with resizability.
	//
	// Fails closed on an engine without resizable buffers: it ignores
	// maxByteLength, the "resizable" views are plain, no byte discriminates, and
	// the fast path stays off — slower, never wrong. The constructors are read
	// off the global object, so prime_view_probe runs this before any user code
	// can replace them (a soft failure there retries lazily, unprimed).
	@(private = "file")
	probe_view_mode :: proc(
		ctx: JSContextRef,
		ty: u8,
		vec_off, len_off: uintptr,
		wasteful: [3]uintptr,
	) -> (
		off: uintptr,
		fixed: [3]u8,
		state: Mode_Probe,
	) {
		global := JSContextGetGlobalObject(ctx)
		u8_name := JSStringCreateWithUTF8CString("Uint8Array")
		defer JSStringRelease(u8_name)
		ab_name := JSStringCreateWithUTF8CString("ArrayBuffer")
		defer JSStringRelease(ab_name)
		max_name := JSStringCreateWithUTF8CString("maxByteLength")
		defer JSStringRelease(max_name)
		u8_ctor := JSObjectGetProperty(ctx, global, u8_name, nil)
		ab_ctor := JSObjectGetProperty(ctx, global, ab_name, nil)
		if u8_ctor == nil || !JSValueIsObject(ctx, u8_ctor) || ab_ctor == nil || !JSValueIsObject(ctx, ab_ctor) {
			return 0, {}, .Mismatch
		}
		// Rooted by the global object only while nobody reassigns it; protect.
		JSValueProtect(ctx, u8_ctor)
		defer JSValueUnprotect(ctx, u8_ctor)
		JSValueProtect(ctx, ab_ctor)
		defer JSValueUnprotect(ctx, ab_ctor)

		fast_args := [1]JSValueRef{JSValueMakeNumber(ctx, 4)}
		fast := JSObjectCallAsConstructor(ctx, JSObjectRef(u8_ctor), 1, &fast_args[0], nil)
		if fast == nil do return 0, {}, .Soft
		JSValueProtect(ctx, JSValueRef(fast))
		defer JSValueUnprotect(ctx, JSValueRef(fast))
		big_args := [1]JSValueRef{JSValueMakeNumber(ctx, 4096)}
		big := JSObjectCallAsConstructor(ctx, JSObjectRef(u8_ctor), 1, &big_args[0], nil)
		if big == nil do return 0, {}, .Soft
		JSValueProtect(ctx, JSValueRef(big))
		defer JSValueUnprotect(ctx, JSValueRef(big))
		// The NoCopy offset view from ensure_view is gone by now; one more
		// ArrayBuffer-backed wasteful view stands in for it.
		ab := JSObjectMakeArrayBufferWithBytesNoCopy(ctx, &g_probe_d[0], len(g_probe_d), nil, nil, nil)
		if ab == nil do return 0, {}, .Soft
		JSValueProtect(ctx, JSValueRef(ab))
		defer JSValueUnprotect(ctx, JSValueRef(ab))
		wv_args := [1]JSValueRef{JSValueRef(ab)}
		wv := JSObjectCallAsConstructor(ctx, JSObjectRef(u8_ctor), 1, &wv_args[0], nil)
		if wv == nil do return 0, {}, .Soft
		JSValueProtect(ctx, JSValueRef(wv))
		defer JSValueUnprotect(ctx, JSValueRef(wv))

		opts := JSObjectMake(ctx, nil, nil)
		if opts == nil do return 0, {}, .Soft
		JSValueProtect(ctx, JSValueRef(opts))
		defer JSValueUnprotect(ctx, JSValueRef(opts))
		JSObjectSetProperty(ctx, opts, max_name, JSValueMakeNumber(ctx, 16), {}, nil)
		rab_args := [2]JSValueRef{JSValueMakeNumber(ctx, 8), JSValueRef(opts)}
		rab := JSObjectCallAsConstructor(ctx, JSObjectRef(ab_ctor), 2, &rab_args[0], nil)
		if rab == nil do return 0, {}, .Soft
		JSValueProtect(ctx, JSValueRef(rab))
		defer JSValueUnprotect(ctx, JSValueRef(rab))
		tracking_args := [1]JSValueRef{JSValueRef(rab)}
		tracking := JSObjectCallAsConstructor(ctx, JSObjectRef(u8_ctor), 1, &tracking_args[0], nil)
		if tracking == nil do return 0, {}, .Soft
		JSValueProtect(ctx, JSValueRef(tracking))
		defer JSValueUnprotect(ctx, JSValueRef(tracking))
		fixed_args := [3]JSValueRef{JSValueRef(rab), JSValueMakeNumber(ctx, 0), JSValueMakeNumber(ctx, 4)}
		bounded := JSObjectCallAsConstructor(ctx, JSObjectRef(u8_ctor), 3, &fixed_args[0], nil)
		if bounded == nil do return 0, {}, .Soft
		JSValueProtect(ctx, JSValueRef(bounded))
		defer JSValueUnprotect(ctx, JSValueRef(bounded))

		pf, pg, pw := uintptr(rawptr(fast)), uintptr(rawptr(big)), uintptr(rawptr(wv))
		pt, pr := uintptr(rawptr(tracking)), uintptr(rawptr(bounded))
		for p in ([5]uintptr{pf, pg, pw, pt, pr}) {
			if (^u8)(p + JSCELL_TYPE_OFFSET)^ != ty do return 0, {}, .Mismatch
		}

		byte_at :: #force_inline proc(p, off: uintptr) -> u8 {return (^u8)(p + off)^}
		for cand := max(vec_off, len_off) + 8; cand <= 120; cand += 1 {
			w := byte_at(wasteful[0], cand)
			if byte_at(wasteful[1], cand) != w || byte_at(wasteful[2], cand) != w || byte_at(pw, cand) != w {
				continue
			}
			set := [3]u8{byte_at(pf, cand), byte_at(pg, cand), w}
			t, r := byte_at(pt, cand), byte_at(pr, cand)
			if t == set[0] || t == set[1] || t == set[2] do continue
			if r == set[0] || r == set[1] || r == set[2] do continue
			return cand, set, .Found
		}
		return 0, {}, .Mismatch
	}

	// prime_view_probe runs the layout probe for this thread now. The runtime
	// calls it right after creating a context, before any script runs, because
	// the mode probe constructs views through the global Uint8Array/ArrayBuffer
	// — which user code may later replace — and a probe that learned its
	// "fixed-length" modes from a steered constructor would whitelist a
	// resizable view's mode. Idempotent per thread.
	prime_view_probe :: proc(ctx: JSContextRef) {
		ensure_view(ctx)
	}

	// typed_array_bytes borrows a Uint8Array's bytes straight from the view
	// cell — any Structure (Buffer subclass views included), byteOffset already
	// folded into the pointer.
	//
	// Returns:
	//   ok=true with the view's current bytes (nil for an empty or detached
	//   view) only for a Uint8Array of FIXED length over a non-resizable buffer.
	//   ok=false for everything else — other view types, DataView, non-cells,
	//   any view over a resizable or growable buffer, and whenever the probe is
	//   unavailable — and the caller must use the C API.
	// Node:
	//   A length-tracking view's length follows its buffer, and a fixed view
	//   the buffer has shrunk under reads as length 0 (node 26.13.0, verified by
	//   tests/node-compat/cases/68-resizable-view-bytes.js). Declining those
	//   views is what keeps this path from answering either wrongly.
	//
	// The slice is valid only while the value is alive, i.e. for the duration
	// of the native call.
	typed_array_bytes :: proc(ctx: JSContextRef, value: JSValueRef) -> (data: []byte, ok: bool) {
		ensure_view(ctx)
		if !g_view_ok do return nil, false
		p := uintptr(value)
		if p == 0 || (u64(p) & VALUE_NOT_CELL_MASK) != 0 do return nil, false
		if (^u8)(p + JSCELL_TYPE_OFFSET)^ != g_view_type do return nil, false
		// A resizable- or growable-backed view: m_length is not its length.
		mode := (^u8)(p + g_mode_off)^
		if mode != g_mode_fixed[0] && mode != g_mode_fixed[1] && mode != g_mode_fixed[2] do return nil, false
		vec := (^rawptr)(p + g_vec_off)^
		n := g_len_u64 ? int((^u64)(p + g_len_off)^) : int((^u32)(p + g_len_off)^)
		if vec == nil || n < 0 {
			// Detached (or zero-length wasteful) views have a null vector and a
			// zeroed length; report those as a valid empty view.
			return nil, n == 0
		}
		// Defense in depth against a mis-probed length field: a real Uint8Array
		// never exceeds MAX_VIEW_LENGTH, so anything larger means the read is
		// bogus — fall back to the C API rather than hand out a wild slice.
		if n > MAX_VIEW_LENGTH do return nil, false
		return ([^]byte)(vec)[:n], true
	}
} else {
	prime_view_probe :: proc(_: JSContextRef) {}

	typed_array_bytes :: proc(_: JSContextRef, _: JSValueRef) -> (data: []byte, ok: bool) {
		return nil, false
	}
}
