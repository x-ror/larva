// node:stream/promises — promisified finished() and pipeline() over node:stream.
(function (require, module) {
  'use strict';

  var stream = require('stream');

  function finished(s, opts) {
    return new Promise(function (resolve, reject) {
      stream.finished(s, opts || {}, function (err) {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  function pipeline() {
    var args = [];
    for (var i = 0; i < arguments.length; i++) args[i] = arguments[i];
    return new Promise(function (resolve, reject) {
      args.push(function (err) {
        if (err) reject(err);
        else resolve();
      });
      stream.pipeline.apply(null, args);
    });
  }

  module.exports = { finished: finished, pipeline: pipeline };
});
