package lava_runtime

import "base:runtime"
import "core:c"
import "core:crypto"
import "core:crypto/hash"
import "core:crypto/hkdf"
import "core:crypto/hmac"
import "core:crypto/pbkdf2"
import "core:math/rand"
import jsc "lava:pkg/jsc"

// Native backing for the node:crypto built-in. The JavaScript surface
// (createHash/createHmac/randomBytes/pbkdf2/...) lives in js/node/crypto.js
// and consults these primitives through the `native` bindings object the loader
// passes as the factory's fourth argument — the same pattern `console` uses to
// receive its write primitives without exposing them on globalThis.
//
// Entropy comes from crypto.rand_bytes (the OS CSPRNG: getentropy on Darwin,
// getrandom on Linux, BCryptGenRandom on Windows), replacing the Math.random
// placeholder the pure-JS module shipped with.

// crypto_algorithm maps a canonical Node digest name to an Odin hash.Algorithm.
// The JS layer (js/node/crypto.js) lowercases the name and resolves every
// OpenSSL/Node alias (RSA-SHA256, sha256WithRSAEncryption, ssl3-md5, …) to one
// of the canonical names below before crossing the boundary, and rejects any
// digest Lava does not support — so this switch only handles the canonical set
// and returns (.Invalid, false) defensively for anything unexpected.
crypto_algorithm :: proc(name: string) -> (hash.Algorithm, bool) {
	switch name {
	case "md5":
		return .Insecure_MD5, true
	case "sha1":
		return .Insecure_SHA1, true
	case "sha224":
		return .SHA224, true
	case "sha256":
		return .SHA256, true
	case "sha384":
		return .SHA384, true
	case "sha512":
		return .SHA512, true
	case "sha512-256":
		return .SHA512_256, true
	case "sha3-224":
		return .SHA3_224, true
	case "sha3-256":
		return .SHA3_256, true
	case "sha3-384":
		return .SHA3_384, true
	case "sha3-512":
		return .SHA3_512, true

	// BLAKE2 and SM3, served by the same core:crypto/hash interface. The generic
	// digest sizes (BLAKE2b=64, BLAKE2s=32, SM3=32) match Node's blake2b512 /
	// blake2s256 / sm3, and BLOCK_SIZES exist for all three so HMAC/PBKDF2/HKDF
	// work without any extra wiring.
	case "blake2b512":
		return .BLAKE2B, true
	case "blake2s256":
		return .BLAKE2S, true
	case "sm3":
		return .SM3, true
	}
	return .Invalid, false
}

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

// hash(algorithm, data) — one-shot digest. The JS layer accumulates update()
// chunks and concatenates them into `data` before calling here, so streaming
// state never has to cross the boundary.
crypto_hash_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()

	if argument_count < 2 {
		return jsc.JSValueMakeUndefined(ctx)
	}

	name, alloc := jsc_value_to_string_or_default(ctx, arguments[0])
	defer if alloc {
		delete(name, context.allocator)
	}

	algo, valid := crypto_algorithm(name)

	if !valid {
		if exception != nil {
			exception^ = make_js_error(ctx, "Digest method not supported")
		}

		return jsc.JSValueMakeUndefined(ctx)
	}

	data, ok := typed_array_view(ctx, arguments[1])

	if !ok {
		if exception != nil {
			exception^ = make_js_error(ctx, "hash expects a Uint8Array")
		}

		return jsc.JSValueMakeUndefined(ctx)
	}

	dst := make([]byte, hash.DIGEST_SIZES[algo], context.allocator)
	hash.hash_bytes_to_buffer(algo, data, dst)
	return make_uint8_array(ctx, dst)
}

// hmac(algorithm, key, data) — one-shot HMAC, mirroring crypto_hash_cb.
crypto_hmac_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()

	if argument_count < 3 {
		return jsc.JSValueMakeUndefined(ctx)
	}

	name, alloc := jsc_value_to_string_or_default(ctx, arguments[0])
	defer if alloc {
		delete(name, context.allocator)
	}

	algo, valid := crypto_algorithm(name)

	if !valid {
		if exception != nil {
			exception^ = make_js_error(ctx, "Digest method not supported")
		}

		return jsc.JSValueMakeUndefined(ctx)
	}

	key, key_ok := typed_array_view(ctx, arguments[1])
	data, data_ok := typed_array_view(ctx, arguments[2])

	if !key_ok || !data_ok {
		if exception != nil {
			exception^ = make_js_error(ctx, "hmac expects Uint8Array key and data")
		}

		return jsc.JSValueMakeUndefined(ctx)
	}

	dst := make([]byte, hash.DIGEST_SIZES[algo], context.allocator)
	hmac.sum(algo, dst, data, key)
	return make_uint8_array(ctx, dst)
}

