package jsc

import "core:c"

// lava_jsc_init runs JavaScriptCore's one-time process bring-up before the first
// JSGlobalContextCreate. On Windows (statically-linked bun-webkit) the C API does NOT do
// this on its own, so the shim runs WTF::initializeMainThread + JSC::initialize and
// disables the baseline JIT tier (broken in that build); without it heavy JS corrupts
// memory mid-execution (0xC0000409). The implementation is build/jsc_init.lib
// (scripts/build-jsc-init-windows.sh, from pkg/jsc/jsc_init_windows.cpp) and is once-
// guarded. No-op elsewhere: the GTK/macOS dynamic JavaScriptCore calls JSC::initialize()
// itself as the first statement of JSGlobalContextCreate (and JSClassCreate), so the bring-
// up always happens; callers can still invoke lava_jsc_init unconditionally.
//
// make_uint8_nocopy_locked wraps JSObjectMakeTypedArrayWithBytesNoCopy in a JSLockHolder on
// Windows, where that bun-webkit build's typed-array creator does not enter the VM and a GC
// during the allocation aborts (see the .cpp). Stock JavaScriptCore's creator self-locks
// (JSLockHolder locker(vm) in JSTypedArray.cpp), so on Linux/macOS the plain C-API call is
// already correct.
when ODIN_OS == .Windows {
	foreign import jsc_init_lib "system:jsc_init.lib"

	@(default_calling_convention = "c", link_prefix = "")
	foreign jsc_init_lib {
		lava_jsc_init :: proc() ---
		lava_make_uint8_nocopy :: proc(ctx: JSContextRef, bytes: rawptr, length: c.size_t, dealloc: proc "c" (bytes: rawptr, deallocator_context: rawptr)) -> JSObjectRef ---
	}

	make_uint8_nocopy_locked :: proc(
		ctx: JSContextRef,
		bytes: rawptr,
		length: c.size_t,
		dealloc: proc "c" (bytes: rawptr, deallocator_context: rawptr),
	) -> JSObjectRef {
		return lava_make_uint8_nocopy(ctx, bytes, length, dealloc)
	}
} else {
	lava_jsc_init :: proc() {}

	make_uint8_nocopy_locked :: proc(
		ctx: JSContextRef,
		bytes: rawptr,
		length: c.size_t,
		dealloc: proc "c" (bytes: rawptr, deallocator_context: rawptr),
	) -> JSObjectRef {
		return JSObjectMakeTypedArrayWithBytesNoCopy(ctx, .Uint8Array, bytes, length, dealloc, nil, nil)
	}
}
