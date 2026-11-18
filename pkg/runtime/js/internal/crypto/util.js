// Shared node:crypto helpers — argument validators, byte-source coercion and the digest
// name table — where node keeps them: lib/internal/crypto/util.js (getHashes, the
// digest lookup) and lib/internal/validators.js. Every other file under
// internal/crypto/ requires this one; it requires none of them back.
(function (require, module) {
  'use strict';

  var Buffer = require('buffer').Buffer;

  // Argument-validation helpers mirroring Node's internal validators, so bad
  // input fails with Node's error class + code instead of being silently
  // coerced (a zero-filled buffer, a wrapped iteration count, a clamped range).
  // The errors themselves come from internal/errors (CLAUDE.md §5).
  var P = require('internal/primordials');
  var errors = require('internal/errors');
  var nativeError = errors.nativeError;
  var invalidArgType = errors.ERR_INVALID_ARG_TYPE;
  var outOfRange = errors.ERR_OUT_OF_RANGE;
  // Node's validateInt32: number, integer, within [min, max] (default int32 range).
  function validateInt32(value, name, min, max) {
    if (min === undefined) min = -0x80000000;
    if (max === undefined) max = 0x7fffffff;
    if (typeof value !== 'number') throw invalidArgType(name, 'number', value);
    if (!Number.isInteger(value)) throw outOfRange(name, 'an integer', value);
    if (value < min || value > max) throw outOfRange(name, '>= ' + min + ' && <= ' + max, value);
    return value;
  }
  // A byte count (randomBytes size): must be a number in [0, 2^31-1] and not
  // NaN, but — matching Node — a fractional value is truncated, not rejected.
  function validateByteCount(value, name) {
    if (typeof value !== 'number') throw invalidArgType(name, 'number', value);
    if (Number.isNaN(value) || value < 0 || value > 0x7fffffff)
      throw outOfRange(name, '>= 0 && <= ' + 0x7fffffff, value);
    return Math.trunc(value);
  }

  // toU8 accepts the byte sources Node accepts (string + Buffer/TypedArray/
  // DataView/ArrayBuffer) and throws ERR_INVALID_ARG_TYPE for anything else —
  // numbers used to be silently turned into a zero-filled buffer.
  function toU8(data, encoding, name) {
    if (typeof data === 'string') return new Uint8Array(Buffer.from(data, encoding || 'utf8'));
    if (ArrayBuffer.isView(data))
      return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
    if (typeof SharedArrayBuffer !== 'undefined' && data instanceof SharedArrayBuffer)
      return new Uint8Array(new Uint8Array(data));
    throw invalidArgType(name || 'data', ['string', 'Buffer', 'TypedArray', 'DataView'], data);
  }

  // Canonical digest names — one per Odin core:crypto/hash primitive. These are
  // the only names the native layer (pkg/runtime/crypto.odin) understands; every
  // accepted alias below is normalized to one of these before it crosses the
  // boundary, so the Odin switch stays minimal.
  var HASHES = [
    'md5',
    'sha1',
    'sha224',
    'sha256',
    'sha384',
    'sha512',
    'sha512-256',
    'sha3-224',
    'sha3-256',
    'sha3-384',
    'sha3-512',
    'blake2b512',
    'blake2s256',
    'sm3',
  ];

  // Node/OpenSSL digest aliases whose underlying primitive Lava supports. Each
  // maps a canonical name to the OpenSSL signature/legacy spellings that resolve
  // to the same digest (createHash('RSA-SHA256') === createHash('sha256')). The
  // display names keep Node's exact casing for getHashes(); resolveDigest()
  // matches case-insensitively. Aliases for digests Lava lacks (RSA-RIPEMD160,
  // RSA-SHA512/224, …) are intentionally absent — see UNSUPPORTED_NODE_DIGESTS.
  var HASH_ALIAS_GROUPS = {
    md5: ['RSA-MD5', 'md5WithRSAEncryption', 'ssl3-md5'],
    sha1: ['RSA-SHA1', 'RSA-SHA1-2', 'sha1WithRSAEncryption', 'ssl3-sha1'],
    sha224: ['RSA-SHA224', 'sha224WithRSAEncryption'],
    sha256: ['RSA-SHA256', 'sha256WithRSAEncryption'],
    sha384: ['RSA-SHA384', 'sha384WithRSAEncryption'],
    sha512: ['RSA-SHA512', 'sha512WithRSAEncryption'],
    'sha512-256': ['RSA-SHA512/256', 'sha512-256WithRSAEncryption'],
    'sha3-224': ['RSA-SHA3-224', 'id-rsassa-pkcs1-v1_5-with-sha3-224'],
    'sha3-256': ['RSA-SHA3-256', 'id-rsassa-pkcs1-v1_5-with-sha3-256'],
    'sha3-384': ['RSA-SHA3-384', 'id-rsassa-pkcs1-v1_5-with-sha3-384'],
    'sha3-512': ['RSA-SHA3-512', 'id-rsassa-pkcs1-v1_5-with-sha3-512'],
    sm3: ['RSA-SM3', 'sm3WithRSAEncryption'],
  };

  // Names Node/OpenSSL accepts that Lava intentionally rejects, because Odin's
  // core:crypto/hash enum has no matching primitive. Listed for documentation
  // only; resolveDigest() returns null for anything not canonical-or-aliased, so
  // these surface the same "unsupported digest" errors as a bogus name. SHAKE is
  // an XOF (variable-length) and would need a distinct API; RIPEMD-160,
  // SHA-512/224 and md5-sha1 have no Odin primitive.
  // var UNSUPPORTED_NODE_DIGESTS = [
  //   'ripemd160', 'rmd160', 'RSA-RIPEMD160', 'ripemd160WithRSA',
  //   'sha512-224', 'RSA-SHA512/224', 'sha512-224WithRSAEncryption',
  //   'md5-sha1', 'shake128', 'shake256',
  // ];

  // ALIAS_TO_CANONICAL: lowercased alias -> canonical name. CANONICAL_SET: the
  // canonical names as a lookup. Both built once at load.
  var CANONICAL_SET = {};
  HASHES.forEach(function (name) {
    CANONICAL_SET[name] = true;
  });
  var ALIAS_TO_CANONICAL = {};
  var ALIAS_DISPLAY_NAMES = [];
  Object.keys(HASH_ALIAS_GROUPS).forEach(function (canonical) {
    HASH_ALIAS_GROUPS[canonical].forEach(function (alias) {
      ALIAS_TO_CANONICAL[alias.toLowerCase()] = canonical;
      ALIAS_DISPLAY_NAMES.push(alias);
    });
  });

  // resolveDigest maps any accepted spelling to its canonical name, or null if
  // Lava does not support it. Case-insensitive, matching OpenSSL/Node.
  function resolveDigest(name) {
    var lc = String(name).toLowerCase();
    if (CANONICAL_SET[lc]) return lc;
    return ALIAS_TO_CANONICAL[lc] || null;
  }

  // Two error shapes, matching Node exactly: createHash()/hash() throw a plain
  // Error with no code ("Digest method not supported"), while the keyed digests
  // (createHmac/pbkdf2/hkdf) throw TypeError ERR_CRYPTO_INVALID_DIGEST.
  function unsupportedDigestError(name) {
    return new Error(
      name === undefined
        ? 'Digest method not supported'
        : 'Digest method ' + name + ' is not supported',
    );
  }
  function invalidDigestError(name) {
    return nativeError(P.TypeError, 'ERR_CRYPTO_INVALID_DIGEST', 'Invalid digest: ' + name);
  }

  function getHashes() {
    return HASHES.concat(ALIAS_DISPLAY_NAMES);
  }

  module.exports = {
    invalidArgType: invalidArgType,
    outOfRange: outOfRange,
    validateInt32: validateInt32,
    validateByteCount: validateByteCount,
    toU8: toU8,
    resolveDigest: resolveDigest,
    unsupportedDigestError: unsupportedDigestError,
    invalidDigestError: invalidDigestError,
    getHashes: getHashes,
  };
});
