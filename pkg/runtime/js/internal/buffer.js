/**
 * @fileoverview node:internal/buffer — the encoding codecs and the fixed-width numeric
 * accessors behind `Buffer.prototype`, where node keeps them: lib/internal/buffer.js.
 *
 * `addBufferPrototypeMethods` installs the read/write integer and float methods and the
 * per-encoding `*Slice`/`*Write` aliases on the prototype node:buffer builds, at the
 * point it always installed them, so the prototype key order is unchanged. The codec
 * helpers (`normalizeEncoding`, `strToBytes`, `bytesToString`) are node:buffer's
 * encoding ops; node/buffer.js captures them once at its own module-eval, so a
 * `toString` or `write` pays a closure-variable call exactly as before the split, not
 * a property read. Nothing here requires node:buffer back.
 *
 * @param {Object} native node:buffer's bindings (the loader hands this file the same
 *   object as node/buffer.js).
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

  var EMPTY_U8 = new Uint8Array(0);

  // Encoding-name resolution is hardened ahead of the rest of node:buffer because
  // internal/encoding.js routes TextEncoder.encode and the TextDecoder utf-8 fast
  // path through Buffer: a replaced `String` global or a poisoned
  // `String.prototype.toLowerCase` reached a hardened TextDecoder through here and
  // turned a valid decode into `Unknown encoding: …`. The rest of node:buffer is
  // not yet converted (see tests/node-compat/pollution-baseline.json).
  var P = require('internal/primordials');
  var StringG = String;
  var StringPrototypeToLowerCase = P.StringPrototypeToLowerCase;
  var StringPrototypeCharCodeAt = P.StringPrototypeCharCodeAt;
  var StringFromCharCode = String.fromCharCode;
  var ObjectPrototypeHasOwnProperty = P.ObjectPrototypeHasOwnProperty;

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

  // Node-shaped coded errors come from internal/errors (CLAUDE.md §5); what stays here
  // are the buffer-only message templates.
  var errors = require('internal/errors');
  var nodeError = errors.nodeError;
  var ERR_INVALID_ARG_TYPE = errors.ERR_INVALID_ARG_TYPE;
  var ERR_OUT_OF_RANGE = errors.ERR_OUT_OF_RANGE;
  var ERR_UNKNOWN_ENCODING = errors.ERR_UNKNOWN_ENCODING;

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
   * Installs the per-encoding `*Slice`/`*Write` aliases and the fixed-width numeric
   * read/write methods on `p` (Buffer.prototype), as node's addBufferPrototypeMethods
   * does. Called once, by node:buffer, between `toLocaleString` and the `parent`/`offset`
   * accessors: the position they were assigned at before the split, so the prototype's
   * own-key order is unchanged.
   * @param {Object} p Buffer.prototype (=== FastBuffer.prototype).
   */
  function addBufferPrototypeMethods(p) {
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
    // BIG_0 is null exactly when BigInt is missing; read it rather than the live `BigInt`
    // global, which this module-eval test became a call-time read of once it moved here.
    if (BIG_0 !== null) {
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
    if (BIG_0 !== null) {
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
  }

  module.exports = {
    requireNative: requireNative,
    normalizeEncoding: normalizeEncoding,
    isEncodingName: isEncodingName,
    strToBytes: strToBytes,
    bytesToString: bytesToString,
    addBufferPrototypeMethods: addBufferPrototypeMethods,
  };
});
