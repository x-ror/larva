/**
 * @fileoverview Blob (WHATWG File API) and the `blob:` object-URL registry —
 * node's lib/internal/blob.js. Re-exported from node:buffer (`Blob`,
 * `resolveObjectURL`); node/buffer.js also installs the `Blob` global and the
 * `URL.createObjectURL`/`revokeObjectURL` statics, so the order of every global
 * install stays where it was before this file was split out of it.
 *
 * Instantiated eagerly: node/buffer.js requires it at its top level, before user
 * code runs, so the module-eval captures below are pristine.
 *
 * @module lava/internal/blob
 */

(function (require, module, _exports) {
  'use strict';

  var P = require('internal/primordials');
  var StringG = String;
  var StringPrototypeCharCodeAt = P.StringPrototypeCharCodeAt;
  var StringPrototypeSlice = P.StringPrototypeSlice;
  var StringPrototypeIndexOf = P.StringPrototypeIndexOf;

  var errors = require('internal/errors');
  var ERR_INVALID_ARG_TYPE = errors.ERR_INVALID_ARG_TYPE;
  var ERR_MISSING_ARGS = errors.ERR_MISSING_ARGS;

  // UTF-8 encode/decode go through the loader's pristine Buffer table, read at CALL
  // time. It cannot be captured here: node/buffer.js requires this module from its own
  // factory, so `require.pristineBuffer` is attached only after this module has run —
  // and a top-level `require('buffer')` would be a cycle (check-js-graph rejects it).
  // The functions are the same ones node/buffer.js's own `Buffer.from` /
  // `Buffer.prototype.toString` are, so the bytes are identical for every string,
  // lone surrogates included; what changes is that a replaced `Buffer.from` no longer
  // steers Blob, which is where node is (its Blob encodes through a binding).
  function encodeUtf8(str) {
    return new Uint8Array(require.pristineBuffer.from(str, 'utf8'));
  }

  function decodeUtf8(bytes) {
    var PB = require.pristineBuffer;
    return PB.bufferToString(PB.from(bytes), 'utf8');
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
    return [encodeUtf8(str)];
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

  // Blob.prototype's methods were enumerable while Blob was a function whose prototype
  // was assigned to; class methods are not. Kept enumerable so `for…in` and
  // Object.keys(Blob.prototype) report what they did before the class conversion. Node's
  // set differs (it also lists size/type and a textStream Lava does not have, and not
  // toString), so matching it is a separate change, not a line here.
  var ENUMERABLE_METHODS = ['arrayBuffer', 'bytes', 'stream', 'text', 'slice', 'toString'];

  /**
   * Minimal Blob: stores parts without eager concat; materializes on demand.
   * @node A class, like node's: Blob.prototype is non-writable (node 26.13.0, verified).
   * @deviates Calling it without `new` throws JSC's class-constructor TypeError —
   *   `Cannot call a class constructor Blob without |new|` — where node says
   *   `Class constructor Blob cannot be invoked without 'new'` (and Lava said
   *   `Constructor Blob requires 'new'` before the class conversion). The text is the
   *   engine's and cannot be customised on a class; pinned by
   *   cmd/lava/blob_class_test.odin.
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

    get size() {
      return this._size;
    }

    get type() {
      return this._type;
    }

    arrayBuffer() {
      return Promise.resolve(blobJoin(this._parts, this._size).buffer);
    }

    bytes() {
      return Promise.resolve(blobJoin(this._parts, this._size));
    }

    stream() {
      var parts = this._parts;
      var ReadableStream = require('node:stream/web').ReadableStream;
      return new ReadableStream({
        start: function (controller) {
          for (var i = 0; i < parts.length; i++) controller.enqueue(new Uint8Array(parts[i]));
          controller.close();
        },
      });
    }

    text() {
      return Promise.resolve(decodeUtf8(blobJoin(this._parts, this._size)));
    }

    slice(start, end, contentType) {
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
    }

    toString() {
      return '[object Blob]';
    }
  }
  for (var m = 0; m < ENUMERABLE_METHODS.length; m++) {
    Object.defineProperty(Blob.prototype, ENUMERABLE_METHODS[m], { enumerable: true });
  }

  if (typeof Symbol !== 'undefined' && Symbol.toStringTag) {
    Object.defineProperty(Blob.prototype, Symbol.toStringTag, {
      value: 'Blob',
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
      throw ERR_INVALID_ARG_TYPE('obj', 'Blob', obj);
    }
    var id = 'blob:nodedata:' + objectUrlId();
    objectUrlRegistry.set(id, obj);
    return id;
  }

  /** @param {string} url */
  function revokeObjectURL(url) {
    if (url === undefined) {
      throw ERR_MISSING_ARGS('url');
    }
    objectUrlRegistry.delete(StringG(url));
  }

  /** @param {string} id @returns {Blob|File|null} */
  function resolveObjectURL(id) {
    var blob = objectUrlRegistry.get(`${id}`);
    if (blob === undefined) return;
    return new Blob([blob], { type: blob.type });
  }

  module.exports = {
    Blob: Blob,
    createObjectURL: createObjectURL,
    revokeObjectURL: revokeObjectURL,
    resolveObjectURL: resolveObjectURL,
  };
});
