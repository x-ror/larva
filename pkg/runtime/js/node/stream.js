// node:stream — classic Node streams: Readable, Writable, Duplex, Transform,
// PassThrough, plus finished() and pipeline(). This is the base layer node:net,
// node:http, and the npm ecosystem compose on (pipe, drain-based backpressure,
// async iteration). Web Streams (stream/web) remain a separate spec surface;
// Readable/Writable.fromWeb/toWeb bridge the two worlds.
//
// Scope notes (vs Node): no writev batching (writev is called per-chunk through
// _write), and byte streams only decode via string_decoder when setEncoding is
// used. Ordering of the observable events — 'data' synchronous from flow, cb /
// 'drain' / 'finish' / 'end' / 'close' deferred a tick — follows Node so the
// oracle cases diff clean.
//
// This file only assembles the public module. The implementation lives under
// js/internal/streams/ (and js/internal/webstreams/adapters.js for the bridges), one
// file per node lib/internal/streams module, so a stack frame names the same source
// node's does (`node:internal/streams/readable`). Pinned by
// tests/node-compat/cases/79-stream-internal-modules.js.
(function (require, module) {
  'use strict';

  var Stream = require('internal/streams/legacy').Stream;
  var Readable = require('internal/streams/readable').Readable;
  var Writable = require('internal/streams/writable').Writable;
  var Duplex = require('internal/streams/duplex');
  var Transform = require('internal/streams/transform');
  var PassThrough = require('internal/streams/passthrough');
  var finished = require('internal/streams/end-of-stream');
  var pipeline = require('internal/streams/pipeline').pipeline;
  var addAbortSignal = require('internal/streams/add-abort-signal').addAbortSignal;

  // --- exports ---------------------------------------------------------------------

  Stream.Stream = Stream;
  Stream.Readable = Readable;
  Stream.Writable = Writable;
  Stream.Duplex = Duplex;
  Stream.Transform = Transform;
  Stream.PassThrough = PassThrough;
  Stream.finished = finished;
  Stream.pipeline = pipeline;
  Stream.addAbortSignal = function (signal, stream) {
    addAbortSignal(signal, stream);
    return stream;
  };
  Stream.isReadable = function (s) {
    return !!(
      s &&
      typeof s.read === 'function' &&
      s.readable !== false &&
      !(s._readableState && s._readableState.endEmitted)
    );
  };
  Stream.isWritable = function (s) {
    return !!(
      s &&
      typeof s.write === 'function' &&
      s.writable !== false &&
      !(s._writableState && s._writableState.finished)
    );
  };

  module.exports = Stream;
});
