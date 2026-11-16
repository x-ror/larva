// The Stream base constructor every classic stream inherits from — node's
// lib/internal/streams/legacy.js. Lava's has no legacy `pipe`; Readable carries its own.
(function (require, module) {
  'use strict';

  var EventEmitter = require('events');

  function Stream(opts) {
    EventEmitter.call(this);
  }
  Stream.prototype = Object.create(EventEmitter.prototype);
  Stream.prototype.constructor = Stream;

  module.exports = { Stream: Stream };
});
