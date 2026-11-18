package lava_runtime

import "base:runtime"
import "core:c"
import "core:mem"
import jsc "lava:pkg/jsc"

// Shared JavaScriptCore <-> Odin TypedArray marshalling helpers.

// --- BytesPtr offset layout (issue #68) --------------------------------------
// javascriptcoregtk's JSObjectGetTypedArrayBytesPtr returns the ArrayBuffer base
// and ignores the view's byteOffset (verified 2026-07-10 on 6.0/2.52.3: BytesPtr
// points at base, first byte is pool[0] not view[0]). Correct access is always
// base + byteOffset. We still prefer BytesPtr + ByteOffset (4 C API calls after
// the type check) over Buffer + ArrayBufferBytesPtr + Offset (5 calls): BytesPtr
// and ArrayBufferBytesPtr both yield the same base when the bug is present.
//
// If a future JSC returns the view start from BytesPtr, adding offset would
// double-apply. First non-zero-offset view compares BytesPtr to ArrayBuffer base
// and pins the mode for the process.

@(private = "file")
BytesPtr_Mode :: enum u8 {
	Unknown,
	Base_Plus_Offset, // BytesPtr == ArrayBuffer base (gtk today)
	View_Start,       // BytesPtr == base + offset (fixed JSC)
}

// Thread-local: the gtk-bug mode is a build-global fact, but each worker's JSC
// context is thread-confined and the mode is latched from a view created on the
// owning thread; per-thread state avoids a cross-thread read of a half-written
// global during concurrent worker startup.
@(private = "file", thread_local)
g_bytes_ptr_mode: BytesPtr_Mode // written once per thread after first offset view; read thereafter

// typed_array_view borrows the backing store of a TypedArray or DataView as an
// Odin byte slice. Valid only for the duration of the native call.
//
// Returns:
//   The view's CURRENT bytes and true for any TypedArray or DataView (nil for an
//   empty, detached or out-of-bounds view); false for anything else.
// Node:
//   A view over a resizable ArrayBuffer has no fixed length: a length-tracking
//   one follows the buffer's current size, and a fixed window the buffer has
//   shrunk below reads as length 0 — so `decode(new Uint8Array(rab))` sees every
//   byte and a stale window sees none (node 26.13.0, verified by
//   tests/node-compat/cases/68-resizable-view-bytes.js). The cell fast path
//   declines those views and the C API below answers for them; its byteLength
//   applies the spec's rules for every view mode.
typed_array_view :: proc(ctx: jsc.JSContextRef, value: jsc.JSValueRef) -> ([]byte, bool) {
	// Direct cell read (Uint8Array of any Structure, byteOffset pre-applied) —
	// zero C-API calls. Other view types and DataView fall through.
	if data, ok := jsc.typed_array_bytes(ctx, value); ok do return data, true

	if jsc.JSValueGetTypedArrayType(ctx, value, nil) == .None do return nil, false
	obj := cast(jsc.JSObjectRef)value
	n := int(jsc.JSObjectGetTypedArrayByteLength(ctx, obj, nil))
	if n == 0 do return nil, true

	ptr := jsc.JSObjectGetTypedArrayBytesPtr(ctx, obj, nil)
	offset := int(jsc.JSObjectGetTypedArrayByteOffset(ctx, obj, nil))

	if ptr == nil {
		buffer := jsc.JSObjectGetTypedArrayBuffer(ctx, obj, nil)
		if buffer == nil do return nil, false
		base := jsc.JSObjectGetArrayBufferBytesPtr(ctx, buffer, nil)
		if base == nil do return nil, false
		return (cast([^]byte)base)[offset:][:n], true
	}

	if offset == 0 {
		return (cast([^]byte)ptr)[:n], true
	}

	mode := g_bytes_ptr_mode
	if mode == .Unknown {
		buffer := jsc.JSObjectGetTypedArrayBuffer(ctx, obj, nil)
		base := buffer != nil ? jsc.JSObjectGetArrayBufferBytesPtr(ctx, buffer, nil) : nil
		if base != nil {
			if ptr == base {
				mode = .Base_Plus_Offset
			} else if ptr == rawptr(uintptr(base) + uintptr(offset)) {
				mode = .View_Start
			} else {
				// Unexpected — use ArrayBuffer base + offset (always correct).
				return (cast([^]byte)base)[offset:][:n], true
			}
			g_bytes_ptr_mode = mode
		} else {
			// Cannot probe; assume gtk layout (base + offset).
			mode = .Base_Plus_Offset
			g_bytes_ptr_mode = mode
		}
	}

	if mode == .View_Start {
		return (cast([^]byte)ptr)[:n], true
	}
	// Base_Plus_Offset (and default): BytesPtr is the buffer base.
	return (cast([^]byte)ptr)[offset:][:n], true
}

