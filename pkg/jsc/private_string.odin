package jsc

import "core:c"

// Direct-write JS string construction over javascriptcoregtk's exported (but
// private) C++ ABI. The public C API can only build a string by re-validating
// UTF-8 (JSStringCreateWithUTF8CString) or copying UTF-16
// (JSStringCreateWithCharacters); both cost an extra full pass over the content,
// the UTF-8 path truncates at embedded NULs, and the UTF-16 path always widens
// byte-like content to two bytes per character. libjavascriptcoregtk-6.0 exports
// WTF::StringImpl::createUninitialized (8- and 16-bit) and
// OpaqueJSString::tryCreate, which together allocate the string's final storage
// up front so codec output is written straight into it — one pass, no
// validation, and dense 8-bit (Latin-1) storage for byte-like content, the same
// representation JSC's own builtins produce.
//
// string_alloc8/string_alloc16 return a JSStringRef the caller owns (release
// with JSStringRelease) plus the string's uninitialized storage. The caller must
// fill every element of `data` before handing `str` to any other JSC call:
// JSC hashes the content lazily on first use and caches it, so a string read
// before it is fully written would be corrupt forever.
//
// ABI notes (verified against javascriptcoregtk 2.52.3, GCC/Itanium):
//   - Both functions return a smart pointer (Ref/RefPtr) with a non-trivial
//     destructor, so they take a hidden sret out-pointer as the first argument.
//   - std::span<T>& lowers to a pointer to {data: ^T, size: size_t}.
//   - WTF::String&& lowers to a pointer to a single StringImpl* which tryCreate
//     moves out of (adopting our +1 ref).
// Symbols are resolved with dlsym at first use and the whole path is verified
// with an 8-bit and 16-bit round-trip self-test through the public C API; if a
// symbol is missing or any check fails, string_alloc8/16 permanently report
// ok=false and callers stay on the public-API construction path.

