/**
 * @fileoverview node:buffer — `Buffer` as a `Uint8Array` subclass.
 *
 * Codecs and byte-ops are Odin natives (`pkg/runtime/buffer.odin`) injected via
 * the loader's fourth `native` argument. This file owns Node API glue, errors and
 * pooling. Blob, File and the blob: URL registry live in internal/blob.js and
 * internal/file.js (node's lib/internal layout); this module re-exports them and
 * installs their globals, in the order it always has.
 *
 * @module lava/internal/buffer
 */

(function (require, module, exports, native) {
  'use strict';

  if (!native) throw new Error('node:buffer requires native codec bindings');

  /** @param {string} name @returns {Function} */
  function requireNative(name) {
    var fn = native[name];
    if (typeof fn !== 'function') throw new Error('node:buffer missing native binding: ' + name);
    return fn;
  }

  var utf8EncodeNative = requireNative('utf8Encode');
  var utf8DecodeNative = requireNative('utf8Decode');
  var hexEncodeNative = requireNative('hexEncode');
  var hexDecodeNative = requireNative('hexDecode');
  var base64EncodeNative = requireNative('base64Encode');
  var base64DecodeNative = requireNative('base64Decode');
  var base64urlEncodeNative = requireNative('base64urlEncode');
  var latin1EncodeNative = requireNative('latin1Encode');
  var latin1DecodeNative = requireNative('latin1Decode');
  var asciiDecodeNative = requireNative('asciiDecode');
  var utf16leEncodeNative = requireNative('utf16leEncode');
  var utf16leDecodeNative = requireNative('utf16leDecode');
  var utf8WriteIntoNative = requireNative('utf8WriteInto');
  var latin1WriteIntoNative = requireNative('latin1WriteInto');
  var utf16leWriteIntoNative = requireNative('utf16leWriteInto');
  var utf8ByteLengthNative = requireNative('utf8ByteLength');
  var base64ByteLengthNative = requireNative('base64ByteLength');
  var swapInPlaceNative = requireNative('swapInPlace');
  var nativeCompare = requireNative('compare');
  var nativeIndexOf = requireNative('indexOf');
  var nativeIsValidUtf8 = requireNative('isValidUtf8');
  /** @type {((size: number) => Uint8Array|null)|null} */
  var nativeAllocUninit = typeof native.allocUninit === 'function' ? native.allocUninit : null;

  var EMPTY_U8 = new Uint8Array(0);
  var u8Fill = Uint8Array.prototype.fill;

  // Encoding-name resolution is hardened ahead of the rest of this module because
  // internal/encoding.js routes TextEncoder.encode and the TextDecoder utf-8 fast
  // path through Buffer: a replaced `String` global or a poisoned
  // `String.prototype.toLowerCase` reached a hardened TextDecoder through here and
  // turned a valid decode into `Unknown encoding: …`. The rest of buffer.js is not
  // yet converted (see tests/node-compat/pollution-baseline.json).
  var P = require('internal/primordials');
  var StringG = String;
  var StringPrototypeToLowerCase = P.StringPrototypeToLowerCase;
  var StringPrototypeCharCodeAt = P.StringPrototypeCharCodeAt;
  var StringPrototypeSlice = P.StringPrototypeSlice;
  var StringFromCharCode = String.fromCharCode;
  var ObjectPrototypeHasOwnProperty = P.ObjectPrototypeHasOwnProperty;
  var TypedArrayPrototypeGetLength = P.TypedArrayPrototypeGetLength;

  /**
   * @type {Object<string, string>} lowercased name → canonical encoding.
   * Null-prototype: the keys are caller-supplied, so with Object.prototype in the
   * chain `Buffer.from(s, 'constructor')` resolved to a function instead of
   * failing, and any `Object.prototype.<name>` a script set forged an encoding.
   */
  var ENCODING_ALIASES = {
    __proto__: null,
    utf8: 'utf8',
    'utf-8': 'utf8',
    utf16le: 'utf16le',
    'utf-16le': 'utf16le',
    ucs2: 'utf16le',
    'ucs-2': 'utf16le',
    binary: 'latin1',
    latin1: 'latin1',
    ascii: 'ascii',
    hex: 'hex',
    base64: 'base64',
    base64url: 'base64url',
  };

  var MAX_SAFE = 9007199254740991;
  var MAX_ALLOC_BYTES =
    native && typeof native.maxAllocBytes === 'number' && native.maxAllocBytes > 0
      ? Math.min(native.maxAllocBytes, MAX_SAFE)
      : 4294967296;
  /** Max Buffer size (JSC ceiling; override via LAVA_MAX_BUFFER_BYTES). */
  var K_MAX_LENGTH = MAX_ALLOC_BYTES;
  /** V8-style max string length reported as Buffer.constants.MAX_STRING_LENGTH. */
  var K_STRING_MAX_LENGTH = 536870888;
  var inspectMaxBytes = 50;

  /** @type {symbol|null} util.inspect custom hook. */
  var customInspectSymbol =
    typeof Symbol !== 'undefined' && Symbol.for ? Symbol.for('nodejs.util.inspect.custom') : null;

  // Node-shaped coded errors come from internal/errors (CLAUDE.md §5); what stays here
  // are the buffer-only message templates.
  var errors = require('internal/errors');
  var nodeError = errors.nodeError;
  var ERR_INVALID_ARG_TYPE = errors.ERR_INVALID_ARG_TYPE;
  var ERR_INVALID_ARG_VALUE = errors.ERR_INVALID_ARG_VALUE;
  var ERR_OUT_OF_RANGE = errors.ERR_OUT_OF_RANGE;
  var ERR_MISSING_ARGS = errors.ERR_MISSING_ARGS;
  var ERR_UNKNOWN_ENCODING = errors.ERR_UNKNOWN_ENCODING;

  // Required here, at the top level, so both stay in the eager set: the globals and
  // URL statics below are installed from this module, in the same order as before
  // they were split out. Neither requires node:buffer back (see internal/blob.js).
  var blobModule = require('internal/blob');
  var Blob = blobModule.Blob;
  var File = require('internal/file').File;

  function validateByteLength(byteLength) {
    if (typeof byteLength !== 'number')
      throw ERR_INVALID_ARG_TYPE('byteLength', 'number', byteLength);
    if (Math.floor(byteLength) !== byteLength)
      throw ERR_OUT_OF_RANGE('byteLength', 'an integer', byteLength);
    if (byteLength < 1 || byteLength > 6)
      throw ERR_OUT_OF_RANGE('byteLength', '>= 1 and <= 6', byteLength);
  }

  function checkValueInt(value, min, max, blMinus1) {
    if (value > max || value < min) {
      var n = typeof min === 'bigint' ? 'n' : '';
      var range;
      if (blMinus1 > 3) {
        var bits = (blMinus1 + 1) * 8;
        if (min === 0 || min === BigInt(0)) {
          range = '>= 0' + n + ' and < 2' + n + ' ** ' + bits + n;
        } else {
          range =
            '>= -(2' + n + ' ** ' + (bits - 1) + n + ') and < 2' + n + ' ** ' + (bits - 1) + n;
        }
      } else {
        range = '>= ' + min + n + ' and <= ' + max + n;
      }
      throw ERR_OUT_OF_RANGE('value', range, value);
    }
  }

  function validateWriteOffset(offset, max, name) {
    if (Math.floor(offset) !== offset) throw ERR_OUT_OF_RANGE(name, 'an integer', offset);
    if (offset < 0 || offset > max) throw ERR_OUT_OF_RANGE(name, '>= 0 && <= ' + max, offset);
    return offset;
  }

  // Node's validateOffset(value, name, 0, max) as write/compare/fill call it: a
  // non-number is a type error (no ToNumber coercion), then the integer/range check.
  function validateOffsetArg(value, name, max) {
    if (typeof value !== 'number') throw ERR_INVALID_ARG_TYPE(name, 'number', value);
    return validateWriteOffset(value, max, name);
  }

  function errBufferSize(bits) {
    return nodeError(
      P.RangeError,
      'ERR_INVALID_BUFFER_SIZE',
      'Buffer size must be a multiple of ' + bits + '-bits',
    );
  }

  /**
   * Validates a byte count for alloc/allocUnsafe/allocUnsafeSlow and the deprecated
   * `Buffer(n)` constructor (node + JSC abort guard: JSC aborts rather than throws on
   * some oversized typed-array requests, so the ceiling is checked here first).
   * @param {*} size
   * @throws {TypeError} ERR_INVALID_ARG_TYPE — size is not a number.
   * @throws {RangeError} ERR_OUT_OF_RANGE — NaN, negative, ±Infinity, or above the
   *         ceiling; the message quotes the ceiling and `Received <size>`.
   * @node -1/NaN/±Infinity/2**53 → `The value of "size" is out of range. It must be
   *       >= 0 && <= 9007199254740991. Received -1` (2**53 prints 9_007_199_254_740_992);
   *       -0 and 1.5 pass (length 0 and 1). Node 26.13.0, verified by
   *       tests/node-compat/cases/70-buffer-size-inspect-parity.js.
   * @deviates The ceiling is K_MAX_LENGTH (4 GiB by default; LAVA_MAX_BUFFER_BYTES lowers it,
   *           and buffer.constants.MAX_LENGTH reports it), not node's 2**53-1 — the documented
   *           kMaxLength deviation in reference/node-compatibility.md. The bound is pinned
   *           to MAX_LENGTH, not to a literal, by
   *           tests/node-compat/cases/70-buffer-size-inspect-parity.js and
   *           34-oversized-allocation.js.
   */
  function assertSize(size) {
    if (typeof size !== 'number') throw ERR_INVALID_ARG_TYPE('size', 'number', size);
    if (!(size >= 0 && size <= K_MAX_LENGTH))
      throw ERR_OUT_OF_RANGE('size', '>= 0 && <= ' + K_MAX_LENGTH, size);
  }

  /** @returns {string} Canonical encoding name (default utf8). */
  function normalizeEncoding(encoding) {
    if (encoding === undefined || encoding === null || encoding === '') return 'utf8';
    if (typeof encoding === 'symbol') return '' + encoding; // throws TypeError on Symbol, matching Node
    var key = StringPrototypeToLowerCase(StringG(encoding));
    var canon = ENCODING_ALIASES[key];
    return canon !== undefined ? canon : key;
  }

  /** @returns {boolean} */
  function isEncodingName(encoding) {
    return (
      typeof encoding === 'string' &&
      ObjectPrototypeHasOwnProperty(ENCODING_ALIASES, StringPrototypeToLowerCase(encoding))
    );
  }

  /**
   * Lenient Node base64/base64url normalization before native decode.
   *
   * A charCode filter, not `replaceAll(/[^A-Za-z0-9+/]/g, '')`. That was a GLOBAL
   * regex replace, and a global replace under a forged `RegExp.prototype.exec` does
   * not answer wrongly — it never returns, because `Symbol.replace` advances
   * `lastIndex` only on an empty match. Measured: `Buffer.from('dXNlcjpwYXNz',
   * 'base64')` hung indefinitely on `bin/lava` where node answered promptly, and
   * this is the Basic-auth / JWT decode path, so one unauthenticated request with an
   * `Authorization` header was enough to wedge the event loop for good.
   *
   * The `-`/`_` folds are plain string arguments, not regexes, so they were never
   * part of the vector; they are folded into the same pass because the pass is free.
   */
  function normalizeBase64(str) {
    var src = StringG(str);
    var n = src.length;
    var out = '';
    for (var i = 0; i < n; i++) {
      var c = StringPrototypeCharCodeAt(src, i);
      if (c === 0x2d) {
        c = 0x2b; // '-' -> '+'
      } else if (c === 0x5f) {
        c = 0x2f; // '_' -> '/'
      }
      if (
        (c >= 0x41 && c <= 0x5a) || // A-Z
        (c >= 0x61 && c <= 0x7a) || // a-z
        (c >= 0x30 && c <= 0x39) || // 0-9
        c === 0x2b || // +
        c === 0x2f // /
      ) {
        out += StringFromCharCode(c);
      }
    }
    if (out.length % 4 === 1) out = out.slice(0, out.length - 1);
    while (out.length % 4 !== 0) out += '=';
    return out;
  }

  /** @returns {Uint8Array} */
  function strToBytes(str, encoding) {
    encoding = normalizeEncoding(encoding);
    str = StringG(str);
    if (encoding === 'utf8') return utf8EncodeNative(str);
    if (encoding === 'utf16le') return utf16leEncodeNative(str);
    if (encoding === 'hex') return hexDecodeNative(str);
    if (encoding === 'base64' || encoding === 'base64url') {
      var norm = normalizeBase64(str);
      return norm ? base64DecodeNative(norm) : EMPTY_U8;
    }
    if (encoding === 'ascii' || encoding === 'latin1') return latin1EncodeNative(str);
    throw ERR_UNKNOWN_ENCODING(encoding);
  }

  /** @returns {string} */
  function bytesToString(bytes, encoding) {
    encoding = normalizeEncoding(encoding);
    if (encoding === 'utf8') return utf8DecodeNative(bytes);
    if (encoding === 'utf16le') return utf16leDecodeNative(bytes);
    if (encoding === 'hex') return hexEncodeNative(bytes);
    if (encoding === 'base64') return base64EncodeNative(bytes);
    if (encoding === 'base64url') return base64urlEncodeNative(bytes);
    if (encoding === 'latin1') return latin1DecodeNative(bytes);
    if (encoding === 'ascii') return asciiDecodeNative(bytes);
    throw ERR_UNKNOWN_ENCODING(encoding);
  }

  function toInteger(value, fallback) {
    if (value === undefined) return fallback;
    value = Number(value);
    if (!isFinite(value) || value === 0) return 0;
    return value < 0 ? Math.ceil(value) : Math.floor(value);
  }

  function clampIndex(value, length, fallback) {
    value = toInteger(value, fallback);
    if (value < 0) value += length;
    if (value < 0) return 0;
    if (value > length) return length;
    return value;
  }

  function errBufferOutOfBounds() {
    return nodeError(
      P.RangeError,
      'ERR_BUFFER_OUT_OF_BOUNDS',
      'Attempt to access memory outside buffer bounds',
    );
  }

  /** Node-style offset bounds for fixed-width numeric accessors. */
  function checkBounds(buf, offset, byteLength) {
    if (offset === undefined) offset = 0;
    if (typeof offset !== 'number') throw ERR_INVALID_ARG_TYPE('offset', 'number', offset);
    if (Math.floor(offset) !== offset) throw ERR_OUT_OF_RANGE('offset', 'an integer', offset);
    var max = buf.length - byteLength;
    if (max < 0) throw errBufferOutOfBounds();
    if (offset < 0 || offset > max) throw ERR_OUT_OF_RANGE('offset', '>= 0 and <= ' + max, offset);
    return offset;
  }

  function validateRange(value, max, name) {
    value = toInteger(value, 0);
    if (value < 0 || value > max) throw new RangeError(name + ' is out of range');
    return value;
  }

  var dataViewCache = new WeakMap();
  /** @returns {DataView} Cached DataView for `buf` (WeakMap). */
  function viewOf(buf) {
    var dv = dataViewCache.get(buf);
    if (dv === undefined) {
      dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      dataViewCache.set(buf, dv);
    }
    return dv;
  }

  /** @returns {-1|0|1} */
  function compareBytes(a, b) {
    return nativeCompare(a, b);
  }

  function toSearchBytes(value, encoding) {
    if (typeof value === 'number') return new Uint8Array([value & 0xff]);
    if (typeof value === 'string') return strToBytes(value, encoding || 'utf8');
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    throw ERR_INVALID_ARG_TYPE('value', ['number', 'string', 'Buffer', 'Uint8Array'], value);
  }

  /** indexOf / lastIndexOf implementation (native search). */
  function bidirectionalIndexOf(buf, value, byteOffset, encoding, forward) {
    var needle = toSearchBytes(value, encoding);
    if (needle.length === 0)
      return forward
        ? clampIndex(byteOffset, buf.length, 0)
        : Math.min(clampIndex(byteOffset, buf.length, buf.length), buf.length);
    var start = clampIndex(byteOffset, buf.length, forward ? 0 : buf.length);
    if (needle.length > buf.length) return -1;
    return nativeIndexOf(buf, needle, start, forward);
  }

  function checkFixed(value, min, max, blMinus1) {
    value = +value;
    checkValueInt(value, min, max, blMinus1);
    return value;
  }

  function readUInt(buf, offset, byteLength, littleEndian) {
    validateByteLength(byteLength);
    offset = checkBounds(buf, offset, byteLength);
    var value = 0;
    if (littleEndian) {
      for (var i = byteLength - 1; i >= 0; i--) value = value * 0x100 + buf[offset + i];
    } else {
      for (var j = 0; j < byteLength; j++) value = value * 0x100 + buf[offset + j];
    }
    return value;
  }

  function readInt(buf, offset, byteLength, littleEndian) {
    var value = readUInt(buf, offset, byteLength, littleEndian);
    var sign = Math.pow(2, byteLength * 8 - 1);
    var full = sign * 2;
    return value >= sign ? value - full : value;
  }

  function writeUInt(buf, value, offset, byteLength, littleEndian) {
    validateByteLength(byteLength);
    var max = Math.pow(2, 8 * byteLength) - 1;
    value = +value;
    checkValueInt(value, 0, max, byteLength - 1);
    offset = checkBounds(buf, offset, byteLength);
    value = Math.floor(value);
    for (var i = 0; i < byteLength; i++) {
      var index = littleEndian ? offset + i : offset + byteLength - 1 - i;
      buf[index] = value & 0xff;
      value = Math.floor(value / 0x100);
    }
    return offset + byteLength;
  }

  function writeInt(buf, value, offset, byteLength, littleEndian) {
    validateByteLength(byteLength);
    var limit = Math.pow(2, 8 * byteLength - 1);
    value = +value;
    checkValueInt(value, -limit, limit - 1, byteLength - 1);
    offset = checkBounds(buf, offset, byteLength);
    value = Math.floor(value);
    if (value < 0) value += Math.pow(2, byteLength * 8);
    for (var i = 0; i < byteLength; i++) {
      var index = littleEndian ? offset + i : offset + byteLength - 1 - i;
      buf[index] = value & 0xff;
      value = Math.floor(value / 0x100);
    }
    return offset + byteLength;
  }

  var BIG_0 = typeof BigInt === 'function' ? BigInt(0) : null;
  var BIG_1 = typeof BigInt === 'function' ? BigInt(1) : null;
  var BIG_MAX_U64 = typeof BigInt === 'function' ? (BIG_1 << BigInt(64)) - BIG_1 : null;
  var BIG_SIGN_I64 = typeof BigInt === 'function' ? BIG_1 << BigInt(63) : null;

  function readBigUInt(buf, offset, littleEndian) {
    offset = checkBounds(buf, offset, 8);
    return viewOf(buf).getBigUint64(offset, littleEndian);
  }

  function readBigInt(buf, offset, littleEndian) {
    offset = checkBounds(buf, offset, 8);
    return viewOf(buf).getBigInt64(offset, littleEndian);
  }

  // Node's writeBigU_Int64* order (lib/internal/buffer.js checkInt): the range compare
  // runs first on the raw value, then the offset bounds, and only then `value & mask`,
  // whose mixed-type `&` is what throws "Cannot mix BigInt and other types". So a boxed
  // BigInt (Object(5n)) writes, an out-of-range number reports ERR_OUT_OF_RANGE, a bad
  // offset beats a non-BigInt value, and a Symbol throws from the compare. The mask
  // also yields the two's-complement u64 for a negative signed value, so both widths
  // store through setBigUint64. Pinned by tests/node-compat/cases/73-buffer-type-fill-bigint.js.
  function writeBigUInt(buf, value, offset, littleEndian) {
    checkValueInt(value, BIG_0, BIG_MAX_U64, 7);
    offset = checkBounds(buf, offset, 8);
    viewOf(buf).setBigUint64(offset, value & BIG_MAX_U64, littleEndian);
    return offset + 8;
  }

  function writeBigInt(buf, value, offset, littleEndian) {
    checkValueInt(value, -BIG_SIGN_I64, BIG_SIGN_I64 - BIG_1, 7);
    offset = checkBounds(buf, offset, 8);
    viewOf(buf).setBigUint64(offset, value & BIG_MAX_U64, littleEndian);
    return offset + 8;
  }

  /**
   * The concrete Buffer class: a Uint8Array subclass carrying all Buffer methods,
   * with the DEFAULT (forwarding) constructor so internal construction from a known
   * (ArrayBuffer, offset, length) or size is as cheap as `new Uint8Array(...)`. The
   * public `Buffer` (a function, defined just below) shares this exact prototype
   * object, so `Object.getPrototypeOf(buf) === Buffer.prototype` holds for every
   * Buffer however it was built — matching Node, where Buffer and FastBuffer are
   * one prototype. Argument dispatch (string→from, size check) lives in that
   * function, not here.
   * @extends {Uint8Array}
   */
  class FastBuffer extends Uint8Array {
    /**
     * @param {string} [encoding='utf8']
     * @param {number} [start]
     * @param {number} [end]
     * @returns {string}
     */
    toString(encoding, start, end) {
      // The captured getter, not `this.length`: %TypedArray%.prototype.length is
      // a configurable accessor, and this value decides the output range. With it
      // poisoned to 0 every toString — and so every TextDecoder.decode — returned
      // "" while node returned the real text. Truncation rather than an
      // over-read, but a silent wrong answer either way.
      var len = TypedArrayPrototypeGetLength(this);
      if (start === undefined || start <= 0) start = 0;
      else if (start >= len) return '';
      else start = +start | 0;
      if (end === undefined || end >= len) end = len;
      else end = +end | 0;
      if (end <= start) return '';
      // Full-range toString (the common case) skips the subarray view: the
      // codec natives read this buffer's bytes in place either way.
      if (start === 0 && end === len) return bytesToString(this, encoding || 'utf8');
      return bytesToString(this.subarray(start, end), encoding || 'utf8');
    }

    /**
     * @param {Uint8Array} target
     * @param {number} [targetStart]
     * @param {number} [sourceStart]
     * @param {number} [sourceEnd]
     * @returns {number} Bytes copied
     */
    copy(target, targetStart, sourceStart, sourceEnd) {
      if (!(target instanceof Uint8Array))
        throw ERR_INVALID_ARG_TYPE('target', ['Buffer', 'Uint8Array'], target);
      if (targetStart === undefined) {
        targetStart = 0;
      } else {
        targetStart = toInteger(targetStart, 0);
        if (targetStart < 0) throw ERR_OUT_OF_RANGE('targetStart', '>= 0', targetStart);
      }
      if (sourceStart === undefined) {
        sourceStart = 0;
      } else {
        sourceStart = toInteger(sourceStart, 0);
        if (sourceStart < 0 || sourceStart > this.length)
          throw ERR_OUT_OF_RANGE('sourceStart', '>= 0 && <= ' + this.length, sourceStart);
      }
      if (sourceEnd === undefined) {
        sourceEnd = this.length;
      } else {
        sourceEnd = toInteger(sourceEnd, 0);
        if (sourceEnd < 0) throw ERR_OUT_OF_RANGE('sourceEnd', '>= 0', sourceEnd);
      }
      if (sourceEnd > this.length) sourceEnd = this.length;
      if (targetStart >= target.length || sourceStart >= sourceEnd) return 0;
      var len = Math.min(sourceEnd - sourceStart, target.length - targetStart);
      if (len <= 0) return 0;
      if (sourceStart === 0 && len === this.length) target.set(this, targetStart);
      else target.set(this.subarray(sourceStart, sourceStart + len), targetStart);
      return len;
    }

    /**
     * @param {string} string
     * @param {number|string} [offset]
     * @param {number|string} [length]
     * @param {string} [encoding]
     * @returns {number} Bytes written
     */
    write(string, offset, length, encoding) {
      if (typeof string !== 'string') {
        // node's C++ StringWrite throws this one: no Received tail, no [code].
        throw errors.nativeError(P.TypeError, 'ERR_INVALID_ARG_TYPE', 'argument must be a string');
      }
      if (offset === undefined) {
        offset = 0;
        length = this.length;
      } else if (typeof offset === 'string') {
        encoding = offset;
        offset = 0;
        length = this.length;
      } else {
        offset = validateOffsetArg(offset, 'offset', this.length);
        if (typeof length === 'string') {
          encoding = length;
          length = undefined;
        }
      }
      var enc = normalizeEncoding(encoding || 'utf8');
      var remaining = this.length - offset;
      var max;
      if (length === undefined) {
        max = remaining;
      } else {
        // Node bounds `length` by the whole buffer, not by what is left after
        // `offset`, then clamps: write('abcdef', 5, 8) on 10 bytes writes 5.
        max = validateOffsetArg(length, 'length', this.length);
        if (max > remaining) max = remaining;
      }
      if (max <= 0) return 0;
      string = StringG(string);
      if (enc === 'utf8') return utf8WriteIntoNative(this, string, offset, max);
      if (enc === 'latin1' || enc === 'ascii')
        return latin1WriteIntoNative(this, string, offset, max);
      if (enc === 'utf16le') return utf16leWriteIntoNative(this, string, offset, max);
      var bytes = strToBytes(string, enc);
      var n = bytes.length < max ? bytes.length : max;
      if (n > 0) this.set(n === bytes.length ? bytes : bytes.subarray(0, n), offset);
      return n;
    }

    slice(start, end) {
      return this.subarray(start, end);
    }

    subarray(start, end) {
      var sub = Uint8Array.prototype.subarray.call(this, start, end);
      return new FastBuffer(sub.buffer, sub.byteOffset, sub.length);
    }

    equals(other) {
      if (!(other instanceof Uint8Array) || this.length !== other.length) return false;
      if (this.length === 0) return true;
      return nativeCompare(this, other) === 0;
    }

    compare(target, targetStart, targetEnd, sourceStart, sourceEnd) {
      if (!(target instanceof Uint8Array))
        throw ERR_INVALID_ARG_TYPE('target', ['Buffer', 'Uint8Array'], target);
      // Node bounds the *Start arguments by kMaxLength only, the *End ones by the
      // buffer length: compare(b3, 100) is 1 (empty target range), not a RangeError.
      if (targetStart === undefined) targetStart = 0;
      else targetStart = validateOffsetArg(targetStart, 'targetStart', K_MAX_LENGTH);
      if (targetEnd === undefined) targetEnd = target.length;
      else targetEnd = validateOffsetArg(targetEnd, 'targetEnd', target.length);
      if (sourceStart === undefined) sourceStart = 0;
      else sourceStart = validateOffsetArg(sourceStart, 'sourceStart', K_MAX_LENGTH);
      if (sourceEnd === undefined) sourceEnd = this.length;
      else sourceEnd = validateOffsetArg(sourceEnd, 'sourceEnd', this.length);
      if (sourceStart >= sourceEnd && targetStart >= targetEnd) return 0;
      if (sourceStart >= sourceEnd) return -1;
      if (targetStart >= targetEnd) return 1;
      return compareBytes(
        this.subarray(sourceStart, sourceEnd),
        target.subarray(targetStart, targetEnd),
      );
    }

    fill(value, start, end, encoding) {
      if (typeof start === 'string') {
        encoding = start;
        start = 0;
        end = this.length;
      } else if (typeof end === 'string') {
        encoding = end;
        end = this.length;
      }
      // validateOffsetArg's checks, inlined: the extra call layer per offset was the
      // whole residual on fill(i, 0, 32) — 3e6 calls on a 64-byte buffer took 954 ms
      // through validateOffsetArg and 496 inlined, base 8619888 738 (medians of 5
      // interleaved launches per arm, darwin arm64, -o:speed). The valid case only compares; anything else (fraction, NaN, ±Infinity,
      // out of range) goes to validateWriteOffset, which picks and builds the error.
      // `% 1` rather than Math.floor keeps the live `Math` global read out (§5).
      if (start === undefined) start = 0;
      else if (typeof start !== 'number') throw ERR_INVALID_ARG_TYPE('offset', 'number', start);
      else if (start % 1 !== 0 || start < 0 || start > K_MAX_LENGTH)
        validateWriteOffset(start, K_MAX_LENGTH, 'offset');
      if (end === undefined) end = this.length;
      else if (typeof end !== 'number') throw ERR_INVALID_ARG_TYPE('end', 'number', end);
      else if (end % 1 !== 0 || end < 0 || end > this.length)
        validateWriteOffset(end, this.length, 'end');
      if (end <= start) return this;
      var bytes;
      // Numbers skip the string and instanceof tests (the hot case) and land in the
      // same `& 0xff` fill as every other non-string, non-Uint8Array value, so the order
      // is unobservable. Behind those tests, 3e6 fill(i, 0, 32) on a 64-byte buffer took
      // 1111 ms; ahead of them, 989 ms (medians of 5 interleaved launches per arm,
      // darwin arm64, -o:speed). One shared fill site rather than an early-return copy,
      // so the primordials invoke count does not grow.
      if (typeof value !== 'number') {
        if (typeof value === 'string') {
          bytes = strToBytes(value, encoding || 'utf8');
          if (bytes.length === 0) {
            if (value.length !== 0) throw ERR_INVALID_ARG_VALUE('value', value);
            u8Fill.call(this, 0, start, end);
            return this;
          }
        } else if (value instanceof Uint8Array) {
          if (value.length === 0) throw ERR_INVALID_ARG_VALUE('value', value);
          bytes = value;
        }
      }
      if (bytes === undefined) {
        // Numbers and every other value (null, undefined, objects, booleans, BigInt,
        // Symbol) coerce via ToNumber/ToInt32 (& 0xff), matching Node:
        // null/undefined/{} -> 0, true -> 1, BigInt/Symbol -> TypeError.
        u8Fill.call(this, value & 0xff, start, end);
        return this;
      }
      if (bytes.length === 1) {
        u8Fill.call(this, bytes[0], start, end);
        return this;
      }
      for (var i = start; i < end; i++) this[i] = bytes[(i - start) % bytes.length];
      return this;
    }

    includes(value, byteOffset, encoding) {
      return this.indexOf(value, byteOffset, encoding) !== -1;
    }

    indexOf(value, byteOffset, encoding) {
      return bidirectionalIndexOf(this, value, byteOffset, encoding, true);
    }

    lastIndexOf(value, byteOffset, encoding) {
      return bidirectionalIndexOf(this, value, byteOffset, encoding, false);
    }

    swap16() {
      if (this.length % 2 !== 0) throw errBufferSize(16);
      swapInPlaceNative(this, 2);
      return this;
    }

    swap32() {
      if (this.length % 4 !== 0) throw errBufferSize(32);
      swapInPlaceNative(this, 4);
      return this;
    }

    swap64() {
      if (this.length % 8 !== 0) throw errBufferSize(64);
      swapInPlaceNative(this, 8);
      return this;
    }

    toJSON() {
      return { type: 'Buffer', data: Array.from(this) };
    }
  }

  /**
   * Public Buffer constructor. A function (not a class) so its `.prototype` can be
   * the very same object as FastBuffer.prototype — that shared identity is what makes
   * `getPrototypeOf(buf) === Buffer.prototype` true for buffers from every path
   * (Node's structure). Callable with or without `new`; both yield a FastBuffer.
   * @param {number|string|ArrayBuffer|ArrayBufferView|ArrayLike<number>} arg
   * @param {number|string} [encodingOrOffset]
   * @param {number} [length]
   * @returns {Buffer}
   * @throws {RangeError} ERR_OUT_OF_RANGE — a number `arg` that is NaN, negative,
   *         ±Infinity or above kMaxLength (assertSize, the check Buffer.alloc runs).
   * @node `Buffer(n)` is `Buffer.alloc(n)`: -1, NaN, ±Infinity and 2**53 throw the
   *       coded "size" RangeError, -0 → length 0, 1.5 → length 1, 5 → five zero bytes;
   *       identical with and without `new`. Node 26.13.0, verified by
   *       tests/node-compat/cases/70-buffer-size-inspect-parity.js.
   * @deviates The out-of-range bound is K_MAX_LENGTH (see assertSize), pinned by
   *           tests/node-compat/cases/70-buffer-size-inspect-parity.js.
   */
  function Buffer(arg, encodingOrOffset, length) {
    if (typeof arg === 'string') return Buffer.from(arg, encodingOrOffset);
    if (typeof arg === 'number') {
      // Only the upper bound used to be checked here, so -1 reached the typed-array
      // constructor and threw JSC's codeless "length cannot be negative", and NaN
      // (ToIndex(NaN) is 0) quietly returned an empty Buffer. assertSize is the
      // validation Buffer.alloc runs; calling it rather than the live `Buffer.alloc`
      // keeps a user-replaced static out of the constructor.
      assertSize(arg);
      return new FastBuffer(arg); // zero-filled, matching the old `super(number)`
    }
    return new FastBuffer(arg, encodingOrOffset, length);
  }
  // Share ONE prototype object between the class and the public constructor, and let
  // Buffer inherit FastBuffer's statics (Symbol.species etc.); own statics below win.
  Object.setPrototypeOf(Buffer, FastBuffer);
  Buffer.prototype = FastBuffer.prototype;
  Object.defineProperty(FastBuffer.prototype, 'constructor', {
    value: Buffer,
    writable: true,
    configurable: true,
  });

  var p = Buffer.prototype;

  function inspectBuffer(buf) {
    var max = inspectMaxBytes;
    var shown = buf.length > max ? max : buf.length;
    var hex = '';
    if (shown > 0) {
      // Group the hex into byte pairs. This was `.replaceAll(/(.{2})/g, '$1 ').trim()`,
      // and a GLOBAL replace under a forged `RegExp.prototype.exec` never returns — it
      // only advances `lastIndex` on an empty match — so `console.log(buf)` on a Buffer
      // holding remote bytes wedged the process. node 24 hangs here too, so this is a
      // deviation in Lava's favour, pinned Lava-only by
      // cmd/lava/regexp_pollution_test.odin.
      //
      // Slicing straight out of the encoder's output also drops the trailing-space +
      // trim() round trip the regex form needed.
      var raw = hexEncodeNative(shown === buf.length ? buf : buf.subarray(0, shown));
      for (var h = 0; h < raw.length; h += 2) {
        if (h > 0) hex += ' ';
        hex += StringPrototypeSlice(raw, h, h + 2);
      }
    }
    var remaining = buf.length - shown;
    // Unconditional separator: node appends ` ... N more bytes` to whatever hex it
    // produced, so INSPECT_MAX_BYTES = 0 prints TWO spaces after `<Buffer`.
    if (remaining > 0) hex += ' ... ' + remaining + ' more byte' + (remaining > 1 ? 's' : '');
    return '<Buffer ' + hex + '>';
  }

  p.inspect = function () {
    return inspectBuffer(this);
  };
  if (customInspectSymbol) {
    Object.defineProperty(p, customInspectSymbol, {
      value: function () {
        return inspectBuffer(this);
      },
      writable: true,
      configurable: true,
    });
  }
  p.toLocaleString = p.toString;
  p.utf8Slice = function (start, end) {
    return this.toString('utf8', start, end);
  };
  p.hexSlice = function (start, end) {
    return this.toString('hex', start, end);
  };
  p.asciiSlice = function (start, end) {
    return this.toString('ascii', start, end);
  };
  p.latin1Slice = function (start, end) {
    return this.toString('latin1', start, end);
  };
  p.base64Slice = function (start, end) {
    return this.toString('base64', start, end);
  };
  p.base64urlSlice = function (start, end) {
    return this.toString('base64url', start, end);
  };
  p.ucs2Slice = function (start, end) {
    return this.toString('utf16le', start, end);
  };
  p.utf8Write = function (string, offset, length) {
    return this.write(string, offset, length, 'utf8');
  };
  p.hexWrite = function (string, offset, length) {
    return this.write(string, offset, length, 'hex');
  };
  p.asciiWrite = function (string, offset, length) {
    return this.write(string, offset, length, 'ascii');
  };
  p.latin1Write = function (string, offset, length) {
    return this.write(string, offset, length, 'latin1');
  };
  p.base64Write = function (string, offset, length) {
    return this.write(string, offset, length, 'base64');
  };
  p.base64urlWrite = function (string, offset, length) {
    return this.write(string, offset, length, 'base64url');
  };
  p.ucs2Write = function (string, offset, length) {
    return this.write(string, offset, length, 'utf16le');
  };
  p.readUInt8 = p.readUint8 = function (offset) {
    offset = checkBounds(this, offset, 1);
    return this[offset];
  };
  p.readInt8 = function (offset) {
    var v = this.readUInt8(offset);
    return v & 0x80 ? v - 0x100 : v;
  };
  p.readUIntLE = p.readUintLE = function (offset, byteLength) {
    return readUInt(this, offset, byteLength, true);
  };
  p.readUIntBE = p.readUintBE = function (offset, byteLength) {
    return readUInt(this, offset, byteLength, false);
  };
  p.readIntLE = function (offset, byteLength) {
    return readInt(this, offset, byteLength, true);
  };
  p.readIntBE = function (offset, byteLength) {
    return readInt(this, offset, byteLength, false);
  };
  p.readUInt16LE = p.readUint16LE = function (offset) {
    return viewOf(this).getUint16(checkBounds(this, offset, 2), true);
  };
  p.readUInt16BE = p.readUint16BE = function (offset) {
    return viewOf(this).getUint16(checkBounds(this, offset, 2), false);
  };
  p.readUInt32LE = p.readUint32LE = function (offset) {
    return viewOf(this).getUint32(checkBounds(this, offset, 4), true);
  };
  p.readUInt32BE = p.readUint32BE = function (offset) {
    return viewOf(this).getUint32(checkBounds(this, offset, 4), false);
  };
  p.readInt16LE = function (offset) {
    return viewOf(this).getInt16(checkBounds(this, offset, 2), true);
  };
  p.readInt16BE = function (offset) {
    return viewOf(this).getInt16(checkBounds(this, offset, 2), false);
  };
  p.readInt32LE = function (offset) {
    return viewOf(this).getInt32(checkBounds(this, offset, 4), true);
  };
  p.readInt32BE = function (offset) {
    return viewOf(this).getInt32(checkBounds(this, offset, 4), false);
  };
  p.readFloatLE = function (offset) {
    return viewOf(this).getFloat32(checkBounds(this, offset, 4), true);
  };
  p.readFloatBE = function (offset) {
    return viewOf(this).getFloat32(checkBounds(this, offset, 4), false);
  };
  p.readDoubleLE = function (offset) {
    return viewOf(this).getFloat64(checkBounds(this, offset, 8), true);
  };
  p.readDoubleBE = function (offset) {
    return viewOf(this).getFloat64(checkBounds(this, offset, 8), false);
  };
  if (typeof BigInt === 'function') {
    p.readBigUInt64LE = p.readBigUint64LE = function (offset) {
      return readBigUInt(this, offset, true);
    };
    p.readBigUInt64BE = p.readBigUint64BE = function (offset) {
      return readBigUInt(this, offset, false);
    };
    p.readBigInt64LE = function (offset) {
      return readBigInt(this, offset, true);
    };
    p.readBigInt64BE = function (offset) {
      return readBigInt(this, offset, false);
    };
  }

  p.writeUInt8 = p.writeUint8 = function (value, offset) {
    value = checkFixed(value, 0, 0xff, 0);
    offset = checkBounds(this, offset, 1);
    this[offset] = value;
    return offset + 1;
  };
  p.writeInt8 = function (value, offset) {
    value = checkFixed(value, -0x80, 0x7f, 0);
    offset = checkBounds(this, offset, 1);
    this[offset] = value;
    return offset + 1;
  };
  p.writeUIntLE = p.writeUintLE = function (value, offset, byteLength) {
    return writeUInt(this, value, offset, byteLength, true);
  };
  p.writeUIntBE = p.writeUintBE = function (value, offset, byteLength) {
    return writeUInt(this, value, offset, byteLength, false);
  };
  p.writeIntLE = function (value, offset, byteLength) {
    return writeInt(this, value, offset, byteLength, true);
  };
  p.writeIntBE = function (value, offset, byteLength) {
    return writeInt(this, value, offset, byteLength, false);
  };
  p.writeUInt16LE = p.writeUint16LE = function (value, offset) {
    value = checkFixed(value, 0, 0xffff, 1);
    offset = checkBounds(this, offset, 2);
    viewOf(this).setUint16(offset, value, true);
    return offset + 2;
  };
  p.writeUInt16BE = p.writeUint16BE = function (value, offset) {
    value = checkFixed(value, 0, 0xffff, 1);
    offset = checkBounds(this, offset, 2);
    viewOf(this).setUint16(offset, value, false);
    return offset + 2;
  };
  p.writeUInt32LE = p.writeUint32LE = function (value, offset) {
    value = checkFixed(value, 0, 0xffffffff, 3);
    offset = checkBounds(this, offset, 4);
    viewOf(this).setUint32(offset, value, true);
    return offset + 4;
  };
  p.writeUInt32BE = p.writeUint32BE = function (value, offset) {
    value = checkFixed(value, 0, 0xffffffff, 3);
    offset = checkBounds(this, offset, 4);
    viewOf(this).setUint32(offset, value, false);
    return offset + 4;
  };
  p.writeInt16LE = function (value, offset) {
    value = checkFixed(value, -0x8000, 0x7fff, 1);
    offset = checkBounds(this, offset, 2);
    viewOf(this).setInt16(offset, value, true);
    return offset + 2;
  };
  p.writeInt16BE = function (value, offset) {
    value = checkFixed(value, -0x8000, 0x7fff, 1);
    offset = checkBounds(this, offset, 2);
    viewOf(this).setInt16(offset, value, false);
    return offset + 2;
  };
  p.writeInt32LE = function (value, offset) {
    value = checkFixed(value, -0x80000000, 0x7fffffff, 3);
    offset = checkBounds(this, offset, 4);
    viewOf(this).setInt32(offset, value, true);
    return offset + 4;
  };
  p.writeInt32BE = function (value, offset) {
    value = checkFixed(value, -0x80000000, 0x7fffffff, 3);
    offset = checkBounds(this, offset, 4);
    viewOf(this).setInt32(offset, value, false);
    return offset + 4;
  };
  p.writeFloatLE = function (value, offset) {
    offset = checkBounds(this, offset, 4);
    viewOf(this).setFloat32(offset, Number(value), true);
    return offset + 4;
  };
  p.writeFloatBE = function (value, offset) {
    offset = checkBounds(this, offset, 4);
    viewOf(this).setFloat32(offset, Number(value), false);
    return offset + 4;
  };
  p.writeDoubleLE = function (value, offset) {
    offset = checkBounds(this, offset, 8);
    viewOf(this).setFloat64(offset, Number(value), true);
    return offset + 8;
  };
  p.writeDoubleBE = function (value, offset) {
    offset = checkBounds(this, offset, 8);
    viewOf(this).setFloat64(offset, Number(value), false);
    return offset + 8;
  };
  if (typeof BigInt === 'function') {
    p.writeBigUInt64LE = p.writeBigUint64LE = function (value, offset) {
      return writeBigUInt(this, value, offset, true);
    };
    p.writeBigUInt64BE = p.writeBigUint64BE = function (value, offset) {
      return writeBigUInt(this, value, offset, false);
    };
    p.writeBigInt64LE = function (value, offset) {
      return writeBigInt(this, value, offset, true);
    };
    p.writeBigInt64BE = function (value, offset) {
      return writeBigInt(this, value, offset, false);
    };
  }

  Object.defineProperty(p, 'parent', {
    get: function () {
      return this.buffer;
    },
  });
  Object.defineProperty(p, 'offset', {
    get: function () {
      return this.byteOffset;
    },
  });

  var poolBufferSize;
  var poolOffset;
  var allocPool;

  /**
   * (Re)build the shared allocUnsafe pool from Buffer.poolSize. The pool backs
   * allocUnsafe, so its bytes may be uninitialized: prefer the native
   * uninitialized allocator — `new Uint8Array(n)` would zero the whole slab and
   * allocate it on the GC heap, which measures ~100µs per refill on JSC vs the
   * native path's plain malloc.
   */
  function createPool() {
    var raw = nativeAllocUninit ? nativeAllocUninit(Buffer.poolSize) : null;
    allocPool = raw ? raw.buffer : new Uint8Array(Buffer.poolSize).buffer;
    poolBufferSize = allocPool.byteLength;
    poolOffset = 0;
  }

  /**
   * Unpooled uninitialized allocation (allocUnsafe large path / allocUnsafeSlow).
   * @param {number} size
   * @returns {Buffer}
   */
  function allocUnsafeNoZero(size) {
    size = Math.floor(size);
    if (size <= 0) return new FastBuffer(0);
    if (nativeAllocUninit && size <= K_MAX_LENGTH) {
      var raw = nativeAllocUninit(size);
      if (raw) return new FastBuffer(raw.buffer, raw.byteOffset, raw.length);
    }
    return new FastBuffer(size);
  }

  function alignPool() {
    if (poolOffset & 0x7) poolOffset = (poolOffset | 0x7) + 1;
  }

  /** Small sizes use the shared pool; larger call allocUnsafeNoZero. */
  function allocate(size) {
    if (!(size > 0)) return new FastBuffer(0);
    if (size < Buffer.poolSize >>> 1) {
      size = Math.floor(size);
      if (size === 0) return new FastBuffer(0);
      if (size > poolBufferSize - poolOffset) createPool();
      var b = new FastBuffer(allocPool, poolOffset, size);
      poolOffset += size;
      alignPool();
      return b;
    }
    return allocUnsafeNoZero(size);
  }

  function fromArrayLike(obj) {
    var len = Number(obj.length);
    if (!(len > 0)) return new FastBuffer(0);
    len = Math.floor(len);
    var b = allocate(len);
    for (var i = 0; i < len; i++) b[i] = obj[i];
    return b;
  }

  /**
   * Buffer.from(string) without the encode-then-copy round trip: encodings with
   * a knowable byte length (latin1/ascii = length, utf16le = 2*length, utf8 =
   * native exact count) allocate once — usually from the pool, like Node — and
   * the native writeInto fills that allocation directly. hex/base64 decode into
   * a fresh native-backed array; the Buffer becomes a view over that same
   * ArrayBuffer instead of copying it.
   * @returns {Buffer}
   */
  function fromString(str, encoding) {
    encoding = normalizeEncoding(encoding);
    str = StringG(str);
    if (str.length === 0) return allocate(0);
    if (encoding === 'latin1' || encoding === 'ascii') {
      var b = allocate(str.length);
      latin1WriteIntoNative(b, str, 0, str.length);
      return b;
    }
    if (encoding === 'utf16le') {
      var b16 = allocate(str.length * 2);
      utf16leWriteIntoNative(b16, str, 0, str.length * 2);
      return b16;
    }
    if (encoding === 'utf8') {
      var n = utf8ByteLengthNative(str);
      if (n === 0) return allocate(0);
      var b8 = allocate(n);
      utf8WriteIntoNative(b8, str, 0, n);
      return b8;
    }
    var bytes = strToBytes(str, encoding);
    if (bytes.length === 0) return allocate(0);
    // Small results: pooled copy (materializing .buffer costs more than the
    // copy). Large results: view the decode's own ArrayBuffer, zero copy.
    if (bytes.length < 512) {
      var bc = allocate(bytes.length);
      bc.set(bytes);
      return bc;
    }
    return new FastBuffer(bytes.buffer, bytes.byteOffset, bytes.length);
  }

  /** @see https://nodejs.org/api/buffer.html#static-method-bufferfromarray */
  Buffer.from = function (value, encodingOrOffset, length) {
    if (typeof value === 'string') {
      return fromString(value, encodingOrOffset);
    }
    if (value !== null && typeof value === 'object') {
      if (
        value instanceof ArrayBuffer ||
        (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer)
      ) {
        return new FastBuffer(value, encodingOrOffset === undefined ? 0 : encodingOrOffset, length);
      }
      if (typeof value.valueOf === 'function') {
        var valueOf = value.valueOf();
        if (
          valueOf != null &&
          valueOf !== value &&
          (typeof valueOf === 'string' || typeof valueOf === 'object')
        ) {
          return Buffer.from(valueOf, encodingOrOffset, length);
        }
      }
      if (ArrayBuffer.isView(value)) {
        // An out-of-bounds view (a fixed window its resizable buffer shrank
        // below) reads as length 0, but %TypedArray%.prototype.set still
        // throws on it as a SOURCE; node returns an empty Buffer.
        var viewLength = value.length;
        var copy = allocate(viewLength);
        if (viewLength > 0) copy.set(value);
        return copy;
      }
      if (Array.isArray(value) || typeof value.length === 'number') {
        return fromArrayLike(value);
      }
      if (value.type === 'Buffer' && Array.isArray(value.data)) {
        return fromArrayLike(value.data);
      }
      if (typeof value[Symbol.toPrimitive] === 'function') {
        var primitive = value[Symbol.toPrimitive]('string');
        if (typeof primitive === 'string') return Buffer.from(primitive, encodingOrOffset);
      }
    }
    throw ERR_INVALID_ARG_TYPE(
      'first argument',
      ['string', 'Buffer', 'ArrayBuffer', 'Array', 'Array-like Object'],
      value,
    );
  };

  /** Zero-filled (or filled) allocation. */
  Buffer.alloc = function (size, fill, encoding) {
    assertSize(size);
    var b = new FastBuffer(size);
    if (fill !== undefined && fill !== 0) b.fill(fill, 0, b.length, encoding);
    return b;
  };

  /** Uninitialized; may use the shared pool when size < poolSize/2. */
  Buffer.allocUnsafe = function (size) {
    assertSize(size);
    return allocate(size);
  };

  /** Uninitialized, never pooled. */
  Buffer.allocUnsafeSlow = function (size) {
    assertSize(size);
    return allocUnsafeNoZero(size);
  };

  Buffer.isBuffer = function (b) {
    return b instanceof Buffer;
  };

  Buffer.isEncoding = function (encoding) {
    return typeof encoding === 'string' && isEncodingName(encoding);
  };

  /**
   * Byte size of `string` under `encoding` without always allocating the encode.
   * @param {string|ArrayBufferView|ArrayBuffer} string
   * @param {string} [encoding='utf8']
   * @returns {number}
   */
  Buffer.byteLength = function (string, encoding) {
    if (typeof string === 'string') {
      var enc =
        encoding === undefined || !isEncodingName(encoding) ? 'utf8' : normalizeEncoding(encoding);
      if (enc === 'ascii' || enc === 'latin1') return string.length;
      if (enc === 'utf16le') return string.length * 2;
      if (enc === 'hex') return string.length >>> 1;
      if (enc === 'base64' || enc === 'base64url') return base64ByteLengthNative(string);
      if (enc === 'utf8') return utf8ByteLengthNative(string);
      return strToBytes(string, enc).length;
    }
    if (
      ArrayBuffer.isView(string) ||
      string instanceof ArrayBuffer ||
      (typeof SharedArrayBuffer !== 'undefined' && string instanceof SharedArrayBuffer)
    ) {
      return string.byteLength;
    }
    throw ERR_INVALID_ARG_TYPE('string', ['string', 'Buffer', 'ArrayBuffer'], string);
  };

  Buffer.compare = function (a, b) {
    if (!(a instanceof Uint8Array)) throw ERR_INVALID_ARG_TYPE('buf1', ['Buffer', 'Uint8Array'], a);
    if (!(b instanceof Uint8Array)) throw ERR_INVALID_ARG_TYPE('buf2', ['Buffer', 'Uint8Array'], b);
    return compareBytes(a, b);
  };

  function assertConcatElement(item, index) {
    if (!(item instanceof Uint8Array))
      throw ERR_INVALID_ARG_TYPE('list[' + index + ']', ['Buffer', 'Uint8Array'], item);
  }

  /** @param {Array<Uint8Array|Buffer>} list @param {number} [totalLength] */
  Buffer.concat = function (list, totalLength) {
    if (!Array.isArray(list)) throw ERR_INVALID_ARG_TYPE('list', 'Array', list);
    if (list.length === 0) return new FastBuffer(0);
    if (totalLength === undefined) {
      totalLength = 0;
      for (var i = 0; i < list.length; i++) {
        assertConcatElement(list[i], i);
        totalLength += list[i].length;
      }
    } else {
      if (typeof totalLength !== 'number')
        throw ERR_INVALID_ARG_TYPE('length', 'number', totalLength);
      if (Math.floor(totalLength) !== totalLength)
        throw ERR_OUT_OF_RANGE('length', 'an integer', totalLength);
      if (totalLength < 0 || totalLength > K_MAX_LENGTH)
        throw ERR_OUT_OF_RANGE('length', '>= 0 && <= ' + K_MAX_LENGTH, totalLength);
    }
    var result = allocate(totalLength);
    var offset = 0;
    for (var j = 0; j < list.length; j++) {
      var item = list[j];
      assertConcatElement(item, j);
      if (offset + item.length > totalLength) {
        result.set(item.subarray(0, totalLength - offset), offset);
        offset = totalLength;
        break;
      }
      result.set(item, offset);
      offset += item.length;
    }
    if (offset < totalLength) result.fill(0, offset);
    return result;
  };

  Buffer.copyBytesFrom = function (view, offset, length) {
    if (!ArrayBuffer.isView(view)) throw ERR_INVALID_ARG_TYPE('view', 'TypedArray', view);
    var bpe = view.BYTES_PER_ELEMENT || 1;
    offset = toInteger(offset, 0);
    length = length === undefined ? view.length - offset : toInteger(length, 0);
    var bytes = new Uint8Array(view.buffer, view.byteOffset + offset * bpe, length * bpe);
    return Buffer.from(bytes);
  };

  Buffer.of = function () {
    return Buffer.from(Array.prototype.slice.call(arguments));
  };

  /**
   * Shared pool size for small allocUnsafe (bytes). Larger than Node's 8 KiB:
   * a pool refill costs far more on JSC than on V8, so a bigger slab amortizes
   * it further (the pooled-size cutoff stays poolSize >>> 1, like Node).
   */
  Buffer.poolSize = 262144;

  createPool();

  // Node throws a DOMException here; Lava has no DOMException (same gap as
  // structured_clone.js's DataCloneError), so this is an Error carrying the
  // DOMException's name and legacy numeric code.
  function errInvalidCharacter(message) {
    var e = new Error(message);
    e.name = 'InvalidCharacterError';
    e.code = 5;
    return e;
  }

  // One native regex scan instead of a per-char StringPrototypeCharCodeAt loop
  // (~63 ns/char through the caller1 wrapper). 200 btoa calls on 48 KiB of latin1
  // took 615 ms that way and 89 ms with the regex; 200 atob calls on 64 KiB of
  // base64, 2542 vs 1579 ms (medians of 5 interleaved launches per arm, darwin
  // arm64, -o:speed). Most of what is left is the Buffer round trip, not this
  // check. Non-global, so RegExpMatches never touches lastIndex (§5).
  // ATOB_SLOW_RE matches anything the fast path cannot take as-is: whitespace or a
  // non-alphabet character, a '=' followed by anything but '=', or three '='; atob
  // then falls back to the exact per-char loop, so error selection and messages
  // are unchanged.
  var ATOB_SLOW_RE = /[^A-Za-z0-9+/=]|=[^=]|===/;
  var NON_LATIN1_RE = /[^\u0000-\u00ff]/;

  /**
   * Base64 → latin1 per the HTML forgiving-base64 decode (global atob and node:buffer's
   * atob are the same function, as in Node).
   * @param {*} input Stringified with a template literal, like Node (`${input}`).
   * @returns {string}
   * @throws {TypeError} ERR_MISSING_ARGS — called with no argument.
   * @throws {Error} name InvalidCharacterError, code 5 — a character outside
   *         A-Za-z0-9+/= and ASCII whitespace, '=' not at the end or more than two,
   *         '=' when the length is not a multiple of 4, or a lone trailing character.
   * @node Mirrors lib/buffer.js atob: whitespace is TAB LF FF CR SPACE (not VT); the
   *       messages are 'Invalid character' and 'The string to be decoded is not
   *       correctly encoded.' (node 26.13.0, tests/node-compat/cases/03-buffer.js).
   * @deviates The error is an Error, not a DOMException (Lava has none); name, code
   *           and message match. Pinned by cmd/lava/atob_invalid_character_test.odin.
   */
  function atob(input) {
    if (arguments.length === 0) throw ERR_MISSING_ARGS('input');
    input = `${input}`;
    var nonWhitespace = 0;
    var equals = 0;
    if (!P.RegExpMatches(ATOB_SLOW_RE, input)) {
      // Fast path: only alphabet characters and at most two trailing '='. The
      // remainder rules below still apply.
      nonWhitespace = input.length;
      if (nonWhitespace > 0 && StringPrototypeCharCodeAt(input, nonWhitespace - 1) === 0x3d) {
        equals = 1;
        if (nonWhitespace > 1 && StringPrototypeCharCodeAt(input, nonWhitespace - 2) === 0x3d)
          equals = 2;
      }
    } else
      for (var i = 0; i < input.length; i++) {
        var c = StringPrototypeCharCodeAt(input, i);
        if (c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d || c === 0x20) continue;
        var alnum =
          (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39);
        if (!alnum && c !== 0x2b && c !== 0x2f && c !== 0x3d)
          throw errInvalidCharacter('Invalid character');
        nonWhitespace++;
        if (c === 0x3d) equals++;
        else if (equals) throw errInvalidCharacter('Invalid character'); // '=' only at the end
        if (equals > 2) throw errInvalidCharacter('Invalid character');
      }
    // The lone-trailing-character test runs on the length WITHOUT the '=' and wins
    // over the padding test: node 26.13.0 answers 'not correctly encoded' for 'a=',
    // 'a==' and 'abcde=', and 'Invalid character' for 'ab=', 'abc==' and 'Zm9v='
    // (probed; pinned by tests/node-compat/cases/03-buffer.js).
    if ((nonWhitespace - equals) % 4 === 1)
      throw errInvalidCharacter('The string to be decoded is not correctly encoded.');
    if (equals && nonWhitespace % 4) throw errInvalidCharacter('Invalid character');
    return Buffer.from(input, 'base64').toString('latin1');
  }

  /**
   * latin1 → Base64 (global btoa and node:buffer's btoa are the same function).
   * @param {*} input Stringified with a template literal, like Node.
   * @returns {string}
   * @throws {TypeError} ERR_MISSING_ARGS — called with no argument.
   * @throws {Error} name InvalidCharacterError, code 5 — a code unit above 0xFF.
   * @node lib/buffer.js btoa (node 26.13.0, tests/node-compat/cases/03-buffer.js).
   * @deviates Not a DOMException, as for atob; pinned by
   *           cmd/lava/atob_invalid_character_test.odin.
   */
  function btoa(input) {
    if (arguments.length === 0) throw ERR_MISSING_ARGS('input');
    input = `${input}`;
    if (P.RegExpMatches(NON_LATIN1_RE, input)) throw errInvalidCharacter('Invalid character');
    return Buffer.from(input, 'latin1').toString('base64');
  }

  /** @param {ArrayBuffer|Uint8Array} input @returns {boolean} */
  function isAscii(input) {
    var bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
    if (!(bytes instanceof Uint8Array))
      throw new TypeError('input must be a Buffer, ArrayBuffer, or TypedArray');
    for (var i = 0; i < bytes.length; i++) if (bytes[i] > 0x7f) return false;
    return true;
  }

  /** Strict UTF-8 validity (native). @param {ArrayBuffer|Uint8Array} input */
  function isUtf8(input) {
    var bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
    if (!(bytes instanceof Uint8Array))
      throw new TypeError('input must be a Buffer, ArrayBuffer, or TypedArray');
    return nativeIsValidUtf8(bytes);
  }

  /** Re-encode buffer contents between encodings. */
  function transcode(source, fromEnc, toEnc) {
    return Buffer.from(Buffer.from(source).toString(fromEnc), toEnc);
  }

  var createObjectURL = blobModule.createObjectURL;
  var revokeObjectURL = blobModule.revokeObjectURL;
  if (globalThis.URL === undefined) {
    globalThis.URL = { createObjectURL: createObjectURL, revokeObjectURL: revokeObjectURL };
  } else {
    if (typeof globalThis.URL.createObjectURL !== 'function')
      globalThis.URL.createObjectURL = createObjectURL;
    if (typeof globalThis.URL.revokeObjectURL !== 'function')
      globalThis.URL.revokeObjectURL = revokeObjectURL;
  }

  if (globalThis.Buffer === undefined) {
    globalThis.Buffer = Buffer;
  }
  if (globalThis.Blob === undefined) {
    globalThis.Blob = Blob;
  }
  if (globalThis.File === undefined) {
    globalThis.File = File;
  }
  if (globalThis.atob === undefined) {
    globalThis.atob = atob;
  }
  if (globalThis.btoa === undefined) {
    globalThis.btoa = btoa;
  }

  var exported = {
    Buffer: Buffer,
    Blob: Blob,
    File: File,
    kMaxLength: K_MAX_LENGTH,
    kStringMaxLength: K_STRING_MAX_LENGTH,
    constants: { MAX_LENGTH: K_MAX_LENGTH, MAX_STRING_LENGTH: K_STRING_MAX_LENGTH },
    atob: atob,
    btoa: btoa,
    isAscii: isAscii,
    isUtf8: isUtf8,
    transcode: transcode,
    resolveObjectURL: blobModule.resolveObjectURL,
  };
  Object.defineProperty(exported, 'INSPECT_MAX_BYTES', {
    get: function () {
      return inspectMaxBytes;
    },
    set: function (value) {
      inspectMaxBytes = value;
    },
  });
  module.exports = exported;
});
