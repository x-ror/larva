// PassThrough — node's lib/internal/streams/passthrough.js.
(function (require, module) {
  'use strict';

  var Transform = require('internal/streams/transform');

  function PassThrough(options) {
    if (!(this instanceof PassThrough)) return new PassThrough(options);
    Transform.call(this, options);
  }
  PassThrough.prototype = Object.create(Transform.prototype);
  PassThrough.prototype.constructor = PassThrough;
  PassThrough.prototype._transform = function (chunk, encoding, cb) {
    cb(null, chunk);
  };

  module.exports = PassThrough;
});
