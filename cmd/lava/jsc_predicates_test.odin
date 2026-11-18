#+build linux, darwin
package main

import "core:c"
import "core:testing"
import jsc "lava:pkg/jsc"

// Regression guard for the JSValueIs* / JSValueToBoolean FFI boundary (#159).
//
// History (the "heisenbug"): these predicates were once declared `-> b32` (a
// 4-byte boolean). JSC's C API returns C `_Bool` (1 byte) — on the SysV-AMD64 and
// AArch64 ABIs the value lives in the low byte of the return register and the
// upper bytes are UNDEFINED. Reading 4 bytes therefore picked up that garbage, so
// a JS `false` (low byte 0, upper bytes nonzero) read back as a truthy nonzero —
// "a JS false comes back true", the symptom seen in the sqlite readBigInts / bind
// paths and defensively worked around with JSValueGetType.
//
// The bindings now declare these `-> bool` (Odin `bool` is 1 byte), which reads
// only the low byte and is ABI-correct. This test pins that down: it exercises the
// predicates on values of every known type, BOTH from a normal Odin context and
// from inside a JSC `proc "c"` callback (the context the workarounds blamed), so a
// regression back to a wide return type — or a real engine misbehavior — fails
// loudly here instead of corrupting control flow somewhere downstream.

@(test)
jsc_value_predicates :: proc(t: ^testing.T) {
	jsc.lava_jsc_init()
	gctx := jsc.JSGlobalContextCreate(nil)
	testing.expect(t, gctx != nil, "could not create a JSC global context")

	if gctx == nil {
		return
	}

	defer jsc.JSGlobalContextRelease(gctx)

	ctx := cast(jsc.JSContextRef)gctx

	v_false := jsc.JSValueMakeBoolean(ctx, false)
	v_true := jsc.JSValueMakeBoolean(ctx, true)
	v_undef := jsc.JSValueMakeUndefined(ctx)
	v_null := jsc.JSValueMakeNull(ctx)
	v_num := jsc.JSValueMakeNumber(ctx, 42)
	v_obj := cast(jsc.JSValueRef)jsc.JSObjectMake(ctx, nil, nil)

	// The crux: a JS `false` must convert back to `false`. The old b32 return
	// turned this into `true`, which is the whole reason for the workarounds.
	testing.expect(t, jsc.JSValueToBoolean(ctx, v_false) == false, "JSValueToBoolean(false) must be false")
	testing.expect(t, jsc.JSValueToBoolean(ctx, v_true) == true, "JSValueToBoolean(true) must be true")

	// Type predicates must classify each value correctly (and not report a false
	// positive for an unrelated type).
	testing.expect(t, jsc.JSValueIsBoolean(ctx, v_false), "false is a boolean")
	testing.expect(t, jsc.JSValueIsBoolean(ctx, v_true), "true is a boolean")
	testing.expect(t, !jsc.JSValueIsBoolean(ctx, v_num), "42 is not a boolean")
	testing.expect(t, jsc.JSValueIsUndefined(ctx, v_undef), "undefined is undefined")
	testing.expect(t, !jsc.JSValueIsUndefined(ctx, v_null), "null is not undefined")
	testing.expect(t, jsc.JSValueIsNull(ctx, v_null), "null is null")
	testing.expect(t, !jsc.JSValueIsNull(ctx, v_undef), "undefined is not null")
	testing.expect(t, jsc.JSValueIsNumber(ctx, v_num), "42 is a number")
	testing.expect(t, jsc.JSValueIsObject(ctx, v_obj), "{} is an object")
	testing.expect(t, !jsc.JSValueIsObject(ctx, v_num), "42 is not an object")

	// JSValueGetType must agree with the predicates — the two were once treated as
	// divergent (predicates "unreliable", GetType "safe"); they are the same engine
	// answer through two return widths.
	testing.expect(t, jsc.JSValueGetType(ctx, v_false) == .Boolean, "GetType(false) == Boolean")
	testing.expect(t, jsc.JSValueGetType(ctx, v_undef) == .Undefined, "GetType(undefined) == Undefined")
	testing.expect(t, jsc.JSValueGetType(ctx, v_null) == .Null, "GetType(null) == Null")
	testing.expect(t, jsc.JSValueGetType(ctx, v_num) == .Number, "GetType(42) == Number")
	testing.expect(t, jsc.JSValueGetType(ctx, v_obj) == .Object, "GetType({}) == Object")

	// Now the same checks from inside a `proc "c"` callback, driven by real JS.
	probe_reset()
	name: cstring = "__lava_predicate_probe"
	js_name := jsc.JSStringCreateWithUTF8CString(name)
	defer jsc.JSStringRelease(js_name)
	fn := jsc.JSObjectMakeFunctionWithCallback(ctx, js_name, predicate_probe_cb)
	global := jsc.JSContextGetGlobalObject(ctx)
	jsc.JSObjectSetProperty(ctx, global, js_name, cast(jsc.JSValueRef)fn, {}, nil)

	src: cstring = "__lava_predicate_probe(false, undefined, {}, 42)"
	js_src := jsc.JSStringCreateWithUTF8CString(src)
	defer jsc.JSStringRelease(js_src)
	exc: jsc.JSValueRef
	jsc.JSEvaluateScript(ctx, js_src, nil, nil, 1, &exc)
	testing.expect(t, exc == nil, "predicate probe script threw")
	testing.expect(t, probe_called, "predicate probe callback did not run")
	testing.expect(t, probe_false_is_false, "proc-c: JSValueToBoolean(false) must be false")
	testing.expect(t, probe_undef_is_undefined, "proc-c: undefined must be undefined")
	testing.expect(t, probe_obj_is_object, "proc-c: {} must be an object")
	testing.expect(t, probe_num_not_object, "proc-c: 42 must not be an object")
}

// --- proc "c" probe state ---
//
// A JSC callback is `proc "c"` and has no Odin `context`, so it records its
// results into these file-scoped flags for the test body to assert. The callback
// performs no allocation, so it needs no context.

@(private = "file")
probe_called: bool
@(private = "file")
probe_false_is_false: bool
@(private = "file")
probe_undef_is_undefined: bool
@(private = "file")
probe_obj_is_object: bool
@(private = "file")
probe_num_not_object: bool

@(private = "file")
probe_reset :: proc() {
	probe_called = false
	probe_false_is_false = false
	probe_undef_is_undefined = false
	probe_obj_is_object = false
	probe_num_not_object = false
}

// predicate_probe_cb(falseVal, undefinedVal, objVal, numVal) runs the predicates on
// JS-supplied arguments from inside a real JSC callback frame.
@(private = "file")
predicate_probe_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	probe_called = true

	if argument_count >= 4 {
		probe_false_is_false = jsc.JSValueToBoolean(ctx, arguments[0]) == false
		probe_undef_is_undefined = jsc.JSValueIsUndefined(ctx, arguments[1])
		probe_obj_is_object = jsc.JSValueIsObject(ctx, arguments[2])
		probe_num_not_object = !jsc.JSValueIsObject(ctx, arguments[3])
	}

	return jsc.JSValueMakeUndefined(ctx)
}
