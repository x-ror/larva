/**
 * @fileoverview node:buffer — `Buffer` as a `Uint8Array` subclass.
 *
 * Codecs and byte-ops are Odin natives (`pkg/runtime/buffer.odin`) injected via
 * the loader's fourth `native` argument. This file owns Node API glue, errors,
 * pooling, and Blob/File/object-URL helpers.
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
  var P = require('primordials');
  var StringG = String;
  var StringPrototypeToLowerCase = P.StringPrototypeToLowerCase;
  var StringPrototypeCharCodeAt = P.StringPrototypeCharCodeAt;
  var StringPrototypeSlice = P.StringPrototypeSlice;
  var StringPrototypeIndexOf = P.StringPrototypeIndexOf;
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

  function describeType(value) {
    if (value === null) return 'null';
    var t = typeof value;
    if (t === 'undefined') return 'undefined';
    if (t === 'string') {
      var s = value.length > 28 ? value.slice(0, 25) + '...' : value;
      return "type string ('" + s + "')";
    }
    // -0 renders as "-0" in Node (it routes through util.inspect); string
    // concatenation erases the sign. 1/value avoids a dependency on Object.is.
    if (t === 'number')
      return 'type number (' + (value === 0 && 1 / value < 0 ? '-0' : value) + ')';
    if (t === 'boolean') return 'type boolean (' + value + ')';
    if (t === 'bigint') return 'type bigint (' + value + 'n)';
    if (t === 'symbol') return 'type symbol (' + value.toString() + ')';
    if (t === 'function') return 'function ' + (value.name || '(anonymous)');
    var ctor = value.constructor && value.constructor.name;
    return 'an instance of ' + (ctor || 'Object');
  }

  function numericSeparator(value) {
    var str;
    if (typeof value === 'bigint') str = value.toString();
    else if (typeof value !== 'number') return StringG(value);
    else if (!isFinite(value) || Math.floor(value) !== value) return StringG(value);
    else str = StringG(value);
    var neg = str.charAt(0) === '-';
    if (neg) str = str.slice(1);
    var out = '';
    var i = str.length;
    for (; i > 3; i -= 3) out = '_' + str.slice(i - 3, i) + out;
    return (neg ? '-' : '') + str.slice(0, i) + out;
  }

  /** @returns {TypeError & {code: string}} */
  function errInvalidArgType(name, expected, actual) {
    var e = new TypeError(
      'The "' + name + '" argument must be ' + expected + '. Received ' + describeType(actual),
    );
    e.code = 'ERR_INVALID_ARG_TYPE';
    return e;
  }

  function errInvalidFromArg(value) {
    var e = new TypeError(
      'The first argument must be of type string or an instance of Buffer, ArrayBuffer, ' +
        'or Array or an Array-like Object. Received ' +
        describeType(value),
    );
    e.code = 'ERR_INVALID_ARG_TYPE';
    return e;
  }

  /** @returns {RangeError & {code: string}} */
  function errOutOfRange(name, range, received) {
    var rendered;
    if (typeof received === 'bigint') {
      var bigWide = received > BigInt('4294967296') || received < -BigInt('4294967296');
      rendered = (bigWide ? numericSeparator(received) : received.toString()) + 'n';
    } else if (typeof received === 'number' && (received > 4294967296 || received < -4294967296)) {
      rendered = numericSeparator(received);
    } else {
      rendered = StringG(received);
    }
    var e = new RangeError(
      'The value of "' + name + '" is out of range. It must be ' + range + '. Received ' + rendered,
    );
    e.code = 'ERR_OUT_OF_RANGE';
    return e;
  }

  function errInvalidArgValue(name, value) {
    var rendered;
    if (typeof value === 'string') rendered = "'" + value + "'";
    else if (value instanceof Uint8Array) rendered = inspectBuffer(value);
    else rendered = describeType(value);
    var e = new TypeError("The argument '" + name + "' is invalid. Received " + rendered);
    e.code = 'ERR_INVALID_ARG_VALUE';
    return e;
  }

  function validateByteLength(byteLength) {
    if (typeof byteLength !== 'number')
      throw errInvalidArgType('byteLength', 'of type number', byteLength);
    if (Math.floor(byteLength) !== byteLength)
      throw errOutOfRange('byteLength', 'an integer', byteLength);
    if (byteLength < 1 || byteLength > 6)
      throw errOutOfRange('byteLength', '>= 1 and <= 6', byteLength);
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
      throw errOutOfRange('value', range, value);
    }
  }

  function validateWriteOffset(offset, max, name) {
    if (Math.floor(offset) !== offset) throw errOutOfRange(name, 'an integer', offset);
    if (offset < 0 || offset > max) throw errOutOfRange(name, '>= 0 && <= ' + max, offset);
    return offset;
  }

  function errUnknownEncoding(encoding) {
    var e = new TypeError('Unknown encoding: ' + encoding);
    e.code = 'ERR_UNKNOWN_ENCODING';
    return e;
  }

  function errBufferSize(bits) {
    var e = new RangeError('Buffer size must be a multiple of ' + bits + '-bits');
    e.code = 'ERR_INVALID_BUFFER_SIZE';
    return e;
  }

  /** Validates size for alloc/allocUnsafe (Node + JSC abort guard). */
  function assertSize(size) {
    if (typeof size !== 'number') throw errInvalidArgType('size', 'number', size);
    if (!(size >= 0 && size <= K_MAX_LENGTH))
      throw errOutOfRange('size', '>= 0 && <= ' + K_MAX_LENGTH, size);
  }

  /** @returns {string} Canonical encoding name (default utf8). */
  function normalizeEncoding(encoding) {
    if (encoding === undefined || encoding === null || encoding === '') return 'utf8';
    var key = StringPrototypeToLowerCase(StringG(encoding));
    var canon = ENCODING_ALIASES[key];
    return canon !== undefined ? canon : key;
  }

  /** @returns {boolean} */
  function isEncodingName(encoding) {
    return ObjectPrototypeHasOwnProperty(
      ENCODING_ALIASES,
      StringPrototypeToLowerCase(StringG(encoding)),
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
      if (c === 0x2d) c = 0x2b; // '-' -> '+'
      else if (c === 0x5f) c = 0x2f; // '_' -> '/'
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
    throw errUnknownEncoding(encoding);
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
    throw errUnknownEncoding(encoding);
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
    var e = new RangeError('Attempt to access memory outside buffer bounds');
    e.code = 'ERR_BUFFER_OUT_OF_BOUNDS';
    return e;
  }

  /** Node-style offset bounds for fixed-width numeric accessors. */
  function checkBounds(buf, offset, byteLength) {
    if (offset === undefined) offset = 0;
    if (typeof offset !== 'number') throw errInvalidArgType('offset', 'number', offset);
    if (Math.floor(offset) !== offset) throw errOutOfRange('offset', 'an integer', offset);
    var max = buf.length - byteLength;
    if (max < 0) throw errBufferOutOfBounds();
    if (offset < 0 || offset > max) throw errOutOfRange('offset', '>= 0 and <= ' + max, offset);
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
    throw new TypeError('value must be string, number, Buffer, or Uint8Array');
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

  function writeBigUInt(buf, value, offset, littleEndian) {
    value = BigInt(value);
    checkValueInt(value, BIG_0, BIG_MAX_U64, 7);
    offset = checkBounds(buf, offset, 8);
    viewOf(buf).setBigUint64(offset, value, littleEndian);
    return offset + 8;
  }

  function writeBigInt(buf, value, offset, littleEndian) {
    value = BigInt(value);
    checkValueInt(value, -BIG_SIGN_I64, BIG_SIGN_I64 - BIG_1, 7);
    offset = checkBounds(buf, offset, 8);
    viewOf(buf).setBigInt64(offset, value, littleEndian);
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
      else start |= 0;
      if (end === undefined || end > len) end = len;
      else end |= 0;
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
        throw errInvalidArgType('target', 'an instance of Buffer or Uint8Array', target);
      if (targetStart === undefined) {
        targetStart = 0;
      } else {
        targetStart = toInteger(targetStart, 0);
        if (targetStart < 0) throw errOutOfRange('targetStart', '>= 0', targetStart);
      }
      if (sourceStart === undefined) {
        sourceStart = 0;
      } else {
        sourceStart = toInteger(sourceStart, 0);
        if (sourceStart < 0 || sourceStart > this.length)
          throw errOutOfRange('sourceStart', '>= 0 && <= ' + this.length, sourceStart);
      }
      if (sourceEnd === undefined) {
        sourceEnd = this.length;
      } else {
        sourceEnd = toInteger(sourceEnd, 0);
        if (sourceEnd < 0) throw errOutOfRange('sourceEnd', '>= 0', sourceEnd);
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
      if (offset === undefined) {
        offset = 0;
        length = this.length;
      } else if (typeof offset === 'string') {
        encoding = offset;
        offset = 0;
        length = this.length;
      } else {
        offset = validateWriteOffset(+offset, this.length, 'offset');
        if (typeof length === 'string') {
          encoding = length;
          length = undefined;
        }
      }
      var enc = normalizeEncoding(encoding || 'utf8');
      var remaining = this.length - offset;
      var max = length === undefined ? remaining : toInteger(length, 0);
      if (max > remaining) max = remaining;
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
        throw new TypeError('target must be a Buffer or Uint8Array');
      targetStart = validateRange(targetStart, K_MAX_LENGTH, 'targetStart');
      targetEnd = validateRange(
        targetEnd === undefined ? target.length : targetEnd,
        target.length,
        'targetEnd',
      );
      sourceStart = validateRange(sourceStart, K_MAX_LENGTH, 'sourceStart');
      sourceEnd = validateRange(
        sourceEnd === undefined ? this.length : sourceEnd,
        this.length,
        'sourceEnd',
      );
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
      if (start === undefined) start = 0;
      else start = validateWriteOffset(+start, K_MAX_LENGTH, 'offset');
      if (end === undefined) end = this.length;
      else end = validateWriteOffset(+end, this.length, 'end');
      if (end <= start) return this;
      if (typeof value === 'number') {
        u8Fill.call(this, value & 0xff, start, end);
        return this;
      }
      if (typeof value === 'boolean') {
        u8Fill.call(this, value ? 1 : 0, start, end);
        return this;
      }
      var bytes;
      if (value instanceof Uint8Array) {
        if (value.length === 0) throw errInvalidArgValue('value', value);
        bytes = value;
      } else {
        var str = StringG(value);
        bytes = strToBytes(str, encoding || 'utf8');
        if (bytes.length === 0) {
          if (str.length !== 0) throw errInvalidArgValue('value', value);
          u8Fill.call(this, 0, start, end);
          return this;
        }
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
   */
  function Buffer(arg, encodingOrOffset, length) {
    if (typeof arg === 'string') return Buffer.from(arg, encodingOrOffset);
    if (typeof arg === 'number') {
      if (arg > K_MAX_LENGTH) throw errOutOfRange('size', '>= 0 && <= ' + K_MAX_LENGTH, arg);
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
    if (remaining > 0)
      hex += (hex ? ' ' : '') + '... ' + remaining + ' more byte' + (remaining > 1 ? 's' : '');
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
   * Unpooled uninitialized allocation (allocUnsafe large path / SlowBuffer).
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
    throw errInvalidFromArg(value);
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
    throw errInvalidArgType(
      'string',
      'of type string or an instance of Buffer or ArrayBuffer',
      string,
    );
  };

  Buffer.compare = function (a, b) {
    if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array))
      throw new TypeError('Arguments must be Buffers or Uint8Arrays');
    return compareBytes(a, b);
  };

  function assertConcatElement(item, index) {
    if (!(item instanceof Uint8Array))
      throw errInvalidArgType('list[' + index + ']', 'an instance of Buffer or Uint8Array', item);
  }

  /** @param {Array<Uint8Array|Buffer>} list @param {number} [totalLength] */
  Buffer.concat = function (list, totalLength) {
    if (!Array.isArray(list)) throw errInvalidArgType('list', 'an instance of Array', list);
    if (list.length === 0) return new FastBuffer(0);
    if (totalLength === undefined) {
      totalLength = 0;
      for (var i = 0; i < list.length; i++) {
        assertConcatElement(list[i], i);
        totalLength += list[i].length;
      }
    } else {
      if (typeof totalLength !== 'number') throw errInvalidArgType('length', 'number', totalLength);
      if (Math.floor(totalLength) !== totalLength)
        throw errOutOfRange('length', 'an integer', totalLength);
      if (totalLength < 0 || totalLength > K_MAX_LENGTH)
        throw errOutOfRange('length', '>= 0 && <= ' + K_MAX_LENGTH, totalLength);
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
    if (!ArrayBuffer.isView(view)) throw new TypeError('view must be a TypedArray');
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

  /** @deprecated Use Buffer.allocUnsafeSlow. */
  function SlowBuffer(size) {
    assertSize(size);
    return allocUnsafeNoZero(size);
  }

  /** Base64 → latin1 (Node global atob polyfill surface). */
  function atob(data) {
    return Buffer.from(StringG(data), 'base64').toString('latin1');
  }

  /** latin1 → Base64 (Node global btoa polyfill surface). */
  function btoa(data) {
    return Buffer.from(StringG(data), 'latin1').toString('base64');
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

  function nativeEol() {
    return globalThis.process && globalThis.process.platform === 'win32' ? '\r\n' : '\n';
  }

  // toNativeEndings is `str.replace(/\r?\n/g, nativeEol())` — every CRLF or lone LF
  // becomes the platform terminator. No regex: a GLOBAL replace under a forged
  // `RegExp.prototype.exec` never returns, so `new Blob([text], {endings:'native'})`
  // spun on any text at all. node 24 hangs here too, so hardening it is a deviation in
  // Lava's favour; pinned Lava-only by cmd/lava/regexp_pollution_test.odin.
  //
  // `\r?\n` means a CR is consumed only when an LF follows it: a lone CR is left alone,
  // which is why this scans for LF and looks back rather than scanning for CR.
  // Both early-outs are native scans, and they are the whole common case: text with no
  // newline at all, and — on POSIX, where `eol` is '\n' — text with no CR, for which
  // `\r?\n -> '\n'` is the identity. Without them this rebuilt the entire string as a
  // rope even when the result was byte-identical to the input: measured at 1.6x and
  // +54-70% peak RSS on a 64 KB body before they were added.
  function toNativeEndings(str) {
    var firstLF = StringPrototypeIndexOf(str, '\n', 0);
    if (firstLF === -1) return str;
    var eol = nativeEol();
    if (eol === '\n' && StringPrototypeIndexOf(str, '\r', 0) === -1) return str;
    var out = '';
    var from = 0;
    for (var i = firstLF; i !== -1; i = StringPrototypeIndexOf(str, '\n', from)) {
      var cut = i > from && StringPrototypeCharCodeAt(str, i - 1) === 0x0d ? i - 1 : i; // CR
      if (cut > from) out += StringPrototypeSlice(str, from, cut);
      out += eol;
      from = i + 1;
    }
    return from < str.length ? out + StringPrototypeSlice(str, from) : out;
  }

  function blobPartToChunks(part, nativeEndings) {
    if (part instanceof Blob) return part._parts;
    if (part instanceof ArrayBuffer) return [new Uint8Array(part.slice(0))];
    if (ArrayBuffer.isView(part)) {
      return [
        new Uint8Array(part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength)),
      ];
    }
    var str = StringG(part);
    if (nativeEndings) str = toNativeEndings(str);
    return [new Uint8Array(Buffer.from(str, 'utf8'))];
  }

  function blobJoin(parts, total) {
    var merged = new Uint8Array(total),
      off = 0;
    for (var i = 0; i < parts.length; i++) {
      merged.set(parts[i], off);
      off += parts[i].length;
    }
    return merged;
  }

  function normalizeBlobType(options) {
    if (!options || options.type === undefined) return '';
    var type = StringG(options.type);
    for (var i = 0; i < type.length; i++) {
      var code = type.charCodeAt(i);
      if (code < 0x20 || code > 0x7e) return '';
    }
    return type.toLowerCase();
  }

  /**
   * Minimal Blob: stores parts without eager concat; materializes on demand.
   * @param {Array<*>} parts
   * @param {{type?: string, endings?: string}} [options]
   */
  function Blob(parts, options) {
    if (!(this instanceof Blob)) throw new TypeError("Constructor Blob requires 'new'");
    var chunks = [],
      total = 0;
    if (parts !== undefined && parts !== null) {
      if (typeof parts !== 'object' || typeof parts[Symbol.iterator] !== 'function') {
        throw new TypeError('The "parts" argument must be an iterable object');
      }
      var nativeEndings = !!(options && options.endings === 'native');
      var list = Array.from(parts);
      for (var i = 0; i < list.length; i++) {
        var cs = blobPartToChunks(list[i], nativeEndings);
        for (var j = 0; j < cs.length; j++) {
          if (cs[j].length === 0) continue;
          chunks.push(cs[j]);
          total += cs[j].length;
        }
      }
    }
    Object.defineProperty(this, '_parts', { value: chunks });
    Object.defineProperty(this, '_size', { value: total });
    Object.defineProperty(this, '_type', { value: normalizeBlobType(options) });
  }
  Object.defineProperty(Blob.prototype, 'size', {
    get: function () {
      return this._size;
    },
    configurable: true,
  });
  Object.defineProperty(Blob.prototype, 'type', {
    get: function () {
      return this._type;
    },
    configurable: true,
  });
  Blob.prototype.arrayBuffer = function () {
    return Promise.resolve(blobJoin(this._parts, this._size).buffer);
  };
  Blob.prototype.bytes = function () {
    return Promise.resolve(blobJoin(this._parts, this._size));
  };
  Blob.prototype.stream = function () {
    var parts = this._parts;
    var ReadableStream = require('node:stream/web').ReadableStream;
    return new ReadableStream({
      start: function (controller) {
        for (var i = 0; i < parts.length; i++) controller.enqueue(new Uint8Array(parts[i]));
        controller.close();
      },
    });
  };
  Blob.prototype.text = function () {
    return Promise.resolve(Buffer.from(blobJoin(this._parts, this._size)).toString('utf8'));
  };
  Blob.prototype.slice = function (start, end, contentType) {
    var len = this._size;
    var s = start === undefined ? 0 : start < 0 ? Math.max(len + start, 0) : Math.min(start, len);
    var e = end === undefined ? len : end < 0 ? Math.max(len + end, 0) : Math.min(end, len);
    if (e < s) e = s;
    var out = [];
    var pos = 0;
    var parts = this._parts;
    for (var i = 0; i < parts.length && pos < e; i++) {
      var part = parts[i];
      var pEnd = pos + part.length;
      if (pEnd > s) {
        out.push(part.subarray(pos < s ? s - pos : 0, pEnd > e ? e - pos : part.length));
      }
      pos = pEnd;
    }
    return new Blob(out, contentType === undefined ? undefined : { type: contentType });
  };
  Blob.prototype.toString = function () {
    return '[object Blob]';
  };

  /** @extends Blob */
  function File(parts, name, options) {
    if (!(this instanceof File)) throw new TypeError("Constructor File requires 'new'");
    if (arguments.length < 2)
      throw new TypeError(
        "Failed to construct 'File': 2 arguments required, but only " +
          arguments.length +
          ' present.',
      );
    Blob.call(this, parts, options);
    Object.defineProperty(this, '_name', { value: StringG(name) });
    var lm =
      options && options.lastModified !== undefined ? Number(options.lastModified) : Date.now();
    Object.defineProperty(this, '_lastModified', { value: lm });
  }
  File.prototype = Object.create(Blob.prototype);
  File.prototype.constructor = File;
  Object.defineProperty(File.prototype, 'name', {
    get: function () {
      return this._name;
    },
    configurable: true,
  });
  Object.defineProperty(File.prototype, 'lastModified', {
    get: function () {
      return this._lastModified;
    },
    configurable: true,
  });

  if (typeof Symbol !== 'undefined' && Symbol.toStringTag) {
    Object.defineProperty(Blob.prototype, Symbol.toStringTag, {
      value: 'Blob',
      configurable: true,
    });
    Object.defineProperty(File.prototype, Symbol.toStringTag, {
      value: 'File',
      configurable: true,
    });
  }

  var objectUrlRegistry = new Map();

  function objectUrlId() {
    var c = globalThis.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    var bytes = new Uint8Array(16);
    if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
    else for (var i = 0; i < 16; i++) bytes[i] = (Math.random() * 256) & 0xff;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    var s = '';
    for (var j = 0; j < 16; j++) {
      s += (bytes[j] + 0x100).toString(16).slice(1);
      if (j === 3 || j === 5 || j === 7 || j === 9) s += '-';
    }
    return s;
  }

  /** @param {Blob|File} obj @returns {string} blob: URL */
  function createObjectURL(obj) {
    if (!(obj instanceof Blob)) {
      var typeErr = new TypeError('The "obj" argument must be an instance of Blob.');
      typeErr.code = 'ERR_INVALID_ARG_TYPE';
      throw typeErr;
    }
    var id = 'blob:nodedata:' + objectUrlId();
    objectUrlRegistry.set(id, obj);
    return id;
  }

  /** @param {string} url */
  function revokeObjectURL(url) {
    if (url === undefined) {
      var missingErr = new TypeError('The "url" argument must be specified');
      missingErr.code = 'ERR_MISSING_ARGS';
      throw missingErr;
    }
    objectUrlRegistry.delete(StringG(url));
  }

  /** @param {string} id @returns {Blob|File|null} */
  function resolveObjectURL(id) {
    var blob = objectUrlRegistry.get(`${id}`);
    if (blob === undefined) return;
    return new Blob([blob], { type: blob.type });
  }

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

  var exported = {
    Buffer: Buffer,
    SlowBuffer: SlowBuffer,
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
    resolveObjectURL: resolveObjectURL,
  };
  Object.defineProperty(exported, 'INSPECT_MAX_BYTES', {
    get: function () {
      return inspectMaxBytes;
    },
    set: function (value) {
      inspectMaxBytes = value;
    },
  });
  // Internal, and deliberately NON-ENUMERABLE so `Object.keys(require('buffer'))` still
  // matches node exactly: stream.js builds the same ERR_INVALID_ARG_TYPE "Received …"
  // clause, there is no shared errors module to host it, and the alternative is a seventh
  // near-copy in a tree where the six that exist already disagree with each other (fs.js's
  // was missing node's object branch until #330). An earlier revision exported it
  // enumerably, which silently added a key node does not have.
  P.ObjectDefineProperty(exported, 'describeType', {
    value: describeType,
    enumerable: false,
    writable: false,
    configurable: false,
  });

  module.exports = exported;
});
