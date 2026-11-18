// scrypt/scryptSync — where node keeps them: lib/internal/crypto/scrypt.js.
//
// @param {{ pbkdf2: Function }} native node:crypto's bindings (the loader hands this
//   file the same object as node/crypto.js); scrypt needs only PBKDF2-HMAC-SHA256.
(function (require, module, exports, native) {
  'use strict';

  var Buffer = require('buffer').Buffer;
  var P = require('internal/primordials');
  var errors = require('internal/errors');
  var nodeError = errors.nodeError;
  var nativeError = errors.nativeError;
  var util = require('internal/crypto/util');
  var outOfRange = util.outOfRange;
  var toU8 = util.toU8;

  // scrypt (RFC 7914) — layered entirely on top of the native PBKDF2-HMAC-SHA256
  // primitive plus Salsa20/8 in JS, so it needs no extra native code and is
  // identical across platforms. Output is byte-for-byte equal to Node/OpenSSL.
  // The Salsa core and BlockMix/ROMix operate on little-endian u32 words; bytes
  // are converted explicitly so the result is correct regardless of host
  // endianness.

  function scryptSalsa20_8(B) {
    var x = new Uint32Array(16),
      i;
    for (i = 0; i < 16; i++) x[i] = B[i];
    function R(a, b) {
      return (a << b) | (a >>> (32 - b));
    }
    for (i = 0; i < 4; i++) {
      x[4] ^= R(x[0] + x[12], 7);
      x[8] ^= R(x[4] + x[0], 9);
      x[12] ^= R(x[8] + x[4], 13);
      x[0] ^= R(x[12] + x[8], 18);
      x[9] ^= R(x[5] + x[1], 7);
      x[13] ^= R(x[9] + x[5], 9);
      x[1] ^= R(x[13] + x[9], 13);
      x[5] ^= R(x[1] + x[13], 18);
      x[14] ^= R(x[10] + x[6], 7);
      x[2] ^= R(x[14] + x[10], 9);
      x[6] ^= R(x[2] + x[14], 13);
      x[10] ^= R(x[6] + x[2], 18);
      x[3] ^= R(x[15] + x[11], 7);
      x[7] ^= R(x[3] + x[15], 9);
      x[11] ^= R(x[7] + x[3], 13);
      x[15] ^= R(x[11] + x[7], 18);
      x[1] ^= R(x[0] + x[3], 7);
      x[2] ^= R(x[1] + x[0], 9);
      x[3] ^= R(x[2] + x[1], 13);
      x[0] ^= R(x[3] + x[2], 18);
      x[6] ^= R(x[5] + x[4], 7);
      x[7] ^= R(x[6] + x[5], 9);
      x[4] ^= R(x[7] + x[6], 13);
      x[5] ^= R(x[4] + x[7], 18);
      x[11] ^= R(x[10] + x[9], 7);
      x[8] ^= R(x[11] + x[10], 9);
      x[9] ^= R(x[8] + x[11], 13);
      x[10] ^= R(x[9] + x[8], 18);
      x[12] ^= R(x[15] + x[14], 7);
      x[13] ^= R(x[12] + x[15], 9);
      x[14] ^= R(x[13] + x[12], 13);
      x[15] ^= R(x[14] + x[13], 18);
    }
    for (i = 0; i < 16; i++) B[i] = (B[i] + x[i]) >>> 0;
  }

  function scryptBlockMix(B, Y, r) {
    var X = new Uint32Array(16),
      i,
      j,
      last = (2 * r - 1) * 16;
    for (i = 0; i < 16; i++) X[i] = B[last + i];
    for (i = 0; i < 2 * r; i++) {
      var off = i * 16;
      for (j = 0; j < 16; j++) X[j] ^= B[off + j];
      scryptSalsa20_8(X);
      var dest = (i % 2 === 0 ? i / 2 : r + (i - 1) / 2) * 16;
      for (j = 0; j < 16; j++) Y[dest + j] = X[j];
    }
  }

  function scryptROMix(B, N, r) {
    var len = 32 * r,
      V = new Uint32Array(len * N),
      tmp = new Uint32Array(len),
      i,
      k;
    for (i = 0; i < N; i++) {
      V.set(B, i * len);
      scryptBlockMix(B, tmp, r);
      B.set(tmp);
    }
    for (i = 0; i < N; i++) {
      var j = B[(2 * r - 1) * 16] & (N - 1),
        off = j * len;
      for (k = 0; k < len; k++) B[k] ^= V[off + k];
      scryptBlockMix(B, tmp, r);
      B.set(tmp);
    }
  }

  function scryptBytesToWordsLE(bytes, off, words, wlen) {
    for (var i = 0; i < wlen; i++) {
      var k = off + i * 4;
      words[i] =
        (bytes[k] | (bytes[k + 1] << 8) | (bytes[k + 2] << 16) | (bytes[k + 3] << 24)) >>> 0;
    }
  }
  function scryptWordsToBytesLE(words, wlen, bytes, off) {
    for (var i = 0; i < wlen; i++) {
      var v = words[i],
        k = off + i * 4;
      bytes[k] = v & 0xff;
      bytes[k + 1] = (v >>> 8) & 0xff;
      bytes[k + 2] = (v >>> 16) & 0xff;
      bytes[k + 3] = (v >>> 24) & 0xff;
    }
  }

  function isPowerOfTwo(n) {
    return n > 1 && (n & (n - 1)) === 0;
  }

  // Resolve N/r/p with Node's option-and-alias handling. cost/blockSize/
  // parallelization are aliases for N/r/p; supplying both forms of one parameter
  // throws ERR_INCOMPATIBLE_OPTION_PAIR, exactly as Node does.
  function scryptParams(options) {
    var opts = options || {};
    function pick(primary, alias, dflt) {
      var hasP = opts[primary] !== undefined;
      var hasA = opts[alias] !== undefined;
      if (hasP && hasA) {
        throw nodeError(
          P.TypeError,
          'ERR_INCOMPATIBLE_OPTION_PAIR',
          'Option "' + primary + '" cannot be used in combination with option "' + alias + '"',
        );
      }
      if (hasP) return opts[primary];
      if (hasA) return opts[alias];
      return dflt;
    }
    var N = pick('N', 'cost', 16384);
    var r = pick('r', 'blockSize', 8);
    var p = pick('p', 'parallelization', 1);
    var maxmem = opts.maxmem === undefined ? 32 * 1024 * 1024 : opts.maxmem;
    return { N: N, r: r, p: p, maxmem: maxmem };
  }

  function scryptParamsError(message) {
    return nativeError(
      P.RangeError,
      'ERR_CRYPTO_INVALID_SCRYPT_PARAMS',
      message || 'Invalid scrypt params',
    );
  }

  function scryptDerive(password, salt, keylen, options) {
    if (!Number.isInteger(keylen) || keylen < 0 || keylen > 0x7fffffff) {
      throw outOfRange('keylen', '>= 0 && <= 2147483647', keylen);
    }
    var pr = scryptParams(options);
    var N = pr.N,
      r = pr.r,
      p = pr.p;
    // N must be a power of two greater than 1; r and p must be positive ints.
    if (!Number.isInteger(N) || !isPowerOfTwo(N)) throw scryptParamsError();
    if (!Number.isInteger(r) || r < 1 || !Number.isInteger(p) || p < 1) throw scryptParamsError();
    // Memory bound, matching Node's documented ~128*N*r ceiling against maxmem.
    if (128 * N * r > pr.maxmem) throw scryptParamsError();

    var pw = toU8(password),
      slt = toU8(salt);
    var mfLen = 128 * r;
    var B = native.pbkdf2('sha256', pw, slt, 1, p * mfLen);
    var words = new Uint32Array(32 * r);
    for (var i = 0; i < p; i++) {
      scryptBytesToWordsLE(B, i * mfLen, words, 32 * r);
      scryptROMix(words, N, r);
      scryptWordsToBytesLE(words, 32 * r, B, i * mfLen);
    }
    // keylen === 0 yields an empty key without touching the native PBKDF2, which
    // (like OpenSSL) rejects a zero output length.
    if (keylen === 0) return Buffer.alloc(0);
    return Buffer.from(native.pbkdf2('sha256', pw, B, 1, keylen));
  }

  function scryptSync(password, salt, keylen, options) {
    return scryptDerive(password, salt, keylen, options);
  }

  function scrypt(password, salt, keylen, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = undefined;
    }
    if (typeof callback !== 'function') throw new TypeError('Callback must be a function');
    setImmediate(function () {
      var key;
      try {
        key = scryptDerive(password, salt, keylen, options);
      } catch (err) {
        callback(err);
        return;
      }
      callback(null, key);
    });
  }

  module.exports = { scrypt: scrypt, scryptSync: scryptSync };
});
