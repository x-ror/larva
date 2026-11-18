#+build linux, darwin
package main

import "core:testing"
import jsc "lava:pkg/jsc"
import lava "lava:pkg/runtime"

// Regression guard for the argument-coercion re-entrancy hazard in the
// typed-array natives (buffer write-into / indexOf / swap, and the same pattern
// in crypto and http.parseRequest).
//
// js_int_arg / read_string_arg can run arbitrary JS — valueOf / toString on a
// non-primitive argument — and that JS may detach (ArrayBuffer.transfer) or
// resize the target's backing store. The natives must therefore acquire the
// borrowed typed_array_view AFTER every argument coercion, with no JS-reachable
// call between the view and the byte work. The pre-fix order (view first,
// coercions after) left the write/search running over freed memory.
//
// Each case below calls a native callback directly with an `offset` object whose
// valueOf detaches the target mid-call, then asserts the native saw the
// post-detach (empty) target: 0 bytes written / not found — never the stale view.

@(private = "file")
reentrancy_eval :: proc(ctx: jsc.JSContextRef, src: cstring) -> jsc.JSValueRef {
	js_src := jsc.JSStringCreateWithUTF8CString(src)
	defer jsc.JSStringRelease(js_src)
	exc: jsc.JSValueRef
	return jsc.JSEvaluateScript(ctx, js_src, nil, nil, 1, &exc)
}

@(private = "file")
reentrancy_global :: proc(ctx: jsc.JSContextRef, name: cstring) -> jsc.JSValueRef {
	js_name := jsc.JSStringCreateWithUTF8CString(name)
	defer jsc.JSStringRelease(js_name)
	return jsc.JSObjectGetProperty(ctx, jsc.JSContextGetGlobalObject(ctx), js_name, nil)
}

// reentrancy_setup builds a fresh 64-byte 0xAA-filled Uint8Array target and an
// `evil` offset object whose valueOf detaches the target's ArrayBuffer and
// returns 0. Fresh per case: a detached buffer stays detached.
@(private = "file")
reentrancy_setup :: proc(ctx: jsc.JSContextRef) -> (view: jsc.JSValueRef, evil: jsc.JSValueRef) {
	reentrancy_eval(
		ctx,
		`globalThis.__ab = new ArrayBuffer(64);
globalThis.__view = new Uint8Array(globalThis.__ab);
globalThis.__view.fill(0xAA);
globalThis.__evil = { valueOf: function () { globalThis.__ab.transfer(); return 0; } };`,
	)
	return reentrancy_global(ctx, "__view"), reentrancy_global(ctx, "__evil")
}

@(test)
buffer_natives_detach_during_coercion :: proc(t: ^testing.T) {
	jsc.lava_jsc_init()
	gctx := jsc.JSGlobalContextCreate(nil)
	testing.expect(t, gctx != nil, "could not create a JSC global context")
	if gctx == nil do return
	defer jsc.JSGlobalContextRelease(gctx)
	ctx := cast(jsc.JSContextRef)gctx

	// ArrayBuffer.prototype.transfer is the detach primitive; without it (older
	// JSC) there is nothing to exercise.
	has_transfer := jsc.JSValueToBoolean(
		ctx,
		reentrancy_eval(ctx, "typeof ArrayBuffer.prototype.transfer === 'function'"),
	)
	if !has_transfer {
		// Older JSC without the detach primitive: nothing to exercise.
		return
	}

	str := jsc.JSStringCreateWithUTF8CString("hello")
	defer jsc.JSStringRelease(str)
	v_str := jsc.JSValueMakeString(ctx, str)
	v_max := jsc.JSValueMakeNumber(ctx, 64)
	exc: jsc.JSValueRef

	// The three write-into natives: (target, string, offset=evil, max). The evil
	// valueOf detaches target before the native may borrow it — 0 bytes written.
	{
		view, evil := reentrancy_setup(ctx)
		args := [4]jsc.JSValueRef{view, v_str, evil, v_max}
		r := lava.buffer_utf8_write_into_cb(ctx, nil, nil, 4, raw_data(args[:]), &exc)
		testing.expect(t, jsc.JSValueToNumber(ctx, r, nil) == 0, "utf8WriteInto wrote through a detached target")
	}
	{
		view, evil := reentrancy_setup(ctx)
		args := [4]jsc.JSValueRef{view, v_str, evil, v_max}
		r := lava.buffer_latin1_write_into_cb(ctx, nil, nil, 4, raw_data(args[:]), &exc)
		testing.expect(t, jsc.JSValueToNumber(ctx, r, nil) == 0, "latin1WriteInto wrote through a detached target")
	}
	{
		view, evil := reentrancy_setup(ctx)
		args := [4]jsc.JSValueRef{view, v_str, evil, v_max}
		r := lava.buffer_utf16le_write_into_cb(ctx, nil, nil, 4, raw_data(args[:]), &exc)
		testing.expect(t, jsc.JSValueToNumber(ctx, r, nil) == 0, "utf16leWriteInto wrote through a detached target")
	}

	// indexOf: (hay, needle, start=evil, forward). The needle byte matches the
	// pre-detach fill, so a stale hay view would report a hit at 0; the
	// post-detach hay is empty and must report -1.
	{
		view, evil := reentrancy_setup(ctx)
		needle := reentrancy_eval(ctx, "new Uint8Array([0xAA])")
		args := [4]jsc.JSValueRef{view, needle, evil, jsc.JSValueMakeBoolean(ctx, true)}
		r := lava.buffer_index_of_cb(ctx, nil, nil, 4, raw_data(args[:]), &exc)
		testing.expect(t, jsc.JSValueToNumber(ctx, r, nil) == -1, "indexOf searched a detached haystack")
	}

	// swapInPlace: (target, width=evil-returning-2). Detached target has no
	// bytes; the call must be a no-op (undefined return, no write).
	{
		view, _ := reentrancy_setup(ctx)
		evil2 := reentrancy_eval(ctx, "({ valueOf: function () { globalThis.__ab.transfer(); return 2; } })")
		args := [2]jsc.JSValueRef{view, evil2}
		r := lava.buffer_swap_cb(ctx, nil, nil, 2, raw_data(args[:]), &exc)
		testing.expect(t, jsc.JSValueIsUndefined(ctx, r), "swapInPlace must no-op on a detached target")
	}
}
