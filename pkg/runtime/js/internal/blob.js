/**
 * @fileoverview Blob (WHATWG File API) and the `blob:` object-URL registry —
 * node's lib/internal/blob.js. Re-exported from node:buffer (`Blob`,
 * `resolveObjectURL`). This file installs the `Blob` global and the
 * `URL.createObjectURL`/`revokeObjectURL` statics itself, at the end of module-eval,
 * so the Window surface has them without a node/ module; internal/url.js copies the
 * statics onto the URL class when it replaces the stub.
 *
 * Strings are encoded and text() decoded by the UTF-8 natives the loader hands in as
 * the factory's fourth argument (pkg/runtime/globals.odin make_blob_bindings).
 *
 * Errors are Chrome's: the WebIDL conversions in Blink's order — the `sequence<BlobPart>` (iterated through
 * its @@iterator, each part converted as it comes), then the BlobPropertyBag members
 * `endings` and `type` — with Blink's text and no `code`, a foreign receiver throwing
 * "Illegal invocation" (a rejected promise from text/arrayBuffer/bytes). Recorded in
 * tests/web/cases/blob-errors, blob-object-url (Chrome 158).
 *
 * Instantiated eagerly by the loader, before page code runs, so the module-eval
 * captures below are pristine.
 *
 * @module lava/internal/blob
 */

