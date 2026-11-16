// Helpers shared by more than one internal/streams module. node keeps isNodeStream and
// friends in lib/internal/streams/utils.js; isStreamLike is Lava's (narrower) version of
// that check. The chunk helpers have no single home in node — it hangs
// _isArrayBufferView/_uint8ArrayToBuffer off the Stream constructor in lib/stream.js —
// and Lava does not expose those statics, so readable.js and writable.js share them here.
(function (require, module) {
  'use strict';

  var Buffer = require('buffer').Buffer;
  var BufferIsEncoding = Buffer.isEncoding;

  // Through primordials, NOT captured off the globals here: these were written when stream
  // was believed lazy, where a module-eval capture runs after user code and is steerable
  // (#333), and primordials keeps them safe whichever way the module is instantiated.
  // `ArrayBuffer.isView` in particular is a
  // security decision — read live, `globalThis.ArrayBuffer = {isView: () => true}` walks a
  // plain object straight into the byte path.
  var StreamPrimordials = require('internal/primordials');
  var ArrayBufferIsView = StreamPrimordials.ArrayBufferIsView;
  var ErrorG = StreamPrimordials.Error;
  var ObjectGetPrototypeOf = StreamPrimordials.ObjectGetPrototypeOf;
  var DataViewPrototype = StreamPrimordials.DataViewPrototype;
  var DataViewPrototypeGetBuffer = StreamPrimordials.DataViewPrototypeGetBuffer;
  var DataViewPrototypeGetByteOffset = StreamPrimordials.DataViewPrototypeGetByteOffset;
  var DataViewPrototypeGetByteLength = StreamPrimordials.DataViewPrototypeGetByteLength;
  var TypedArrayPrototypeGetBuffer = StreamPrimordials.TypedArrayPrototypeGetBuffer;
  var TypedArrayPrototypeGetByteOffset = StreamPrimordials.TypedArrayPrototypeGetByteOffset;
  var TypedArrayPrototypeGetByteLength = StreamPrimordials.TypedArrayPrototypeGetByteLength;

  var errors = require('internal/errors');
  var nodeError = errors.nodeError;
  var ERR_UNKNOWN_ENCODING = errors.ERR_UNKNOWN_ENCODING;
  function errMethodNotImplemented(name) {
    return nodeError(
      ErrorG,
      'ERR_METHOD_NOT_IMPLEMENTED',
      'The ' + name + ' method is not implemented',
    );
  }

  // node's chunk contract, verified on 24.18.1: a string, or ANY ArrayBuffer view —
  // Buffer, every TypedArray, and DataView. `instanceof Uint8Array` is wrong in both
  // directions: it rejects DataView and Int16Array, which node accepts, and it accepts
  // `Object.create(Uint8Array.prototype)`, which node rejects. ArrayBuffer.isView is the
  // whole test, and it also refuses a bare ArrayBuffer.
  var CHUNK_EXPECTED = ['string', 'Buffer', 'TypedArray', 'DataView'];
  function isBytesChunk(chunk) {
    return ArrayBufferIsView(chunk);
  }

  function isDataViewChunk(value) {
    // Prototype-chain walk rather than `instanceof` (forgeable through Symbol.hasInstance)
    // or a try/catch around a getter (an exception per write on the hot path).
    var proto = ObjectGetPrototypeOf(value);
    while (proto !== null) {
      if (proto === DataViewPrototype) return true;
      proto = ObjectGetPrototypeOf(proto);
    }
    return false;
  }

  // THE STEP WHOSE ABSENCE CAUSED #326's REGRESSION. node hands `_write` a Buffer with
  // encoding 'buffer' for every view, so widening the accept set without converting left
  // `chunk.length` undefined for a DataView: `writableLength` went NaN, `'drain'` could
  // never fire again (NaN === 0 is false), and pipe() stalled forever.
  //
  // The two getter families are NOT interchangeable — a %TypedArray% getter throws on a
  // DataView receiver, which is exactly what the in-flight fix hit last time — so the
  // brand decides which set to read the window through.
  function bytesToBuffer(chunk) {
    if (isDataViewChunk(chunk)) {
      return Buffer.from(
        DataViewPrototypeGetBuffer(chunk),
        DataViewPrototypeGetByteOffset(chunk),
        DataViewPrototypeGetByteLength(chunk),
      );
    }
    return Buffer.from(
      TypedArrayPrototypeGetBuffer(chunk),
      TypedArrayPrototypeGetByteOffset(chunk),
      TypedArrayPrototypeGetByteLength(chunk),
    );
  }

  // node validates an EXPLICIT encoding before it looks at the chunk, which is why
  // `write(5, 'bogus')` reports the encoding and not the chunk type. 'buffer' is node's
  // internal marker and is always allowed through.
  function validateEncoding(encoding) {
    if (encoding !== 'buffer' && !BufferIsEncoding(encoding)) throw ERR_UNKNOWN_ENCODING(encoding);
  }

  function isStreamLike(s) {
    return s !== null && typeof s === 'object' && typeof s.on === 'function';
  }

  module.exports = {
    CHUNK_EXPECTED: CHUNK_EXPECTED,
    isBytesChunk: isBytesChunk,
    bytesToBuffer: bytesToBuffer,
    validateEncoding: validateEncoding,
    errMethodNotImplemented: errMethodNotImplemented,
    isStreamLike: isStreamLike,
  };
});
