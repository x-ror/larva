/**
 * @fileoverview node:buffer — `Buffer` as a `Uint8Array` subclass.
 *
 * Codecs and byte-ops are Odin natives (`pkg/runtime/buffer.odin`) injected via
 * the loader's fourth `native` argument. This file owns Node API glue, errors and
 * pooling: the constructor, the statics, the pool, the prototype methods node keeps
 * in lib/buffer.js, and atob/btoa. The encoding codecs and the fixed-width numeric
 * accessors live in internal/buffer.js, as node's do in lib/internal/buffer.js.
 * Blob, File and the blob: URL registry live in internal/blob.js and
 * internal/file.js (node's lib/internal layout); this module re-exports them and
 * installs their globals, in the order it always has.
 *
 * @module lava/internal/buffer
 */

(function (require, module, exports, native) {
  'use strict';

  if (!native) throw new Error('node:buffer requires native codec bindings');

  // Required first: it owns requireNative, and the codec helpers below are captured
  // from it once, here, so every call site is a closure-variable call as before.
  var internalBuffer = require('internal/buffer');
  var requireNative = internalBuffer.requireNative;
  var normalizeEncoding = internalBuffer.normalizeEncoding;
  var isEncodingName = internalBuffer.isEncodingName;
  var strToBytes = internalBuffer.strToBytes;
  var bytesToString = internalBuffer.bytesToString;

  var hexEncodeNative = requireNative('hexEncode');
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

  var u8Fill = Uint8Array.prototype.fill;

  // The encoding-name hardening moved to internal/buffer.js with the codecs; what is
  // captured here serves write, fromString, inspect and atob.
  var P = require('internal/primordials');
  var StringG = String;
  var StringPrototypeCharCodeAt = P.StringPrototypeCharCodeAt;
  var StringPrototypeSlice = P.StringPrototypeSlice;
  var TypedArrayPrototypeGetLength = P.TypedArrayPrototypeGetLength;

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

  // Required here, at the top level, so both stay in the eager set: the globals and
  // URL statics below are installed from this module, in the same order as before
  // they were split out. Neither requires node:buffer back (see internal/blob.js).
  var blobModule = require('internal/blob');
  var Blob = blobModule.Blob;
  var File = require('internal/file').File;

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

  function validateRange(value, max, name) {
    value = toInteger(value, 0);
    if (value < 0 || value > max) throw new RangeError(name + ' is out of range');
    return value;
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
  // node's addBufferPrototypeMethods, at the point these were always assigned.
  internalBuffer.addBufferPrototypeMethods(p);

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
