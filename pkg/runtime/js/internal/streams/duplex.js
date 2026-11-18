// Duplex: a Readable that also carries the Writable API — node's
// lib/internal/streams/duplex.js.
(function (require, module) {
  'use strict';

  var Stream = require('internal/streams/legacy').Stream;
  var readable = require('internal/streams/readable');
  var Readable = readable.Readable;
  var ReadableState = readable.ReadableState;
  var writable = require('internal/streams/writable');
  var Writable = writable.Writable;
  var WritableState = writable.WritableState;
  var addAbortSignal = require('internal/streams/add-abort-signal').addAbortSignal;

  function Duplex(options) {
    if (!(this instanceof Duplex)) return new Duplex(options);
    Stream.call(this);
    this._readableState = new ReadableState(options, options && options.readableObjectMode);
    this._writableState = new WritableState(options, options && options.writableObjectMode);
    if (options) {
      if (typeof options.read === 'function') this._read = options.read;
      if (typeof options.write === 'function') this._write = options.write;
      if (typeof options.writev === 'function') this._writev = options.writev;
      if (typeof options.final === 'function') this._final = options.final;
      if (typeof options.destroy === 'function') this._destroy = options.destroy;
      if (options.encoding) this.setEncoding(options.encoding);
      if (options.readable === false) {
        this._readableState.ended = true;
        this._readableState.endEmitted = true;
      }
      if (options.writable === false) {
        this._writableState.ending = true;
        this._writableState.ended = true;
        this._writableState.finished = true;
      }
      if (options.signal) addAbortSignal(options.signal, this);
    }
  }
  Duplex.prototype = Object.create(Readable.prototype);
  Duplex.prototype.constructor = Duplex;
  // Mix in the Writable API (own-property methods + accessors).
  (function mixinWritable() {
    var keys = Object.getOwnPropertyNames(Writable.prototype);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k === 'constructor') continue;
      if (!Object.prototype.hasOwnProperty.call(Duplex.prototype, k)) {
        Object.defineProperty(
          Duplex.prototype,
          k,
          Object.getOwnPropertyDescriptor(Writable.prototype, k),
        );
      }
    }
    // destroy must tear down BOTH sides; Readable's prototype copy already
    // delegates to the shared destroyImpl, which handles both states.
  })();

  module.exports = Duplex;
});
