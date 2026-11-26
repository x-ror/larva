// ReadableStream, its default reader and controller, tee, async iteration, pipeTo and
// the deferred BYOB reader — node's lib/internal/webstreams/readablestream.js, which
// also keeps pipeTo here. pipeTo drives a WritableStream, so this file requires
// writablestream at its top level; writablestream never requires back, so there is no
// cycle to late-bind.
(function (require, module) {
  'use strict';

  var util = require('internal/webstreams/util');
  var illegalInvocation = require('internal/web_errors').illegalInvocation;
  var dequeueValue = util.dequeueValue;
  var enqueueMicrotask = util.enqueueMicrotask;
  var enqueueValueWithSize = util.enqueueValueWithSize;
  var extractHighWaterMark = util.extractHighWaterMark;
  var extractSizeAlgorithm = util.extractSizeAlgorithm;
  var newDeferred = util.newDeferred;
  var newPromise = util.newPromise;
  var noop = util.noop;
  var promiseFrom = util.promiseFrom;
  var promiseRejectedWith = util.promiseRejectedWith;
  var promiseResolvedWith = util.promiseResolvedWith;
  var resetQueue = util.resetQueue;
  var setPromiseIsHandled = util.setPromiseIsHandled;
  var uponPromise = util.uponPromise;
  var writable = require('internal/webstreams/writablestream');
  var WritableStream = writable.WritableStream;
  var WritableStreamDefaultWriter = writable.WritableStreamDefaultWriter;
  var isWritableStreamLocked = writable.isWritableStreamLocked;
  var writableStreamAbort = writable.writableStreamAbort;
  var writableStreamCloseQueuedOrInFlight = writable.writableStreamCloseQueuedOrInFlight;
  var writableStreamDefaultWriterCloseWithErrorPropagation =
    writable.writableStreamDefaultWriterCloseWithErrorPropagation;
  var writableStreamDefaultWriterRelease = writable.writableStreamDefaultWriterRelease;
  var writableStreamDefaultWriterWrite = writable.writableStreamDefaultWriterWrite;

  // ============================================================================
  // ReadableStream
  // ============================================================================

  class ReadableStream {
    constructor(underlyingSource, strategy) {
      underlyingSource = underlyingSource === undefined ? {} : underlyingSource;
      strategy = strategy === undefined ? {} : strategy;

      this._state = 'readable';
      this._storedError = undefined;
      this._reader = undefined;
      this._disturbed = false;
      this._controller = undefined;

      // Byte sources (BYOB) are deferred. Keep the rejection explicit rather than
      // silently treating a byte stream as a default stream.
      if (underlyingSource.type !== undefined) {
        if (String(underlyingSource.type) === 'bytes') {
          throw new TypeError(
            "ReadableStream byte sources (underlyingSource.type 'bytes') are not " +
              'supported in Lava yet',
          );
        }
        throw new RangeError('Invalid underlyingSource.type');
      }

      var highWaterMark = extractHighWaterMark(strategy, 1);
      var sizeAlgorithm = extractSizeAlgorithm(strategy);
      setUpReadableStreamDefaultControllerFromUnderlyingSource(
        this,
        underlyingSource,
        highWaterMark,
        sizeAlgorithm,
      );
    }

    get locked() {
      return isReadableStreamLocked(this);
    }

    cancel(reason) {
      if (isReadableStreamLocked(this)) {
        return promiseRejectedWith(new TypeError('Cannot cancel a locked stream'));
      }
      return readableStreamCancel(this, reason);
    }

    getReader(options) {
      if (options && options.mode !== undefined) {
        if (String(options.mode) === 'byob') {
          throw new TypeError(
            'BYOB readers are not supported in Lava yet (this stream is not a byte stream)',
          );
        }
        throw new TypeError('Invalid reader mode');
      }
      return new ReadableStreamDefaultReader(this);
    }

    pipeThrough(transform, options) {
      if (!transform || !(transform.writable instanceof WritableStream)) {
        throw new TypeError('pipeThrough requires a { writable, readable } pair');
      }
      if (!(transform.readable instanceof ReadableStream)) {
        throw new TypeError('pipeThrough requires a { writable, readable } pair');
      }
      if (isReadableStreamLocked(this)) {
        throw new TypeError('Cannot pipe a locked stream');
      }
      if (isWritableStreamLocked(transform.writable)) {
        throw new TypeError('Cannot pipe to a locked writable');
      }
      options = options || {};
      var promise = readableStreamPipeTo(
        this,
        transform.writable,
        !!options.preventClose,
        !!options.preventAbort,
        !!options.preventCancel,
        options.signal,
      );
      setPromiseIsHandled(promise);
      return transform.readable;
    }

    pipeTo(destination, options) {
      if (!(destination instanceof WritableStream)) {
        return promiseRejectedWith(new TypeError('pipeTo requires a WritableStream destination'));
      }
      if (isReadableStreamLocked(this)) {
        return promiseRejectedWith(new TypeError('Cannot pipe a locked stream'));
      }
      if (isWritableStreamLocked(destination)) {
        return promiseRejectedWith(new TypeError('Cannot pipe to a locked writable'));
      }
      options = options || {};
      return readableStreamPipeTo(
        this,
        destination,
        !!options.preventClose,
        !!options.preventAbort,
        !!options.preventCancel,
        options.signal,
      );
    }

    tee() {
      return readableStreamDefaultTee(this);
    }

    values(options) {
      return acquireReadableStreamAsyncIterator(this, options && options.preventCancel);
    }

    [Symbol.asyncIterator](options) {
      return acquireReadableStreamAsyncIterator(this, options && options.preventCancel);
    }
  }

  function isReadableStreamLocked(stream) {
    return stream._reader !== undefined;
  }

  function readableStreamCancel(stream, reason) {
    stream._disturbed = true;
    if (stream._state === 'closed') return promiseResolvedWith(undefined);
    if (stream._state === 'errored') return promiseRejectedWith(stream._storedError);
    readableStreamClose(stream);
    var sourceCancelPromise = readableStreamDefaultControllerCancelSteps(
      stream._controller,
      reason,
    );
    return sourceCancelPromise.then(noop);
  }

  function readableStreamClose(stream) {
    stream._state = 'closed';
    var reader = stream._reader;
    if (reader === undefined) return;
    reader._closedDeferred.resolve(undefined);
    if (reader._readRequests !== undefined) {
      var requests = reader._readRequests;
      reader._readRequests = [];
      for (var i = 0; i < requests.length; i++) requests[i].closeSteps();
    }
  }

  function readableStreamError(stream, e) {
    stream._state = 'errored';
    stream._storedError = e;
    var reader = stream._reader;
    if (reader === undefined) return;
    reader._closedDeferred.reject(e);
    setPromiseIsHandled(reader._closedDeferred.promise);
    if (reader._readRequests !== undefined) {
      var requests = reader._readRequests;
      reader._readRequests = [];
      for (var i = 0; i < requests.length; i++) requests[i].errorSteps(e);
    }
  }

  function readableStreamAddReadRequest(stream, readRequest) {
    stream._reader._readRequests.push(readRequest);
  }
  function readableStreamFulfillReadRequest(stream, chunk, done) {
    var readRequest = stream._reader._readRequests.shift();
    if (done) readRequest.closeSteps();
    else readRequest.chunkSteps(chunk);
  }
  function readableStreamGetNumReadRequests(stream) {
    return stream._reader._readRequests.length;
  }

  // ---- ReadableStreamDefaultReader -------------------------------------------

  class ReadableStreamDefaultReader {
    constructor(stream) {
      if (!(stream instanceof ReadableStream)) {
        throw new TypeError('ReadableStreamDefaultReader requires a ReadableStream');
      }
      if (isReadableStreamLocked(stream)) {
        throw new TypeError('ReadableStream is already locked to a reader');
      }
      readableStreamReaderGenericInitialize(this, stream);
      this._readRequests = [];
    }

    get closed() {
      if (!this._ownerReadableStream) {
        return promiseRejectedWith(readerLockException('closed'));
      }
      return this._closedDeferred.promise;
    }

    read() {
      if (!this._ownerReadableStream) {
        return promiseRejectedWith(readerLockException('read from'));
      }
      var deferred = newDeferred();
      var readRequest = {
        chunkSteps: function (chunk) {
          deferred.resolve({ value: chunk, done: false });
        },
        closeSteps: function () {
          deferred.resolve({ value: undefined, done: true });
        },
        errorSteps: function (e) {
          deferred.reject(e);
        },
      };
      readableStreamDefaultReaderRead(this, readRequest);
      return deferred.promise;
    }

    releaseLock() {
      if (!this._ownerReadableStream) return;
      readableStreamDefaultReaderRelease(this);
    }

    cancel(reason) {
      if (!this._ownerReadableStream) {
        return promiseRejectedWith(readerLockException('cancel'));
      }
      return readableStreamReaderGenericCancel(this, reason);
    }
  }

  function readerLockException(name) {
    return new TypeError('Cannot ' + name + ' a stream using a released reader');
  }

  function readableStreamReaderGenericInitialize(reader, stream) {
    reader._ownerReadableStream = stream;
    stream._reader = reader;
    reader._closedDeferred = newDeferred();
    if (stream._state === 'readable') {
      // pending
    } else if (stream._state === 'closed') {
      reader._closedDeferred.resolve(undefined);
    } else {
      reader._closedDeferred.reject(stream._storedError);
      setPromiseIsHandled(reader._closedDeferred.promise);
    }
  }

  function readableStreamReaderGenericCancel(reader, reason) {
    return readableStreamCancel(reader._ownerReadableStream, reason);
  }

  function readableStreamReaderGenericRelease(reader) {
    var stream = reader._ownerReadableStream;
    if (stream._state === 'readable') {
      reader._closedDeferred.reject(readerLockException('release a reader on'));
    } else {
      reader._closedDeferred = newDeferred();
      reader._closedDeferred.reject(readerLockException('release a reader on'));
    }
    setPromiseIsHandled(reader._closedDeferred.promise);
    // The default controller's release steps are empty: it keeps its queue.
    stream._reader = undefined;
    reader._ownerReadableStream = undefined;
  }

  function readableStreamDefaultReaderRelease(reader) {
    readableStreamReaderGenericRelease(reader);
    var e = readerLockException('read from');
    var requests = reader._readRequests;
    reader._readRequests = [];
    for (var i = 0; i < requests.length; i++) requests[i].errorSteps(e);
  }

  function readableStreamDefaultReaderRead(reader, readRequest) {
    var stream = reader._ownerReadableStream;
    stream._disturbed = true;
    if (stream._state === 'closed') {
      readRequest.closeSteps();
    } else if (stream._state === 'errored') {
      readRequest.errorSteps(stream._storedError);
    } else {
      readableStreamDefaultControllerPullSteps(stream._controller, readRequest);
    }
  }

  function acquireReadableStreamDefaultReader(stream) {
    return new ReadableStreamDefaultReader(stream);
  }

  // ---- ReadableStreamDefaultController ---------------------------------------

  class ReadableStreamDefaultController {
    constructor() {
      throw new TypeError('Illegal constructor');
    }

    get desiredSize() {
      return readableStreamDefaultControllerGetDesiredSize(this);
    }

    close() {
      if (!readableStreamDefaultControllerCanCloseOrEnqueue(this)) {
        throw new TypeError('Cannot close a stream that is already closing or not readable');
      }
      readableStreamDefaultControllerClose(this);
    }

    enqueue(chunk) {
      if (!readableStreamDefaultControllerCanCloseOrEnqueue(this)) {
        throw new TypeError('Cannot enqueue a chunk into a stream that is closing or not readable');
      }
      readableStreamDefaultControllerEnqueue(this, chunk);
    }

    error(e) {
      readableStreamDefaultControllerError(this, e);
    }
  }

  // The controller's abstract "steps" the stream and reader call. Functions, not
  // methods: a page reads every own key of ReadableStreamDefaultController.prototype,
  // and Chrome's has none of these (tests/web/cases/shape-streams.expected).
  function readableStreamDefaultControllerCancelSteps(controller, reason) {
    resetQueue(controller);
    var result = controller._cancelAlgorithm(reason);
    readableStreamDefaultControllerClearAlgorithms(controller);
    return result;
  }

  function readableStreamDefaultControllerPullSteps(controller, readRequest) {
    var stream = controller._controlledReadableStream;
    if (controller._queue.length > 0) {
      var chunk = dequeueValue(controller);
      if (controller._closeRequested && controller._queue.length === 0) {
        readableStreamDefaultControllerClearAlgorithms(controller);
        readableStreamClose(stream);
      } else {
        readableStreamDefaultControllerCallPullIfNeeded(controller);
      }
      readRequest.chunkSteps(chunk);
    } else {
      readableStreamAddReadRequest(stream, readRequest);
      readableStreamDefaultControllerCallPullIfNeeded(controller);
    }
  }

  function readableStreamDefaultControllerCallPullIfNeeded(controller) {
    if (!readableStreamDefaultControllerShouldCallPull(controller)) return;
    if (controller._pulling) {
      controller._pullAgain = true;
      return;
    }
    controller._pulling = true;
    var pullPromise = controller._pullAlgorithm();
    uponPromise(
      pullPromise,
      function () {
        controller._pulling = false;
        if (controller._pullAgain) {
          controller._pullAgain = false;
          readableStreamDefaultControllerCallPullIfNeeded(controller);
        }
      },
      function (e) {
        readableStreamDefaultControllerError(controller, e);
      },
    );
  }

  function readableStreamDefaultControllerShouldCallPull(controller) {
    var stream = controller._controlledReadableStream;
    if (!readableStreamDefaultControllerCanCloseOrEnqueue(controller)) return false;
    if (!controller._started) return false;
    if (isReadableStreamLocked(stream) && readableStreamGetNumReadRequests(stream) > 0) return true;
    return readableStreamDefaultControllerGetDesiredSize(controller) > 0;
  }

  function readableStreamDefaultControllerClearAlgorithms(controller) {
    controller._pullAlgorithm = undefined;
    controller._cancelAlgorithm = undefined;
    controller._strategySizeAlgorithm = undefined;
  }

  function readableStreamDefaultControllerClose(controller) {
    if (!readableStreamDefaultControllerCanCloseOrEnqueue(controller)) return;
    var stream = controller._controlledReadableStream;
    controller._closeRequested = true;
    if (controller._queue.length === 0) {
      readableStreamDefaultControllerClearAlgorithms(controller);
      readableStreamClose(stream);
    }
  }

  function readableStreamDefaultControllerEnqueue(controller, chunk) {
    if (!readableStreamDefaultControllerCanCloseOrEnqueue(controller)) return;
    var stream = controller._controlledReadableStream;
    if (isReadableStreamLocked(stream) && readableStreamGetNumReadRequests(stream) > 0) {
      readableStreamFulfillReadRequest(stream, chunk, false);
    } else {
      var chunkSize;
      try {
        chunkSize = controller._strategySizeAlgorithm(chunk);
      } catch (e) {
        readableStreamDefaultControllerError(controller, e);
        throw e;
      }
      try {
        enqueueValueWithSize(controller, chunk, chunkSize);
      } catch (e) {
        readableStreamDefaultControllerError(controller, e);
        throw e;
      }
    }
    readableStreamDefaultControllerCallPullIfNeeded(controller);
  }

  function readableStreamDefaultControllerError(controller, e) {
    var stream = controller._controlledReadableStream;
    if (stream._state !== 'readable') return;
    resetQueue(controller);
    readableStreamDefaultControllerClearAlgorithms(controller);
    readableStreamError(stream, e);
  }

  function readableStreamDefaultControllerGetDesiredSize(controller) {
    var state = controller._controlledReadableStream._state;
    if (state === 'errored') return null;
    if (state === 'closed') return 0;
    return controller._strategyHWM - controller._queueTotalSize;
  }

  function readableStreamDefaultControllerCanCloseOrEnqueue(controller) {
    return (
      !controller._closeRequested && controller._controlledReadableStream._state === 'readable'
    );
  }

  function setUpReadableStreamDefaultController(
    stream,
    controller,
    startAlgorithm,
    pullAlgorithm,
    cancelAlgorithm,
    highWaterMark,
    sizeAlgorithm,
  ) {
    controller._controlledReadableStream = stream;
    resetQueue(controller);
    controller._started = false;
    controller._closeRequested = false;
    controller._pullAgain = false;
    controller._pulling = false;
    controller._strategySizeAlgorithm = sizeAlgorithm;
    controller._strategyHWM = highWaterMark;
    controller._pullAlgorithm = pullAlgorithm;
    controller._cancelAlgorithm = cancelAlgorithm;
    stream._controller = controller;

    var startResult = startAlgorithm();
    uponPromise(
      promiseResolvedWith(startResult),
      function () {
        controller._started = true;
        readableStreamDefaultControllerCallPullIfNeeded(controller);
      },
      function (r) {
        readableStreamDefaultControllerError(controller, r);
      },
    );
  }

  function setUpReadableStreamDefaultControllerFromUnderlyingSource(
    stream,
    underlyingSource,
    highWaterMark,
    sizeAlgorithm,
  ) {
    var controller = Object.create(ReadableStreamDefaultController.prototype);
    var startAlgorithm = noop;
    var pullAlgorithm = function () {
      return promiseResolvedWith(undefined);
    };
    var cancelAlgorithm = function () {
      return promiseResolvedWith(undefined);
    };
    if (typeof underlyingSource.start === 'function') {
      startAlgorithm = function () {
        return promiseFrom(function () {
          return underlyingSource.start(controller);
        });
      };
    }
    if (typeof underlyingSource.pull === 'function') {
      pullAlgorithm = function () {
        return promiseFrom(function () {
          return underlyingSource.pull(controller);
        });
      };
    }
    if (typeof underlyingSource.cancel === 'function') {
      cancelAlgorithm = function (reason) {
        return promiseFrom(function () {
          return underlyingSource.cancel(reason);
        });
      };
    }
    setUpReadableStreamDefaultController(
      stream,
      controller,
      startAlgorithm,
      pullAlgorithm,
      cancelAlgorithm,
      highWaterMark,
      sizeAlgorithm,
    );
  }

  // createReadableStream builds a stream from internal algorithms (used by tee).
  function createReadableStream(
    startAlgorithm,
    pullAlgorithm,
    cancelAlgorithm,
    highWaterMark,
    sizeAlgorithm,
  ) {
    var stream = Object.create(ReadableStream.prototype);
    stream._state = 'readable';
    stream._storedError = undefined;
    stream._reader = undefined;
    stream._disturbed = false;
    stream._controller = undefined;
    var controller = Object.create(ReadableStreamDefaultController.prototype);
    setUpReadableStreamDefaultController(
      stream,
      controller,
      startAlgorithm,
      pullAlgorithm,
      cancelAlgorithm,
      highWaterMark === undefined ? 1 : highWaterMark,
      sizeAlgorithm ||
        function () {
          return 1;
        },
    );
    return stream;
  }

  // ---- tee (default) ---------------------------------------------------------

  function readableStreamDefaultTee(stream) {
    var reader = acquireReadableStreamDefaultReader(stream);
    var reading = false;
    var readAgainForBranch1 = false;
    var readAgainForBranch2 = false;
    var canceled1 = false;
    var canceled2 = false;
    var reason1, reason2;
    var branch1, branch2;
    var cancelDeferred = newDeferred();

    function pullAlgorithm() {
      if (reading) {
        readAgainForBranch1 = true;
        readAgainForBranch2 = true;
        return promiseResolvedWith(undefined);
      }
      reading = true;
      var readRequest = {
        chunkSteps: function (chunk) {
          enqueueMicrotask(function () {
            readAgainForBranch1 = false;
            readAgainForBranch2 = false;
            if (!canceled1) readableStreamDefaultControllerEnqueue(branch1._controller, chunk);
            if (!canceled2) readableStreamDefaultControllerEnqueue(branch2._controller, chunk);
            reading = false;
            if (readAgainForBranch1) pullAlgorithm();
            else if (readAgainForBranch2) pullAlgorithm();
          });
        },
        closeSteps: function () {
          reading = false;
          if (!canceled1) readableStreamDefaultControllerClose(branch1._controller);
          if (!canceled2) readableStreamDefaultControllerClose(branch2._controller);
          if (!canceled1 || !canceled2) cancelDeferred.resolve(undefined);
        },
        errorSteps: function () {
          reading = false;
        },
      };
      readableStreamDefaultReaderRead(reader, readRequest);
      return promiseResolvedWith(undefined);
    }

    function cancel1Algorithm(reason) {
      canceled1 = true;
      reason1 = reason;
      if (canceled2) {
        var composite = [reason1, reason2];
        var cancelResult = readableStreamCancel(stream, composite);
        cancelDeferred.resolve(cancelResult);
      }
      return cancelDeferred.promise;
    }
    function cancel2Algorithm(reason) {
      canceled2 = true;
      reason2 = reason;
      if (canceled1) {
        var composite = [reason1, reason2];
        var cancelResult = readableStreamCancel(stream, composite);
        cancelDeferred.resolve(cancelResult);
      }
      return cancelDeferred.promise;
    }

    branch1 = createReadableStream(noop, pullAlgorithm, cancel1Algorithm);
    branch2 = createReadableStream(noop, pullAlgorithm, cancel2Algorithm);

    uponPromise(reader._closedDeferred.promise, undefined, function (e) {
      readableStreamDefaultControllerError(branch1._controller, e);
      readableStreamDefaultControllerError(branch2._controller, e);
      if (!canceled1 || !canceled2) cancelDeferred.resolve(undefined);
    });

    return [branch1, branch2];
  }

  // ---- async iterator --------------------------------------------------------

  function acquireReadableStreamAsyncIterator(stream, preventCancel) {
    var reader = acquireReadableStreamDefaultReader(stream);
    var iterator = Object.create(ReadableStreamAsyncIteratorPrototype);
    iterator._reader = reader;
    iterator._preventCancel = !!preventCancel;
    return iterator;
  }

  var ReadableStreamAsyncIteratorPrototype = {
    next: function () {
      var reader = this._reader;
      if (!reader._ownerReadableStream) {
        return promiseRejectedWith(readerLockException('iterate'));
      }
      var deferred = newDeferred();
      var readRequest = {
        chunkSteps: function (chunk) {
          deferred.resolve({ value: chunk, done: false });
        },
        closeSteps: function () {
          readableStreamDefaultReaderRelease(reader);
          deferred.resolve({ value: undefined, done: true });
        },
        errorSteps: function (e) {
          readableStreamDefaultReaderRelease(reader);
          deferred.reject(e);
        },
      };
      readableStreamDefaultReaderRead(reader, readRequest);
      return deferred.promise;
    },
    return: function (value) {
      var reader = this._reader;
      if (!reader._ownerReadableStream) {
        return promiseResolvedWith({ value: value, done: true });
      }
      if (reader._readRequests.length > 0) {
        return promiseRejectedWith(
          new TypeError('Tried to release a reader lock when that reader has pending read calls'),
        );
      }
      if (!this._preventCancel) {
        var result = readableStreamReaderGenericCancel(reader, value);
        readableStreamDefaultReaderRelease(reader);
        return result.then(function () {
          return { value: value, done: true };
        });
      }
      readableStreamDefaultReaderRelease(reader);
      return promiseResolvedWith({ value: value, done: true });
    },
  };
  ReadableStreamAsyncIteratorPrototype[Symbol.asyncIterator] = function () {
    return this;
  };

  // ---- pipeTo ----------------------------------------------------------------

  function readableStreamPipeTo(source, dest, preventClose, preventAbort, preventCancel, signal) {
    var reader = acquireReadableStreamDefaultReader(source);
    var writer = new WritableStreamDefaultWriter(dest);
    source._disturbed = true;
    var shuttingDown = false;
    var currentWrite = promiseResolvedWith(undefined);
    var resultDeferred = newDeferred();

    var abortAlgorithm;
    if (signal !== undefined && signal !== null) {
      abortAlgorithm = function () {
        var error =
          signal.reason !== undefined ? signal.reason : new DOMExceptionLike('AbortError');
        var actions = [];
        if (!preventAbort) {
          actions.push(function () {
            if (dest._state === 'writable') return writableStreamAbort(dest, error);
            return promiseResolvedWith(undefined);
          });
        }
        if (!preventCancel) {
          actions.push(function () {
            if (source._state === 'readable') return readableStreamCancel(source, error);
            return promiseResolvedWith(undefined);
          });
        }
        shutdownWithAction(
          function () {
            return Promise.all(
              actions.map(function (a) {
                return a();
              }),
            );
          },
          true,
          error,
        );
      };
      if (signal.aborted) {
        abortAlgorithm();
        return resultDeferred.promise;
      }
      signal.addEventListener('abort', abortAlgorithm);
    }

    function isOrBecomesErrored(stream, promise, action) {
      if (stream._state === 'errored') action(stream._storedError);
      else uponPromise(promise, undefined, action);
    }
    function isOrBecomesClosed(stream, promise, action) {
      if (stream._state === 'closed') action();
      else uponPromise(promise, action, undefined);
    }

    // Error/close forwarding.
    isOrBecomesErrored(source, reader._closedDeferred.promise, function (storedError) {
      if (!preventAbort) {
        shutdownWithAction(
          function () {
            return writableStreamAbort(dest, storedError);
          },
          true,
          storedError,
        );
      } else {
        shutdown(true, storedError);
      }
    });
    isOrBecomesErrored(dest, writer._closedDeferred.promise, function (storedError) {
      if (!preventCancel) {
        shutdownWithAction(
          function () {
            return readableStreamCancel(source, storedError);
          },
          true,
          storedError,
        );
      } else {
        shutdown(true, storedError);
      }
    });
    isOrBecomesClosed(source, reader._closedDeferred.promise, function () {
      if (!preventClose) {
        shutdownWithAction(function () {
          return writableStreamDefaultWriterCloseWithErrorPropagation(writer);
        });
      } else {
        shutdown();
      }
    });
    if (writableStreamCloseQueuedOrInFlight(dest) || dest._state === 'closed') {
      var destClosed = new TypeError(
        'the destination writable stream closed before all data was piped to it',
      );
      if (!preventCancel) {
        shutdownWithAction(
          function () {
            return readableStreamCancel(source, destClosed);
          },
          true,
          destClosed,
        );
      } else {
        shutdown(true, destClosed);
      }
    }

    function pipeLoop() {
      return newPromise(function (resolveLoop, rejectLoop) {
        function next(done) {
          if (done) resolveLoop(undefined);
          else uponPromise(pipeStep(), next, rejectLoop);
        }
        next(false);
      });
    }

    function pipeStep() {
      if (shuttingDown) return promiseResolvedWith(true);
      return writer._readyDeferred.promise.then(function () {
        return newPromise(function (resolveRead, rejectRead) {
          readableStreamDefaultReaderRead(reader, {
            chunkSteps: function (chunk) {
              // Swallow a write rejection here: pipe write errors surface through
              // the dest-errored forwarding (writer.closed), and waitForWrites-
              // ToFinish must observe a never-rejecting currentWrite (spec).
              currentWrite = writableStreamDefaultWriterWrite(writer, chunk).then(undefined, noop);
              resolveRead(false);
            },
            closeSteps: function () {
              resolveRead(true);
            },
            errorSteps: rejectRead,
          });
        });
      });
    }

    uponPromise(pipeLoop(), undefined, noop);

    function waitForWritesToFinish() {
      var oldCurrentWrite = currentWrite;
      return currentWrite.then(function () {
        return oldCurrentWrite !== currentWrite ? waitForWritesToFinish() : undefined;
      });
    }

    function shutdownWithAction(action, originalIsError, originalError) {
      if (shuttingDown) return;
      shuttingDown = true;
      if (dest._state === 'writable' && !writableStreamCloseQueuedOrInFlight(dest)) {
        uponPromise(waitForWritesToFinish(), doTheRest);
      } else {
        doTheRest();
      }
      function doTheRest() {
        uponPromise(
          action(),
          function () {
            finalize(originalIsError, originalError);
          },
          function (newError) {
            finalize(true, newError);
          },
        );
      }
    }

    function shutdown(isError, error) {
      if (shuttingDown) return;
      shuttingDown = true;
      if (dest._state === 'writable' && !writableStreamCloseQueuedOrInFlight(dest)) {
        uponPromise(waitForWritesToFinish(), function () {
          finalize(isError, error);
        });
      } else {
        finalize(isError, error);
      }
    }

    function finalize(isError, error) {
      writableStreamDefaultWriterRelease(writer);
      readableStreamDefaultReaderRelease(reader);
      if (signal !== undefined && signal !== null) {
        signal.removeEventListener('abort', abortAlgorithm);
      }
      if (isError) resultDeferred.reject(error);
      else resultDeferred.resolve(undefined);
    }

    return resultDeferred.promise;
  }

  // A tiny stand-in for AbortError when a signal has no reason. Real AbortSignal
  // (js/internal/abort.js) supplies a DOMException reason, so this is only a
  // fallback for hand-rolled signals.
  function DOMExceptionLike(name) {
    var e = new Error(name);
    e.name = name;
    return e;
  }

  function readableStreamDefaultControllerHasBackpressure(controller) {
    return readableStreamDefaultControllerGetDesiredSize(controller) <= 0;
  }

  // ============================================================================
  // BYOB (deferred) — expose the constructor so `typeof` matches, but report the
  // deferral explicitly on use.
  // ============================================================================

  class ReadableStreamBYOBReader {
    constructor(stream) {
      if (!(stream instanceof ReadableStream)) {
        throw new TypeError('ReadableStreamBYOBReader requires a ReadableStream');
      }
      // Lava has no byte-stream sources yet, so there is never a valid byte
      // stream to attach to — report that explicitly rather than half-attaching.
      throw new TypeError('BYOB readers are not supported in Lava yet (no readable byte streams)');
    }

    // Blink's members (tests/web/cases/shape-streams.expected). No instance can exist
    // without byte streams, so every call has a receiver that is not one, and Chrome
    // answers that with "Illegal invocation" too.
    get closed() {
      throw illegalInvocation();
    }

    cancel() {
      throw illegalInvocation();
    }

    read(_view) {
      throw illegalInvocation();
    }

    releaseLock() {
      throw illegalInvocation();
    }
  }

  module.exports = {
    ReadableStream: ReadableStream,
    ReadableStreamDefaultReader: ReadableStreamDefaultReader,
    ReadableStreamBYOBReader: ReadableStreamBYOBReader,
    ReadableStreamDefaultController: ReadableStreamDefaultController,
    createReadableStream: createReadableStream,
    readableStreamDefaultControllerCanCloseOrEnqueue:
      readableStreamDefaultControllerCanCloseOrEnqueue,
    readableStreamDefaultControllerClose: readableStreamDefaultControllerClose,
    readableStreamDefaultControllerEnqueue: readableStreamDefaultControllerEnqueue,
    readableStreamDefaultControllerError: readableStreamDefaultControllerError,
    readableStreamDefaultControllerGetDesiredSize: readableStreamDefaultControllerGetDesiredSize,
    readableStreamDefaultControllerHasBackpressure: readableStreamDefaultControllerHasBackpressure,
  };
});