// pbkdf2(algorithm, password, salt, iterations, keylen) — derive `keylen` bytes.
crypto_pbkdf2_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()

	if argument_count < 5 {
		return jsc.JSValueMakeUndefined(ctx)
	}

	name, alloc := jsc_value_to_string_or_default(ctx, arguments[0])
	defer if alloc {
		delete(name, context.allocator)
	}

	algo, valid := crypto_algorithm(name)

	if !valid {
		if exception != nil {
			exception^ = make_js_error(ctx, "Digest method not supported")
		}

		return jsc.JSValueMakeUndefined(ctx)
	}

	// JSValueToNumber can run JS (valueOf) — read the numbers before borrowing
	// the views; see the note in buffer_utf16le_write_into_cb (buffer.odin).
	iterations := u32(jsc.JSValueToNumber(ctx, arguments[3], nil))
	keylen := int(jsc.JSValueToNumber(ctx, arguments[4], nil))

	if iterations == 0 || keylen <= 0 {
		if exception != nil {
			exception^ = make_js_error(ctx, "pbkdf2 requires positive iterations and keylen")
		}

		return jsc.JSValueMakeUndefined(ctx)
	}

	password, pw_ok := typed_array_view(ctx, arguments[1])
	salt, salt_ok := typed_array_view(ctx, arguments[2])

	if !pw_ok || !salt_ok {
		if exception != nil {
			exception^ = make_js_error(ctx, "pbkdf2 expects Uint8Array password and salt")
		}

		return jsc.JSValueMakeUndefined(ctx)
	}

	dst := make([]byte, keylen, context.allocator)
	pbkdf2.derive(algo, password, salt, iterations, dst)
	return make_uint8_array(ctx, dst)
}

// hkdf(algorithm, ikm, salt, info, keylen) — RFC 5869 extract+expand. The
// derived key bytes are returned as a Uint8Array; the JS shim exposes the
// backing ArrayBuffer to match Node's hkdfSync().
crypto_hkdf_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()

	if argument_count < 5 {
		return jsc.JSValueMakeUndefined(ctx)
	}

	name, alloc := jsc_value_to_string_or_default(ctx, arguments[0])
	defer if alloc {
		delete(name, context.allocator)
	}

	algo, valid := crypto_algorithm(name)

	if !valid {
		if exception != nil {
			exception^ = make_js_error(ctx, "Digest method not supported")
		}

		return jsc.JSValueMakeUndefined(ctx)
	}

	// JSValueToNumber can run JS (valueOf) — read it before borrowing the views;
	// see the note in buffer_utf16le_write_into_cb (buffer.odin).
	keylen := int(jsc.JSValueToNumber(ctx, arguments[4], nil))
	hash_len := hash.DIGEST_SIZES[algo]

	if keylen < 0 || keylen > 255 * hash_len {
		if exception != nil {
			exception^ = make_js_error(ctx, "Invalid key length")
		}

		return jsc.JSValueMakeUndefined(ctx)
	}

	ikm, ikm_ok := typed_array_view(ctx, arguments[1])
	salt, salt_ok := typed_array_view(ctx, arguments[2])
	info, info_ok := typed_array_view(ctx, arguments[3])

	if !ikm_ok || !salt_ok || !info_ok {
		if exception != nil {
			exception^ = make_js_error(ctx, "hkdf expects Uint8Array ikm, salt, and info")
		}

		return jsc.JSValueMakeUndefined(ctx)
	}

	dst := make([]byte, keylen, context.allocator)
	hkdf.extract_and_expand(algo, salt, ikm, info, dst)
	return make_uint8_array(ctx, dst)
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
//   - password hashing/KDF APIs: argon2* (scrypt is implemented in JS on top of
//     the PBKDF2 primitive; core:crypto/argon2id could back argon2* in a follow-up)
//   - metadata/webcrypto APIs: getCiphers, getCipherInfo, getCurves,
//     getDiffieHellman, setFips/setEngine, secureHeapUsed, webcrypto/subtle
//     (getFips is a constant 0 in JS — Lava has no FIPS provider)
//   - randomness aliases/features: getRandomValues and randomUUIDv7

// make_crypto_bindings builds the `native` object handed to js/node/crypto.js.
make_crypto_bindings :: proc(ctx: jsc.JSContextRef) -> jsc.JSObjectRef {
	bindings := jsc.JSObjectMake(ctx, nil, nil)
	inject_native_function(ctx, bindings, "randomFill", crypto_random_fill_cb)
	inject_native_function(ctx, bindings, "randomInt", crypto_random_int_cb)
	inject_native_function(ctx, bindings, "hash", crypto_hash_cb)
	inject_native_function(ctx, bindings, "hmac", crypto_hmac_cb)
	inject_native_function(ctx, bindings, "pbkdf2", crypto_pbkdf2_cb)
	inject_native_function(ctx, bindings, "hkdf", crypto_hkdf_cb)
	inject_native_function(ctx, bindings, "timingSafeEqual", crypto_timing_safe_equal_cb)
	return bindings
}
