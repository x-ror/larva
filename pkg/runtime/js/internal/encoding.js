/**
 * @fileoverview TextEncoder / TextDecoder (WHATWG Encoding standard), installed as
 * globals on both surfaces.
 *
 * No Buffer anywhere on either path (stage S4b of the Node-profile removal). Encoding
 * is the `utf8Encode` native, which hands back a plain Uint8Array over a buffer of its
 * own; decoding is the `utf8Decode`/`utf16leDecode` natives plus the stateful JS
 * decoders below. windows-1252 (the WHATWG alias for latin1/ascii) uses an explicit
 * high-byte table so it is exact, not approximate.
 *
 * Errors follow the profile (docs/LARVA.md decision 1). On `.Web` they are Chrome's:
 * the WebIDL binding's conversions in Blink's order (receiver, argument count, each
 * argument left to right, a dictionary's members as it is converted — before the label
 * is looked up) and Blink's text, built by internal/web_errors, with no `code`. On
 * `.Node` they keep node's coded errors and node's order until stage S5b deletes that
 * arm. Recorded: tests/web/cases/encoding-errors and encoding-webidl (Chrome 158).
 *
 * @module lava/internal/encoding
 */
(function (require, module, _exports, native) {
  'use strict';

  // --- Pollution-safe intrinsics -------------------------------------------
  // TextDecoder decodes attacker-controlled bytes, and url.js routes every
  // percent-decode and host-decode through it (percentDecode /
  // percentDecodeHostStrict), so this module inherits url's threat model: it
  // must be correct while user code has poisoned a shared prototype or replaced
  // a global — hardening url.js alone left this hole open. Prototype methods route
  // through the pristine primordials table; free globals and statics are
  // captured HERE, at module-eval, which the loader runs before any user code.
  //
  // The sharpest vector was `String.fromCharCode.apply(null, units)` in
  // unitsToString: `apply` is read off Function.prototype at call time, so a
  // poisoned Function.prototype.apply replaced the text of every decoded
  // string — `new URL('http://über.example/')` silently became `http://a/`.
  // ReflectApply (a captured static) closes it.
  //
  // The decoders do NOT route their accumulator through a push primordial at
  // all — see the note on pushCodePoint. Routing those per-code-unit loops
  // through the variadic ArrayPrototypePush measured 1.43x on the JS decode
  // path (callerN's arguments switch is ~7x a direct call).
  var P = require('internal/primordials');
  var defineInterface = require('internal/native_shape').defineInterface;
  var StringPrototypeSlice = P.StringPrototypeSlice;
  var StringPrototypeCharCodeAt = P.StringPrototypeCharCodeAt;
  var StringPrototypeToLowerCase = P.StringPrototypeToLowerCase;
  var ReflectApply = P.ReflectApply;
  var TypeErrorG = P.TypeError;
  var RangeErrorG = P.RangeError;
  var ErrorG = P.Error;
  var Uint8ArrayG = P.Uint8Array;
  var Uint16ArrayG = P.Uint16Array;
  var TypedArrayPrototypeSubarray = P.TypedArrayPrototypeSubarray;
  var TypedArrayPrototypeGetBuffer = P.TypedArrayPrototypeGetBuffer;
  var TypedArrayPrototypeGetByteOffset = P.TypedArrayPrototypeGetByteOffset;
  var TypedArrayPrototypeGetByteLength = P.TypedArrayPrototypeGetByteLength;
  var TypedArrayPrototypeGetLength = P.TypedArrayPrototypeGetLength;
  var TypedArrayPrototypeGetSymbolToStringTag = P.TypedArrayPrototypeGetSymbolToStringTag;
  var DataViewPrototypeGetBuffer = P.DataViewPrototypeGetBuffer;
  var DataViewPrototypeGetByteOffset = P.DataViewPrototypeGetByteOffset;
  var DataViewPrototypeGetByteLength = P.DataViewPrototypeGetByteLength;
  var ArrayBufferPrototypeGetByteLength = P.ArrayBufferPrototypeGetByteLength;
  var ArrayBufferIsView = P.ArrayBufferIsView;
  var ObjectGetPrototypeOf = P.ObjectGetPrototypeOf;
  var Uint8ArrayPrototype = Uint8ArrayG.prototype;
  // Free globals / statics, captured pristine at module-eval.
  var StringG = String;
  var StringFromCharCode = String.fromCharCode;

  // The profile's error text (CLAUDE.md §5): Chrome's builders on `.Web`, node's
  // coded errors on `.Node`. `web` is fixed per context before any module runs.
  var webErrors = require('internal/web_errors');
  var web = webErrors.web;
  var typeError = webErrors.typeError;
  var argumentsRequired = webErrors.argumentsRequired;
  var notOfType = webErrors.notOfType;
  var toDOMString = webErrors.toDOMString;
  var illegalInvocation = webErrors.illegalInvocation;
  var pageError = webErrors.pageError;
  var context = webErrors.context;
  var errors = require('internal/errors');
  var nodeError = errors.nodeError;
  var nativeError = errors.nativeError;
  var ERR_INVALID_ARG_TYPE = errors.ERR_INVALID_ARG_TYPE;

  // The codecs this module needs are Odin natives handed in through the loader's
  // fourth argument (pkg/runtime/globals.odin: the buffer bindings object, which is a
  // table of natives, not the node:buffer module) and captured at module-eval. That
  // leaves no `.call`, no `Reflect.apply` and no Buffer on any path.
  //
  // Decoding: `Buffer.prototype.toString.call(bytes, 'utf8')` used to put a live
  // `Function.prototype.call` read on the RETURN path of decode() — replacing `.call`
  // made decode() hand back the replacement's value. Going to the native is also
  // FASTER than the `.call` it replaced, because toString's captured-length read,
  // range clamp and normalizeEncoding chain all drop out — 93.0 -> 69.0 ns on a 9-byte
  // decode (0.74x) and 23.20 -> 21.10 us on a 20-parameter URLSearchParams parse
  // (0.91x), medians of 7 interleaved launches per arm.
  //
  // Encoding: `utf8Encode` replaced `new Uint8Array(Buffer.from(str, 'utf8'))`, which
  // encoded into Buffer's shared pool and then copied out of it so a page never saw a
  // pooled view (Chrome's result owns its buffer: encoding-webidl, "encode result").
  // The native allocates the result once and hands JSC the bytes without a copy; see
  // the PR for the paired medians.
  //
  // Equivalent by construction: this module only ever decodes a WHOLE view, which is
  // exactly the range the natives re-derive from the view's internal slots. Pinned by
  // tests/web/cases/encoding-text and the differential property suite.
  function requireNative(name) {
    var fn = native && native[name];
    if (typeof fn !== 'function')
      throw new ErrorG('internal encoding requires the native codec binding: ' + name);
    return fn;
  }
  var utf8EncodeNative = requireNative('utf8Encode');
  var utf8DecodeNative = requireNative('utf8Decode');
  var utf16leDecodeNative = requireNative('utf16leDecode');

  // Only labels Lava can service are listed; an unknown label throws (Chrome knows
  // the legacy single- and multi-byte encodings too — not implemented here).
  // Null-prototype because the keys come from the caller: with Object.prototype
  // in the chain, `new TextDecoder('constructor')` resolved to Object and
  // `new TextDecoder('__proto__')` to Object.prototype instead of throwing
  // RangeError, and any `Object.prototype.<label>` a script sets became a
  // forged encoding. Node reaches the same end with a SafeMap in
  // lib/internal/encoding.js — Map keys never consult a prototype chain — and a
  // null-prototype object literal is the cheap equivalent for a static table.
  var LABELS = {
    __proto__: null,
    'utf-8': 'utf-8',
    utf8: 'utf-8',
    'unicode-1-1-utf-8': 'utf-8',
    unicode11utf8: 'utf-8',
    unicode20utf8: 'utf-8',
    'x-unicode20utf8': 'utf-8',
    'utf-16le': 'utf-16le',
    'utf-16': 'utf-16le',
    'ucs-2': 'utf-16le',
    unicode: 'utf-16le',
    unicodefeff: 'utf-16le',
    csunicode: 'utf-16le',
    'iso-10646-ucs-2': 'utf-16le',
    'windows-1252': 'windows-1252',
    latin1: 'windows-1252',
    'iso-8859-1': 'windows-1252',
    'iso8859-1': 'windows-1252',
    iso88591: 'windows-1252',
    cp1252: 'windows-1252',
    'x-cp1252': 'windows-1252',
    cp819: 'windows-1252',
    ibm819: 'windows-1252',
    l1: 'windows-1252',
    ascii: 'windows-1252',
    'us-ascii': 'windows-1252',
    'ansi_x3.4-1968': 'windows-1252',
    // WHATWG windows-1252 labels Node accepts and Lava used to reject. Pure
    // table parity — no new codec.
    'iso-ir-100': 'windows-1252',
    'iso_8859-1': 'windows-1252',
    'iso_8859-1:1987': 'windows-1252',
    csisolatin1: 'windows-1252',
  };

  // windows-1252 code points for bytes 0x80-0x9F (others equal the byte value).
  var WIN1252_HIGH = [
    8364, 129, 8218, 402, 8222, 8230, 8224, 8225, 710, 8240, 352, 8249, 338, 141, 381, 143, 144,
    8216, 8217, 8220, 8221, 8226, 8211, 8212, 732, 8482, 353, 8250, 339, 157, 382, 376,
  ];

  // WHATWG "get an encoding" strips leading/trailing ASCII whitespace only —
  // TAB/LF/FF/CR/SPACE, notably NOT vertical tab. String.prototype.trim also
  // strips Unicode whitespace, so it used to accept labels Node rejects
  // (' utf-8', '　utf-8'); Node carries its own trimAsciiWhitespace for
  // exactly this reason. Takes an already-coerced string.
  function isAsciiWhitespace(c) {
    return c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d || c === 0x20;
  }
  function normalizeLabel(text) {
    var i = 0,
      j = text.length;
    while (i < j && isAsciiWhitespace(StringPrototypeCharCodeAt(text, i))) i++;
    while (j > i && isAsciiWhitespace(StringPrototypeCharCodeAt(text, j - 1))) j--;
    return LABELS[
      StringPrototypeToLowerCase(
        i === 0 && j === text.length ? text : StringPrototypeSlice(text, i, j),
      )
    ];
  }

  // --- WebIDL conversions --------------------------------------------------
  // decode()'s `input`, as an `AllowSharedBufferSource`: a Uint8Array itself, or a
  // Uint8Array over the same bytes as any other view or an ArrayBuffer.
  //
  // Every brand test reads an internal slot, never the prototype chain or
  // `instanceof`. `instanceof` dispatches through `Ctor[Symbol.hasInstance]`, a
  // configurable own property, so a caller could flip the brand in either direction:
  // against node 26.13.0 (probe, 2026-11-16) forging `DataView[Symbol.hasInstance]` to
  // false made `decode(dataView)` THROW, and forging `Uint8Array`'s to true made
  // `decode()` return "" — a silent empty decode of valid input; six diverging cells.
  // The prototype-chain walk that replaced it (brandedAs) still accepted
  // `Object.create(Uint8Array.prototype)`, which has no bytes, and refused a real
  // Uint8Array whose prototype a page re-pointed, both of which Chrome answers the
  // other way: %TypedArray%.prototype[@@toStringTag] and ArrayBuffer's byteLength
  // getter read the slot, through captures a page cannot replace. Pinned by vector W
  // in tests/web/cases/robust-encoding-pollution.js.
  //
  // A non-Uint8Array view is re-wrapped over the SAME range, so all three reads come
  // from the engine's slots: read live, a poisoned trio selected a window across a
  // neighbouring allocation. DataView's accessors are separate properties from
  // %TypedArray%'s, hence two arms.
  function toBytes(input) {
    if (input === undefined) {
      bytesLength = 0;
      return new Uint8ArrayG(0);
    }

    if (likelyUint8Array(input)) {
      var n = uint8ArrayLength(input);
      if (n !== -1) {
        bytesLength = n;
        return input;
      }
    }

    var kind = TypedArrayPrototypeGetSymbolToStringTag(input);
    if (kind === 'Uint8Array') {
      bytesLength = TypedArrayPrototypeGetLength(input);
      return input;
    }
    if (kind !== undefined) {
      bytesLength = TypedArrayPrototypeGetByteLength(input);
      return new Uint8ArrayG(
        TypedArrayPrototypeGetBuffer(input),
        TypedArrayPrototypeGetByteOffset(input),
        bytesLength,
      );
    }
    // A view that is not a typed array is a DataView.
    if (ArrayBufferIsView(input)) {
      bytesLength = DataViewPrototypeGetByteLength(input);
      return new Uint8ArrayG(
        DataViewPrototypeGetBuffer(input),
        DataViewPrototypeGetByteOffset(input),
        bytesLength,
      );
    }
    if (isArrayBuffer(input)) {
      var view = new Uint8ArrayG(input);
      bytesLength = TypedArrayPrototypeGetLength(view);
      return view;
    }
    if (web) throw typeError('TextDecoder', 'decode', notOfType(1, 'ArrayBuffer'));
    // Node names this argument "list" and appends no "Received" tail here: it is
    // thrown by the C++ encoding binding, which is also why String(e) carries no
    // [code]. SharedArrayBuffer is in the text because Node's is; Lava does not
    // implement it, so that arm is unreachable and the wording is parity-only.
    throw nativeError(
      TypeErrorG,
      'ERR_INVALID_ARG_TYPE',
      'The "list" argument must be an instance of SharedArrayBuffer, ArrayBuffer or ArrayBufferView.',
    );
  }

  // The view length toBytes found, read by its caller on the very next line: the
  // decoders loop on it, and a live `bytes.length` is %TypedArray%.prototype's
  // configurable accessor. A side channel rather than a second return value, which
  // would cost an allocation per decode; no page code runs between the write and the
  // read.
  var bytesLength = 0;

  // The common input — a Uint8Array whose prototype nobody touched — in one captured
  // Reflect.getPrototypeOf, which JSC inlines. It is a hint, not a brand: an object
  // made with Object.create(Uint8Array.prototype) passes it too, so every caller
  // confirms through a slot read (uint8ArrayLength, or the native's own answer). The
  // brand alone costs more than the rest of a small decode: the @@toStringTag getter
  // measured +45 ns and ArrayBuffer.isView +35 ns on decode() of 9 bytes, against
  // ~370 ns for the whole call (--surface=web, best of 5 reps, medians of 3
  // interleaved launches per arm).
  function likelyUint8Array(value) {
    return (
      typeof value === 'object' &&
      value !== null &&
      ObjectGetPrototypeOf(value) === Uint8ArrayPrototype
    );
  }

  // The length of a value likelyUint8Array accepted, through the captured getter
  // (which reads the slot and throws for anything that is not a typed array), or -1.
  // The try costs nothing until it throws.
  function uint8ArrayLength(value) {
    try {
      return TypedArrayPrototypeGetLength(value);
    } catch {
      return -1;
    }
  }

  // The byteLength getter throws for anything without an [[ArrayBufferData]] slot (a
  // SharedArrayBuffer included, which Lava does not expose). Only reached once the
  // view arms have missed, so the try costs the common inputs nothing.
  function isArrayBuffer(value) {
    if (value === null || typeof value !== 'object') return false;
    try {
      ArrayBufferPrototypeGetByteLength(value);
      return true;
    } catch {
      return false;
    }
  }

  // Node's validateObject(value, 'options', kValidateObjectAllowObjects) as TextDecoder
  // calls it — nullable, arrays and functions allowed, every scalar (-0, NaN, '' and
  // false included) refused; verified against node 26.13.0 (probe, 2026-11-16). WebIDL's
  // dictionary conversion draws the same line, so one predicate serves both surfaces
  // and only the text differs. Callers guard with `options !== undefined && options !==
  // null`, so the common `decode(bytes)` pays two comparisons and no call: as a bare
  // call this cost 1.087x on `new-textdecoder` (200k constructions, paired median of
  // 15 launches); guarded it is 1.035x.
  function badOptions(options, op) {
    var t = typeof options;
    if (t === 'object' || t === 'function') return null;
    if (!web) return ERR_INVALID_ARG_TYPE('options', 'object', options);
    return typeError(
      'TextDecoder',
      op,
      "The provided value is not of type '" +
        (op === undefined ? 'TextDecoderOptions' : 'TextDecodeOptions') +
        "'.",
    );
  }

  // What every operation and accessor throws for a receiver that is not an instance:
  // Blink's "Illegal invocation" on `.Web`, node's ERR_INVALID_THIS on `.Node` (node 24
  // and 26 validateEncoder/validateDecoder, probed).
  function invalidThis(iface) {
    if (web) return illegalInvocation();
    return nodeError(TypeErrorG, 'ERR_INVALID_THIS', 'Value of "this" must be of type ' + iface);
  }

  // --- TextEncoder ---------------------------------------------------------
  // `#encoder` is only a brand: TextEncoder has no state, but its operations still
  // refuse a foreign `this`, as Blink's do.
  class TextEncoder {
    #encoder = true;

    static #is(value) {
      return value !== null && typeof value === 'object' && #encoder in value;
    }

    get encoding() {
      if (!TextEncoder.#is(this)) throw invalidThis('TextEncoder');
      return 'utf-8';
    }

    /**
     * UTF-8 encodes `input`.
     * @param {string} [input] USVString: lone surrogates become U+FFFD.
     * @returns {Uint8Array} a plain Uint8Array over a buffer of its own.
     * @throws {TypeError} `this` is not a TextEncoder; on `.Web`, a Symbol input.
     * @node Chrome 158 (tests/web/cases/encoding-webidl): ToString, so a Symbol
     *       throws "Cannot convert a Symbol value to a string"; null encodes "null".
     * @deviates none
     */
    encode(input) {
      if (!TextEncoder.#is(this)) throw invalidThis('TextEncoder');
      var text;
      if (input === undefined) text = '';
      else if (web) text = toDOMString(input, 'TextEncoder', 'encode');
      else text = StringG(input);
      return utf8EncodeNative(text);
    }

    /**
     * Encodes as much of `source` as fits whole into `dest`.
     * @param {string} source
     * @param {Uint8Array} dest
     * @returns {{read: number, written: number}} a plain object.
     * @throws {TypeError} on `.Web`, in Blink's order: a foreign `this`, fewer than two
     *   arguments, a Symbol source, then a `dest` that is not a Uint8Array (the slot,
     *   so a Uint8ClampedArray or a DataView is refused).
     * @node Chrome 158 (tests/web/cases/encoding-webidl, encoding-errors): `source` is
     *       converted before `dest` is checked.
     * @deviates none
     */
    encodeInto(source, dest) {
      if (!TextEncoder.#is(this)) throw invalidThis('TextEncoder');
      if (web) {
        if (arguments.length < 2) {
          throw typeError('TextEncoder', 'encodeInto', argumentsRequired(2, arguments.length));
        }

        source = toDOMString(source, 'TextEncoder', 'encodeInto');
      } else {
        source = StringG(source);
      }
      var capacity = destCapacity(dest);
      var read = 0,
        written = 0,
        length = source.length;
      // Surrogate pairing is done by hand off charCodeAt rather than by
      // codePointAt: the ASCII/BMP case (the overwhelming majority of input) then
      // costs a single primordial call and no branch on a >0xffff result, and the
      // astral case pays a second call it would otherwise pay inside codePointAt.
      for (var i = 0; i < length;) {
        var cp = StringPrototypeCharCodeAt(source, i);
        var units = 1;
        if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < length) {
          var lo = StringPrototypeCharCodeAt(source, i + 1);
          if (lo >= 0xdc00 && lo <= 0xdfff) {
            cp = (cp - 0xd800) * 0x400 + (lo - 0xdc00) + 0x10000;
            units = 2;
          }
        }
        if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd;
        var size = cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
        if (written + size > capacity) break;
        written += encodeCodePoint(cp, dest, written);
        read += units;
        i += units;
      }
      return { read: read, written: written };
    }
  }

  // encodeInto's `dest` length, or the profile's TypeError for anything that is not a
  // Uint8Array — by its [[TypedArrayName]] slot, so a Uint8ClampedArray, a DataView
  // or an object that only inherits from Uint8Array.prototype is refused, and a real
  // Uint8Array whose prototype a page re-pointed is not. Node checks `dest` before
  // converting `source`; Chrome after, which is the order both arms keep only because
  // node's String(source) cannot observe the difference here — a throwing toString
  // runs first on both.
  function destCapacity(dest) {
    var n = likelyUint8Array(dest) ? uint8ArrayLength(dest) : -1;
    if (n !== -1) return n;
    if (TypedArrayPrototypeGetSymbolToStringTag(dest) === 'Uint8Array') {
      return TypedArrayPrototypeGetLength(dest);
    }
    if (web) throw typeError('TextEncoder', 'encodeInto', notOfType(2, 'Uint8Array'));
    throw ERR_INVALID_ARG_TYPE('dest', 'Uint8Array', dest);
  }

  function encodeCodePoint(cp, dest, offset) {
    if (cp <= 0x7f) {
      dest[offset] = cp;
      return 1;
    }
    if (cp <= 0x7ff) {
      dest[offset] = 0xc0 | (cp >> 6);
      dest[offset + 1] = 0x80 | (cp & 0x3f);
      return 2;
    }
    if (cp <= 0xffff) {
      dest[offset] = 0xe0 | (cp >> 12);
      dest[offset + 1] = 0x80 | ((cp >> 6) & 0x3f);
      dest[offset + 2] = 0x80 | (cp & 0x3f);
      return 3;
    }
    dest[offset] = 0xf0 | (cp >> 18);
    dest[offset + 1] = 0x80 | ((cp >> 12) & 0x3f);
    dest[offset + 2] = 0x80 | ((cp >> 6) & 0x3f);
    dest[offset + 3] = 0x80 | (cp & 0x3f);
    return 4;
  }

  // Per-instance decoder state. WHATWG TextDecoder is stateful so that {stream:
  // true} can carry an incomplete trailing sequence into the next decode() call:
  // `needed/cp/seen/lower/upper` are the UTF-8 decoder state, `pend` a single
  // held UTF-16LE low byte, `hs` a held UTF-16 high surrogate, `bomChecked` marks
  // that the leading BOM window has closed, and `doNotFlush` records whether the
  // previous call was streaming (a non-streaming call resets the decoder first).
  function newDecoderState() {
    return {
      doNotFlush: false,
      bomChecked: false,
      needed: 0,
      cp: 0,
      seen: 0,
      lower: 0x80,
      upper: 0xbf,
      pend: -1,
      hs: -1,
    };
  }
  function resetDecoderState(s) {
    s.bomChecked = false;
    s.needed = 0;
    s.cp = 0;
    s.seen = 0;
    s.lower = 0x80;
    s.upper = 0xbf;
    s.pend = -1;
    s.hs = -1;
  }

  // What a fatal decoder throws. Chrome names neither the encoding nor a code (the
  // message is the same for every decoder; tests/web/cases/encoding-errors.expected);
  // node's C++ decoder binding names the encoding and, being C++-thrown, leaves the
  // code out of String(e).
  function fatalErr(enc) {
    if (web) return typeError('TextDecoder', 'decode', 'The encoded data was not valid.');
    return nativeError(
      TypeErrorG,
      'ERR_ENCODING_INVALID_ENCODED_DATA',
      'The encoded data was not valid for encoding ' + enc,
    );
  }

  // The code-unit accumulator is a PREALLOCATED Uint16Array written by index,
  // not a growing array written by push. Two reasons, both load-bearing:
  //   * indexed access on a typed array never consults a prototype chain, so
  //     there is no accessor to install: the earlier null-prototype JS Array
  //     existed because `Set(units, "0", v)` DID walk that chain, and an
  //     accessor at Array.prototype[0] intercepted every stored code unit and
  //     fed the getter's value back to the string builder. A typed array closes
  //     that by construction, and takes Symbol.species steering of the chunk
  //     slice with it. (The one prototype-chain read left on this path is
  //     `.buffer` at string-building time — see unitsToString, which routes it
  //     through a captured getter.)
  //   * it is faster than push through any wrapper, and two bytes per unit
  //     instead of a boxed slot: these writes are the per-code-unit inner loop
  //     of every non-fast-path decode. See decode() for the sizing bound.
  // Each emitter takes the write index and returns the next one.
  function pushCodePoint(units, n, cp) {
    if (cp <= 0xffff) {
      units[n] = cp;
      return n + 1;
    }
    cp -= 0x10000;
    units[n] = 0xd800 + (cp >> 10);
    units[n + 1] = 0xdc00 + (cp & 0x3ff);
    return n + 2;
  }

  // A Uint16Array's backing bytes ARE UTF-16 code units in platform order, so on
  // a little-endian target the decoded string is exactly what Buffer's native
  // utf16le codec produces from those same bytes — no per-unit JS work, no
  // chunking, no `apply` at all.
  //
  // This is not just tidier, it is why the accumulator could become a typed array
  // in the first place. String.fromCharCode.apply has a JSArray-only fast path in
  // JSC: over a Uint16Array subarray it costs 95.75ms where the plain Array cost
  // 44.18ms (3960 units x 3000 reps), which turned the memory fix into a 1.6-1.7x
  // decode regression. Routing the same bytes through the native codec measures
  // 13.74ms — 3.2x FASTER than the Array path this replaces. Numbers from
  // bench/micro/encoding.js's payload size; see the PR for the paired medians.
  // Module-eval probe (pristine intrinsics), same shape as os.js's endianness().
  var LITTLE_ENDIAN = new Uint8ArrayG(new Uint16ArrayG([1]).buffer)[0] === 1;

  // fromCharCode applied to the whole array blows the call stack past ~64k args,
  // so the big-endian fallback builds the result in fixed chunks. `count` is the
  // number of units actually emitted; `units` is over-allocated, so every read
  // goes through subarray.
  function unitsToString(units, count) {
    if (count === 0) return '';
    // Overflow guard for the fixed-size accumulator: a typed array drops
    // out-of-bounds writes silently (while the emit counter keeps advancing),
    // so a decoder edit that violates decode()'s sizing formula would garble
    // output with no failing test. One comparison per decode, not per byte.
    if (count > units.length) throw new ErrorG('lava: decode accumulator overflow');
    if (LITTLE_ENDIAN)
      // Both reads here are captured. The backing store comes through the
      // CAPTURED %TypedArray%.prototype.buffer getter — `units.buffer` would
      // resolve through that configurable prototype accessor, and a poisoned
      // getter substitutes an attacker's ArrayBuffer as the decode output
      // (pinned by 55-encoding-pollution.js). The view is the PRIMORDIAL
      // Uint8Array, not Buffer.from: that routes an ArrayBuffer argument
      // through a live `ArrayBuffer.isView` read, which a replaced global broke
      // the first time this path shipped (same test, case P2). The decode itself
      // goes to the captured `utf16leDecode` native rather than borrowing
      // Buffer's prototype method through `.call` — the native takes any typed
      // array, so nothing about Buffer is on this path at all.
      return utf16leDecodeNative(
        new Uint8ArrayG(TypedArrayPrototypeGetBuffer(units), 0, count * 2),
      );
    // Big-endian: Buffer's utf16le would byte-swap every unit. No target Lava
    // builds for is big-endian today, so this arm is correctness insurance for a
    // future port, not a live path — it is the exact code the fast arm replaced.
    var out = '';
    for (var i = 0; i < count; i += 0x2000) {
      out += ReflectApply(
        StringFromCharCode,
        null,
        TypedArrayPrototypeSubarray(units, i, i + 0x2000 < count ? i + 0x2000 : count),
      );
    }
    return out;
  }

  // WHATWG "UTF-8 decoder" state machine (the streaming form of the maximal-
  // subpart rule the native Buffer codec implements). An invalid continuation
  // re-processes the offending byte so an ill-formed run yields one U+FFFD, not
  // one per byte. In fatal mode any error throws; otherwise it emits U+FFFD. An
  // incomplete trailing sequence is held across calls and only flushed (to one
  // U+FFFD, or an error when fatal) on the final, non-streaming call.
  function decodeUtf8(s, bytes, len, isFinal, fatal, units) {
    var n = 0;
    for (var i = 0; i < len;) {
      var b = bytes[i];
      if (s.needed === 0) {
        if (b <= 0x7f) {
          units[n++] = b;
          i++;
        } else if (b >= 0xc2 && b <= 0xdf) {
          s.needed = 1;
          s.cp = b & 0x1f;
          i++;
        } else if (b >= 0xe0 && b <= 0xef) {
          if (b === 0xe0) s.lower = 0xa0;
          if (b === 0xed) s.upper = 0x9f;
          s.needed = 2;
          s.cp = b & 0x0f;
          i++;
        } else if (b >= 0xf0 && b <= 0xf4) {
          if (b === 0xf0) s.lower = 0x90;
          if (b === 0xf4) s.upper = 0x8f;
          s.needed = 3;
          s.cp = b & 0x07;
          i++;
        } else {
          if (fatal) throw fatalErr('utf-8');
          units[n++] = 0xfffd;
          i++;
        }
      } else if (b < s.lower || b > s.upper) {
        s.cp = 0;
        s.needed = 0;
        s.seen = 0;
        s.lower = 0x80;
        s.upper = 0xbf;
        if (fatal) throw fatalErr('utf-8');
        units[n++] = 0xfffd; // re-process b: do not advance i
      } else {
        s.lower = 0x80;
        s.upper = 0xbf;
        s.cp = (s.cp << 6) | (b & 0x3f);
        s.seen++;
        i++;
        if (s.seen === s.needed) {
          n = pushCodePoint(units, n, s.cp);
          s.cp = 0;
          s.needed = 0;
          s.seen = 0;
        }
      }
    }
    if (isFinal && s.needed !== 0) {
      s.cp = 0;
      s.needed = 0;
      s.seen = 0;
      s.lower = 0x80;
      s.upper = 0xbf;
      if (fatal) throw fatalErr('utf-8');
      units[n++] = 0xfffd;
    }
    return n;
  }

  // Emit one UTF-16 code unit, pairing surrogates and replacing lone ones with
  // U+FFFD (or throwing when fatal) — WHATWG behavior that differs from
  // Buffer.toString('utf16le'), which passes lone surrogates through verbatim.
  function pushU16(s, units, n, u, fatal) {
    if (s.hs >= 0) {
      if (u >= 0xdc00 && u <= 0xdfff) {
        units[n] = s.hs;
        units[n + 1] = u;
        s.hs = -1;
        return n + 2;
      }
      s.hs = -1;
      if (fatal) throw fatalErr('utf-16le');
      units[n++] = 0xfffd;
      return pushU16(s, units, n, u, fatal); // re-process u as a fresh unit
    } else if (u >= 0xd800 && u <= 0xdbff) {
      s.hs = u; // hold the high surrogate for its low half (possibly next chunk)
    } else if (u >= 0xdc00 && u <= 0xdfff) {
      if (fatal) throw fatalErr('utf-16le');
      units[n++] = 0xfffd;
    } else {
      units[n++] = u;
    }
    return n;
  }

  function decodeUtf16le(s, bytes, len, isFinal, fatal, units) {
    var i = 0;
    var n = 0;
    if (s.pend >= 0 && len > 0) {
      n = pushU16(s, units, n, s.pend | (bytes[0] << 8), fatal);
      s.pend = -1;
      i = 1;
    }
    for (; i + 2 <= len; i += 2) {
      n = pushU16(s, units, n, bytes[i] | (bytes[i + 1] << 8), fatal);
    }
    if (i < len) {
      // One trailing byte in this chunk. At EOF it is handled by the flush below
      // together with any held lead surrogate — NOT here, or the two produce two
      // errors where the spec produces one.
      s.pend = bytes[i];
    }
    // WHATWG "shared UTF-16 decoder", EOF step: if EITHER the lead byte or the
    // lead surrogate is non-null, set BOTH to null and emit ONE error. Emitting
    // one per pending item is the obvious reading and the wrong one — an
    // unpaired lead surrogate followed by an odd trailing byte
    // (`39 db 64`) gave two U+FFFD where node gives one. Found by generating
    // inputs rather than picking them: 19 mismatches in 30000, all this shape.
    if (isFinal && (s.hs >= 0 || s.pend >= 0)) {
      s.hs = -1;
      s.pend = -1;
      if (fatal) throw fatalErr('utf-16le');
      units[n++] = 0xfffd;
    }
    return n;
  }

  function decodeWin1252Units(bytes, len, units) {
    for (var i = 0; i < len; i++) {
      var b = bytes[i];
      units[i] = b >= 0x80 && b <= 0x9f ? WIN1252_HIGH[b - 0x80] : b;
    }
    return len;
  }

  // --- TextDecoder ---------------------------------------------------------
  // State lives in private fields: nothing a page can read, write or forge (the
  // function constructor this replaced kept `_enc`, `_fatal`, `_ignoreBOM` and
  // `_state` as own properties of every instance, where Chrome's has none), and the
  // fields are the brand the operations check.
  class TextDecoder {
    #enc;
    #fatal;
    #ignoreBOM;
    #state;

    static #is(value) {
      return value !== null && typeof value === 'object' && #state in value;
    }

    /**
     * @param {string} [label] Default 'utf-8'; ASCII whitespace trimmed, case-folded.
     * @param {{fatal?: boolean, ignoreBOM?: boolean}} [options]
     * @throws {TypeError} a Symbol label (`.Web`), or a non-object `options`.
     * @throws {RangeError} an unknown label.
     * @node `.Web`, Chrome 158 (tests/web/cases/encoding-errors, encoding-webidl): the
     *       label is converted, then the options dictionary — its `fatal` then
     *       `ignoreBOM` read, each once — and only then is the label looked up, so a
     *       bad label still runs the getters. `.Node`: node 26 validates options before
     *       the lookup but reads the members after it.
     * @deviates none
     */
    constructor(label, options) {
      // Coerce ONCE: building the message from `label` again would run a
      // caller-supplied toString/Symbol.toPrimitive a second time, so the thrown
      // error could name a label that was never looked up.
      var text;
      if (label === undefined) text = 'utf-8';
      else if (web) text = toDOMString(label, 'TextDecoder');
      else text = StringG(label);
      var fatal = false;
      var ignoreBOM = false;
      var hasOptions = options !== undefined && options !== null;
      if (hasOptions) {
        var bad = badOptions(options, undefined);
        if (bad !== null) throw bad;
        // An omitted or null `options` reads nothing, so a poisoned
        // Object.prototype.fatal reaches only a caller-supplied dictionary — where
        // WebIDL's [[Get]] reads inherited members too, in Chrome as here.
        if (web) {
          fatal = !!options.fatal;
          ignoreBOM = !!options.ignoreBOM;
        }
      }

      var enc = normalizeLabel(text);
      if (enc === undefined) {
        if (web) {
          throw pageError(
            new RangeErrorG(
              context('TextDecoder') + "The encoding label provided ('" + text + "') is invalid.",
            ),
          );
        }

        throw nodeError(
          RangeErrorG,
          'ERR_ENCODING_NOT_SUPPORTED',
          'The "' + text + '" encoding is not supported',
        );
      }

      if (hasOptions && !web) {
        fatal = !!options.fatal;
        ignoreBOM = !!options.ignoreBOM;
      }

      this.#enc = enc;
      this.#fatal = fatal;
      this.#ignoreBOM = ignoreBOM;
      this.#state = newDecoderState();
    }

    // The BOM is stripped at STRING level, exactly as the streaming path does.
    // Equivalent because EF BB BF is the only utf-8 encoding of U+FEFF and an invalid
    // sequence yields U+FFFD, never U+FEFF.
    #stripBOM(text) {
      if (!this.#ignoreBOM && StringPrototypeCharCodeAt(text, 0) === 0xfeff) {
        return StringPrototypeSlice(text, 1);
      }
      return text;
    }

    get encoding() {
      if (!TextDecoder.#is(this)) throw invalidThis('TextDecoder');
      return this.#enc;
    }

    get fatal() {
      if (!TextDecoder.#is(this)) throw invalidThis('TextDecoder');
      return this.#fatal;
    }

    get ignoreBOM() {
      if (!TextDecoder.#is(this)) throw invalidThis('TextDecoder');
      return this.#ignoreBOM;
    }

    /**
     * Decodes `input`, carrying an incomplete sequence across calls with `stream`.
     * @param {ArrayBuffer|ArrayBufferView} [input]
     * @param {{stream?: boolean}} [options]
     * @returns {string}
     * @throws {TypeError} a foreign `this`, an input that is no BufferSource, a
     *   non-object `options`, or invalid data when fatal.
     * @node `.Web`, Chrome 158 (tests/web/cases/encoding-webidl): the input is
     *       converted BEFORE the options, so `decode(5, 5)` reports the input and a bad
     *       input never runs a `stream` getter. `.Node`: node 26 reports the options
     *       first (11-text-encoding.js).
     * @deviates none
     */
    decode(input, options) {
      if (!TextDecoder.#is(this)) throw invalidThis('TextDecoder');
      var hasOptions = options !== undefined && options !== null;
      var s = this.#state;
      var enc = this.#enc;
      var fatal = this.#fatal;
      // Fast path: a fresh, non-streaming, non-fatal utf-8 decode IS the native
      // WHATWG utf-8 decoder (invalid sequences -> U+FFFD), ~60x the per-unit JS
      // loop below. Streaming, fatal, and runs chained onto leftover streaming state
      // still take the stateful JS decoder.
      //
      // Taken BEFORE any conversion for the shape url.js and most pages pass — a
      // Uint8Array and no options — so it pays for no brand check: the native reads
      // the view's slots itself and answers '' for anything that is not a view, which
      // is the one answer that falls through to the full conversion below (to throw,
      // or to decode an empty view to '' again). With options it goes the long way:
      // `stream` must be read after the input is converted, and a getter can see when.
      if (!hasOptions && enc === 'utf-8' && !fatal && !s.doNotFlush && likelyUint8Array(input)) {
        var fast = utf8DecodeNative(input);
        if (fast !== '') return this.#stripBOM(fast);
      }

      var bad;
      var bytes;
      var len;
      if (web) {
        bytes = toBytes(input);
        len = bytesLength;
        if (hasOptions && (bad = badOptions(options, 'decode')) !== null) throw bad;
      } else {
        if (hasOptions && (bad = badOptions(options, 'decode')) !== null) throw bad;
        bytes = toBytes(input);
        len = bytesLength;
      }
      var stream = hasOptions && !!options.stream;
      if (enc === 'utf-8' && !fatal && !stream && !s.doNotFlush) {
        // NO JS-side window at all — and that is both the fast shape and the safe
        // one. The native re-derives the real range from the engine's internal slots
        // (typed_array_bytes, pkg/jsc/private_view.odin — byteOffset is folded into
        // the pointer), so any offset/length this layer computed would be at best
        // redundant and at worst forgeable. Measured: 114.1 ns/decode against 217.5
        // for the direct-read version and 230.5 for the captured-getter one — 11
        // interleaved launches per arm on a 9-byte payload, the shape url.js's
        // percentDecode actually passes.
        return this.#stripBOM(utf8DecodeNative(bytes));
      }
      // WHATWG: a non-streaming decode starts a fresh run (reset decoder + BOM
      // window); a streaming decode chains from the previous call's leftover state.
      if (!s.doNotFlush) resetDecoderState(s);
      s.doNotFlush = stream;
      var isFinal = !stream;

      // Upper bound on emitted code units: utf-8 and windows-1252 emit at most one
      // per input byte (a 4-byte sequence yields a surrogate PAIR from 4 bytes);
      // utf-16le at most one per TWO bytes — pushU16 amortizes to one emission per
      // processed unit even through the held-surrogate re-process path. The +4
      // covers a unit carried in from the previous chunk plus the final flush
      // (at most two more).
      //
      // A Uint16Array, not a JS Array: every element here IS a UTF-16 code unit, so
      // two bytes each instead of a boxed 8-byte slot, and the storage is off the GC
      // heap. Measured on a 16 MB windows-1252 decode: 388 MB peak RSS -> 167 MB
      // against node 24's 135 MB, which is the difference between "scales with the
      // input" and "4x the input". url.js reaches this for any percent-encoded host
      // (percentDecodeHostStrict), so the input is attacker-sized. Indexed access on
      // a typed array never consults the prototype chain; the one prototype-chain
      // read left on this path (`.buffer`, at string-building) goes through the
      // captured getter in unitsToString.
      var units = new Uint16ArrayG((enc === 'utf-16le' ? (len + 1) >> 1 : len) + 4);
      var count;
      if (enc === 'windows-1252') {
        count = decodeWin1252Units(bytes, len, units);
      } else if (enc === 'utf-8') {
        count = decodeUtf8(s, bytes, len, isFinal, fatal, units);
      } else {
        count = decodeUtf16le(s, bytes, len, isFinal, fatal, units);
      }
      var result = unitsToString(units, count);
      // Strip the BOM once, at the first output of the (possibly chunked) stream.
      if (!s.bomChecked && result.length > 0) {
        s.bomChecked = true;
        if (!this.#ignoreBOM && StringPrototypeCharCodeAt(result, 0) === 0xfeff)
          result = StringPrototypeSlice(result, 1);
      }
      return result;
    }
  }

  // The interface objects a page sees (internal/native_shape), in Blink's member order
  // and lengths (Chrome 158, tests/web/cases/shape-encoding.expected).
  var PublicTextEncoder = defineInterface({
    name: 'TextEncoder',
    impl: TextEncoder,
    length: 0,
    members: ['encoding', 'encode:0', 'encodeInto:2', 'constructor', '@@toStringTag'],
  });
  var PublicTextDecoder = defineInterface({
    name: 'TextDecoder',
    impl: TextDecoder,
    length: 0,
    members: ['encoding', 'fatal', 'ignoreBOM', 'decode:0', 'constructor', '@@toStringTag'],
  });

  module.exports = { TextEncoder: PublicTextEncoder, TextDecoder: PublicTextDecoder };
});
