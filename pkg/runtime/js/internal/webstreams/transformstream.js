// TransformStream and its default controller — node's
// lib/internal/webstreams/transformstream.js. Builds its two sides through
// readablestream's and writablestream's internal constructors, both required at top
// level (neither requires this file).
(function (require, module) {
  'use strict';

  var util = require('internal/webstreams/util');
  var extractHighWaterMark = util.extractHighWaterMark;
  var extractSizeAlgorithm = util.extractSizeAlgorithm;
  var newDeferred = util.newDeferred;
  var promiseFrom = util.promiseFrom;
  var promiseRejectedWith = util.promiseRejectedWith;
  var promiseResolvedWith = util.promiseResolvedWith;
  var readable = require('internal/webstreams/readablestream');
  var createReadableStream = readable.createReadableStream;
  var readableStreamDefaultControllerCanCloseOrEnqueue =
    readable.readableStreamDefaultControllerCanCloseOrEnqueue;
  var readableStreamDefaultControllerClose = readable.readableStreamDefaultControllerClose;
  var readableStreamDefaultControllerEnqueue = readable.readableStreamDefaultControllerEnqueue;
  var readableStreamDefaultControllerError = readable.readableStreamDefaultControllerError;
  var readableStreamDefaultControllerGetDesiredSize =
    readable.readableStreamDefaultControllerGetDesiredSize;
  var readableStreamDefaultControllerHasBackpressure =
    readable.readableStreamDefaultControllerHasBackpressure;
  var writable = require('internal/webstreams/writablestream');
  var createWritableStream = writable.createWritableStream;
  var writableStreamDefaultControllerErrorIfNeeded =
    writable.writableStreamDefaultControllerErrorIfNeeded;

  // ============================================================================
  // TransformStream
  // ============================================================================

  class TransformStream {
    constructor(transformer, writableStrategy, readableStrategy) {
      transformer = transformer === undefined ? {} : transformer;
      writableStrategy = writableStrategy === undefined ? {} : writableStrategy;
      readableStrategy = readableStrategy === undefined ? {} : readableStrategy;
      if (transformer.readableType !== undefined) {
        throw new RangeError('Invalid transformer.readableType');
      }
      if (transformer.writableType !== undefined) {
        throw new RangeError('Invalid transformer.writableType');
      }

      var readableHWM = extractHighWaterMark(readableStrategy, 0);
      var readableSize = extractSizeAlgorithm(readableStrategy);
      var writableHWM = extractHighWaterMark(writableStrategy, 1);
      var writableSize = extractSizeAlgorithm(writableStrategy);

      var startDeferred = newDeferred();
      initializeTransformStream(
        this,
        startDeferred.promise,
        writableHWM,
        writableSize,
        readableHWM,
        readableSize,
      );
      setUpTransformStreamDefaultControllerFromTransformer(this, transformer);

      if (typeof transformer.start === 'function') {
        startDeferred.resolve(transformer.start(this._controller));
      } else {
        startDeferred.resolve(undefined);
      }
    }

    get readable() {
      return this._readable;
    }
    get writable() {
      return this._writable;
    }
  }

  function initializeTransformStream(
    stream,
    startPromise,
    writableHWM,
    writableSize,
    readableHWM,
    readableSize,
  ) {
    function startAlgorithm() {
      return startPromise;
    }
    function writeAlgorithm(chunk) {
      return transformStreamDefaultSinkWriteAlgorithm(stream, chunk);
    }
    function abortAlgorithm(reason) {
      return transformStreamDefaultSinkAbortAlgorithm(stream, reason);
    }
    function closeAlgorithm() {
      return transformStreamDefaultSinkCloseAlgorithm(stream);
    }
    stream._writable = createWritableStream(
      startAlgorithm,
      writeAlgorithm,
      closeAlgorithm,
      abortAlgorithm,
      writableHWM,
      writableSize,
    );

    function pullAlgorithm() {
      return transformStreamDefaultSourcePullAlgorithm(stream);
    }
    function cancelAlgorithm(reason) {
      transformStreamErrorWritableAndUnblockWrite(stream, reason);
      return promiseResolvedWith(undefined);
    }
    stream._readable = createReadableStream(
      startAlgorithm,
      pullAlgorithm,
      cancelAlgorithm,
      readableHWM,
      readableSize,
    );

    stream._backpressure = undefined;
    stream._backpressureChangeDeferred = undefined;
    transformStreamSetBackpressure(stream, true);
    stream._controller = undefined;
  }

  function transformStreamErrorWritableAndUnblockWrite(stream, e) {
    transformStreamDefaultControllerClearAlgorithms(stream._controller);
    writableStreamDefaultControllerErrorIfNeeded(stream._writable._controller, e);
    transformStreamUnblockWrite(stream);
  }
  function transformStreamUnblockWrite(stream) {
    if (stream._backpressure) transformStreamSetBackpressure(stream, false);
  }
  function transformStreamError(stream, e) {
    readableStreamDefaultControllerError(stream._readable._controller, e);
    transformStreamErrorWritableAndUnblockWrite(stream, e);
  }
  function transformStreamSetBackpressure(stream, backpressure) {
    if (stream._backpressureChangeDeferred !== undefined) {
      stream._backpressureChangeDeferred.resolve(undefined);
    }
    stream._backpressureChangeDeferred = newDeferred();
    stream._backpressure = backpressure;
  }

  class TransformStreamDefaultController {
    constructor() {
      throw new TypeError('Illegal constructor');
    }
    get desiredSize() {
      return readableStreamDefaultControllerGetDesiredSize(this._stream._readable._controller);
    }
    enqueue(chunk) {
      transformStreamDefaultControllerEnqueue(this, chunk);
    }
    error(reason) {
      transformStreamDefaultControllerError(this, reason);
    }
    terminate() {
      transformStreamDefaultControllerTerminate(this);
    }
  }

  function setUpTransformStreamDefaultController(
    stream,
    controller,
    transformAlgorithm,
    flushAlgorithm,
  ) {
    controller._stream = stream;
    stream._controller = controller;
    controller._transformAlgorithm = transformAlgorithm;
    controller._flushAlgorithm = flushAlgorithm;
  }
  function setUpTransformStreamDefaultControllerFromTransformer(stream, transformer) {
    var controller = Object.create(TransformStreamDefaultController.prototype);
    var transformAlgorithm = function (chunk) {
      try {
        transformStreamDefaultControllerEnqueue(controller, chunk);
        return promiseResolvedWith(undefined);
      } catch (e) {
        return promiseRejectedWith(e);
      }
    };
    var flushAlgorithm = function () {
      return promiseResolvedWith(undefined);
    };
    if (typeof transformer.transform === 'function') {
      transformAlgorithm = function (chunk) {
        return promiseFrom(function () {
          return transformer.transform(chunk, controller);
        });
      };
    }
    if (typeof transformer.flush === 'function') {
      flushAlgorithm = function () {
        return promiseFrom(function () {
          return transformer.flush(controller);
        });
      };
    }
    setUpTransformStreamDefaultController(stream, controller, transformAlgorithm, flushAlgorithm);
  }
  function transformStreamDefaultControllerClearAlgorithms(controller) {
    controller._transformAlgorithm = undefined;
    controller._flushAlgorithm = undefined;
  }
  function transformStreamDefaultControllerEnqueue(controller, chunk) {
    var stream = controller._stream;
    var readableController = stream._readable._controller;
    if (!readableStreamDefaultControllerCanCloseOrEnqueue(readableController)) {
      throw new TypeError('Readable side is not in a state that permits enqueue');
    }
    try {
      readableStreamDefaultControllerEnqueue(readableController, chunk);
    } catch (e) {
      transformStreamErrorWritableAndUnblockWrite(stream, e);
      throw stream._readable._storedError;
    }
    var backpressure = readableStreamDefaultControllerHasBackpressure(readableController);
    if (backpressure !== stream._backpressure) {
      transformStreamSetBackpressure(stream, true);
    }
  }

  function transformStreamDefaultControllerError(controller, e) {
    transformStreamError(controller._stream, e);
  }
  function transformStreamDefaultControllerPerformTransform(controller, chunk) {
    var transformPromise = controller._transformAlgorithm(chunk);
    return transformPromise.then(undefined, function (r) {
      transformStreamError(controller._stream, r);
      throw r;
    });
  }
  function transformStreamDefaultControllerTerminate(controller) {
    var stream = controller._stream;
    var readableController = stream._readable._controller;
    readableStreamDefaultControllerClose(readableController);
    var error = new TypeError('TransformStream terminated');
    transformStreamErrorWritableAndUnblockWrite(stream, error);
  }

  function transformStreamDefaultSinkWriteAlgorithm(stream, chunk) {
    var controller = stream._controller;
    if (stream._backpressure) {
      var backpressureChangePromise = stream._backpressureChangeDeferred.promise;
      return backpressureChangePromise.then(function () {
        var writable = stream._writable;
        var state = writable._state;
        if (state === 'erroring') throw writable._storedError;
        return transformStreamDefaultControllerPerformTransform(controller, chunk);
      });
    }
    return transformStreamDefaultControllerPerformTransform(controller, chunk);
  }
  function transformStreamDefaultSinkAbortAlgorithm(stream, reason) {
    transformStreamError(stream, reason);
    return promiseResolvedWith(undefined);
  }
  function transformStreamDefaultSinkCloseAlgorithm(stream) {
    var controller = stream._controller;
    var flushPromise = controller._flushAlgorithm();
    transformStreamDefaultControllerClearAlgorithms(controller);
    return flushPromise.then(
      function () {
        if (stream._readable._state === 'errored') throw stream._readable._storedError;
        readableStreamDefaultControllerClose(stream._readable._controller);
      },
      function (r) {
        transformStreamError(stream, r);
        throw stream._readable._storedError;
      },
    );
  }
  function transformStreamDefaultSourcePullAlgorithm(stream) {
    transformStreamSetBackpressure(stream, false);
    return stream._backpressureChangeDeferred.promise;
  }

  module.exports = {
    TransformStream: TransformStream,
    TransformStreamDefaultController: TransformStreamDefaultController,
  };
});
