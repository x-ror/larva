// Web Streams (WHATWG Streams Standard) — the public ReadableStream /
// WritableStream / TransformStream surface plus the readers, writers, default
// controllers, and queuing strategies. This is the pure-JS half: it installs the
// standard globals (Node exposes them without a require) and backs
// `require('node:stream/web')`. fetch (js/internal/fetch.js) builds response
// bodies and consumes request bodies through this same ReadableStream type, so
// there is one stream implementation, not a fetch-only fork.
//
// Scope (see reference/node-compatibility.md): the default (chunk) ReadableStream
// path is implemented in full — reader, async iteration, tee, cancel, locking,
// desiredSize-driven backpressure, pipeTo, and pipeThrough. WritableStream and
// TransformStream are implemented to the level pipeTo/pipeThrough need (and are
// generally usable). Byte streams / BYOB are deliberately deferred: a
// `type: 'bytes'` source or a `mode: 'byob'` reader throws an explicit error, and
// ReadableStreamBYOBReader exists as a constructor that reports the same. Text
// encoder/decoder streams and (de)compression streams are intentionally not
// provided here.
(function (require, module, _exports) {
  'use strict';

  // ---- microtask + promise helpers -------------------------------------------

  // queueMicrotask exists as a global (microtasks.js), but fall back to a
  // resolved-promise continuation so this module is usable even if it is loaded
  // before that global appears.
  var enqueueMicrotask =
    typeof queueMicrotask === 'function'
      ? queueMicrotask
      : function (cb) {
          Promise.resolve().then(cb);
        };

  function noop() {}

  function newPromise(executor) {
    return new Promise(executor);
  }
  // Invoke a method (preserving `this` via the caller's closure) and turn a
  // synchronous throw into a rejected promise, so an underlying source/sink/
  // transformer callback that throws behaves like one that returns a rejected
  // promise (spec algorithms always settle, never throw out of the controller).
  function promiseFrom(thunk) {
    try {
      return promiseResolvedWith(thunk());
    } catch (e) {
      return promiseRejectedWith(e);
    }
  }
  function promiseResolvedWith(value) {
    return Promise.resolve(value);
  }
  function promiseRejectedWith(reason) {
    return Promise.reject(reason);
  }
  // A deferred: { promise, resolve, reject }. Used for reader/writer closed and
  // writer ready promises, which settle from elsewhere in the algorithm.
  function newDeferred() {
    var d = {};
    d.promise = new Promise(function (resolve, reject) {
      d.resolve = resolve;
      d.reject = reject;
    });
    return d;
  }
  // Attach reactions without creating an unhandled-rejection if `promise` rejects
  // and only onRejected is registered elsewhere later — matches the spec's
  // PerformPromiseThen, which never surfaces an unhandled rejection.
  function performPromiseThen(promise, onFulfilled, onRejected) {
    promise.then(onFulfilled || undefined, onRejected || undefined);
  }
  function uponPromise(promise, onFulfilled, onRejected) {
    performPromiseThen(promise, onFulfilled, onRejected);
  }
  function setPromiseIsHandled(promise) {
    promise.then(undefined, noop);
  }

  // ---- generic queue (spec "queue-with-sizes") -------------------------------

  // A FIFO queue with amortized O(1) push/shift. A plain array's shift() is O(n)
  // — it reindexes every remaining element — so draining N queued chunks costs
  // O(n^2). That bites a byte-sized response body or a pipe that arrives as many
  // small chunks: the queue can hold thousands of them before a reader drains
  // (the high-water mark bounds queued *bytes*, not chunk count). Keeping a head
  // cursor and only compacting once the consumed prefix dominates the backing
  // array keeps push/shift/peek/length O(1) amortized while bounding wasted space
  // to ~2x the live length.
  class SimpleQueue {
    constructor() {
      this._items = [];
      this._head = 0;
    }
    get length() {
      return this._items.length - this._head;
    }
    push(item) {
      this._items.push(item);
    }
    shift() {
      var item = this._items[this._head];
      this._head++;
      if (this._head > 64 && this._head * 2 >= this._items.length) {
        this._items = this._items.slice(this._head);
        this._head = 0;
      }
      return item;
    }
    peek() {
      return this._items[this._head];
    }
  }

  function resetQueue(container) {
    container._queue = new SimpleQueue();
    container._queueTotalSize = 0;
  }
  function dequeueValue(container) {
    var pair = container._queue.shift();
    container._queueTotalSize -= pair.size;
    if (container._queueTotalSize < 0) container._queueTotalSize = 0;
    return pair.value;
  }
  function enqueueValueWithSize(container, value, size) {
    if (typeof size !== 'number' || size !== size || size === Infinity || size < 0) {
      throw new RangeError('Invalid chunk size');
    }
    container._queue.push({ value: value, size: size });
    container._queueTotalSize += size;
  }
  function peekQueueValue(container) {
    return container._queue.peek().value;
  }

  // ---- queuing strategies ----------------------------------------------------

  function extractHighWaterMark(strategy, defaultHWM) {
    if (!strategy || strategy.highWaterMark === undefined) return defaultHWM;
    var hwm = Number(strategy.highWaterMark);
    if (hwm !== hwm || hwm < 0) throw new RangeError('Invalid highWaterMark');
    return hwm;
  }
  function extractSizeAlgorithm(strategy) {
    if (!strategy || strategy.size === undefined) {
      return function () {
        return 1;
      };
    }
    var size = strategy.size;
    if (typeof size !== 'function') throw new TypeError('strategy.size must be a function');
    return function (chunk) {
      return Number(size(chunk));
    };
  }

  class ByteLengthQueuingStrategy {
    constructor(options) {
      if (!options || options.highWaterMark === undefined) {
        throw new TypeError('ByteLengthQueuingStrategy requires a highWaterMark option');
      }
      this._highWaterMark = Number(options.highWaterMark);
    }
    get highWaterMark() {
      return this._highWaterMark;
    }
    get size() {
      // Per spec this is a fresh function bound to no stream; chunk.byteLength.
      return function (chunk) {
        return chunk.byteLength;
      };
    }
  }

  class CountQueuingStrategy {
    constructor(options) {
      if (!options || options.highWaterMark === undefined) {
        throw new TypeError('CountQueuingStrategy requires a highWaterMark option');
      }
      this._highWaterMark = Number(options.highWaterMark);
    }
    get highWaterMark() {
      return this._highWaterMark;
    }
    get size() {
      return function () {
        return 1;
      };
    }
  }

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
    var sourceCancelPromise = stream._controller._cancelSteps(reason);
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
    stream._controller._releaseSteps();
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
      stream._controller._pullSteps(readRequest);
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

    // ---- abstract control "steps" called by the stream/reader ----

    _cancelSteps(reason) {
      resetQueue(this);
      var result = this._cancelAlgorithm(reason);
      readableStreamDefaultControllerClearAlgorithms(this);
      return result;
    }

    _pullSteps(readRequest) {
      var stream = this._controlledReadableStream;
      if (this._queue.length > 0) {
        var chunk = dequeueValue(this);
        if (this._closeRequested && this._queue.length === 0) {
          readableStreamDefaultControllerClearAlgorithms(this);
          readableStreamClose(stream);
        } else {
          readableStreamDefaultControllerCallPullIfNeeded(this);
        }
        readRequest.chunkSteps(chunk);
      } else {
        readableStreamAddReadRequest(stream, readRequest);
        readableStreamDefaultControllerCallPullIfNeeded(this);
      }
    }

    _releaseSteps() {
      // Default controller keeps its queue across reader release.
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
    stream._controller._errorSteps();
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
    var promise = stream._controller._abortSteps(abortRequest.reason);
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

    _abortSteps(reason) {
      var result = this._abortAlgorithm(reason);
      writableStreamDefaultControllerClearAlgorithms(this);
      return result;
    }

    _errorSteps() {
      resetQueue(this);
    }
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

  // A tiny stand-in for AbortError when a signal has no reason. Real AbortSignal
  // (js/internal/abort.js) supplies a DOMException reason, so this is only a
  // fallback for hand-rolled signals.
  function DOMExceptionLike(name) {
    var e = new Error(name);
    e.name = name;
    return e;
  }

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
  function readableStreamDefaultControllerHasBackpressure(controller) {
    return readableStreamDefaultControllerGetDesiredSize(controller) <= 0;
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
  }

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
