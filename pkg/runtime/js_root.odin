package lava_runtime

import jsc "lava:pkg/jsc"

// GC-root slot helpers — ONE way to pair a JSValueProtect with its release.
//
// A "slot" is a struct field holding a JS object the native side must keep
// alive across loop turns (a callback, a handle backed by JSObjectSetPrivate).
// The invariant these helpers enforce mechanically is the one the codebase
// otherwise re-derives by hand at every site: a slot is EITHER nil OR holds a
// protected object, so clearing is idempotent, teardown can never double-
// unprotect, and a new field added to a constructor cannot silently leak its
// root as long as its teardown lists the slot once.
//
// js_root_set fills an EMPTY slot (protects fn, nil-safe). js_root_clear
// unprotects and nils. js_root_clear_private additionally severs the object's
// private back-pointer BEFORE dropping the root — for handles JS may still
// reach after the native owner is freed (a later call must no-op on a nil
// private rather than dereference freed memory).

js_root_set :: proc(ctx: jsc.JSContextRef, slot: ^jsc.JSObjectRef, fn: jsc.JSObjectRef) {
	assert(slot^ == nil, "js_root_set requires an empty slot (clear it first)")
	slot^ = fn

	if fn != nil {
		jsc.JSValueProtect(ctx, cast(jsc.JSValueRef)fn)
	}
}

js_root_clear :: proc(ctx: jsc.JSContextRef, slot: ^jsc.JSObjectRef) {
	if slot^ == nil {
		return
	}

	jsc.JSValueUnprotect(ctx, cast(jsc.JSValueRef)slot^)
	slot^ = nil
}

js_root_clear_private :: proc(ctx: jsc.JSContextRef, slot: ^jsc.JSObjectRef) {
	if slot^ == nil {
		return
	}

	jsc.JSObjectSetPrivate(slot^, nil)
	jsc.JSValueUnprotect(ctx, cast(jsc.JSValueRef)slot^)
	slot^ = nil
}