// jsc_buffer_deallocator frees a byte slice handed to JavaScriptCore as the NoCopy
// backing of a Uint8Array. JSC calls it from GC or VM teardown, with no Odin context
// of its own, so it frees through the heap allocator — and the bytes must come from
// runtime.heap_allocator(), not whatever context.allocator a caller happens to run
// under: a page runner installs its own allocator for everything a tick does.
jsc_buffer_deallocator :: proc "c" (bytes: rawptr, deallocator_context: rawptr) {
	context = runtime.default_context()
	if bytes != nil do free(bytes)
}

// make_uint8_array hands a byte slice from runtime.heap_allocator() to JavaScriptCore
// as a Uint8Array without copying; jsc_buffer_deallocator frees it. Natives reached
// as `proc "c"` callbacks run under runtime.default_context(), whose allocator is the
// heap, so their context.allocator qualifies; loop callbacks do not (net.odin).
make_uint8_array :: proc(ctx: jsc.JSContextRef, data: []byte) -> jsc.JSValueRef {
	ptr := raw_data(data)
	n := len(data)
	if ptr == nil {
		pad := make([]byte, 1, runtime.heap_allocator())
		ptr = raw_data(pad)
		n = 0
	}
	// No free on a nil return: JSC already ran jsc_buffer_deallocator (see
	// make_uint8_array_uninit).
	array := jsc.make_uint8_nocopy_locked(ctx, ptr, c.size_t(n), jsc_buffer_deallocator)
	return cast(jsc.JSValueRef)array
}

MAX_UNINIT_ALLOC :: 0x7fff_ffff // 2^31 - 1 bytes

// make_uint8_array_uninit allocates `size` uninitialized bytes on runtime.heap_allocator()
// (matching jsc_buffer_deallocator) and hands them to JavaScriptCore as a NoCopy Uint8Array.
// A nil return needs no free here: JSTypedArray.h documents for
// JSObjectMakeTypedArrayWithBytesNoCopy that "If an exception is thrown during this
// function the bytesDeallocator will always be called" (MacOSX.sdk JavaScriptCore
// Headers/JSTypedArray.h:61) — the bytes are wrapped in ArrayBuffer::createFromBytes
// with the deallocator as its destructor before the typed array is created, so a
// failed create drops that buffer and frees them. Deleting again is a double free.
make_uint8_array_uninit :: proc(ctx: jsc.JSContextRef, size: int) -> (jsc.JSValueRef, bool) {
	if size <= 0 || size > MAX_UNINIT_ALLOC do return nil, false
	heap := runtime.heap_allocator()
	data, err := mem.alloc_bytes_non_zeroed(size, mem.DEFAULT_ALIGNMENT, heap)
	if err != nil || len(data) != size do return nil, false
	array := jsc.make_uint8_nocopy_locked(
		ctx,
		raw_data(data),
		c.size_t(size),
		jsc_buffer_deallocator,
	)
	if array == nil do return nil, false
	return cast(jsc.JSValueRef)array, true
}
