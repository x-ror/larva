package lava_runtime

import "base:runtime"
import "core:c"
import "core:crypto"
import jsc "lava:pkg/jsc"

// Native backing for the WHATWG `crypto` global. The JavaScript surface
// (getRandomValues/randomUUID) lives in js/internal/crypto/random.js and consults this
// primitive through the `native` bindings object the loader
// passes as the factory's fourth argument — the same pattern `console` uses to
// receive its write primitives without exposing them on globalThis.
//
// Entropy comes from crypto.rand_bytes (the OS CSPRNG: getentropy on Darwin,
// getrandom on Linux, BCryptGenRandom on Windows), replacing the Math.random
// placeholder the pure-JS module shipped with.

// typed_array_view and make_uint8_array — the shared JSC TypedArray marshalling
// helpers crypto uses — now live in typed_array.odin (same package).

// randomFill(typedArray) — fill the array in place with CSPRNG bytes and return
// it. Used by getRandomValues/randomUUID. Writing through the borrowed view mutates
// the caller's typed array directly.
crypto_random_fill_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()

	if argument_count < 1 {
		return jsc.JSValueMakeUndefined(ctx)
	}

	view, ok := typed_array_view(ctx, arguments[0])

	if !ok {
		if exception != nil {
			exception^ = make_js_error(ctx, "randomFill expects a Uint8Array")
		}

		return jsc.JSValueMakeUndefined(ctx)
	}

	if len(view) > 0 {
		crypto.rand_bytes(view)
	}

	return arguments[0]
}

// make_crypto_bindings builds the `native` object handed to js/internal/crypto/random.js.
make_crypto_bindings :: proc(ctx: jsc.JSContextRef) -> jsc.JSObjectRef {
	bindings := jsc.JSObjectMake(ctx, nil, nil)
	inject_native_function(ctx, bindings, "randomFill", crypto_random_fill_cb)
	return bindings
}
