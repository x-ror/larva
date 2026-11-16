// node:crypto — hashing, HMAC, CSPRNG and PBKDF2 backed by the Odin crypto
// stdlib. The `native` bindings object (fourth factory argument, supplied by the
// loader) exposes primitives implemented in pkg/runtime/crypto.odin:
//
//   native.randomFill(typedArray)              -> fills in place with OS CSPRNG bytes
//   native.randomInt(range)                    -> uniform integer in [0, range)
//   native.hash(algo, Uint8Array)              -> digest Uint8Array
//   native.hmac(algo, key, data)               -> HMAC Uint8Array
//   native.pbkdf2(algo, password, salt, it, n) -> derived-key Uint8Array
//   native.hkdf(algo, ikm, salt, info, n)      -> derived-key Uint8Array
//   native.timingSafeEqual(a, b)               -> constant-time boolean
//
// Streaming (createHash().update()…digest()) is handled here by accumulating
// chunks and calling the one-shot native primitive once at digest time, so no
// streaming state has to cross the native boundary.
//
// Higher-level KDFs that decompose into the primitives above are built in JS:
// scrypt (RFC 7914) runs Salsa20/8 + BlockMix/ROMix here on top of
// native.pbkdf2 (PBKDF2-HMAC-SHA256), so it needs no extra native code and is
// identical on every platform. OpenSSL/Node digest aliases (e.g. RSA-SHA256 ->
// sha256) are normalized to canonical names here too, so the native layer only
// ever sees the names in HASHES.
(function (require, module, exports, native) {
  'use strict';

  var Buffer = require('buffer').Buffer;

  // Argument-validation helpers mirroring Node's internal validators, so bad
  // input fails with Node's error class + code instead of being silently
  // coerced (a zero-filled buffer, a wrapped iteration count, a clamped range).
  function inspectReceived(value) {
    if (value === null) return 'null';
    var t = typeof value;
    if (t === 'undefined') return 'undefined';
    // -0 renders as "-0" in Node (util.inspect); string concatenation erases the
    // sign. Same fix as buffer.js/encoding.js's copies of this helper.
    if (t === 'number')
      return 'type number (' + (value === 0 && 1 / value < 0 ? '-0' : value) + ')';
    if (t === 'boolean') return 'type boolean (' + value + ')';
    // A bigint keeps Node's trailing "n" (util.inspect(10n) === '10n'), which bare
    // string coercion ('' + 10n === '10') drops — matches os.js/buffer.js.
    if (t === 'bigint') return 'type bigint (' + value + 'n)';
    if (t === 'string') return 'type string';
    if (t === 'symbol') return 'type symbol';
    if (t === 'function') return 'function ' + (value.name || '(anonymous)');
    if (value && value.constructor && value.constructor.name)
      return 'an instance of ' + value.constructor.name;
    return 'type object';
  }
  function invalidArgType(name, expected, value) {
    var err = new TypeError(
      'The "' + name + '" argument must be ' + expected + '. Received ' + inspectReceived(value),
    );
    err.code = 'ERR_INVALID_ARG_TYPE';
    return err;
  }
  function outOfRange(name, range, value) {
    var err = new RangeError(
      'The value of "' + name + '" is out of range. It must be ' + range + '. Received ' + value,
    );
    err.code = 'ERR_OUT_OF_RANGE';
    return err;
  }
  // Node's validateInt32: number, integer, within [min, max] (default int32 range).
  function validateInt32(value, name, min, max) {
    if (min === undefined) min = -0x80000000;
    if (max === undefined) max = 0x7fffffff;
    if (typeof value !== 'number') throw invalidArgType(name, 'of type number', value);
    if (!Number.isInteger(value)) throw outOfRange(name, 'an integer', value);
    if (value < min || value > max) throw outOfRange(name, '>= ' + min + ' && <= ' + max, value);
    return value;
  }
  // A byte count (randomBytes size): must be a number in [0, 2^31-1] and not
  // NaN, but — matching Node — a fractional value is truncated, not rejected.
  function validateByteCount(value, name) {
    if (typeof value !== 'number') throw invalidArgType(name, 'of type number', value);
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
    throw invalidArgType(
      name || 'data',
      'of type string or an instance of Buffer, TypedArray, or DataView',
      data,
    );
  }

  function concat(chunks) {
    if (chunks.length === 1) return chunks[0];
    var total = 0,
      i;
    for (i = 0; i < chunks.length; i++) total += chunks[i].length;
    var out = new Uint8Array(total),
      off = 0;
    for (i = 0; i < chunks.length; i++) {
      out.set(chunks[i], off);
      off += chunks[i].length;
    }
    return out;
  }

  function finalizedError() {
    var err = new Error('Digest already called');
    err.code = 'ERR_CRYPTO_HASH_FINALIZED';
    return err;
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
    var err = new TypeError('Invalid digest: ' + name);
    err.code = 'ERR_CRYPTO_INVALID_DIGEST';
    return err;
  }

  function getHashes() {
    return HASHES.concat(ALIAS_DISPLAY_NAMES);
  }

  function notImplemented(name) {
    return function () {
      var err = new Error('node:crypto ' + name + ' is not implemented in Lava');
      err.code = 'ERR_NOT_IMPLEMENTED';
      throw err;
    };
  }

  function notImplementedConstructor(name) {
    return function () {
      var err = new Error('node:crypto ' + name + ' is not implemented in Lava');
      err.code = 'ERR_NOT_IMPLEMENTED';
      throw err;
    };
  }

  // Hash/Hmac accumulate chunks and call the one-shot native primitive at
  // digest time (no streaming state crosses the boundary). Methods live on the
  // prototype and the constructors are exported so the surface matches Node,
  // where createHash()/createHmac() return Hash/Hmac instances.

  function Hash(algorithm) {
    if (!(this instanceof Hash)) return new Hash(algorithm);
    var algo = resolveDigest(algorithm);
    if (!algo) throw unsupportedDigestError();
    this._algo = algo;
    this._chunks = [];
    this._finalized = false;
  }
  Hash.prototype.update = function (data, encoding) {
    if (this._finalized) throw finalizedError();
    this._chunks.push(toU8(data, encoding));
    return this;
  };
  Hash.prototype.digest = function (encoding) {
    if (this._finalized) throw finalizedError();
    this._finalized = true;
    var out = Buffer.from(native.hash(this._algo, concat(this._chunks)));
    return encoding ? out.toString(encoding) : out;
  };
  Hash.prototype.copy = function () {
    if (this._finalized) throw finalizedError();
    var clone = new Hash(this._algo);
    clone._chunks = this._chunks.slice();
    return clone;
  };

  function Hmac(algorithm, key) {
    if (!(this instanceof Hmac)) return new Hmac(algorithm, key);
    var algo = resolveDigest(algorithm);
    if (!algo) throw invalidDigestError(algorithm);
    this._algo = algo;
    this._key = toU8(key, undefined, 'key');
    this._chunks = [];
    this._finalized = false;
  }
  Hmac.prototype.update = function (data, encoding) {
    if (this._finalized) throw finalizedError();
    this._chunks.push(toU8(data, encoding));
    return this;
  };
  Hmac.prototype.digest = function (encoding) {
    if (this._finalized) {
      var empty = Buffer.alloc(0);
      return encoding ? empty.toString(encoding) : empty;
    }
    this._finalized = true;
    var out = Buffer.from(native.hmac(this._algo, this._key, concat(this._chunks)));
    return encoding ? out.toString(encoding) : out;
  };

  function createHash(algorithm) {
    return new Hash(algorithm);
  }

  function createHmac(algorithm, key) {
    return new Hmac(algorithm, key);
  }

  // crypto.hash(algorithm, data[, outputEncoding]) — one-shot digest (Node 21+).
  // outputEncoding defaults to "hex"; "buffer" yields a Buffer.
  function hash(algorithm, data, outputEncoding) {
    var algo = resolveDigest(algorithm);
    if (!algo) throw unsupportedDigestError(algorithm);
    var out = Buffer.from(native.hash(algo, toU8(data)));
    if (outputEncoding === undefined || outputEncoding === 'hex') return out.toString('hex');
    if (outputEncoding === 'buffer') return out;
    return out.toString(outputEncoding);
  }

  // Every CSPRNG entry point goes through this, and none calls native.randomFill
  // directly. The native returns the view it filled, so an identity check is the
  // available proof that the fill ran. Second layer, not the first: the
  // dispatcher already fails closed against the miss-forges-entropy scenario
  // (the canonical write-up is at host_dispatch_fail, pkg/runtime/
  // host_natives.odin), but that layer is one registration decision away from
  // not covering this native, and a wrong answer here is silent forged entropy.
  // The error is deliberately not a Node ERR_* code: Node has no counterpart,
  // because in Node this cannot happen.
  function fillRandom(view) {
    if (native.randomFill(view) !== view)
      throw new Error('lava: CSPRNG unavailable (native.randomFill did not fill the buffer)');
    return view;
  }

  function randomBytes(size, callback) {
    // Node validates size as 0..2^31-1 (NaN rejected, fractional truncated); a
    // negative/huge value used to wrap into a multi-gigabyte allocation instead
    // of a catchable RangeError.
    size = validateByteCount(size, 'size');
    var buf = Buffer.alloc(size);
    if (size > 0) fillRandom(buf);
    if (typeof callback === 'function') {
      // Node completes a zero-size request synchronously (it queues no work for
      // zero bytes); only real fills report their completion asynchronously.
      if (size === 0) {
        callback(null, buf);
        return;
      }
      setImmediate(function () {
        callback(null, buf);
      });
      return;
    }
    return buf;
  }

  // assertOffset/assertSize mirror Node: offset and size are counted in
  // elements, converted to bytes against the view, and validated. An oversized
  // size now throws ERR_OUT_OF_RANGE instead of silently filling fewer bytes.
  function assertOffset(offset, elementSize, byteLength) {
    if (typeof offset !== 'number') throw invalidArgType('offset', 'of type number', offset);
    var bytes = offset * elementSize;
    if (Number.isNaN(bytes) || bytes < 0 || bytes > byteLength)
      throw outOfRange('offset', '>= 0 && <= ' + byteLength / elementSize, offset);
    return bytes >>> 0;
  }
  function assertSize(size, elementSize, offsetBytes, byteLength) {
    if (typeof size !== 'number') throw invalidArgType('size', 'of type number', size);
    var bytes = size * elementSize;
    if (Number.isNaN(bytes) || bytes < 0 || bytes > 0x7fffffff)
      throw outOfRange('size', '>= 0 && <= ' + 0x7fffffff, size);
    if (bytes + offsetBytes > byteLength)
      throw outOfRange('size + offset', '<= ' + byteLength, bytes + offsetBytes);
    return bytes >>> 0;
  }

  // Shared buf/offset/size validation for randomFillSync and randomFill,
  // resolving to the byte range to fill. Split out so randomFill can validate
  // SYNCHRONOUSLY the way Node does — only the fill itself is deferred.
  function resolveFillRange(buffer, offset, size) {
    var ab, base, byteLength, elementSize;
    if (ArrayBuffer.isView(buffer)) {
      ab = buffer.buffer;
      base = buffer.byteOffset;
      byteLength = buffer.byteLength;
      elementSize = buffer.BYTES_PER_ELEMENT || 1;
    } else if (
      buffer instanceof ArrayBuffer ||
      (typeof SharedArrayBuffer !== 'undefined' && buffer instanceof SharedArrayBuffer)
    ) {
      ab = buffer;
      base = 0;
      byteLength = buffer.byteLength;
      elementSize = 1;
    } else {
      throw invalidArgType(
        'buf',
        'an instance of ArrayBuffer, Buffer, TypedArray, or DataView',
        buffer,
      );
    }
    var offsetBytes = assertOffset(offset === undefined ? 0 : offset, elementSize, byteLength);
    var sizeBytes =
      size === undefined
        ? byteLength - offsetBytes
        : assertSize(size, elementSize, offsetBytes, byteLength);
    return { base: base + offsetBytes, ab: ab, sizeBytes: sizeBytes };
  }

  function randomFillSync(buffer, offset, size) {
    var r = resolveFillRange(buffer, offset, size);
    if (r.sizeBytes > 0) fillRandom(new Uint8Array(r.ab, r.base, r.sizeBytes));
    return buffer;
  }

  function randomFill(buffer, offset, size, callback) {
    if (typeof offset === 'function') {
      callback = offset;
      offset = undefined;
      size = undefined;
    } else if (typeof size === 'function') {
      callback = size;
      size = undefined;
    }
    if (typeof callback !== 'function') throw new TypeError('Callback must be a function');
    // Validate now — Node throws a bad buf/offset/size from randomFill itself
    // (deferring it turned a synchronous TypeError into an uncaught async one)
    // and completes a zero-byte request synchronously, queueing no work for it.
    var r = resolveFillRange(buffer, offset, size);
    if (r.sizeBytes === 0) {
      callback(null, buffer);
      return;
    }
    setImmediate(function () {
      fillRandom(new Uint8Array(r.ab, r.base, r.sizeBytes));
      callback(null, buffer);
    });
  }

  var HEX = '0123456789abcdef';

  function randomUUID() {
    var b = randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var s = '';
    for (var i = 0; i < 16; i++) {
      s += HEX[(b[i] >> 4) & 0xf] + HEX[b[i] & 0xf];
      if (i === 3 || i === 5 || i === 7 || i === 9) s += '-';
    }
    return s;
  }

  // WHATWG crypto.getRandomValues: fill an integer TypedArray in place with
  // CSPRNG bytes and return it. Float views and DataView are rejected; the spec
  // caps a single call at 65536 bytes.
  function getRandomValues(typedArray) {
    if (
      typedArray == null ||
      typeof typedArray.byteLength !== 'number' ||
      !(typedArray.buffer instanceof ArrayBuffer) ||
      typedArray instanceof Float32Array ||
      typedArray instanceof Float64Array ||
      (typeof DataView !== 'undefined' && typedArray instanceof DataView)
    ) {
      throw new TypeError('The data argument must be an integer-type TypedArray');
    }
    if (typedArray.byteLength > 65536) {
      throw new RangeError(
        "The ArrayBufferView's byte length (" +
          typedArray.byteLength +
          ') exceeds the number of bytes of entropy available via this API (65536)',
      );
    }
    if (typedArray.byteLength > 0) {
      fillRandom(new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength));
    }
    return typedArray;
  }

  // Constant-time comparison: never short-circuits on the first differing byte.
  // Node requires both operands to be ArrayBufferView/ArrayBuffer — strings and
  // numbers are rejected (a number used to be zero-filled, so timingSafeEqual(5,
  // 5) wrongly returned true).
  function requireBufferSource(value, name) {
    if (!ArrayBuffer.isView(value) && !(value instanceof ArrayBuffer))
      throw invalidArgType(
        name,
        'an instance of ArrayBuffer, Buffer, TypedArray, or DataView',
        value,
      );
  }
  function timingSafeEqual(a, b) {
    requireBufferSource(a, 'a');
    requireBufferSource(b, 'b');
    var ua = toU8(a),
      ub = toU8(b);
    if (ua.length !== ub.length) {
      var err = new RangeError('Input buffers must have the same byte length');
      err.code = 'ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH';
      throw err;
    }
    return native.timingSafeEqual(ua, ub);
  }

  // randomInt([min, ] max[, callback]) — uniform integer in [min, max).
  // Node caps the range at 2^48; native.randomInt handles rejection sampling.
  function randomInt(min, max, callback) {
    if (typeof min === 'function') {
      callback = min;
      min = undefined;
      max = undefined;
    } else if (typeof max === 'function') {
      callback = max;
      max = undefined;
    }
    if (max === undefined) {
      max = min;
      min = 0;
    }
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max)) {
      throw new RangeError('The value of "min"/"max" is out of range. It must be a safe integer.');
    }
    if (max <= min)
      throw new RangeError(
        'The value of "max" is out of range. It must be greater than the value of "min".',
      );
    var range = max - min;
    if (range > 0x1000000000000)
      throw new RangeError('The value of "max - min" is out of range. It must be <= 2^48.');

    function sample() {
      return min + native.randomInt(range);
    }

    if (typeof callback === 'function') {
      setImmediate(function () {
        var value;
        try {
          value = sample();
        } catch (err) {
          callback(err);
          return;
        }
        callback(null, value);
      });
      return;
    }
    return sample();
  }

  function pbkdf2Sync(password, salt, iterations, keylen, digest) {
    if (typeof digest !== 'string') throw invalidArgType('digest', 'of type string', digest);
    var algo = resolveDigest(digest);
    if (!algo) throw invalidDigestError(digest);
    var pw = toU8(password, undefined, 'password');
    var slt = toU8(salt, undefined, 'salt');
    // Node validates iterations as 1..2^31-1 and keylen as 0..2^31-1. The old
    // `iterations >>> 0` turned -1 into 4294967295 (a permanent sync hang) and
    // wrapped values >= 2^32 to a different derived key.
    validateInt32(iterations, 'iterations', 1);
    validateInt32(keylen, 'keylen', 0);
    var out = native.pbkdf2(algo, pw, slt, iterations, keylen);
    return Buffer.from(out);
  }

  function pbkdf2(password, salt, iterations, keylen, digest, callback) {
    if (typeof callback !== 'function') throw new TypeError('Callback must be a function');
    setImmediate(function () {
      var key;
      try {
        key = pbkdf2Sync(password, salt, iterations, keylen, digest);
      } catch (err) {
        callback(err);
        return;
      }
      callback(null, key);
    });
  }

  // hkdfSync(digest, ikm, salt, info, keylen) — RFC 5869 HKDF over the native
  // crypto primitive. Returns an ArrayBuffer, matching Node.
  function hkdfSync(digest, ikm, salt, info, keylen) {
    var algo = resolveDigest(digest);
    if (!algo) throw invalidDigestError(digest);
    return native.hkdf(algo, toU8(ikm), toU8(salt), toU8(info), keylen).buffer;
  }

  function hkdf(digest, ikm, salt, info, keylen, callback) {
    if (typeof callback !== 'function') throw new TypeError('Callback must be a function');
    setImmediate(function () {
      var key;
      try {
        key = hkdfSync(digest, ikm, salt, info, keylen);
      } catch (err) {
        callback(err);
        return;
      }
      callback(null, key);
    });
  }

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
        var err = new TypeError(
          'Option "' + primary + '" cannot be used in combination with option "' + alias + '"',
        );
        err.code = 'ERR_INCOMPATIBLE_OPTION_PAIR';
        throw err;
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
    var err = new RangeError(message || 'Invalid scrypt params');
    err.code = 'ERR_CRYPTO_INVALID_SCRYPT_PARAMS';
    return err;
  }

  function scryptDerive(password, salt, keylen, options) {
    if (!Number.isInteger(keylen) || keylen < 0 || keylen > 0x7fffffff) {
      var rerr = new RangeError(
        'The value of "keylen" is out of range. It must be >= 0 && <= 2147483647. Received ' +
          keylen,
      );
      rerr.code = 'ERR_OUT_OF_RANGE';
      throw rerr;
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
    Hash: Hash,
    Hmac: Hmac,
    createHash: createHash,
    createHmac: createHmac,
    hash: hash,
    getHashes: getHashes,
    timingSafeEqual: timingSafeEqual,
    randomBytes: randomBytes,
    randomFillSync: randomFillSync,
    randomFill: randomFill,
    randomInt: randomInt,
    randomUUID: randomUUID,
    pbkdf2: pbkdf2,
    pbkdf2Sync: pbkdf2Sync,
    hkdf: hkdf,
    hkdfSync: hkdfSync,
    scrypt: scrypt,
    scryptSync: scryptSync,
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

  // WHATWG Web Crypto global. Only the random surface is provided here;
  // crypto.subtle is a follow-up. Eager-required by loader.js so it is present
  // without an explicit require.
  if (globalThis.crypto === undefined) {
    globalThis.crypto = {
      randomUUID: randomUUID,
      getRandomValues: getRandomValues,
    };
  }

  module.exports = exported;
});