(function (require, module, _exports, native) {
  'use strict';

  var P = require('internal/primordials');
  var defineInterface = require('internal/native_shape').defineInterface;
  var StringG = P.String;
  var NumberG = P.Number;
  var ErrorG = P.Error;
  var Uint8ArrayG = P.Uint8Array;
  var ArrayIsArray = P.ArrayIsArray;
  var ArrayBufferIsView = P.ArrayBufferIsView;
  var ArrayPrototypePush1 = P.ArrayPrototypePush1;
  var MathMax = P.MathMax;
  var MathMin = P.MathMin;
  var MathFloor = P.MathFloor;
  var MathTrunc = P.MathTrunc;
  var NumberIsNaN = P.NumberIsNaN;
  var ReflectApply = P.ReflectApply;
  var SymbolIterator = P.Symbol.iterator;
  var PromiseResolve = P.FunctionPrototypeBind(P.Promise.resolve, P.Promise);
  var PromiseReject = P.PromiseReject;
  var StringPrototypeCharCodeAt = P.StringPrototypeCharCodeAt;
  var StringPrototypeSlice = P.StringPrototypeSlice;
  var StringPrototypeIndexOf = P.StringPrototypeIndexOf;
  var StringPrototypeToLowerCase = P.StringPrototypeToLowerCase;
  var ArrayBufferPrototypeSlice = P.ArrayBufferPrototypeSlice;
  var ArrayBufferPrototypeGetByteLength = P.ArrayBufferPrototypeGetByteLength;
  var Uint8ArrayPrototypeSet = P.Uint8ArrayPrototypeSet;
  var TypedArrayPrototypeSubarray = P.TypedArrayPrototypeSubarray;
  var TypedArrayPrototypeGetBuffer = P.TypedArrayPrototypeGetBuffer;
  var TypedArrayPrototypeGetByteOffset = P.TypedArrayPrototypeGetByteOffset;
  var TypedArrayPrototypeGetByteLength = P.TypedArrayPrototypeGetByteLength;
  var TypedArrayPrototypeGetLength = P.TypedArrayPrototypeGetLength;
  var TypedArrayPrototypeGetSymbolToStringTag = P.TypedArrayPrototypeGetSymbolToStringTag;
  var DataViewPrototypeGetBuffer = P.DataViewPrototypeGetBuffer;
  var DataViewPrototypeGetByteOffset = P.DataViewPrototypeGetByteOffset;
  var DataViewPrototypeGetByteLength = P.DataViewPrototypeGetByteLength;
  // The array fast path in convertParts: an Array whose iteration nobody replaced.
  // Captured here, at this eager eval, so the comparison is against the intrinsics.
  var ArrayPrototypeValues = Array.prototype.values;
  var ArrayIteratorPrototype = P.ObjectGetPrototypeOf([][SymbolIterator]());
  var ArrayIteratorPrototypeNext = ArrayIteratorPrototype.next;

  var webErrors = require('internal/web_errors');
  var context = webErrors.context;
  var typeError = webErrors.typeError;
  var argumentsRequired = webErrors.argumentsRequired;
  var illegalInvocation = webErrors.illegalInvocation;
  var pageError = webErrors.pageError;

  function requireNative(name) {
    var fn = native && native[name];
    if (typeof fn !== 'function') throw new ErrorG('internal/blob requires the native ' + name);
    return fn;
  }
  var utf8EncodeNative = requireNative('utf8Encode');
  var utf8DecodeNative = requireNative('utf8Decode');
  // The page's origin as the embedder gave it ('' for an opaque one), serialized on
  // first use (pageOrigin).
  var ORIGIN_RAW = native && typeof native.origin === 'string' ? native.origin : '';

  // The platform terminator for `endings: 'native'`, as the native bindings give it
  // (make_blob_bindings: CRLF on Windows, LF elsewhere, as Chrome writes them).
  var EOL = native && native.eol === '\r\n' ? '\r\n' : '\n';

  // Hands a prepared part list and type to the constructor (File, slice, clone,
  // resolveObjectURL). Module-private, so a page passing extra constructor arguments
  // cannot reach the internal path.
  var INTERNAL = { __proto__: null };

  // toNativeEndings is `str.replace(/\r?\n/g, EOL)` — every CRLF or lone LF
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
    if (EOL === '\n' && StringPrototypeIndexOf(str, '\r', 0) === -1) return str;
    var out = '';
    var from = 0;
    for (var i = firstLF; i !== -1; i = StringPrototypeIndexOf(str, '\n', from)) {
      var cut = i > from && StringPrototypeCharCodeAt(str, i - 1) === 0x0d ? i - 1 : i; // CR
      if (cut > from) out += StringPrototypeSlice(str, from, cut);
      out += EOL;
      from = i + 1;
    }
    return from < str.length ? out + StringPrototypeSlice(str, from) : out;
  }

  // --- WebIDL conversions ----------------------------------------------------
  // Shared with internal/file.js, whose constructor converts the same parts and bag but
  // must convert its `fileName` between them.

  // A TypeError for a failed conversion, in Blink's text.
  function conversionError(iface, op, detail) {
    return typeError(iface, op, detail);
  }

  // WebIDL's DOMString/USVString conversion: ToString, refusing a Symbol (JSC's
  // String() would have answered "Symbol(…)"). `member` names the dictionary member
  // being read, which Blink puts in front of the detail. USVString's lone-surrogate
  // replacement happens in the UTF-8 encoder, so both conversions are this one.
  function toStringArg(value, iface, op, member) {
    if (typeof value === 'symbol') {
      throw conversionError(iface, op, member + 'Cannot convert a Symbol value to a string');
    }

    return StringG(value);
  }

  // WebIDL's ToNumber step for an integer type: a Symbol or a BigInt throws Blink's
  // text (Number(1n) would have answered 1).
  function toNumberArg(value, iface, op, member) {
    if (typeof value === 'symbol') {
      throw conversionError(iface, op, member + 'Cannot convert a Symbol value to a number');
    }

    if (typeof value === 'bigint') {
      throw conversionError(iface, op, member + 'Cannot convert a BigInt value to a number');
    }

    return NumberG(value);
  }

  // An ArrayBuffer by its [[ArrayBufferData]] slot: the byteLength getter throws for
  // anything else (a SharedArrayBuffer included, which Lava does not expose). Only
  // reached once the Blob and view arms have missed.
  function isArrayBuffer(value) {
    if (value === null || typeof value !== 'object') return false;
    try {
      ArrayBufferPrototypeGetByteLength(value);
      return true;
    } catch {
      return false;
    }
  }

  // One BlobPart, converted as WebIDL's (Blob or BufferSource or USVString) union
  // does: a Blob or a buffer is kept as is (its bytes are copied once the whole
  // argument list is converted, as the File API's "process blob parts" does),
  // anything else becomes a string now, so its toString runs in iteration order.
  function convertPart(value, iface) {
    if (value !== null && typeof value === 'object') {
      if (isBlob(value) || ArrayBufferIsView(value) || isArrayBuffer(value)) return value;
    }

    return toStringArg(value, iface, undefined, '');
  }

  /**
   * Converts a `sequence<BlobPart>` argument.
   * @param {*} parts
   * @param {string} iface 'Blob' or 'File', for the error text.
   * @returns {Array<*>} the parts, each a Blob, a buffer or a string.
   * @throws {TypeError} not an object, no callable @@iterator, a `next()` result that is
   *   not an object, or a Symbol part; whatever the iterator itself throws.
   * @node Chrome 158 (tests/web/cases/blob-errors): a string, number or null is "cannot
   *       be converted to a sequence", an array-like without @@iterator is refused, and a
   *       Set is accepted. The iterator protocol is followed, so a replaced
   *       Array.prototype[Symbol.iterator] is honoured, as in Chrome.
   * @deviates none
   */
  function convertParts(parts, iface) {
    var out = [];
    if (parts === undefined) return out;
    if (parts === null || (typeof parts !== 'object' && typeof parts !== 'function')) {
      throw typeError(iface, undefined, 'The provided value cannot be converted to a sequence.');
    }

    var method = parts[SymbolIterator];
    // An Array iterated by the intrinsics yields exactly its indices in order, so it is
    // read by index; anything else goes through the protocol.
    if (
      method === ArrayPrototypeValues &&
      ArrayIsArray(parts) &&
      ArrayIteratorPrototype.next === ArrayIteratorPrototypeNext
    ) {
      for (var i = 0; i < parts.length; i++) ArrayPrototypePush1(out, convertPart(parts[i], iface));
      return out;
    }

    if (typeof method !== 'function') {
      throw typeError(iface, undefined, 'The object must have a callable @@iterator property.');
    }

    var iterator = ReflectApply(method, parts, []);
    if (iterator === null || (typeof iterator !== 'object' && typeof iterator !== 'function')) {
      throw conversionError(
        iface,
        undefined,
        'The object must have a callable @@iterator property.',
      );
    }

    var next = iterator.next;
    for (;;) {
      var step = ReflectApply(next, iterator, []);
      if (step === null || (typeof step !== 'object' && typeof step !== 'function')) {
        throw conversionError(iface, undefined, 'Expected iterator.next() to return an Object.');
      }

      if (step.done) return out;
      ArrayPrototypePush1(out, convertPart(step.value, iface));
    }
  }

  /**
   * Converts a BlobPropertyBag (or, for File, a FilePropertyBag).
   * @param {*} options
   * @param {string} iface 'Blob' or 'File'.
   * @returns {{native: boolean, type: string, lastModified: (number|undefined)}}
   *   `type` already normalized; `lastModified` only for File, undefined when absent.
   * @throws {TypeError} a non-object bag, a bad `endings` enum value, or a Symbol or
   *   BigInt member.
   * @node Chrome 158 (tests/web/cases/blob-errors): members are read in WebIDL's order
   *       — the inherited `endings` and `type`, then File's `lastModified` — and an error
   *       in an inherited member names BlobPropertyBag even under File.
   * @deviates none
   */
  function convertBag(options, iface) {
    var bag = { __proto__: null, native: false, type: '', lastModified: undefined };
    if (options === undefined || options === null) return bag;
    var isFile = iface === 'File';
    if (typeof options !== 'object' && typeof options !== 'function') {
      throw conversionError(
        iface,
        undefined,
        "The provided value is not of type '" +
          (isFile ? 'FilePropertyBag' : 'BlobPropertyBag') +
          "'.",
      );
    }

    var endings = options.endings;
    if (endings !== undefined) {
      var member = "Failed to read the 'endings' property from 'BlobPropertyBag': ";
      endings = toStringArg(endings, iface, undefined, member);
      if (endings !== 'transparent' && endings !== 'native') {
        throw conversionError(
          iface,
          undefined,
          member +
            "The provided value '" +
            endings +
            "' is not a valid enum value of type EndingType.",
        );
      }

      bag.native = endings === 'native';
    }

    var type = options.type;
    if (type !== undefined) {
      bag.type = normalizeType(
        toStringArg(
          type,
          iface,
          undefined,
          "Failed to read the 'type' property from 'BlobPropertyBag': ",
        ),
      );
    }

    if (isFile) {
      var lastModified = options.lastModified;
      if (lastModified !== undefined) {
        bag.lastModified = toLongLong(
          toNumberArg(
            lastModified,
            iface,
            undefined,
            "Failed to read the 'lastModified' property from 'FilePropertyBag': ",
          ),
        );
      }
    }

    return bag;
  }

  // WebIDL `long long` without [Clamp]: NaN and the infinities are 0, the rest is
  // truncated and wrapped modulo 2^64 into the signed range.
  var TWO_64 = 18446744073709551616;
  var TWO_63 = 9223372036854775808;
  function toLongLong(n) {
    if (NumberIsNaN(n) || n === Infinity || n === -Infinity) return 0;
    n = MathTrunc(n);
    // In range already: no wrap. The general form below loses a negative near 0 to
    // rounding (-1 + 2^64 is 2^64 in a double, and wraps to 0).
    if (n >= -TWO_63 && n < TWO_63) return n + 0;
    n -= MathFloor(n / TWO_64) * TWO_64;
    return n >= TWO_63 ? n - TWO_64 : n + 0;
  }

  // WebIDL `[Clamp] long long`: NaN is 0, the rest clamped into range and rounded to
  // the nearest integer, ties to even.
  function toClampedLongLong(n) {
    if (NumberIsNaN(n)) return 0;
    n = MathMin(MathMax(n, -TWO_63), TWO_63 - 1);
    var f = MathFloor(n);
    var diff = n - f;
    if (diff > 0.5 || (diff === 0.5 && f % 2 !== 0)) f += 1;
    return f + 0;
  }

  // The File API's type rule: a type with any code unit outside U+0020-U+007E is
  // dropped whole, otherwise it is lowercased.
  function normalizeType(type) {
    for (var k = 0; k < type.length; k++) {
      var code = StringPrototypeCharCodeAt(type, k);
      if (code < 0x20 || code > 0x7e) return '';
    }

    return StringPrototypeToLowerCase(type);
  }

  // The File API's "process blob parts": the converted parts as the byte chunks a Blob
  // keeps, each a Uint8Array of its own (a Blob part's chunks are shared, never
  // written). A view's window comes from the engine's slots through the captured
  // getters — read live, a forged trio selected a window across a neighbouring
  // allocation. Deviates: node's Blob reads all three live (node 26.13.0, spy getters);
  // pinned Lava-only by blob_view_window_ignores_forged_accessors in
  // cmd/lava/blob_class_test.odin. The copy goes through ArrayBufferPrototypeSlice,
  // which reads the source's `constructor` / Symbol.species, as node's does.
  function buildChunks(parts, nativeEndings) {
    var chunks = [];
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (typeof part === 'string') {
        if (part.length !== 0) {
          ArrayPrototypePush1(
            chunks,
            utf8EncodeNative(nativeEndings ? toNativeEndings(part) : part),
          );
        }
      } else if (isBlob(part)) {
        var inner = partsOf(part);
        for (var j = 0; j < inner.length; j++) ArrayPrototypePush1(chunks, inner[j]);
      } else {
        var bytes = copyBytes(part);
        if (TypedArrayPrototypeGetLength(bytes) !== 0) ArrayPrototypePush1(chunks, bytes);
      }
    }

    return chunks;
  }

  function copyBytes(part) {
    if (!ArrayBufferIsView(part)) return new Uint8ArrayG(ArrayBufferPrototypeSlice(part, 0));
    var typed = TypedArrayPrototypeGetSymbolToStringTag(part) !== undefined;
    var buf = typed ? TypedArrayPrototypeGetBuffer(part) : DataViewPrototypeGetBuffer(part);
    var off = typed ? TypedArrayPrototypeGetByteOffset(part) : DataViewPrototypeGetByteOffset(part);
    var len = typed ? TypedArrayPrototypeGetByteLength(part) : DataViewPrototypeGetByteLength(part);
    return new Uint8ArrayG(ArrayBufferPrototypeSlice(buf, off, off + len));
  }

  // Three callers (arrayBuffer, bytes, text), so it stays a function.
  function blobJoin(parts, total) {
    var merged = new Uint8ArrayG(total),
      off = 0;
    for (var i = 0; i < parts.length; i++) {
      Uint8ArrayPrototypeSet(merged, parts[i], off);
      off += TypedArrayPrototypeGetLength(parts[i]);
    }
    return merged;
  }

  function sizeOfChunks(chunks) {
    var total = 0;
    for (var i = 0; i < chunks.length; i++) total += TypedArrayPrototypeGetLength(chunks[i]);
    return total;
  }

  // What a foreign receiver gets from the promise-returning operations: a rejection,
  // which in Chrome carries the context prefix the synchronous ones do not.
  function rejectReceiver(op) {
    return PromiseReject(typeError('Blob', op, 'Illegal invocation'));
  }

  function invalidThis() {
    return illegalInvocation();
  }

  // Bound in Blob's static block: the only code that can read its private fields.
  var isBlob, partsOf, sizeOf, typeOf;

  /**
   * Blob: its bytes kept as the parts it was built from, joined on demand. State is in
   * private fields — nothing a page can read or forge, and the brand every member checks.
   * @node Chrome 158's shape (tests/web/cases/shape-blob.expected): the interface object
   *   and every member are built by internal/native_shape around this class, so they
   *   read as native, members enumerable, and a call without `new` throws Blink's text.
   *   An instance has no own properties (tests/web/cases/blob-errors).
   * @deviates none
   */
  class Blob {
    #parts;
    #size;
    #type;

    static {
      isBlob = function (value) {
        return value !== null && typeof value === 'object' && #parts in value;
      };
      partsOf = function (blob) {
        return blob.#parts;
      };
      sizeOf = function (blob) {
        return blob.#size;
      };
      typeOf = function (blob) {
        return blob.#type;
      };
    }

    /**
     * @param {Iterable<*>} [parts]
     * @param {{type?: string, endings?: string}} [options]
     * @throws {TypeError} as convertParts and convertBag.
     * @node Chrome 158 (tests/web/cases/blob-errors): the parts are converted before
     *       the options, `endings` before `type`.
     * @deviates none
     */
    constructor(parts, options, internal, type) {
      if (internal === INTERNAL) {
        // A prepared chunk list (`parts`) and an already-normalized type.
        this.#parts = parts;
        this.#size = sizeOfChunks(parts);
        this.#type = type;
        return;
      }

      var list = convertParts(parts, 'Blob');
      var bag = convertBag(options, 'Blob');
      this.#parts = buildChunks(list, bag.native);
      this.#size = sizeOfChunks(this.#parts);
      this.#type = bag.type;
    }

    get size() {
      if (!isBlob(this)) throw invalidThis();
      return this.#size;
    }

    get type() {
      if (!isBlob(this)) throw invalidThis();
      return this.#type;
    }

    arrayBuffer() {
      if (!isBlob(this)) return rejectReceiver('arrayBuffer');
      return PromiseResolve(TypedArrayPrototypeGetBuffer(blobJoin(this.#parts, this.#size)));
    }

    bytes() {
      if (!isBlob(this)) return rejectReceiver('bytes');
      return PromiseResolve(blobJoin(this.#parts, this.#size));
    }

    stream() {
      if (!isBlob(this)) throw invalidThis();
      var parts = this.#parts;
      var ReadableStream = require('internal/webstreams/index').ReadableStream;
      return new ReadableStream({
        start: function (controller) {
          for (var i = 0; i < parts.length; i++) controller.enqueue(new Uint8ArrayG(parts[i]));
          controller.close();
        },
      });
    }

    /**
     * The contents decoded as UTF-8.
     * @returns {Promise<string>}
     * @node Chrome 158 (tests/web/cases/blob-errors): the Encoding standard's "UTF-8
     *       decode", so ONE leading BOM is stripped and an invalid byte is U+FFFD.
     * @deviates none
     */
    text() {
      if (!isBlob(this)) return rejectReceiver('text');
      var text = utf8DecodeNative(blobJoin(this.#parts, this.#size));
      if (StringPrototypeCharCodeAt(text, 0) === 0xfeff) text = StringPrototypeSlice(text, 1);
      return PromiseResolve(text);
    }

    /**
     * @param {number} [start]
     * @param {number} [end]
     * @param {string} [contentType]
     * @returns {Blob}
     * @throws {TypeError} a Symbol or BigInt offset, a Symbol type, a foreign receiver.
     * @node Chrome 158 (tests/web/cases/blob-errors): the offsets are `[Clamp] long
     *       long` (strings convert, NaN is 0, out-of-range clamps), converted in order
     *       start, end, contentType; a type with a byte outside printable ASCII is ''.
     * @deviates none
     */
    slice(start, end, contentType) {
      if (!isBlob(this)) throw invalidThis();
      var len = this.#size;
      var s = start === undefined ? 0 : toClampedLongLong(toNumberArg(start, 'Blob', 'slice', ''));
      var e = end === undefined ? len : toClampedLongLong(toNumberArg(end, 'Blob', 'slice', ''));
      var type =
        contentType === undefined
          ? ''
          : normalizeType(toStringArg(contentType, 'Blob', 'slice', ''));
      s = s < 0 ? MathMax(len + s, 0) : MathMin(s, len);
      e = e < 0 ? MathMax(len + e, 0) : MathMin(e, len);
      if (e < s) e = s;
      var out = [];
      var pos = 0;
      var parts = this.#parts;
      for (var i = 0; i < parts.length && pos < e; i++) {
        var part = parts[i];
        var partLength = TypedArrayPrototypeGetLength(part);
        var pEnd = pos + partLength;
        if (pEnd > s) {
          ArrayPrototypePush1(
            out,
            TypedArrayPrototypeSubarray(
              part,
              pos < s ? s - pos : 0,
              pEnd > e ? e - pos : partLength,
            ),
          );
        }
        pos = pEnd;
      }
      return new Blob(out, undefined, INTERNAL, type);
    }

    /**
     * The contents as a stream of strings, decoded as UTF-8 (File API, Chrome 133+).
     * @returns {ReadableStream<string>}
     * @node n/a — Chrome 158 has it (tests/web/cases/shape-blob.expected).
     * @deviates none
     */
    textStream() {
      if (!isBlob(this)) throw invalidThis();
      // Late-bound: webstreams and encoding load after this eager module.
      var TransformStream = require('internal/webstreams/index').TransformStream;
      var TextDecoder = require('internal/encoding').TextDecoder;
      var decoder = new TextDecoder();
      return this.stream().pipeThrough(
        new TransformStream({
          transform: function (chunk, controller) {
            var text = decoder.decode(chunk, { stream: true });
            if (text !== '') controller.enqueue(text);
          },
          flush: function (controller) {
            var text = decoder.decode();
            if (text !== '') controller.enqueue(text);
          },
        }),
      );
    }
  }

  // The interface object a page sees (internal/native_shape), in Blink's member order
  // (Chrome 158, tests/web/cases/shape-blob.expected). `String(blob)` needs no own
  // toString: Object.prototype.toString reads the @@toStringTag defined here.
  var PublicBlob = defineInterface({
    name: 'Blob',
    impl: Blob,
    length: 0,
    members: [
      'size',
      'type',
      'arrayBuffer:0',
      'slice:0',
      'stream:0',
      'text:0',
      'bytes:0',
      'textStream:0',
      'constructor',
      '@@toStringTag',
    ],
  });

  /**
   * A Blob's bytes, joined, for code that consumes a Blob without its promise API
   * (a fetch body); null for anything that is not a Blob.
   * @param {*} value
   * @returns {Uint8Array|null}
   */
  function blobBytes(value) {
    if (!isBlob(value)) return null;
    return blobJoin(partsOf(value), sizeOf(value));
  }

  /**
   * A Blob's structured-clone serialization: a new Blob over the same bytes (a Blob's
   * chunks are never written, so they are shared) and type. File's own clone is
   * internal/file's, which calls this for a plain Blob.
   * @param {*} value
   * @returns {Blob|undefined} undefined for anything that is not a Blob.
   */
  function cloneBlob(value) {
    if (!isBlob(value)) return undefined;
    return new Blob(partsOf(value), undefined, INTERNAL, typeOf(value));
  }

  // A null-prototype dictionary rather than a Map: its get/set/delete are plain property
  // operations, so a replaced Map.prototype method has nothing to steer, and no Map
  // primordials are needed for it. Keys are strings either way, and with no prototype a
  // key such as '__proto__' or 'toString' is just an own key.
  var objectUrlRegistry = { __proto__: null };

  // The page's origin, serialized as an origin (`scheme://host[:port]`), or 'null' for an
  // opaque one: what the embedder passed (`lava run --origin=`) is a URL or an origin,
  // so it goes through the URL parser once, on the first object URL. A value the parser
  // refuses is an opaque origin too — what Chrome mints for one — rather than a URL
  // that names text the embedder never meant as an origin.
  var pageOriginText = null;
  function pageOrigin() {
    if (pageOriginText !== null) return pageOriginText;
    pageOriginText = 'null';
    if (ORIGIN_RAW !== '') {
      try {
        // Late-bound: internal/url loads after this eager module (it copies the statics
        // below onto its URL class).
        pageOriginText = new (require('internal/url').URL)(ORIGIN_RAW).origin;
      } catch {}
    }

    return pageOriginText;
  }

  // The key an object URL is registered under: the URL without its fragment, which the
  // File API's resolution ignores.
  function registryKey(url) {
    var hash = StringPrototypeIndexOf(url, '#', 0);
    return hash === -1 ? url : StringPrototypeSlice(url, 0, hash);
  }

  /**
   * Registers a Blob (or File) and returns its object URL.
   * @param {Blob} obj
   * @returns {string} `blob:<origin>/<uuid>`, the origin the page's (`null` when opaque).
   * @throws {TypeError} no argument, or not a Blob (by its private brand).
   * @node Chrome 158 (tests/web/cases/blob-object-url, blob-errors): the argument count
   *       first, then "Overload resolution failed." (the overload is Blob or
   *       MediaSource), even for an object that only inherits from Blob.prototype.
   * @deviates none
   */
  function createObjectURL(obj) {
    if (arguments.length < 1) {
      throw typeError('URL', 'createObjectURL', argumentsRequired(1, 0));
    }

    if (!isBlob(obj)) {
      throw typeError('URL', 'createObjectURL', 'Overload resolution failed.');
    }

    // The loader's pristine crypto.randomUUID (see bootstrap/loader.js); crypto is eager,
    // so it always exists.
    var id = 'blob:' + pageOrigin() + '/' + require.pristineRandomUUID();
    objectUrlRegistry[id] = obj;
    return id;
  }

  /**
   * Revokes an object URL; anything that names none is ignored.
   * @param {string} url
   * @throws {TypeError} no argument, or a Symbol.
   * @node Chrome 158 (tests/web/cases/blob-errors): `undefined` is converted, not
   *       refused.
   * @deviates none
   */
  function revokeObjectURL(url) {
    if (arguments.length < 1) {
      throw typeError('URL', 'revokeObjectURL', argumentsRequired(1, 0));
    }

    url = toStringArg(url, 'URL', 'revokeObjectURL', '');

    delete objectUrlRegistry[registryKey(url)];
  }

  /**
   * What fetch() reads for a `blob:` URL: the registered Blob, or undefined for one
   * that names none (never registered, or revoked).
   * @param {string} url The request URL, serialized.
   * @returns {Blob|undefined}
   */
  function resolveForFetch(url) {
    var blob = objectUrlRegistry[registryKey(url)];
    return blob === undefined ? undefined : blob;
  }

  // The first web globals installed: the URL statics (on a stub object, which
  // internal/url.js replaces with the class later in the loader's eager list), then
  // Blob. File, atob and btoa follow from internal/file.js and internal/base64.js, which
  // the loader instantiates next.
  if (globalThis.URL === undefined) {
    globalThis.URL = { createObjectURL: createObjectURL, revokeObjectURL: revokeObjectURL };
  } else {
    if (typeof globalThis.URL.createObjectURL !== 'function')
      globalThis.URL.createObjectURL = createObjectURL;
    if (typeof globalThis.URL.revokeObjectURL !== 'function')
      globalThis.URL.revokeObjectURL = revokeObjectURL;
  }
  module.exports = {
    Blob: PublicBlob,
    BlobImpl: Blob,
    INTERNAL: INTERNAL,
    isBlob: isBlob,
    typeOf: typeOf,
    partsOf: partsOf,
    blobBytes: blobBytes,
    cloneBlob: cloneBlob,
    convertParts: convertParts,
    convertBag: convertBag,
    buildChunks: buildChunks,
    toStringArg: toStringArg,
    createObjectURL: createObjectURL,
    revokeObjectURL: revokeObjectURL,
    resolveForFetch: resolveForFetch,
  };
});
