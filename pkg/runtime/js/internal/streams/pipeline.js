// pipeline() — node's lib/internal/streams/pipeline.js.
(function (require, module) {
  'use strict';

  var errors = require('internal/errors');
  var ERR_INVALID_ARG_TYPE = errors.ERR_INVALID_ARG_TYPE;
  var isStreamLike = require('internal/streams/utils').isStreamLike;
  var finished = require('internal/streams/end-of-stream');

  // node's list for a pipeline stage. Lava accepts only the Stream arm so far (functions,
  // iterables and web streams are not piped yet), but the error names what node accepts.
  var PIPELINE_BODY = [
    'function',
    'Blob',
    'ReadableStream',
    'WritableStream',
    'Stream',
    'Iterable',
    'AsyncIterable',
    'Promise',
    '{ readable, writable } pair',
  ];

  function pipeline() {
    var args = [];
    for (var i = 0; i < arguments.length; i++) args[i] = arguments[i];
    var cb = args.pop();
    if (typeof cb !== 'function')
      throw ERR_INVALID_ARG_TYPE('streams[stream.length - 1]', 'function', cb);
    if (Array.isArray(args[0]) && args.length === 1) args = args[0];
    if (args.length < 2) {
      throw errors.ERR_MISSING_ARGS('streams');
    }

    var streams = args;
    var called = false;
    function done(err) {
      if (called) return;
      called = true;
      // On failure every stream in the chain is torn down (Node parity).
      if (err) {
        for (var j = 0; j < streams.length; j++) {
          if (typeof streams[j].destroy === 'function') streams[j].destroy();
        }
      }
      cb(err || null);
    }

    for (var k = 0; k < streams.length; k++) {
      if (!isStreamLike(streams[k])) throw ERR_INVALID_ARG_TYPE('body', PIPELINE_BODY, streams[k]);
      streams[k].on('error', done);
      if (k > 0) streams[k - 1].pipe(streams[k]);
    }
    finished(streams[streams.length - 1], function (err) {
      done(err);
    });
    return streams[streams.length - 1];
  }

  module.exports = { pipeline: pipeline };
});
