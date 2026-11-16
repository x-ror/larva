// Transform — node's lib/internal/streams/transform.js.
(function (require, module) {
  'use strict';

  var Duplex = require('internal/streams/duplex');
  var errMethodNotImplemented = require('internal/streams/utils').errMethodNotImplemented;

  function Transform(options) {
    if (!(this instanceof Transform)) return new Transform(options);
    Duplex.call(this, options);
    this._transformCallback = null;
    if (options && typeof options.transform === 'function') this._transform = options.transform;
    if (options && typeof options.flush === 'function') this._flush = options.flush;
  }
  Transform.prototype = Object.create(Duplex.prototype);
  Transform.prototype.constructor = Transform;

  Transform.prototype._transform = function () {
    throw errMethodNotImplemented('_transform()');
  };

  Transform.prototype._write = function (chunk, encoding, cb) {
    var stream = this;
    var r = this._readableState;
    this._transform(chunk, encoding, function (err, data) {
      if (err) return cb(err);
      if (data !== null && data !== undefined) stream.push(data);
      // Read-side backpressure: hold the write pipeline until the consumer
      // drains the readable buffer below HWM (Node's Transform contract).
      if (r.length < r.highWaterMark || r.destroyed) cb();
      else stream._transformCallback = cb;
    });
  };

  Transform.prototype._read = function () {
    var cb = this._transformCallback;
    if (cb) {
      this._transformCallback = null;
      cb();
    }
  };

  Transform.prototype._final = function (cb) {
    var stream = this;
    if (typeof this._flush === 'function') {
      this._flush(function (err, data) {
        if (err) return cb(err);
        if (data !== null && data !== undefined) stream.push(data);
        stream.push(null);
        cb();
      });
    } else {
      stream.push(null);
      cb();
    }
  };

  module.exports = Transform;
});
