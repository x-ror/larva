// finished() — node's lib/internal/streams/end-of-stream.js.
(function (require, module) {
  'use strict';

  var errors = require('internal/errors');
  var nodeError = errors.nodeError;
  var ERR_INVALID_ARG_TYPE = errors.ERR_INVALID_ARG_TYPE;
  var isStreamLike = require('internal/streams/utils').isStreamLike;
  var ErrorG = require('internal/primordials').Error;
  var nextTick = process.nextTick;

  function errPrematureClose() {
    return nodeError(ErrorG, 'ERR_STREAM_PREMATURE_CLOSE', 'Premature close');
  }

  function finished(stream, opts, cb) {
    if (typeof opts === 'function') {
      cb = opts;
      opts = {};
    }
    opts = opts || {};
    if (!isStreamLike(stream))
      throw ERR_INVALID_ARG_TYPE('stream', ['ReadableStream', 'WritableStream', 'Stream'], stream);

    var readable =
      opts.readable !== false && typeof stream.readable === 'boolean' ? stream.readable : false;
    var writable =
      opts.writable !== false && typeof stream.writable === 'boolean' ? stream.writable : false;
    // Streams that predate the state objects (or foreign ones): fall back to
    // listening for everything and settling on the first terminal event.
    var r = stream._readableState;
    var w = stream._writableState;
    var readableEnded = !readable || (r && r.endEmitted);
    var writableFinished = !writable || (w && w.finished);
    var called = false;

    function done(err) {
      if (called) return;
      called = true;
      cleanup();
      cb.call(stream, err || null);
    }
    function onend() {
      readableEnded = true;
      if (writableFinished) done();
    }
    function onfinish() {
      writableFinished = true;
      if (readableEnded) done();
    }
    function onerror(err) {
      done(err);
    }
    function onclose() {
      if (readable && !readableEnded && !(r && r.endEmitted)) return done(errPrematureClose());
      if (writable && !writableFinished && !(w && w.finished)) return done(errPrematureClose());
      done();
    }
    function cleanup() {
      stream.removeListener('end', onend);
      stream.removeListener('finish', onfinish);
      stream.removeListener('error', onerror);
      stream.removeListener('close', onclose);
    }
    if (readableEnded && writableFinished) {
      nextTick(done);
    } else {
      stream.on('end', onend);
      stream.on('finish', onfinish);
      stream.on('error', onerror);
      stream.on('close', onclose);
    }
    return cleanup;
  }

  module.exports = finished;
});
