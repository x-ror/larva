// WritableStream, its default writer and controller — node's
// lib/internal/webstreams/writablestream.js. Depends on util only: readablestream (for
// pipeTo) and transformstream require this file, never the other way.
(function (require, module) {
  'use strict';

  var util = require('internal/webstreams/util');
  var dequeueValue = util.dequeueValue;
  var enqueueValueWithSize = util.enqueueValueWithSize;
  var extractHighWaterMark = util.extractHighWaterMark;
  var extractSizeAlgorithm = util.extractSizeAlgorithm;
  var newDeferred = util.newDeferred;
  var noop = util.noop;
  var peekQueueValue = util.peekQueueValue;
  var promiseFrom = util.promiseFrom;
  var promiseRejectedWith = util.promiseRejectedWith;
  var promiseResolvedWith = util.promiseResolvedWith;
  var resetQueue = util.resetQueue;
  var setPromiseIsHandled = util.setPromiseIsHandled;
  var uponPromise = util.uponPromise;

  // ============================================================================
  // WritableStream
  // ============================================================================

  class WritableStream {
    constructor(underlyingSink, strategy) {
      underlyingSink = underlyingSink === undefined ? {} : underlyingSink;
      strategy = strategy === undefined ? {} : strategy;
      if (underlyingSink.type !== undefined) {
        throw new RangeError('Invalid underlyingSink.type');
      }

      this._state = 'writable';
      this._storedError = undefined;
      this._writer = undefined;
      this._controller = undefined;
      this._inFlightWriteRequest = undefined;
      this._closeRequest = undefined;
      this._inFlightCloseRequest = undefined;
      this._pendingAbortRequest = undefined;
      this._writeRequests = [];
      this._backpressure = false;

      var highWaterMark = extractHighWaterMark(strategy, 1);
      var sizeAlgorithm = extractSizeAlgorithm(strategy);
      setUpWritableStreamDefaultControllerFromUnderlyingSink(
        this,
        underlyingSink,
        highWaterMark,
        sizeAlgorithm,
      );
    }

    get locked() {
      return isWritableStreamLocked(this);
    }

    abort(reason) {
      if (isWritableStreamLocked(this)) {
        return promiseRejectedWith(new TypeError('Cannot abort a locked stream'));
      }
      return writableStreamAbort(this, reason);
    }

    close() {
      if (isWritableStreamLocked(this)) {
        return promiseRejectedWith(new TypeError('Cannot close a locked stream'));
      }
      if (writableStreamCloseQueuedOrInFlight(this)) {
        return promiseRejectedWith(new TypeError('Cannot close an already-closing stream'));
      }
      return writableStreamClose(this);
    }

    getWriter() {
      return new WritableStreamDefaultWriter(this);
    }
  }

  function isWritableStreamLocked(stream) {
    return stream._writer !== undefined;
  }

  function writableStreamAbort(stream, reason) {
    if (stream._state === 'closed' || stream._state === 'errored') {
      return promiseResolvedWith(undefined);
    }
    if (stream._pendingAbortRequest !== undefined) {
      return stream._pendingAbortRequest.deferred.promise;
    }
    var wasAlreadyErroring = false;
    if (stream._state === 'erroring') {
      wasAlreadyErroring = true;
      reason = undefined;
    }
    var deferred = newDeferred();
    stream._pendingAbortRequest = {
      deferred: deferred,
      reason: reason,
      wasAlreadyErroring: wasAlreadyErroring,
    };
    if (!wasAlreadyErroring) writableStreamStartErroring(stream, reason);
    return deferred.promise;
  }

  function writableStreamClose(stream) {
    // Spec step 2: a closed/errored stream rejects — its close/write algorithms
    // were already cleared, so falling through would crash on _closeAlgorithm().
    if (stream._state === 'closed' || stream._state === 'errored') {
      return promiseRejectedWith(
        new TypeError('Cannot close a ' + stream._state + ' WritableStream'),
      );
    }
    var deferred = newDeferred();
    stream._closeRequest = deferred;
    var writer = stream._writer;
    if (writer !== undefined && stream._backpressure && stream._state === 'writable') {
      writer._readyDeferred.resolve(undefined);
    }
    writableStreamDefaultControllerClose(stream._controller);
    return deferred.promise;
  }

  function writableStreamCloseQueuedOrInFlight(stream) {
    return stream._closeRequest !== undefined || stream._inFlightCloseRequest !== undefined;
  }

  function writableStreamAddWriteRequest(stream) {
    var deferred = newDeferred();
    stream._writeRequests.push(deferred);
    return deferred.promise;
  }

  function writableStreamDealWithRejection(stream, error) {
    if (stream._state === 'writable') {
      writableStreamStartErroring(stream, error);
      return;
    }
    writableStreamFinishErroring(stream);
  }

  function writableStreamStartErroring(stream, reason) {
    var controller = stream._controller;
    stream._state = 'erroring';
    stream._storedError = reason;
    var writer = stream._writer;
    if (writer !== undefined) {
      writableStreamDefaultWriterEnsureReadyPromiseRejected(writer, reason);
    }
    if (!writableStreamHasOperationMarkedInFlight(stream) && controller._started) {
      writableStreamFinishErroring(stream);
    }
  }

  function writableStreamFinishErroring(stream) {
    stream._state = 'errored';
    resetQueue(stream._controller); // the controller's error steps
    var storedError = stream._storedError;
    var requests = stream._writeRequests;
    stream._writeRequests = [];
    for (var i = 0; i < requests.length; i++) requests[i].reject(storedError);
    if (stream._pendingAbortRequest === undefined) {
      writableStreamRejectCloseAndClosedPromiseIfNeeded(stream);
      return;
    }
    var abortRequest = stream._pendingAbortRequest;
    stream._pendingAbortRequest = undefined;
    if (abortRequest.wasAlreadyErroring) {
      abortRequest.deferred.reject(storedError);
      writableStreamRejectCloseAndClosedPromiseIfNeeded(stream);
      return;
    }
    var promise = writableStreamDefaultControllerAbortSteps(
      stream._controller,
      abortRequest.reason,
    );
    uponPromise(
      promise,
      function () {
        abortRequest.deferred.resolve(undefined);
        writableStreamRejectCloseAndClosedPromiseIfNeeded(stream);
      },
      function (reason) {
        abortRequest.deferred.reject(reason);
        writableStreamRejectCloseAndClosedPromiseIfNeeded(stream);
      },
    );
  }

  function writableStreamFinishInFlightWrite(stream) {
    stream._inFlightWriteRequest.resolve(undefined);
    stream._inFlightWriteRequest = undefined;
  }
  function writableStreamFinishInFlightWriteWithError(stream, error) {
    stream._inFlightWriteRequest.reject(error);
    stream._inFlightWriteRequest = undefined;
    writableStreamDealWithRejection(stream, error);
  }
  function writableStreamFinishInFlightClose(stream) {
    stream._inFlightCloseRequest.resolve(undefined);
    stream._inFlightCloseRequest = undefined;
    if (stream._state === 'erroring') {
      stream._storedError = undefined;
      if (stream._pendingAbortRequest !== undefined) {
        stream._pendingAbortRequest.deferred.resolve(undefined);
        stream._pendingAbortRequest = undefined;
      }
    }
    stream._state = 'closed';
    var writer = stream._writer;
    if (writer !== undefined) writer._closedDeferred.resolve(undefined);
  }
  function writableStreamFinishInFlightCloseWithError(stream, error) {
    stream._inFlightCloseRequest.reject(error);
    stream._inFlightCloseRequest = undefined;
    if (stream._pendingAbortRequest !== undefined) {
      stream._pendingAbortRequest.deferred.reject(error);
      stream._pendingAbortRequest = undefined;
    }
    writableStreamDealWithRejection(stream, error);
  }

  function writableStreamHasOperationMarkedInFlight(stream) {
    return stream._inFlightWriteRequest !== undefined || stream._inFlightCloseRequest !== undefined;
  }
  function writableStreamMarkCloseRequestInFlight(stream) {
    stream._inFlightCloseRequest = stream._closeRequest;
    stream._closeRequest = undefined;
  }
  function writableStreamMarkFirstWriteRequestInFlight(stream) {
    stream._inFlightWriteRequest = stream._writeRequests.shift();
  }
  function writableStreamRejectCloseAndClosedPromiseIfNeeded(stream) {
    if (stream._closeRequest !== undefined) {
      stream._closeRequest.reject(stream._storedError);
      stream._closeRequest = undefined;
    }
    var writer = stream._writer;
    if (writer !== undefined) {
      writer._closedDeferred.reject(stream._storedError);
      setPromiseIsHandled(writer._closedDeferred.promise);
    }
  }
  function writableStreamUpdateBackpressure(stream, backpressure) {
    var writer = stream._writer;
    if (writer !== undefined && backpressure !== stream._backpressure) {
      if (backpressure) {
        writer._readyDeferred = newDeferred();
      } else {
        writer._readyDeferred.resolve(undefined);
      }
    }
    stream._backpressure = backpressure;
  }

  // ---- WritableStreamDefaultWriter -------------------------------------------

  class WritableStreamDefaultWriter {
    constructor(stream) {
      if (!(stream instanceof WritableStream)) {
        throw new TypeError('WritableStreamDefaultWriter requires a WritableStream');
      }
      if (isWritableStreamLocked(stream)) {
        throw new TypeError('WritableStream is already locked to a writer');
      }
      this._ownerWritableStream = stream;
      stream._writer = this;
      this._readyDeferred = newDeferred();
      this._closedDeferred = newDeferred();
      var state = stream._state;
      if (state === 'writable') {
        if (!writableStreamCloseQueuedOrInFlight(stream) && stream._backpressure) {
          // ready stays pending
        } else {
          this._readyDeferred.resolve(undefined);
        }
      } else if (state === 'erroring') {
        this._readyDeferred.reject(stream._storedError);
        setPromiseIsHandled(this._readyDeferred.promise);
      } else if (state === 'closed') {
        this._readyDeferred.resolve(undefined);
        this._closedDeferred.resolve(undefined);
      } else {
        var storedError = stream._storedError;
        this._readyDeferred.reject(storedError);
        setPromiseIsHandled(this._readyDeferred.promise);
        this._closedDeferred.reject(storedError);
        setPromiseIsHandled(this._closedDeferred.promise);
      }
    }

    get closed() {
      if (!this._ownerWritableStream) return promiseRejectedWith(defaultWriterLockException());
      return this._closedDeferred.promise;
    }

    get desiredSize() {
      if (!this._ownerWritableStream) throw defaultWriterLockException();
      return writableStreamDefaultWriterGetDesiredSize(this);
    }

    get ready() {
      if (!this._ownerWritableStream) return promiseRejectedWith(defaultWriterLockException());
      return this._readyDeferred.promise;
    }

    abort(reason) {
      if (!this._ownerWritableStream) return promiseRejectedWith(defaultWriterLockException());
      return writableStreamAbort(this._ownerWritableStream, reason);
    }

    close() {
      var stream = this._ownerWritableStream;
      if (!stream) return promiseRejectedWith(defaultWriterLockException());
      if (writableStreamCloseQueuedOrInFlight(stream)) {
        return promiseRejectedWith(new TypeError('Cannot close an already-closing stream'));
      }
      return writableStreamClose(stream);
    }

    releaseLock() {
      var stream = this._ownerWritableStream;
      if (!stream) return;
      var releasedError = new TypeError(
        'Writer was released and can no longer be used to monitor the stream',
      );
      writableStreamDefaultWriterEnsureReadyPromiseRejected(this, releasedError);
      writableStreamDefaultWriterEnsureClosedPromiseRejected(this, releasedError);
      stream._writer = undefined;
      this._ownerWritableStream = undefined;
    }

    write(chunk) {
      if (!this._ownerWritableStream) return promiseRejectedWith(defaultWriterLockException());
      return writableStreamDefaultWriterWrite(this, chunk);
    }
  }

  function defaultWriterLockException() {
    return new TypeError('Cannot use a released writer');
  }

  function writableStreamDefaultWriterEnsureClosedPromiseRejected(writer, error) {
    if (writer._closedDeferred._resolved) {
      writer._closedDeferred = newDeferred();
    }
    writer._closedDeferred.reject(error);
    setPromiseIsHandled(writer._closedDeferred.promise);
  }
  function writableStreamDefaultWriterEnsureReadyPromiseRejected(writer, error) {
    writer._readyDeferred = newDeferred();
    writer._readyDeferred.reject(error);
    setPromiseIsHandled(writer._readyDeferred.promise);
  }
  function writableStreamDefaultWriterGetDesiredSize(writer) {
    var stream = writer._ownerWritableStream;
    var state = stream._state;
    if (state === 'errored' || state === 'erroring') return null;
    if (state === 'closed') return 0;
    return writableStreamDefaultControllerGetDesiredSize(stream._controller);
  }
  function writableStreamDefaultWriterWrite(writer, chunk) {
    var stream = writer._ownerWritableStream;
    var controller = stream._controller;
    var chunkSize = writableStreamDefaultControllerGetChunkSize(controller, chunk);
    if (stream !== writer._ownerWritableStream) {
      return promiseRejectedWith(defaultWriterLockException());
    }
    var state = stream._state;
    if (state === 'errored') return promiseRejectedWith(stream._storedError);
    if (writableStreamCloseQueuedOrInFlight(stream) || state === 'closed') {
      return promiseRejectedWith(new TypeError('Cannot write to a closing/closed stream'));
    }
    if (state === 'erroring') return promiseRejectedWith(stream._storedError);
    var promise = writableStreamAddWriteRequest(stream);
    writableStreamDefaultControllerWrite(controller, chunk, chunkSize);
    return promise;
  }

  // ---- WritableStreamDefaultController ---------------------------------------

  class WritableStreamDefaultController {
    constructor() {
      throw new TypeError('Illegal constructor');
    }

    get signal() {
      return undefined; // AbortController signal plumbing not exposed.
    }

    error(e) {
      if (this._controlledWritableStream._state !== 'writable') return;
      writableStreamDefaultControllerError(this, e);
    }
  }

  // The controller's abstract "steps", as functions: Chrome's prototype has no such
  // members (tests/web/cases/shape-streams.expected).
  function writableStreamDefaultControllerAbortSteps(controller, reason) {
    var result = controller._abortAlgorithm(reason);
    writableStreamDefaultControllerClearAlgorithms(controller);
    return result;
  }

  function setUpWritableStreamDefaultController(
    stream,
    controller,
    startAlgorithm,
    writeAlgorithm,
    closeAlgorithm,
    abortAlgorithm,
    highWaterMark,
    sizeAlgorithm,
  ) {
    controller._controlledWritableStream = stream;
    stream._controller = controller;
    resetQueue(controller);
    controller._started = false;
    controller._strategySizeAlgorithm = sizeAlgorithm;
    controller._strategyHWM = highWaterMark;
    controller._writeAlgorithm = writeAlgorithm;
    controller._closeAlgorithm = closeAlgorithm;
    controller._abortAlgorithm = abortAlgorithm;
    var backpressure = writableStreamDefaultControllerGetBackpressure(controller);
    writableStreamUpdateBackpressure(stream, backpressure);

    var startResult = startAlgorithm();
    uponPromise(
      promiseResolvedWith(startResult),
      function () {
        controller._started = true;
        writableStreamDefaultControllerAdvanceQueueIfNeeded(controller);
      },
      function (r) {
        controller._started = true;
        writableStreamDealWithRejection(stream, r);
      },
    );
  }

  function setUpWritableStreamDefaultControllerFromUnderlyingSink(
    stream,
    underlyingSink,
    highWaterMark,
    sizeAlgorithm,
  ) {
    var controller = Object.create(WritableStreamDefaultController.prototype);
    var startAlgorithm = noop;
    var writeAlgorithm = function () {
      return promiseResolvedWith(undefined);
    };
    var closeAlgorithm = function () {
      return promiseResolvedWith(undefined);
    };
    var abortAlgorithm = function () {
      return promiseResolvedWith(undefined);
    };
    if (typeof underlyingSink.start === 'function') {
      startAlgorithm = function () {
        return promiseFrom(function () {
          return underlyingSink.start(controller);
        });
      };
    }
    if (typeof underlyingSink.write === 'function') {
      writeAlgorithm = function (chunk) {
        return promiseFrom(function () {
          return underlyingSink.write(chunk, controller);
        });
      };
    }
    if (typeof underlyingSink.close === 'function') {
      closeAlgorithm = function () {
        return promiseFrom(function () {
          return underlyingSink.close();
        });
      };
    }
    if (typeof underlyingSink.abort === 'function') {
      abortAlgorithm = function (reason) {
        return promiseFrom(function () {
          return underlyingSink.abort(reason);
        });
      };
    }
    setUpWritableStreamDefaultController(
      stream,
      controller,
      startAlgorithm,
      writeAlgorithm,
      closeAlgorithm,
      abortAlgorithm,
      highWaterMark,
      sizeAlgorithm,
    );
  }

  var CLOSE_SENTINEL = {};

  function writableStreamDefaultControllerClearAlgorithms(controller) {
    controller._writeAlgorithm = undefined;
    controller._closeAlgorithm = undefined;
    controller._abortAlgorithm = undefined;
    controller._strategySizeAlgorithm = undefined;
  }
  function writableStreamDefaultControllerClose(controller) {
    enqueueValueWithSize(controller, CLOSE_SENTINEL, 0);
    writableStreamDefaultControllerAdvanceQueueIfNeeded(controller);
  }
  function writableStreamDefaultControllerGetChunkSize(controller, chunk) {
    try {
      return controller._strategySizeAlgorithm(chunk);
    } catch (e) {
      writableStreamDefaultControllerErrorIfNeeded(controller, e);
      return 1;
    }
  }
  function writableStreamDefaultControllerGetDesiredSize(controller) {
    return controller._strategyHWM - controller._queueTotalSize;
  }
  function writableStreamDefaultControllerWrite(controller, chunk, chunkSize) {
    try {
      enqueueValueWithSize(controller, chunk, chunkSize);
    } catch (e) {
      writableStreamDefaultControllerErrorIfNeeded(controller, e);
      return;
    }
    var stream = controller._controlledWritableStream;
    if (!writableStreamCloseQueuedOrInFlight(stream) && stream._state === 'writable') {
      var backpressure = writableStreamDefaultControllerGetBackpressure(controller);
      writableStreamUpdateBackpressure(stream, backpressure);
    }
    writableStreamDefaultControllerAdvanceQueueIfNeeded(controller);
  }
  function writableStreamDefaultControllerAdvanceQueueIfNeeded(controller) {
    var stream = controller._controlledWritableStream;
    if (!controller._started) return;
    if (stream._inFlightWriteRequest !== undefined) return;
    var state = stream._state;
    if (state === 'erroring') {
      writableStreamFinishErroring(stream);
      return;
    }
    if (controller._queue.length === 0) return;
    var value = peekQueueValue(controller);
    if (value === CLOSE_SENTINEL) {
      writableStreamDefaultControllerProcessClose(controller);
    } else {
      writableStreamDefaultControllerProcessWrite(controller, value);
    }
  }
  function writableStreamDefaultControllerErrorIfNeeded(controller, error) {
    if (controller._controlledWritableStream._state === 'writable') {
      writableStreamDefaultControllerError(controller, error);
    }
  }
  function writableStreamDefaultControllerProcessClose(controller) {
    var stream = controller._controlledWritableStream;
    writableStreamMarkCloseRequestInFlight(stream);
    dequeueValue(controller);
    var sinkClosePromise = controller._closeAlgorithm();
    writableStreamDefaultControllerClearAlgorithms(controller);
    uponPromise(
      sinkClosePromise,
      function () {
        writableStreamFinishInFlightClose(stream);
      },
      function (reason) {
        writableStreamFinishInFlightCloseWithError(stream, reason);
      },
    );
  }
  function writableStreamDefaultControllerProcessWrite(controller, chunk) {
    var stream = controller._controlledWritableStream;
    writableStreamMarkFirstWriteRequestInFlight(stream);
    var sinkWritePromise = controller._writeAlgorithm(chunk);
    uponPromise(
      sinkWritePromise,
      function () {
        writableStreamFinishInFlightWrite(stream);
        var state = stream._state;
        dequeueValue(controller);
        if (!writableStreamCloseQueuedOrInFlight(stream) && state === 'writable') {
          var backpressure = writableStreamDefaultControllerGetBackpressure(controller);
          writableStreamUpdateBackpressure(stream, backpressure);
        }
        writableStreamDefaultControllerAdvanceQueueIfNeeded(controller);
      },
      function (reason) {
        if (stream._state === 'writable') {
          writableStreamDefaultControllerClearAlgorithms(controller);
        }
        writableStreamFinishInFlightWriteWithError(stream, reason);
      },
    );
  }
  function writableStreamDefaultControllerGetBackpressure(controller) {
    return writableStreamDefaultControllerGetDesiredSize(controller) <= 0;
  }
  function writableStreamDefaultControllerError(controller, error) {
    var stream = controller._controlledWritableStream;
    writableStreamDefaultControllerClearAlgorithms(controller);
    writableStreamStartErroring(stream, error);
  }

  function writableStreamDefaultWriterRelease(writer) {
    if (writer._ownerWritableStream) writer.releaseLock();
  }
  function writableStreamDefaultWriterCloseWithErrorPropagation(writer) {
    var stream = writer._ownerWritableStream;
    var state = stream._state;
    if (writableStreamCloseQueuedOrInFlight(stream) || state === 'closed') {
      return promiseResolvedWith(undefined);
    }
    if (state === 'errored') return promiseRejectedWith(stream._storedError);
    return writableStreamClose(stream);
  }

  function createWritableStream(
    startAlgorithm,
    writeAlgorithm,
    closeAlgorithm,
    abortAlgorithm,
    highWaterMark,
    sizeAlgorithm,
  ) {
    var stream = Object.create(WritableStream.prototype);
    stream._state = 'writable';
    stream._storedError = undefined;
    stream._writer = undefined;
    stream._controller = undefined;
    stream._inFlightWriteRequest = undefined;
    stream._closeRequest = undefined;
    stream._inFlightCloseRequest = undefined;
    stream._pendingAbortRequest = undefined;
    stream._writeRequests = [];
    stream._backpressure = false;
    var controller = Object.create(WritableStreamDefaultController.prototype);
    setUpWritableStreamDefaultController(
      stream,
      controller,
      startAlgorithm,
      writeAlgorithm,
      closeAlgorithm,
      abortAlgorithm,
      highWaterMark,
      sizeAlgorithm,
    );
    return stream;
  }

  module.exports = {
    WritableStream: WritableStream,
    WritableStreamDefaultWriter: WritableStreamDefaultWriter,
    WritableStreamDefaultController: WritableStreamDefaultController,
    isWritableStreamLocked: isWritableStreamLocked,
    writableStreamAbort: writableStreamAbort,
    writableStreamCloseQueuedOrInFlight: writableStreamCloseQueuedOrInFlight,
    writableStreamDefaultWriterCloseWithErrorPropagation:
      writableStreamDefaultWriterCloseWithErrorPropagation,
    writableStreamDefaultWriterRelease: writableStreamDefaultWriterRelease,
    writableStreamDefaultWriterWrite: writableStreamDefaultWriterWrite,
    createWritableStream: createWritableStream,
    writableStreamDefaultControllerErrorIfNeeded: writableStreamDefaultControllerErrorIfNeeded,
  };
});