when ODIN_OS == .Linux {
	foreign import libdl "system:dl"

	@(default_calling_convention = "c")
	foreign libdl {
		@(private = "file")
		dlsym :: proc(handle: rawptr, name: cstring) -> rawptr ---
	}

	@(private = "file")
	Wtf_Span8 :: struct {
		data: [^]byte,
		size: c.size_t,
	}

	@(private = "file")
	Wtf_Span16 :: struct {
		data: [^]JSChar,
		size: c.size_t,
	}

	@(private = "file")
	Create_Uninit8_Proc :: #type proc "c" (sret: ^rawptr, length: c.size_t, span_out: ^Wtf_Span8) -> rawptr

	@(private = "file")
	Create_Uninit16_Proc :: #type proc "c" (sret: ^rawptr, length: c.size_t, span_out: ^Wtf_Span16) -> rawptr

	@(private = "file")
	Try_Create_Proc :: #type proc "c" (sret: ^rawptr, string_impl: ^rawptr) -> rawptr

	// Thread-local: a JSC context is thread-confined, so probing must use the
	// calling thread's context and its results are stored per thread. This
	// re-derives the (build-global) symbol pointers and layout facts once per
	// worker thread — cheap, and race-free when workers start concurrently,
	// versus a shared latch that could be observed half-published.
	@(private = "file", thread_local)
	g_checked: bool
	@(private = "file", thread_local)
	g_ok: bool
	@(private = "file", thread_local)
	g_create8: Create_Uninit8_Proc
	@(private = "file", thread_local)
	g_create16: Create_Uninit16_Proc
	@(private = "file", thread_local)
	g_try_create: Try_Create_Proc

	// Read-side layout facts, established by probe_read_layout. StringImplShape
	// has been {u32 refCount; u32 length; T* data; atomic<u32> hashAndFlags} and
	// OpaqueJSString {atomic<u32> refCount; String m_string; ...} for many years,
	// but nothing here is assumed: every offset and the 8-bit flag bit are
	// discovered/confirmed against strings whose impl pointers, storage pointers
	// and widths are known exactly (we created them), plus positive/negative
	// functional checks through the public C API. Any mismatch leaves the read
	// path disabled while the write path keeps working.
	@(private = "file", thread_local)
	g_read_ok: bool
	@(private = "file", thread_local)
	g_flag_mask: u32
	@(private = "file", thread_local)
	g_flag_val8: u32

	@(private = "file")
	IMPL_LENGTH_OFFSET :: 4
	@(private = "file")
	IMPL_DATA_OFFSET :: 8
	@(private = "file")
	IMPL_FLAGS_OFFSET :: 16
	@(private = "file")
	OPAQUE_STRING_IMPL_OFFSET :: 8

	@(private = "file")
	ensure_resolved :: proc() {
		if g_checked {
			return
		}

		g_checked = true

		p8 := dlsym(nil, "_ZN3WTF10StringImpl19createUninitializedEmRSt4spanIhLm18446744073709551615EE")
		p16 := dlsym(nil, "_ZN3WTF10StringImpl19createUninitializedEmRSt4spanIDsLm18446744073709551615EE")
		pt := dlsym(nil, "_ZN14OpaqueJSString9tryCreateEON3WTF6StringE")

		if p8 == nil || p16 == nil || pt == nil {
			return
		}

		g_create8 = transmute(Create_Uninit8_Proc)p8
		g_create16 = transmute(Create_Uninit16_Proc)p16
		g_try_create = transmute(Try_Create_Proc)pt

		// Tentatively enable so the self-test can exercise string_alloc8/16
		// (ensure_resolved re-entry is cut off by g_checked above).
		g_ok = true
		g_ok = self_test()

		if g_ok {
			g_read_ok = probe_read_layout()
		}
	}

	// string_bridge_latched_off reports whether ensure_resolved reached a
	// DEFINITIVE negative verdict on this thread — a missing symbol or an ABI
	// self-test mismatch, as opposed to a transient allocation failure inside a
	// later call. host_function.odin consults it: create_raw builds its name
	// through this bridge, so once the bridge is latched off every host-probe
	// retry is doomed and ensure_host should latch its own flag instead of
	// re-probing on every injection.
	string_bridge_latched_off :: proc() -> bool {
		ensure_resolved()
		return !g_ok
	}

	// self_test round-trips known 8-bit and 16-bit content through the private
	// constructors and back out via the public C API, proving both the symbol
	// resolution and the sret/span ABI assumptions on this exact library build.
	@(private = "file")
	self_test :: proc() -> bool {
		str8, d8, ok8 := string_alloc8(3)

		if !ok8 {
			return false
		}

		d8[0] = 'a'
		d8[1] = 'b'
		d8[2] = 'c'
		defer JSStringRelease(str8)

		if JSStringGetLength(str8) != 3 {
			return false
		}

		buf: [8]byte
		n := JSStringGetUTF8CString(str8, &buf[0], len(buf))

		if n != 4 || buf[0] != 'a' || buf[1] != 'b' || buf[2] != 'c' {
			return false
		}

		str16, d16, ok16 := string_alloc16(2)

		if !ok16 {
			return false
		}

		defer JSStringRelease(str16)
		d16[0] = 0x4F60
		d16[1] = 0x597D

		if JSStringGetLength(str16) != 2 {
			return false
		}

		chars := JSStringGetCharactersPtr(str16)

		if chars == nil || chars[0] != 0x4F60 || chars[1] != 0x597D {
			return false
		}

		return true
	}

	// probe_read_layout establishes the StringImpl/OpaqueJSString field offsets
	// and the 8-bit-storage flag bit needed by string_chars8, using strings whose
	// exact impl pointer, storage pointer and width are known because we created
	// them through the raw constructors, then double-checks the resulting
	// classifier against strings built by the public C API.
	@(private = "file")
	probe_read_layout :: proc() -> bool {
		// Raw 8-bit and 16-bit strings; keep the impl pointers for inspection.
		impl8: rawptr
		span8: Wtf_Span8
		g_create8(&impl8, 3, &span8)

		if impl8 == nil || span8.data == nil {
			return false
		}

		span8.data[0] = 'x'
		span8.data[1] = 'y'
		span8.data[2] = 'z'
		s8: rawptr
		moved8 := impl8
		g_try_create(&s8, &moved8)

		if s8 == nil {
			return false
		}

		defer JSStringRelease(JSStringRef(s8))

		impl16: rawptr
		span16: Wtf_Span16
		g_create16(&impl16, 3, &span16)

		if impl16 == nil || span16.data == nil {
			return false
		}

		span16.data[0] = 0x4F60
		span16.data[1] = 0x597D
		span16.data[2] = 0x0021
		s16: rawptr
		moved16 := impl16
		g_try_create(&s16, &moved16)

		if s16 == nil {
			return false
		}

		defer JSStringRelease(JSStringRef(s16))

		// StringImplShape: length and storage pointer where expected, on both widths.
		if (^u32)(uintptr(impl8) + IMPL_LENGTH_OFFSET)^ != 3 {
			return false
		}

		if (^u32)(uintptr(impl16) + IMPL_LENGTH_OFFSET)^ != 3 {
			return false
		}

		if (^rawptr)(uintptr(impl8) + IMPL_DATA_OFFSET)^ != rawptr(span8.data) {
			return false
		}

		if (^rawptr)(uintptr(impl16) + IMPL_DATA_OFFSET)^ != rawptr(span16.data) {
			return false
		}

		// OpaqueJSString holds its String (one StringImpl*) right after the refcount.
		if (^rawptr)(uintptr(s8) + OPAQUE_STRING_IMPL_OFFSET)^ != impl8 {
			return false
		}

		if (^rawptr)(uintptr(s16) + OPAQUE_STRING_IMPL_OFFSET)^ != impl16 {
			return false
		}

		// The two impls were created identically except for storage width, and
		// neither has a cached hash yet, so the flag words must differ in exactly
		// ONE bit: the is-8-bit-storage flag. Require a single-bit difference —
		// the storage-width flag is immutable and untouched by later hashing, so
		// a single-bit mask makes value_chars16's "not 8-bit => 16-bit" test sound
		// for the lifetime of any string. If more than one bit differs, some
		// other width-correlated state is in play and the read fast path is
		// unsafe: leave it disabled and fall back to the public C API.
		f8 := (^u32)(uintptr(impl8) + IMPL_FLAGS_OFFSET)^
		f16 := (^u32)(uintptr(impl16) + IMPL_FLAGS_OFFSET)^
		diff := f8 ~ f16

		if diff == 0 || (diff & (diff - 1)) != 0 {return false} 	// require exactly one bit
		g_flag_mask = diff
		g_flag_val8 = f8 & diff

		// Functional double-check through the public C API: a UTF-8-created ASCII
		// string must classify as 8-bit with the right bytes; a string holding a
		// non-Latin-1 unit must classify as 16-bit.
		g_read_ok = true
		defer g_read_ok = false // caller re-sets from our return value

		pub8 := JSStringCreateWithUTF8CString("abc")
		defer JSStringRelease(pub8)
		d, ok := string_chars8(pub8)

		if !ok || len(d) != 3 || d[0] != 'a' || d[1] != 'b' || d[2] != 'c' {
			return false
		}

		wide := [1]JSChar{0x4F60}
		pub16 := JSStringCreateWithCharacters(&wide[0], 1)
		defer JSStringRelease(pub16)

		if _, ok16 := string_chars8(pub16); ok16 {
			return false
		}

		return true
	}

	// --- direct JSString cell reads -------------------------------------------
	// Reading a string argument through the C API costs a JSValueToStringCopy
	// (an OpaqueJSString wrapper allocation) per call before string_chars8 can
	// even look at it. A flat JSString cell holds its StringImpl directly: the
	// cell type byte identifies strings, and the fiber word is the impl pointer
	// with low tag bits clear (a rope has them set — ropes fall back to the
	// C API, which flattens). Offsets are discovered by locating a known impl
	// pointer inside cells built from strings we constructed, and verified on a
	// second cell of the other storage width.

	@(private = "file", thread_local)
	g_val_checked: bool
	@(private = "file", thread_local)
	g_val_ok: bool
	@(private = "file", thread_local)
	g_string_type: u8
	@(private = "file", thread_local)
	g_fiber_off: uintptr

	@(private = "file")
	ensure_value_reads :: proc(ctx: JSContextRef) {
		if g_val_checked {
			return
		}

		// Need StringImpl layout from ensure_resolved → probe_read_layout first.
		ensure_resolved()

		if !g_read_ok {
			// Permanent: write path ABI failed. Soft: not yet resolved — retry later.
			if g_checked {
				g_val_checked = true
			}

			return
		}

		str8, d8, ok8 := string_alloc8(3)

		if !ok8 {return} 	// transient; leave g_val_checked false
		defer JSStringRelease(str8)
		d8[0] = 'q'
		d8[1] = 'r'
		d8[2] = 's'
		impl8 := (^rawptr)(uintptr(str8) + OPAQUE_STRING_IMPL_OFFSET)^

		// The JSString cell created for str8 references the same StringImpl —
		// find it. (All reads of v happen before any further allocation, so the
		// unrooted cell cannot be collected under us.)
		v := JSValueMakeString(ctx, str8)
		p := uintptr(v)

		if p == 0 || (u64(p) & VALUE_NOT_CELL_MASK) != 0 {
			g_val_checked = true // layout/value shape wrong
			return
		}

		ty := (^u8)(p + JSCELL_TYPE_OFFSET)^
		off: uintptr
		found := false
		for cand: uintptr = 8; cand <= 32; cand += 8 {
			if (^rawptr)(p + cand)^ == impl8 {
				off = cand
				found = true
				break
			}
		}

		if !found {
			g_val_checked = true
			return
		}

		// Cross-check on a 16-bit string.
		str16, d16, ok16 := string_alloc16(2)

		if !ok16 {return} 	// transient
		defer JSStringRelease(str16)
		d16[0] = 0x4F60
		d16[1] = 0x0021
		impl16 := (^rawptr)(uintptr(str16) + OPAQUE_STRING_IMPL_OFFSET)^
		v16 := JSValueMakeString(ctx, str16)
		p16 := uintptr(v16)

		if p16 == 0 || (u64(p16) & VALUE_NOT_CELL_MASK) != 0 {
			g_val_checked = true
			return
		}

		if (^u8)(p16 + JSCELL_TYPE_OFFSET)^ != ty || (^rawptr)(p16 + off)^ != impl16 {
			g_val_checked = true
			return
		}

		g_string_type = ty
		g_fiber_off = off
		g_val_ok = true
		g_val_checked = true
	}

	// value_string_impl resolves a JS value directly to its flat StringImpl, or
	// ok=false for non-strings, ropes, and when the probe is unavailable.
	@(private = "file")
	value_string_impl :: proc(ctx: JSContextRef, value: JSValueRef) -> (impl: uintptr, ok: bool) {
		ensure_value_reads(ctx)

		if !g_val_ok {
			return 0, false
		}

		p := uintptr(value)

		if p == 0 || (u64(p) & VALUE_NOT_CELL_MASK) != 0 {
			return 0, false
		}

		if (^u8)(p + JSCELL_TYPE_OFFSET)^ != g_string_type {
			return 0, false
		}

		w := (^uintptr)(p + g_fiber_off)^

		if w == 0 || (w & 7) != 0 {return 0, false} 	// rope or empty fiber
		return w, true
	}

	// value_chars8 borrows the 8-bit (Latin-1) storage of a string-typed JS
	// value with no C-API call at all. ok=false for non-strings, ropes and
	// 16-bit strings. The slice is valid only while the value is alive (i.e.
	// for the duration of the native call) and must not be written.
	value_chars8 :: proc(ctx: JSContextRef, value: JSValueRef) -> (data: []byte, ok: bool) {
		impl, iok := value_string_impl(ctx, value)

		if !iok {
			return nil, false
		}

		flags := (^u32)(impl + IMPL_FLAGS_OFFSET)^

		if flags & g_flag_mask != g_flag_val8 {
			return nil, false
		}

		length := int((^u32)(impl + IMPL_LENGTH_OFFSET)^)
		chars := (^[^]byte)(impl + IMPL_DATA_OFFSET)^

		if chars == nil {
			return nil, false
		}

		return chars[:length], true
	}

	// value_chars16 is value_chars8 for 16-bit storage (UTF-16 code units).
	value_chars16 :: proc(ctx: JSContextRef, value: JSValueRef) -> (data: []JSChar, ok: bool) {
		impl, iok := value_string_impl(ctx, value)

		if !iok {
			return nil, false
		}

		flags := (^u32)(impl + IMPL_FLAGS_OFFSET)^

		if flags & g_flag_mask == g_flag_val8 {return nil, false} 	// 8-bit
		length := int((^u32)(impl + IMPL_LENGTH_OFFSET)^)
		chars := (^[^]JSChar)(impl + IMPL_DATA_OFFSET)^

		if chars == nil {
			return nil, false
		}

		return chars[:length], true
	}

	// string_chars8 returns a read-only view of a JSC string's 8-bit (Latin-1)
	// storage, or ok=false when the string is 16-bit or the read path is
	// unavailable. Each byte is one code point U+0000..U+00FF. The view borrows
	// the string's storage: it is valid only while the JSStringRef is alive, and
	// the caller must not write through it.
	string_chars8 :: proc(str: JSStringRef) -> (data: []byte, ok: bool) {
		if !g_read_ok || str == nil {
			return nil, false
		}

		impl := (^rawptr)(uintptr(str) + OPAQUE_STRING_IMPL_OFFSET)^

		if impl == nil {
			return nil, false
		}

		flags := (^u32)(uintptr(impl) + IMPL_FLAGS_OFFSET)^

		if flags & g_flag_mask != g_flag_val8 {
			return nil, false
		}

		length := int((^u32)(uintptr(impl) + IMPL_LENGTH_OFFSET)^)
		chars := (^[^]byte)(uintptr(impl) + IMPL_DATA_OFFSET)^

		if chars == nil {
			return nil, false
		}

		return chars[:length], true
	}

	// wtf_string_impl_from_ascii builds a bare WTF::StringImpl* (refcount 1) from
	// ASCII text, for passing as `const WTF::String&` to other private-ABI calls
	// (a String is one StringImpl*). The caller's ref is deliberately never
	// dereffed — callees take their own refs, so hand this only to bounded,
	// process-lifetime uses (e.g. host function names).
	@(private)
	wtf_string_impl_from_ascii :: proc(s: string) -> (impl: rawptr, ok: bool) {
		ensure_resolved()

		if !g_ok || len(s) == 0 {
			return nil, false
		}

		span: Wtf_Span8
		g_create8(&impl, c.size_t(len(s)), &span)

		if impl == nil || span.data == nil || int(span.size) != len(s) {
			return nil, false
		}

		copy(span.data[:len(s)], s)
		return impl, true
	}

	// string_alloc8 allocates an n-character 8-bit (Latin-1) JSC string and
	// returns its uninitialized storage. Each byte is one character U+0000..U+00FF.
	// Transient create/tryCreate failures return ok=false for this call only —
	// g_ok is latched false only by ensure_resolved's self-test (ABI mismatch).
	string_alloc8 :: proc(n: int) -> (str: JSStringRef, data: []byte, ok: bool) {
		ensure_resolved()

		if !g_ok || n <= 0 {
			return nil, nil, false
		}

		impl: rawptr
		span: Wtf_Span8
		g_create8(&impl, c.size_t(n), &span)

		if impl == nil || span.data == nil || int(span.size) != n {
			return nil, nil, false
		}

		s: rawptr
		moved := impl
		g_try_create(&s, &moved)

		if s == nil {
			// Orphaned StringImpl (no public deref); rare. Fail this call only.
			return nil, nil, false
		}

		return JSStringRef(s), span.data[:n], true
	}

	// string_alloc16 allocates an n-unit 16-bit JSC string and returns its
	// uninitialized storage; units are UTF-16 code units, surrogates preserved.
	string_alloc16 :: proc(n: int) -> (str: JSStringRef, data: []JSChar, ok: bool) {
		ensure_resolved()

		if !g_ok || n <= 0 {
			return nil, nil, false
		}

		impl: rawptr
		span: Wtf_Span16
		g_create16(&impl, c.size_t(n), &span)

		if impl == nil || span.data == nil || int(span.size) != n {
			return nil, nil, false
		}

		s: rawptr
		moved := impl
		g_try_create(&s, &moved)

		if s == nil {
			return nil, nil, false
		}

		return JSStringRef(s), span.data[:n], true
	}
} else {
	string_alloc8 :: proc(_: int) -> (str: JSStringRef, data: []byte, ok: bool) {
		return nil, nil, false
	}

	string_alloc16 :: proc(_: int) -> (str: JSStringRef, data: []JSChar, ok: bool) {
		return nil, nil, false
	}

	string_chars8 :: proc(_: JSStringRef) -> (data: []byte, ok: bool) {
		return nil, false
	}

	value_chars8 :: proc(_: JSContextRef, _: JSValueRef) -> (data: []byte, ok: bool) {
		return nil, false
	}

	value_chars16 :: proc(_: JSContextRef, _: JSValueRef) -> (data: []JSChar, ok: bool) {
		return nil, false
	}
}
