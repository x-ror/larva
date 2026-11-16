// Destroys a stream when its AbortSignal fires — node's
// lib/internal/streams/add-abort-signal.js. The public stream.addAbortSignal wrapper,
// which returns the stream, stays in node/stream.js.
(function (require, module) {
  'use strict';

  var ErrorG = require('internal/primordials').Error;
  var nextTick = process.nextTick;

  // node's AbortError is its own class (name 'AbortError'); this keeps the plain-Error
  // shape the module has always produced — not an ERR_* constructor, so not moved.
  function abortError() {
    var err = new ErrorG('The operation was aborted');
    err.code = 'ABORT_ERR';
    return err;
  }

  function addAbortSignal(signal, stream) {
    if (signal.aborted) {
      nextTick(function () {
        stream.destroy(abortError());
      });
      return;
    }
    signal.addEventListener('abort', function () {
      stream.destroy(abortError());
    });
  }

  module.exports = { addAbortSignal: addAbortSignal };
});
