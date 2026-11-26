package lava_runtime

import "base:runtime"
import "core:c"
import "core:crypto"
import "core:math/rand"
import jsc "lava:pkg/jsc"

// Native backing for the node:crypto built-in and the WHATWG `crypto` global. The
// JavaScript surface (randomBytes/randomUUID/getRandomValues/timingSafeEqual) lives in
// js/node/crypto.js and js/internal/crypto/random.js
// and consults these primitives through the `native` bindings object the loader
// passes as the factory's fourth argument — the same pattern `console` uses to
// receive its write primitives without exposing them on globalThis.
//
// Entropy comes from crypto.rand_bytes (the OS CSPRNG: getentropy on Darwin,
// getrandom on Linux, BCryptGenRandom on Windows), replacing the Math.random
// placeholder the pure-JS module shipped with.

// typed_array_view and make_uint8_array — the shared JSC TypedArray marshalling
// helpers crypto uses — now live in typed_array.odin (same package).

// randomFill(typedArray) — fill the array in place with CSPRNG bytes and return
// it. Used by randomBytes/randomFillSync/randomUUID. Writing through the
// borrowed view mutates the caller's Buffer/Uint8Array directly.
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

// randomInt(range) — uniform integer in [0, range) using Odin's unbiased bounded
// sampler backed by the crypto system-entropy generator. JS validates Node's
// min/max contract and adds min afterward.
crypto_random_int_cb :: proc "c" (
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

	range := u64(jsc.JSValueToNumber(ctx, arguments[0], nil))
	max_48 :: u64(1) << 48

	if range == 0 || range > max_48 {
		if exception != nil {
			exception^ = make_js_error(ctx, "randomInt range must be in (0, 2^48]")
		}

		return jsc.JSValueMakeUndefined(ctx)
	}

	value := rand.uint64_max(range, crypto.random_generator())
	return jsc.JSValueMakeNumber(ctx, f64(value))
}

// timingSafeEqual(a, b) — constant-time byte comparison for equal-length typed
// arrays. JS keeps Node's length-mismatch RangeError behavior before calling.
crypto_timing_safe_equal_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()

	if argument_count < 2 {
		return jsc.JSValueMakeBoolean(ctx, false)
	}

	a, a_ok := typed_array_view(ctx, arguments[0])
	b, b_ok := typed_array_view(ctx, arguments[1])

	if !a_ok || !b_ok {
		if exception != nil {
			exception^ = make_js_error(ctx, "timingSafeEqual expects Uint8Array arguments")
		}

		return jsc.JSValueMakeUndefined(ctx)
	}

	return jsc.JSValueMakeBoolean(ctx, b32(crypto.compare_constant_time(a, b) == 1))
}

// TODO(crypto-native-api): js/node/crypto.js now exposes throwing templates
// for every missing top-level Node crypto export. Add native callbacks here as
// those APIs graduate from placeholders and need Odin-backed primitives:
//
//   - key/signature/cipher APIs: KeyObject, createPrivateKey/createPublicKey,
//     createSecretKey, sign/verify, createSign/createVerify, public/private
//     encrypt/decrypt, createCipheriv/createDecipheriv
//   - key exchange/KEM APIs: DiffieHellman, DiffieHellmanGroup, ECDH,
//     diffieHellman, encapsulate, decapsulate
//   - key generation/prime APIs: generateKey*, generateKeyPair*, generatePrime*,
//     checkPrime*
//   - hashing/KDF APIs: createHash/createHmac, pbkdf2, hkdf, scrypt and argon2*
//     (the first four were removed with the Node profile; core:crypto/{hash,hmac,
//     pbkdf2,hkdf,argon2id} would back them again)
//   - metadata/webcrypto APIs: getCiphers, getCipherInfo, getCurves,
//     getDiffieHellman, setFips/setEngine, secureHeapUsed, webcrypto/subtle
//     (getFips is a constant 0 in JS — Lava has no FIPS provider)
//   - randomness aliases/features: getRandomValues and randomUUIDv7

// make_crypto_bindings builds the `native` object handed to js/node/crypto.js.
make_crypto_bindings :: proc(ctx: jsc.JSContextRef) -> jsc.JSObjectRef {
	bindings := jsc.JSObjectMake(ctx, nil, nil)
	inject_native_function(ctx, bindings, "randomFill", crypto_random_fill_cb)
	inject_native_function(ctx, bindings, "randomInt", crypto_random_int_cb)
	inject_native_function(ctx, bindings, "timingSafeEqual", crypto_timing_safe_equal_cb)
	return bindings
}
