// node:crypto — the CSPRNG and timingSafeEqual, backed by the Odin crypto stdlib. The
// `native` bindings object (fourth factory argument, supplied by the loader) exposes
// primitives implemented in pkg/runtime/crypto.odin:
//
//   native.randomFill(typedArray)              -> fills in place with OS CSPRNG bytes
//   native.randomInt(range)                    -> uniform integer in [0, range)
//   native.timingSafeEqual(a, b)               -> constant-time boolean
//
// The implementation is split along node's lib/internal/crypto seams:
// internal/crypto/{util,random}.js. This file stays the public entry: it assembles the
// exports and keeps timingSafeEqual where node keeps it (lib/crypto.js). The WHATWG
// `globalThis.crypto` is installed by internal/crypto/random.js, so the Window surface
// has it without this file. The loader hands random this same `native` object (see
// bootstrap/loader.js), so there is one binding set per context.
//
// Hashing, HMAC and the KDFs (createHash/createHmac/hash/getHashes, pbkdf2, hkdf,
// scrypt) went with the Node-profile removal (docs/LARVA.md decision 1): no page can
// reach node:crypto, and the Window profile's `crypto.subtle` is to be built on
// core:crypto when it is needed, not on these Node shapes.
(function (require, module, exports, native) {
  'use strict';

  var P = require('internal/primordials');
  var nativeError = require('internal/errors').nativeError;
  var util = require('internal/crypto/util');
  var toU8 = util.toU8;
  var random = require('internal/crypto/random');
  var randomBytes = random.randomBytes;
  var randomFillSync = random.randomFillSync;
  var randomFill = random.randomFill;
  var randomInt = random.randomInt;
  var randomUUID = random.randomUUID;
  var getRandomValues = random.getRandomValues;

  function notImplemented(name) {
    return function () {
      throw nativeError(
        P.Error,
        'ERR_NOT_IMPLEMENTED',
        'node:crypto ' + name + ' is not implemented in Lava',
      );
    };
  }

  function notImplementedConstructor(name) {
    return function () {
      throw nativeError(
        P.Error,
        'ERR_NOT_IMPLEMENTED',
        'node:crypto ' + name + ' is not implemented in Lava',
      );
    };
  }

  // Constant-time comparison: never short-circuits on the first differing byte.
  // Node requires both operands to be ArrayBufferView/ArrayBuffer — strings and
  // numbers are rejected (a number used to be zero-filled, so timingSafeEqual(5,
  // 5) wrongly returned true).
  // node's C++ TimingSafeEqual throws this one: no Received tail, no [code] in String(e).
  function requireBufferSource(value, name) {
    if (!ArrayBuffer.isView(value) && !(value instanceof ArrayBuffer))
      throw nativeError(
        P.TypeError,
        'ERR_INVALID_ARG_TYPE',
        'The "' +
          name +
          '" argument must be an instance of ArrayBuffer, Buffer, TypedArray, or DataView.',
      );
  }
  function timingSafeEqual(a, b) {
    requireBufferSource(a, 'buf1');
    requireBufferSource(b, 'buf2');
    var ua = toU8(a),
      ub = toU8(b);
    if (ua.length !== ub.length) {
      throw nativeError(
        P.RangeError,
        'ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH',
        'Input buffers must have the same byte length',
      );
    }
    return native.timingSafeEqual(ua, ub);
  }

  // getFips() reports whether the process is in FIPS mode. Lava is never built
  // against a FIPS provider, so this is always 0, matching Node's default.
  function getFips() {
    return 0;
  }

  // A small, real subset of crypto.constants (RSA padding modes). Values are
  // stable OpenSSL constants; included for code that references them even
  // before the corresponding cipher/key APIs exist.
  var constants = {
    RSA_PKCS1_PADDING: 1,
    RSA_NO_PADDING: 3,
    RSA_PKCS1_OAEP_PADDING: 4,
    RSA_PKCS1_PSS_PADDING: 6,
    RSA_PSS_SALTLEN_DIGEST: -1,
    RSA_PSS_SALTLEN_MAX_SIGN: -2,
    RSA_PSS_SALTLEN_AUTO: -2,
  };

  // TODO(crypto-api): Templates for Node crypto exports that are not
  // implemented yet. Keep these throwing until the matching JS surface and, when
  // needed, Odin native primitive are wired with compatibility tests.
  var TODO_CRYPTO_CLASSES = {
    Certificate: notImplementedConstructor('Certificate'),
    Cipheriv: notImplementedConstructor('Cipheriv'),
    Decipheriv: notImplementedConstructor('Decipheriv'),
    DiffieHellman: notImplementedConstructor('DiffieHellman'),
    DiffieHellmanGroup: notImplementedConstructor('DiffieHellmanGroup'),
    ECDH: notImplementedConstructor('ECDH'),
    KeyObject: notImplementedConstructor('KeyObject'),
    Sign: notImplementedConstructor('Sign'),
    Verify: notImplementedConstructor('Verify'),
    X509Certificate: notImplementedConstructor('X509Certificate'),
  };

  var TODO_CRYPTO_FUNCTIONS = {
    argon2: notImplemented('argon2'),
    argon2Sync: notImplemented('argon2Sync'),
    checkPrime: notImplemented('checkPrime'),
    checkPrimeSync: notImplemented('checkPrimeSync'),
    createCipheriv: notImplemented('createCipheriv'),
    createDecipheriv: notImplemented('createDecipheriv'),
    createDiffieHellman: notImplemented('createDiffieHellman'),
    createDiffieHellmanGroup: notImplemented('createDiffieHellmanGroup'),
    createECDH: notImplemented('createECDH'),
    createPrivateKey: notImplemented('createPrivateKey'),
    createPublicKey: notImplemented('createPublicKey'),
    createSecretKey: notImplemented('createSecretKey'),
    createSign: notImplemented('createSign'),
    createVerify: notImplemented('createVerify'),
    decapsulate: notImplemented('decapsulate'),
    diffieHellman: notImplemented('diffieHellman'),
    encapsulate: notImplemented('encapsulate'),
    generateKey: notImplemented('generateKey'),
    generateKeyPair: notImplemented('generateKeyPair'),
    generateKeyPairSync: notImplemented('generateKeyPairSync'),
    generateKeySync: notImplemented('generateKeySync'),
    generatePrime: notImplemented('generatePrime'),
    generatePrimeSync: notImplemented('generatePrimeSync'),
    getCipherInfo: notImplemented('getCipherInfo'),
    getCiphers: notImplemented('getCiphers'),
    getCurves: notImplemented('getCurves'),
    getDiffieHellman: notImplemented('getDiffieHellman'),
    privateDecrypt: notImplemented('privateDecrypt'),
    privateEncrypt: notImplemented('privateEncrypt'),
    publicDecrypt: notImplemented('publicDecrypt'),
    publicEncrypt: notImplemented('publicEncrypt'),
    randomUUIDv7: notImplemented('randomUUIDv7'),
    secureHeapUsed: notImplemented('secureHeapUsed'),
    setEngine: notImplemented('setEngine'),
    setFips: notImplemented('setFips'),
    sign: notImplemented('sign'),
    verify: notImplemented('verify'),
  };

  var exported = {
    timingSafeEqual: timingSafeEqual,
    randomBytes: randomBytes,
    randomFillSync: randomFillSync,
    randomFill: randomFill,
    randomInt: randomInt,
    randomUUID: randomUUID,
    getFips: getFips,
    constants: constants,
  };

  Object.keys(TODO_CRYPTO_CLASSES).forEach(function (name) {
    exported[name] = TODO_CRYPTO_CLASSES[name];
  });
  Object.keys(TODO_CRYPTO_FUNCTIONS).forEach(function (name) {
    exported[name] = TODO_CRYPTO_FUNCTIONS[name];
  });

  Object.defineProperties(exported, {
    fips: {
      get: function () {
        return 0;
      },
      set: function () {
        throw notImplemented('fips')();
      },
      configurable: true,
    },
    getRandomValues: {
      get: function () {
        return getRandomValues;
      },
      configurable: true,
    },
    prng: {
      get: function () {
        return randomBytes;
      },
      set: function () {
        throw notImplemented('prng')();
      },
      configurable: true,
    },
    pseudoRandomBytes: {
      get: function () {
        return randomBytes;
      },
      set: function () {
        throw notImplemented('pseudoRandomBytes')();
      },
      configurable: true,
    },
    rng: {
      get: function () {
        return randomBytes;
      },
      set: function () {
        throw notImplemented('rng')();
      },
      configurable: true,
    },
    subtle: {
      get: function () {
        throw notImplemented('subtle')();
      },
      configurable: true,
    },
    webcrypto: {
      get: function () {
        throw notImplemented('webcrypto')();
      },
      configurable: true,
    },
  });

  module.exports = exported;
});
