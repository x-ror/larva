// Web Streams (WHATWG Streams Standard) — the public ReadableStream /
// WritableStream / TransformStream surface plus the readers, writers, default
// controllers, and queuing strategies. This is the pure-JS half: it installs the
// standard globals (Node exposes them without a require) and backs
// `require('node:stream/web')`. fetch (js/internal/fetch.js) builds response
// bodies and consumes request bodies through this same ReadableStream type, so
// there is one stream implementation, not a fetch-only fork.
//
// Scope: the default (chunk) ReadableStream
// path is implemented in full — reader, async iteration, tee, cancel, locking,
// desiredSize-driven backpressure, pipeTo, and pipeThrough. WritableStream and
// TransformStream are implemented to the level pipeTo/pipeThrough need (and are
// generally usable). Byte streams / BYOB are deliberately deferred: a
// `type: 'bytes'` source or a `mode: 'byob'` reader throws an explicit error, and
// ReadableStreamBYOBReader exists as a constructor that reports the same. Text
// encoder/decoder streams and (de)compression streams are intentionally not
// provided here.
//
// The implementation lives in js/internal/webstreams/, laid out like node's
// lib/internal/webstreams (util, queuingstrategies, readablestream, writablestream,
// transformstream), so a stack frame names the file node would. This module only
// assembles the public export object and installs the globals.
(function (require, module, _exports) {
  'use strict';

  var readable = require('internal/webstreams/readablestream');
  var writable = require('internal/webstreams/writablestream');
  var transform = require('internal/webstreams/transformstream');
  var strategies = require('internal/webstreams/queuingstrategies');
  var ReadableStream = readable.ReadableStream;
  var ReadableStreamDefaultReader = readable.ReadableStreamDefaultReader;
  var ReadableStreamBYOBReader = readable.ReadableStreamBYOBReader;
  var ReadableStreamDefaultController = readable.ReadableStreamDefaultController;
  var WritableStream = writable.WritableStream;
  var WritableStreamDefaultWriter = writable.WritableStreamDefaultWriter;
  var WritableStreamDefaultController = writable.WritableStreamDefaultController;
  var TransformStream = transform.TransformStream;
  var TransformStreamDefaultController = transform.TransformStreamDefaultController;
  var ByteLengthQueuingStrategy = strategies.ByteLengthQueuingStrategy;
  var CountQueuingStrategy = strategies.CountQueuingStrategy;

  // ---- exports + globals -----------------------------------------------------

  var api = {
    ReadableStream: ReadableStream,
    ReadableStreamDefaultReader: ReadableStreamDefaultReader,
    ReadableStreamBYOBReader: ReadableStreamBYOBReader,
    ReadableStreamDefaultController: ReadableStreamDefaultController,
    WritableStream: WritableStream,
    WritableStreamDefaultWriter: WritableStreamDefaultWriter,
    WritableStreamDefaultController: WritableStreamDefaultController,
    TransformStream: TransformStream,
    TransformStreamDefaultController: TransformStreamDefaultController,
    ByteLengthQueuingStrategy: ByteLengthQueuingStrategy,
    CountQueuingStrategy: CountQueuingStrategy,
  };

  // Internal helpers fetch.js uses to build/feed a response-body stream without
  // duplicating controller plumbing. Not part of the public node:stream/web API.
  api._internal = {
    createReadableStreamWithController: function (sourceHooks, highWaterMark, sizeAlgorithm) {
      var captured = { controller: undefined };
      var stream = new ReadableStream(
        {
          start: function (controller) {
            captured.controller = controller;
            if (sourceHooks && typeof sourceHooks.start === 'function')
              sourceHooks.start(controller);
          },
          pull: sourceHooks && sourceHooks.pull,
          cancel: sourceHooks && sourceHooks.cancel,
        },
        { highWaterMark: highWaterMark, size: sizeAlgorithm },
      );
      captured.stream = stream;
      return captured;
    },
    isReadableStream: function (value) {
      return value instanceof ReadableStream;
    },
  };

  function installGlobal(name, value) {
    if (globalThis[name] === undefined) globalThis[name] = value;
  }
  installGlobal('ReadableStream', ReadableStream);
  installGlobal('ReadableStreamDefaultReader', ReadableStreamDefaultReader);
  installGlobal('ReadableStreamBYOBReader', ReadableStreamBYOBReader);
  installGlobal('ReadableStreamDefaultController', ReadableStreamDefaultController);
  installGlobal('WritableStream', WritableStream);
  installGlobal('WritableStreamDefaultWriter', WritableStreamDefaultWriter);
  installGlobal('WritableStreamDefaultController', WritableStreamDefaultController);
  installGlobal('TransformStream', TransformStream);
  installGlobal('TransformStreamDefaultController', TransformStreamDefaultController);
  installGlobal('ByteLengthQueuingStrategy', ByteLengthQueuingStrategy);
  installGlobal('CountQueuingStrategy', CountQueuingStrategy);

  module.exports = api;
});
