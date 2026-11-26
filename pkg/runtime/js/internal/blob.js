/**
 * @fileoverview Blob (WHATWG File API) and the `blob:` object-URL registry —
 * node's lib/internal/blob.js. Re-exported from node:buffer (`Blob`,
 * `resolveObjectURL`). This file installs the `Blob` global and the
 * `URL.createObjectURL`/`revokeObjectURL` statics itself, at the end of module-eval,
 * so the Window surface has them without a node/ module; internal/url.js copies the
 * statics onto the URL class when it replaces the stub.
 *
 * Instantiated eagerly: node/buffer.js requires it at its top level, before user
 * code runs, so the module-eval captures below are pristine (the loader also names
 * it as a root of its own).
 *
 * @module lava/internal/blob
 */

(function (require, module, _exports) {
  'use strict';

  var P = require('internal/primordials');
  var defineInterface = require('internal/native_shape').defineInterface;
  var StringG = P.String;
  var TypeErrorG = P.TypeError;
  var Uint8ArrayG = P.Uint8Array;
  var ArrayBufferPrototype = P.ArrayBuffer.prototype;
  var DataViewPrototype = P.DataViewPrototype;
  var brandedAs = P.brandedAs;
  var ArrayFrom = P.ArrayFrom;
  var ArrayBufferIsView = P.ArrayBufferIsView;
  var ArrayPrototypePush1 = P.ArrayPrototypePush1;
  var ObjectDefineProperty = P.ObjectDefineProperty;
  var MathMax = P.MathMax;
  var MathMin = P.MathMin;
  var SymbolIterator = P.Symbol.iterator;
  var PromiseResolve = P.FunctionPrototypeBind(P.Promise.resolve, P.Promise);
  var StringPrototypeCharCodeAt = P.StringPrototypeCharCodeAt;
  var StringPrototypeSlice = P.StringPrototypeSlice;
  var StringPrototypeIndexOf = P.StringPrototypeIndexOf;
  var StringPrototypeToLowerCase = P.StringPrototypeToLowerCase;
  var ArrayBufferPrototypeSlice = P.ArrayBufferPrototypeSlice;
  var Uint8ArrayPrototypeSet = P.Uint8ArrayPrototypeSet;
  var TypedArrayPrototypeSubarray = P.TypedArrayPrototypeSubarray;
  var TypedArrayPrototypeGetBuffer = P.TypedArrayPrototypeGetBuffer;
  var TypedArrayPrototypeGetByteOffset = P.TypedArrayPrototypeGetByteOffset;
  var TypedArrayPrototypeGetByteLength = P.TypedArrayPrototypeGetByteLength;
  var DataViewPrototypeGetBuffer = P.DataViewPrototypeGetBuffer;
  var DataViewPrototypeGetByteOffset = P.DataViewPrototypeGetByteOffset;
  var DataViewPrototypeGetByteLength = P.DataViewPrototypeGetByteLength;

  var errors = require('internal/errors');
  var ERR_INVALID_ARG_TYPE = errors.ERR_INVALID_ARG_TYPE;
  var ERR_MISSING_ARGS = errors.ERR_MISSING_ARGS;

  // The platform terminator for `endings: 'native'`, fixed when this module loads (before
  // user code; install_process runs ahead of the loader). Node fixes it at startup too:
  // with process.platform redefined to 'win32' on darwin, node 26.13.0 still writes '\n'.
  // Pinned by tests/node-compat/cases/78-blob-pristine-reads.js.
  var EOL = process.platform === 'win32' ? '\r\n' : '\n';

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

  // Kept out of the constructor, which would otherwise run past ~40 lines.
  //
  // A view's window comes from the engine's slots through the captured getters, not the
  // configurable %TypedArray% / DataView accessors — read live, a forged trio selects a
  // window across a shared allocUnsafe pool (the same gadget encoding.js's toBytes
  // closed). DataView's accessors are separate properties, hence two arms. Deviates:
  // node's Blob reads all three live (node 26.13.0, spy getters), so a forged trio steers
  // node and not Lava; pinned Lava-only by blob_view_window_ignores_forged_accessors in
  // cmd/lava/blob_class_test.odin.
  // The copy still goes through ArrayBufferPrototypeSlice, which reads the source's
  // `constructor` / Symbol.species: node's Blob copies through the same primordial, so
  // that read is parity, not a leftover.
  //
  // UTF-8 goes through the loader's pristine Buffer table, read at CALL time: it is
  // attached only after node/buffer.js (which requires this module) has finished, and a
  // top-level `require('buffer')` would be a cycle. The functions are the ones Buffer.from
  // uses, so the bytes are identical for every string, lone surrogates included.
  function blobPartToChunks(part, nativeEndings) {
    if (part instanceof Blob) return part._parts;
    if (brandedAs(part, ArrayBufferPrototype)) {
      return [new Uint8ArrayG(ArrayBufferPrototypeSlice(part, 0))];
    }
    if (ArrayBufferIsView(part)) {
      var dv = brandedAs(part, DataViewPrototype);
      var buf = dv ? DataViewPrototypeGetBuffer(part) : TypedArrayPrototypeGetBuffer(part);
      var off = dv ? DataViewPrototypeGetByteOffset(part) : TypedArrayPrototypeGetByteOffset(part);
      var len = dv ? DataViewPrototypeGetByteLength(part) : TypedArrayPrototypeGetByteLength(part);
      return [new Uint8ArrayG(ArrayBufferPrototypeSlice(buf, off, off + len))];
    }
    var str = StringG(part);
    if (nativeEndings) str = toNativeEndings(str);
    return [new Uint8ArrayG(require.pristineBuffer.from(str, 'utf8'))];
  }

  // Three callers (arrayBuffer, bytes, text), so it stays a function.
  function blobJoin(parts, total) {
    var merged = new Uint8ArrayG(total),
      off = 0;
    for (var i = 0; i < parts.length; i++) {
      Uint8ArrayPrototypeSet(merged, parts[i], off);
      off += parts[i].length;
    }
    return merged;
  }

  /**
   * Minimal Blob: stores parts without eager concat; materializes on demand.
   * @node Chrome 158's shape (tests/web/cases/shape-blob.expected): the interface object
   *   and every member are built by internal/native_shape around this class, so they
   *   read as native, members enumerable, and a call without `new` throws Blink's text.
   * @deviates none in shape. Instances still carry non-enumerable `_parts`/`_size`/
   *   `_type` own properties (S4c).
   */
  class Blob {
    /**
     * @param {Iterable<*>} [parts]
     * @param {{type?: string, endings?: string}} [options]
     */
    constructor(parts, options) {
      var chunks = [],
        total = 0;
      if (parts !== undefined && parts !== null) {
        if (typeof parts !== 'object' || typeof parts[SymbolIterator] !== 'function') {
          throw new TypeErrorG('The "parts" argument must be an iterable object');
        }
        var nativeEndings = !!(options && options.endings === 'native');
        var list = ArrayFrom(parts);
        for (var i = 0; i < list.length; i++) {
          var cs = blobPartToChunks(list[i], nativeEndings);
          for (var j = 0; j < cs.length; j++) {
            if (cs[j].length === 0) continue;
            ArrayPrototypePush1(chunks, cs[j]);
            total += cs[j].length;
          }
        }
      }
      // A type with any byte outside printable ASCII is dropped whole, per the File API.
      var type = '';
      if (options && options.type !== undefined) {
        type = StringG(options.type);
        for (var k = 0; k < type.length; k++) {
          var code = StringPrototypeCharCodeAt(type, k);
          if (code < 0x20 || code > 0x7e) break;
        }
        type = k < type.length ? '' : StringPrototypeToLowerCase(type);
      }
      ObjectDefineProperty(this, '_parts', { value: chunks });
      ObjectDefineProperty(this, '_size', { value: total });
      ObjectDefineProperty(this, '_type', { value: type });
    }

    get size() {
      return this._size;
    }

    get type() {
      return this._type;
    }

    arrayBuffer() {
      return PromiseResolve(TypedArrayPrototypeGetBuffer(blobJoin(this._parts, this._size)));
    }

    bytes() {
      return PromiseResolve(blobJoin(this._parts, this._size));
    }

    stream() {
      var parts = this._parts;
      var ReadableStream = require('internal/webstreams/index').ReadableStream;
      return new ReadableStream({
        start: function (controller) {
          for (var i = 0; i < parts.length; i++) controller.enqueue(new Uint8ArrayG(parts[i]));
          controller.close();
        },
      });
    }

    text() {
      // Decoded in place: the pristine Buffer#toString reads any Uint8Array, so the
      // joined bytes need no Buffer copy first. The change that dropped it (with the
      // primordial captures beside it) took 20000 text() calls on a 96-char string from
      // 93.6 to 77.0 ms — medians of 7 interleaved launches per arm, darwin.
      return PromiseResolve(
        require.pristineBuffer.bufferToString(blobJoin(this._parts, this._size), 'utf8'),
      );
    }

    slice(start, end, contentType) {
      var len = this._size;
      var s = start === undefined ? 0 : start < 0 ? MathMax(len + start, 0) : MathMin(start, len);
      var e = end === undefined ? len : end < 0 ? MathMax(len + end, 0) : MathMin(end, len);
      if (e < s) e = s;
      var out = [];
      var pos = 0;
      var parts = this._parts;
      for (var i = 0; i < parts.length && pos < e; i++) {
        var part = parts[i];
        var pEnd = pos + part.length;
        if (pEnd > s) {
          ArrayPrototypePush1(
            out,
            TypedArrayPrototypeSubarray(
              part,
              pos < s ? s - pos : 0,
              pEnd > e ? e - pos : part.length,
            ),
          );
        }
        pos = pEnd;
      }
      return new Blob(out, contentType === undefined ? undefined : { type: contentType });
    }

    /**
     * The contents as a stream of strings, decoded as UTF-8 (File API, Chrome 133+).
     * @returns {ReadableStream<string>}
     * @node n/a — Chrome 158 has it (tests/web/cases/shape-blob.expected).
     * @deviates none
     */
    textStream() {
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

  // A null-prototype dictionary rather than a Map: its get/set/delete are plain property
  // operations, so a replaced Map.prototype method has nothing to steer, and no Map
  // primordials are needed for it. Keys are strings either way (`${id}` / String(url)),
  // and with no prototype a key such as '__proto__' or 'toString' is just an own key.
  var objectUrlRegistry = { __proto__: null };

  /** @param {Blob|File} obj @returns {string} blob: URL */
  function createObjectURL(obj) {
    if (!(obj instanceof Blob)) {
      throw ERR_INVALID_ARG_TYPE('obj', 'Blob', obj);
    }
    // The loader's pristine crypto.randomUUID (see bootstrap/loader.js); crypto is eager,
    // so it always exists and the hand-rolled Math.random fallback that stood here was dead.
    var id = 'blob:nodedata:' + require.pristineRandomUUID();
    objectUrlRegistry[id] = obj;
    return id;
  }

  /** @param {string} url */
  function revokeObjectURL(url) {
    if (url === undefined) {
      throw ERR_MISSING_ARGS('url');
    }
    delete objectUrlRegistry[StringG(url)];
  }

  /** @param {string} id @returns {Blob|File|null} */
  function resolveObjectURL(id) {
    var blob = objectUrlRegistry[`${id}`];
    if (blob === undefined) return;
    return new Blob([blob], { type: blob.type });
  }

  // The first web globals installed, in the order node/buffer.js installed them before
  // they moved here: the URL statics (on a stub object, which internal/url.js replaces
  // with the class later in the loader's eager list), then Blob. File, atob and btoa
  // follow from internal/file.js and internal/base64.js, which node/buffer.js requires
  // next. The one name whose place moved is Node-only: `Buffer` is installed at the end
  // of node/buffer.js, so it now follows these five in the global object's property
  // order instead of following URL. `.Web` deletes Buffer, so its order is unchanged.
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
    createObjectURL: createObjectURL,
    revokeObjectURL: revokeObjectURL,
    resolveObjectURL: resolveObjectURL,
  };
});
