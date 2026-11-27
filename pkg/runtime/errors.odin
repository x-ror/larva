package lava_runtime

import jsc "lava:pkg/jsc"

// Centralized Node-error construction. One place owns the (name, message, code)
// shape every native-thrown error carries, so Lava's errors match both Node's and
// the JS standard-library layer's (which sets `err.code = 'ERR_*'` per module)
// instead of being assembled ad hoc — a base Error plus a manual `name`/`code`
// patch — at each call site. See docs/ARCHITECTURE.md §5.1.

// ERROR_INTRINSIC_NAMES are the standard JS error constructors captured at
// context init (capture_error_intrinsics) so native throws can build *real*
// subclass instances without re-reading the mutable global at throw time. Grow
// this only with genuine global intrinsics — a name that is not a real global
// (e.g. Node's internal "SystemError") simply falls back to a base Error.
@(rodata)
ERROR_INTRINSIC_NAMES := [?]string {
	"Error",
	"TypeError",
	"RangeError",
	"SyntaxError",
	"ReferenceError",
	"EvalError",
	"URIError",
}

// capture_error_intrinsics snapshots and GC-protects the standard error
// constructors from globalThis. eval() calls it once, immediately after the
// context is created and *before any user code runs*, so the captured references
// are the genuine intrinsics. make_native_error then builds from these instead of
// reading globalThis at throw time — a script that overwrites e.g.
// globalThis.RangeError cannot make a native failure run its code or throw a
// different object (Node's internal errors are likewise immune to user globals).
// The JSValueIs* / JSObjectIsConstructor predicates are ABI-safe (#159).
capture_error_intrinsics :: proc(ctx: jsc.JSContextRef, state: ^Runtime_State) {
	if state == nil {
		return
	}

	global := jsc.JSContextGetGlobalObject(ctx)
	for name in ERROR_INTRINSIC_NAMES {
		ctor := get_named(ctx, global, name)

		if ctor != nil && jsc.JSValueIsObject(ctx, ctor) && jsc.JSObjectIsConstructor(ctx, cast(jsc.JSObjectRef)ctor) {
			jsc.JSValueProtect(ctx, ctor)
			state.error_intrinsics[name] = ctor
		}
	}
}

// captured_error_ctor returns the pre-captured intrinsic constructor for `name`,
// or nil when none was captured — a non-intrinsic name (e.g. "SystemError"), or a
// context with no Runtime_State (a bare embedder/test context that never ran
// untrusted user code, so it has nothing to capture against).
@(private = "file")
captured_error_ctor :: proc(ctx: jsc.JSContextRef, name: string) -> jsc.JSValueRef {
	state := get_state_from_ctx(ctx)

	if state == nil {
		return nil
	}

	return state.error_intrinsics[name]
}

// make_native_error builds a *real* instance of a JS error constructor
// (Error / TypeError / RangeError / SyntaxError / …) so `err instanceof TypeError`
// holds exactly as in Node — not merely `err.name === "TypeError"`. `code`, when
// non-empty, is attached as Node's `err.code` string (e.g. "ERR_OUT_OF_RANGE").
//
// The constructor comes from the intrinsics captured at context init
// (capture_error_intrinsics), never from globalThis at throw time, so user code
// that patches a global error constructor cannot intercept native throws. When no
// captured constructor exists — a non-intrinsic name like "SystemError", or a
// stateless embedder/test context — it falls back to a base Error with `name`
// overridden (the pre-factory behavior), so message and code still surface.
make_native_error :: proc(
	ctx: jsc.JSContextRef,
	ctor_name: string,
	message: string,
	code: string = "",
) -> jsc.JSValueRef {
	msg := js_string_value(ctx, message)
	args := [1]jsc.JSValueRef{msg}

	err: jsc.JSValueRef

	if ctor := captured_error_ctor(ctx, ctor_name); ctor != nil {
		built := jsc.JSObjectCallAsConstructor(ctx, cast(jsc.JSObjectRef)ctor, 1, raw_data(args[:]), nil)

		if built != nil {
			err = cast(jsc.JSValueRef)built
		}
	}

	if err == nil {
		// Fallback: a base Error with an overridden name. Never invokes a
		// user-reachable global — JSObjectMakeError is a protected intrinsic.
		base := jsc.JSObjectMakeError(ctx, 1, raw_data(args[:]), nil)
		err = cast(jsc.JSValueRef)base

		if ctor_name != "Error" && jsc.JSValueIsObject(ctx, err) {
			set_named(ctx, cast(jsc.JSObjectRef)err, "name", js_string_value(ctx, ctor_name))
		}
	}

	if len(code) > 0 && jsc.JSValueIsObject(ctx, err) {
		set_named(ctx, cast(jsc.JSObjectRef)err, "code", js_string_value(ctx, code))
	}

	return err
}

// make_js_error builds a plain Error carrying `message` and no `code` — the
// common case for operational failures that do not map to a Node `ERR_*` code.
make_js_error :: proc(ctx: jsc.JSContextRef, message: string) -> jsc.JSValueRef {
	return make_native_error(ctx, "Error", message)
}

// make_js_named_error builds a real instance of the named error subclass
// (e.g. "RangeError", "SyntaxError") carrying `message`, no code. New code that
// needs a `code` should use make_native_error.
make_js_named_error :: proc(ctx: jsc.JSContextRef, name, message: string) -> jsc.JSValueRef {
	return make_native_error(ctx, name, message)
}

// value_is_bigint reports whether `value` is a primitive BigInt. BigInt is the
// only JS primitive type absent from JSValueGetType's enum, so it is detected by
// elimination: a value that is neither an object nor any of the enumerated
// primitive types must be a BigInt. This holds regardless of whether a given JSC
// build reports a BigInt as .Object or as an out-of-enum value. A BigInt *wrapper
// object* (Object(10n)) is a real object and is handled as such, not here.
@(private)
value_is_bigint :: proc(ctx: jsc.JSContextRef, value: jsc.JSValueRef) -> bool {
	if jsc.JSValueIsObject(ctx, value) {
		return false
	}
	#partial switch jsc.JSValueGetType(ctx, value) {
	case .Undefined, .Null, .Boolean, .Number, .String, .Symbol:
		return false
	}
	return true
}
