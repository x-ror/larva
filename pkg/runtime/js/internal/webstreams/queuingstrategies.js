// ByteLengthQueuingStrategy and CountQueuingStrategy — node's
// lib/internal/webstreams/queuingstrategies.js.
(function (require, module) {
  'use strict';

  class ByteLengthQueuingStrategy {
    constructor(options) {
      if (!options || options.highWaterMark === undefined) {
        throw new TypeError('ByteLengthQueuingStrategy requires a highWaterMark option');
      }
      this._highWaterMark = Number(options.highWaterMark);
    }
    get highWaterMark() {
      return this._highWaterMark;
    }
    get size() {
      // Per spec this is a fresh function bound to no stream; chunk.byteLength.
      return function (chunk) {
        return chunk.byteLength;
      };
    }
  }

  class CountQueuingStrategy {
    constructor(options) {
      if (!options || options.highWaterMark === undefined) {
        throw new TypeError('CountQueuingStrategy requires a highWaterMark option');
      }
      this._highWaterMark = Number(options.highWaterMark);
    }
    get highWaterMark() {
      return this._highWaterMark;
    }
    get size() {
      return function () {
        return 1;
      };
    }
  }

  module.exports = {
    ByteLengthQueuingStrategy: ByteLengthQueuingStrategy,
    CountQueuingStrategy: CountQueuingStrategy,
  };
});
