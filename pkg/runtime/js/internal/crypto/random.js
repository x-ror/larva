// The CSPRNG surface — randomBytes, randomFill/randomFillSync, randomInt, randomUUID and
// getRandomValues — where node keeps it: lib/internal/crypto/random.js. It also installs
// the WHATWG `globalThis.crypto` (below), so the Window surface gets it without
// instantiating node/crypto.js.
//
// @param {{ randomFill: Function, randomInt: Function }} native node:crypto's bindings
//   (the loader hands this file the same object as node/crypto.js).
(function (require, module, exports, native) {
  'use strict';

  var util = require('internal/crypto/util');
  var invalidArgType = util.invalidArgType;
  var outOfRange = util.outOfRange;
  var validateByteCount = util.validateByteCount;
  var P = require('internal/primordials');
  var ArrayBufferIsView = P.ArrayBufferIsView;
  var StringPrototypeSlice = P.StringPrototypeSlice;
  var TypedArrayPrototypeGetBuffer = P.TypedArrayPrototypeGetBuffer;
  var TypedArrayPrototypeGetByteLength = P.TypedArrayPrototypeGetByteLength;
  var TypedArrayPrototypeGetByteOffset = P.TypedArrayPrototypeGetByteOffset;
  var TypedArrayPrototypeGetSymbolToStringTag = P.TypedArrayPrototypeGetSymbolToStringTag;
  var Uint8ArrayP = P.Uint8Array;
  var domexception = require('internal/domexception');
  var DOMException = domexception.DOMException;
  var QuotaExceededError = domexception.QuotaExceededError;
  var webErrors = require('internal/web_errors');
  var web = webErrors.web;
  // node:buffer on the Node surface only: `.Web` instantiates no node/ module, and none
  // of its entry points (getRandomValues, randomUUID) touches one. Captured here, at
  // module-eval, because this file is eager — before user code can replace the export.
  var Buffer = web ? null : require('buffer').Buffer;
  var context = webErrors.context;
  var typeError = webErrors.typeError;
  var argumentsRequired = webErrors.argumentsRequired;
  var notOfType = webErrors.notOfType;
  var illegalInvocation = webErrors.illegalInvocation;
  var pageError = webErrors.pageError;
  // The `crypto` global this file installs; getRandomValues' receiver brand on the
  // Window surface.
  var cryptoObject = null;

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
    if (typeof offset !== 'number') throw invalidArgType('offset', 'number', offset);
    var bytes = offset * elementSize;
    if (Number.isNaN(bytes) || bytes < 0 || bytes > byteLength)
      throw outOfRange('offset', '>= 0 && <= ' + byteLength / elementSize, offset);
    return bytes >>> 0;
  }
  function assertSize(size, elementSize, offsetBytes, byteLength) {
    if (typeof size !== 'number') throw invalidArgType('size', 'number', size);
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
      throw invalidArgType('buf', ['ArrayBuffer', 'ArrayBufferView'], buffer);
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
    // A plain Uint8Array, not randomBytes(16)'s Buffer: the bytes never escape (only the
    // string does), and `.Web` has no Buffer.
    var b = fillRandom(new Uint8ArrayP(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var s = '';
    for (var i = 0; i < 16; i++) {
      s += HEX[(b[i] >> 4) & 0xf] + HEX[b[i] & 0xf];
      if (i === 3 || i === 5 || i === 7 || i === 9) s += '-';
    }
    return s;
  }

  // The integer view kinds getRandomValues accepts, by %TypedArray%'s brand tag (read
  // through the captured getter: it answers from the internal slot, so neither a
  // subclass nor a forged Symbol.toStringTag changes it). Anything else that is a view
  // — the float kinds and DataView — is a TypeMismatchError.
  var INTEGER_VIEWS = {
    __proto__: null,
    Int8Array: true,
    Uint8Array: true,
    Uint8ClampedArray: true,
    Int16Array: true,
    Uint16Array: true,
    Int32Array: true,
    Uint32Array: true,
    BigInt64Array: true,
    BigUint64Array: true,
  };
  var GET_RANDOM_VALUES_MAX = 65536;

  /**
   * crypto.getRandomValues(view): fills an integer TypedArray in place with CSPRNG bytes
   * and returns it.
   * @param {ArrayBufferView} typedArray
   * @returns {ArrayBufferView} the argument.
   * @throws {TypeError} no argument, or not an ArrayBufferView.
   * @throws {DOMException} TypeMismatchError (17) — a float view or a DataView, checked
   *   before the length.
   * @throws {QuotaExceededError} more than 65536 bytes; quota/requested left null, as
   *   Chrome leaves them.
   * @node Window surface: Chrome 158's shapes and text,
   *       tests/web/cases/crypto-random-errors.expected. Node surface: the same
   *       DOMException shapes with node 26's text ("The data argument must be an
   *       integer-type TypedArray", "The requested length exceeds 65,536 bytes", probed);
   *       its TypeError keeps Lava's previous text.
   * @deviates No SharedArrayBuffer-backed view can reach this — JSC here defines no
   *   SharedArrayBuffer — so Blink's "must not be shared" refusal has no arm.
   *   The receiver brand is identity with the installed `crypto` object, which is a
   *   plain object until Crypto is an interface of its own; Chrome's answer to every
   *   other receiver, Illegal invocation, is the same.
   */
  function getRandomValues(typedArray) {
    // Before the arguments, as Blink checks them (crypto-random-errors.expected). Node
    // checks no receiver — node:crypto exports this same function, `this` the module —
    // so the Node surface keeps filling.
    if (web && this !== cryptoObject) {
      throw illegalInvocation();
    }

    if (arguments.length === 0 || !ArrayBufferIsView(typedArray)) {
      if (!web) {
        throw new TypeError('The data argument must be an integer-type TypedArray');
      }

      throw typeError(
        'Crypto',
        'getRandomValues',
        arguments.length === 0 ? argumentsRequired(1, 0) : notOfType(1, 'ArrayBufferView'),
      );
    }

    // undefined for a DataView, the only view that is not a TypedArray.
    var kind = TypedArrayPrototypeGetSymbolToStringTag(typedArray);
    if (kind === undefined || INTEGER_VIEWS[kind] !== true) {
      var type = kind === undefined ? 'DataView' : StringPrototypeSlice(kind, 0, kind.length - 5);
      throw pageError(
        new DOMException(
          web
            ? context('Crypto', 'getRandomValues') +
                "The provided ArrayBufferView is of type '" +
                type +
                "', which is not an integer array type."
            : 'The data argument must be an integer-type TypedArray',
          'TypeMismatchError',
        ),
      );
    }

    var byteLength = TypedArrayPrototypeGetByteLength(typedArray);
    if (byteLength > GET_RANDOM_VALUES_MAX) {
      throw pageError(
        new QuotaExceededError(
          web
            ? context('Crypto', 'getRandomValues') +
                "The ArrayBufferView's byte length (" +
                byteLength +
                ') exceeds the number of bytes of entropy available via this API (65536).'
            : 'The requested length exceeds 65,536 bytes',
        ),
      );
    }

    if (byteLength > 0) {
      fillRandom(
        new Uint8ArrayP(
          TypedArrayPrototypeGetBuffer(typedArray),
          TypedArrayPrototypeGetByteOffset(typedArray),
          byteLength,
        ),
      );
    }

    return typedArray;
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

  // WHATWG Web Crypto global: `crypto`, an instance of the Crypto interface, behind a
  // getter on the global as in Chrome. Only the random surface is provided here;
  // crypto.subtle is a follow-up (shape-crypto's known gap). The loader instantiates
  // this file before user code on both surfaces, as the last module that installs a
  // global — the slot node/crypto.js held when the install lived there — and
  // node/crypto.js exports these same two functions.
  function Crypto() {
    throw new P.TypeError('Illegal constructor');
  }
  Crypto.prototype.getRandomValues = getRandomValues;
  Crypto.prototype.randomUUID = randomUUID;
  var nativeShape = require('internal/native_shape');
  // Blink's order (Chrome 158, tests/web/cases/shape-crypto.expected): `subtle` would
  // sit between `constructor` and randomUUID.
  nativeShape.defineInterface({
    name: 'Crypto',
    impl: Crypto,
    length: 0,
    illegal: true,
    members: ['getRandomValues:1', 'constructor', 'randomUUID:0', '@@toStringTag'],
  });
  cryptoObject = P.ObjectCreate(Crypto.prototype);
  nativeShape.defineGlobalAttribute('crypto', function () {
    return cryptoObject;
  });

  module.exports = {
    randomBytes: randomBytes,
    randomFillSync: randomFillSync,
    randomFill: randomFill,
    randomInt: randomInt,
    randomUUID: randomUUID,
    getRandomValues: getRandomValues,
  };
});
