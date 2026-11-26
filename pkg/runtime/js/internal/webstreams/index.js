// Web Streams (WHATWG Streams Standard) — the public ReadableStream /
// WritableStream / TransformStream surface plus the readers, writers, default
// controllers, and queuing strategies. This is the pure-JS half: it installs the
// standard globals on both surfaces and is the export object of
// `require('node:stream/web')` (node/stream/web.js re-exports it unchanged). fetch
// (js/internal/fetch/body.js) builds response bodies and consumes request bodies
// through this same ReadableStream type, so there is one stream implementation, not
// a fetch-only fork.
//
// The globals are installed HERE, not in node/stream/web.js, so the Window surface
// gets them without instantiating a node/ module (cmd/lava/global_surface_test.odin
// global_surface_web_loads_no_node_module). The loader instantiates this file at the
// slot node/stream/web.js used to hold, before fetch, so the install order is the one
// it always was.
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
// The implementation lives beside this file, laid out like node's
// lib/internal/webstreams (util, queuingstrategies, readablestream, writablestream,
// transformstream), so a stack frame names the file node would. This module only
// assembles the export object and installs the globals.
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

  // ---- interface objects + exports -------------------------------------------

  // The interface objects a page sees (internal/native_shape), in Blink's member order
  // and lengths (Chrome 158, tests/web/cases/shape-streams.expected). The
  // implementations above stay what this directory constructs internally.
  var defineInterface = require('internal/native_shape').defineInterface;
  var ArrayPrototypeConcat = require('internal/primordials').ArrayPrototypeConcat;
  var TAIL = ['constructor', '@@toStringTag'];
  function iface(name, impl, length, members, illegal) {
    return defineInterface({
      name: name,
      impl: impl,
      length: length,
      illegal: illegal === true,
      members: ArrayPrototypeConcat(members, TAIL),
    });
  }

  var api = {
    ReadableStream: defineInterface({
      name: 'ReadableStream',
      impl: ReadableStream,
      length: 0,
      members: [
        'locked',
        'cancel:0',
        'getReader:0',
        'pipeThrough:1',
        'pipeTo:1',
        'tee:0',
        'values:0',
        'constructor',
        '@@toStringTag',
        '@@asyncIterator=values',
      ],
    }),
    ReadableStreamDefaultReader: iface(
      'ReadableStreamDefaultReader',
      ReadableStreamDefaultReader,
      1,
      ['closed', 'cancel:0', 'read:0', 'releaseLock:0'],
    ),
    ReadableStreamBYOBReader: iface('ReadableStreamBYOBReader', ReadableStreamBYOBReader, 1, [
      'closed',
      'cancel:0',
      'read:1',
      'releaseLock:0',
    ]),
    ReadableStreamDefaultController: iface(
      'ReadableStreamDefaultController',
      ReadableStreamDefaultController,
      0,
      ['desiredSize', 'close:0', 'enqueue:0', 'error:0'],
      true,
    ),
    WritableStream: iface('WritableStream', WritableStream, 0, [
      'locked',
      'abort:0',
      'close:0',
      'getWriter:0',
    ]),
    WritableStreamDefaultWriter: iface(
      'WritableStreamDefaultWriter',
      WritableStreamDefaultWriter,
      1,
      ['closed', 'desiredSize', 'ready', 'abort:0', 'close:0', 'releaseLock:0', 'write:0'],
    ),
    WritableStreamDefaultController: iface(
      'WritableStreamDefaultController',
      WritableStreamDefaultController,
      0,
      ['signal', 'error:0'],
      true,
    ),
    TransformStream: iface('TransformStream', TransformStream, 0, ['readable', 'writable']),
    TransformStreamDefaultController: iface(
      'TransformStreamDefaultController',
      TransformStreamDefaultController,
      0,
      ['desiredSize', 'enqueue:0', 'error:0', 'terminate:0'],
      true,
    ),
    ByteLengthQueuingStrategy: iface('ByteLengthQueuingStrategy', ByteLengthQueuingStrategy, 1, [
      'highWaterMark',
      'size',
    ]),
    CountQueuingStrategy: iface('CountQueuingStrategy', CountQueuingStrategy, 1, [
      'highWaterMark',
      'size',
    ]),
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

  module.exports = api;
});
