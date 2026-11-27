// ReadableStream, its default reader and controller, tee, async iteration, pipeTo, and
// readable byte streams (the byte controller, the BYOB reader and request, the byte
// tee) — node's lib/internal/webstreams/readablestream.js, which also keeps pipeTo
// here. pipeTo drives a WritableStream, so this file requires
// writablestream at its top level; writablestream never requires back, so there is no
// cycle to late-bind.
(function (require, module) {
  'use strict';

  var util = require('internal/webstreams/util');
  var P = require('internal/primordials');
  var webErrors = require('internal/web_errors');
  var argumentsRequired = webErrors.argumentsRequired;
  var errorContext = webErrors.context;
  var illegalInvocation = webErrors.illegalInvocation;
  var notOfType = webErrors.notOfType;
  var pageError = webErrors.pageError;
  var toDOMString = webErrors.toDOMString;
  var typeError = webErrors.typeError;
  var ArrayBufferIsView = P.ArrayBufferIsView;
  var ArrayBufferP = P.ArrayBuffer;
  var ArrayBufferPrototypeGetByteLength = P.ArrayBufferPrototypeGetByteLength;
  var ArrayBufferPrototypeGetDetached = P.ArrayBufferPrototypeGetDetached;
  var ArrayBufferPrototypeTransfer = P.ArrayBufferPrototypeTransfer;
  var ArrayPrototypePush1 = P.ArrayPrototypePush1;
  var ArrayPrototypeShift = P.ArrayPrototypeShift;
  var ArrayPrototypeSlice = P.ArrayPrototypeSlice;
  // Captured at this module's eval, which the loader runs before page code.
  var DataViewP = DataView;
  var DataViewPrototypeGetBuffer = P.DataViewPrototypeGetBuffer;
  var DataViewPrototypeGetByteLength = P.DataViewPrototypeGetByteLength;
  var DataViewPrototypeGetByteOffset = P.DataViewPrototypeGetByteOffset;
  var MathMin = P.MathMin;
  var MathTrunc = P.MathTrunc;
  var NumberP = P.Number;
  var ObjectCreate = P.ObjectCreate;
  var ObjectHasOwn = P.ObjectHasOwn;
  var RangeErrorP = P.RangeError;
  var ReflectApply = P.ReflectApply;
  var TypeErrorP = P.TypeError;
  var TypedArrayPrototypeGetBuffer = P.TypedArrayPrototypeGetBuffer;
  var TypedArrayPrototypeGetByteLength = P.TypedArrayPrototypeGetByteLength;
  var TypedArrayPrototypeGetByteOffset = P.TypedArrayPrototypeGetByteOffset;
  var TypedArrayPrototypeGetLength = P.TypedArrayPrototypeGetLength;
  var TypedArrayPrototypeGetSymbolToStringTag = P.TypedArrayPrototypeGetSymbolToStringTag;
  var TypedArrayPrototypes = P.TypedArrayPrototypes;
  var Uint8ArrayP = P.Uint8Array;
  var Uint8ArrayPrototypeSet = P.Uint8ArrayPrototypeSet;
  // The byte classes' brand checks, set by their static blocks below.
  var byteControllerOf;
  var byobReaderOf;
  var byobRequestOf;
  var dequeueValue = util.dequeueValue;
  var enqueueMicrotask = util.enqueueMicrotask;
  var enqueueValueWithSize = util.enqueueValueWithSize;
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
    /**
     * @param {Object} [underlyingSource] `type: 'bytes'` makes a byte stream.
     * @param {{highWaterMark?: number, size?: Function}} [strategy]
     * @throws {RangeError} an invalid `type`, a negative or NaN highWaterMark, a
     *   `size` on a byte stream's strategy.
     * @throws {TypeError} a byte source's callback that is not a function, its
     *   autoAllocateChunkSize out of range or 0; whatever `start` throws.
     * @node Chrome 158 (tests/web/cases/streams-byob-errors "order"): the strategy is
     *       read first (size, then highWaterMark), then the source's `type`, then a
     *       byte source's members in dictionary order.
     * @deviates A default (non-byte) source keeps its earlier member reads and its
     *   `size` text; only its order against the strategy, the highWaterMark text and
     *   `start` throwing synchronously follow the recording.
     */
    constructor(underlyingSource, strategy) {
      underlyingSource = underlyingSource === undefined ? {} : underlyingSource;
      strategy = strategy === undefined ? {} : strategy;

      this._state = 'readable';
      this._storedError = undefined;
      this._reader = undefined;
      this._disturbed = false;
      this._controller = undefined;

      var size = strategy ? strategy.size : undefined;
      var highWaterMark = strategy ? strategy.highWaterMark : undefined;
      if (highWaterMark !== undefined) {
        highWaterMark = NumberP(highWaterMark);
        if (highWaterMark !== highWaterMark || highWaterMark < 0) {
          throw rangeError(
            RS,
            undefined,
            "A queuing strategy's highWaterMark property must be a nonnegative, non-NaN number",
          );
        }
      }

      var type = underlyingSource.type;
      if (type !== undefined && toDOMString(type, RS) !== 'bytes') {
        throw rangeError(RS, undefined, 'Invalid type is specified');
      }

      if (type !== undefined) {
        setUpReadableByteStreamControllerFromUnderlyingSource(
          this,
          underlyingSource,
          highWaterMark === undefined ? 0 : highWaterMark,
          size,
        );
        return;
      }

      setUpReadableStreamDefaultControllerFromUnderlyingSource(
        this,
        underlyingSource,
        highWaterMark === undefined ? 1 : highWaterMark,
        sizeAlgorithmOf(size),
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

    /**
     * @param {{mode?: 'byob'}} [options]
     * @returns {ReadableStreamDefaultReader|ReadableStreamBYOBReader}
     * @throws {TypeError} options not a dictionary, an unknown mode, `byob` on a stream
     *   that is locked or not a byte stream.
     * @node Chrome 158 (tests/web/cases/streams-byob-errors).
     * @deviates none
     */
    getReader(options) {
      if (options !== undefined && options !== null) {
        if (typeof options !== 'object' && typeof options !== 'function') {
          throw typeError(
            RS,
            'getReader',
            "The provided value is not of type 'ReadableStreamGetReaderOptions'.",
          );
        }

        var mode = options.mode;
        if (mode !== undefined) {
          mode = toDOMString(mode, RS, 'getReader');
          if (mode !== 'byob') {
            throw typeError(
              RS,
              'getReader',
              "Failed to read the 'mode' property from 'ReadableStreamGetReaderOptions': " +
                "The provided value '" +
                mode +
                "' is not a valid enum value of type ReadableStreamReaderMode.",
            );
          }

          return acquireReadableStreamBYOBReader(this, RS, 'getReader')._self;
        }
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
      if (isByteController(this._controller)) {
        return readableByteStreamTee(this);
      }

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

  function isReadableStream(value) {
    return value instanceof ReadableStream;
  }

  // A strategy's size(), for a default source (a byte source refuses one).
  function sizeAlgorithmOf(size) {
    if (size === undefined) {
      return sizeOne;
    }

    if (typeof size !== 'function') {
      throw pageError(new TypeErrorP('strategy.size must be a function'));
    }

    return function (chunk) {
      return NumberP(size(chunk));
    };
  }

  function sizeOne() {
    return 1;
  }

  function readableStreamCancel(stream, reason) {
    stream._disturbed = true;
    if (stream._state === 'closed') return promiseResolvedWith(undefined);
    if (stream._state === 'errored') return promiseRejectedWith(stream._storedError);
    readableStreamClose(stream);
    var reader = stream._reader;
    if (reader !== undefined && reader._byob === true) {
      var readIntoRequests = reader._readIntoRequests;
      reader._readIntoRequests = [];
      for (var i = 0; i < readIntoRequests.length; i++) {
        readIntoRequests[i].closeSteps(undefined);
      }
    }

    var controller = stream._controller;
    var sourceCancelPromise = isByteController(controller)
      ? byteControllerCancelSteps(controller, reason)
      : readableStreamDefaultControllerCancelSteps(controller, reason);
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
    if (reader._byob === true) {
      readableStreamBYOBReaderErrorReadIntoRequests(reader, e);
    } else if (reader._readRequests !== undefined) {
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
      // Own, so the `_byob` test the shared algorithms make never reaches
      // Object.prototype, where a page could plant one.
      this._byob = false;
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

  // Blink's text for `closed` once a reader is released (Chrome 158,
  // tests/web/cases/streams-byob-errors), for either kind of reader.
  var RELEASED_CLOSED_TEXT =
    'This readable stream reader has been released and cannot be used to monitor the ' +
    "stream's state";

  function readableStreamReaderGenericRelease(reader) {
    var stream = reader._ownerReadableStream;
    if (stream._state === 'readable') {
      reader._closedDeferred.reject(bareTypeError(RELEASED_CLOSED_TEXT));
    } else {
      reader._closedDeferred = newDeferred();
      reader._closedDeferred.reject(bareTypeError(RELEASED_CLOSED_TEXT));
    }
    setPromiseIsHandled(reader._closedDeferred.promise);
    // The controller's [[ReleaseSteps]]: the default controller keeps its queue; the
    // byte controller keeps only its first pending read, now owned by no reader.
    if (isByteController(stream._controller)) {
      byteControllerReleaseSteps(stream._controller);
    }

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
    } else if (isByteController(stream._controller)) {
      byteControllerPullSteps(stream._controller, readRequest);
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
      checkDefaultController(this);
      return readableStreamDefaultControllerGetDesiredSize(this);
    }

    close() {
      checkDefaultController(this);
      if (!readableStreamDefaultControllerCanCloseOrEnqueue(this)) {
        throw new TypeError('Cannot close a stream that is already closing or not readable');
      }
      readableStreamDefaultControllerClose(this);
    }

    enqueue(chunk) {
      checkDefaultController(this);
      if (!readableStreamDefaultControllerCanCloseOrEnqueue(this)) {
        throw new TypeError('Cannot enqueue a chunk into a stream that is closing or not readable');
      }
      readableStreamDefaultControllerEnqueue(this, chunk);
    }

    error(e) {
      checkDefaultController(this);
      readableStreamDefaultControllerError(this, e);
    }
  }

  // The default controller keeps its state in own properties, so an own
  // `_controlledReadableStream` is its brand: a byte controller (or any other object)
  // answers "Illegal invocation", as in Chrome (tests/web/cases/streams-byob-errors).
  function checkDefaultController(o) {
    if (o === null || typeof o !== 'object' || !ObjectHasOwn(o, '_controlledReadableStream')) {
      throw illegalInvocation();
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
    // Own, as the default reader's `_byob`: isByteController must not read a planted
    // Object.prototype._isByte.
    controller._isByte = false;
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
    var controller = ObjectCreate(ReadableStreamDefaultController.prototype);
    var startAlgorithm = noop;
    var pullAlgorithm = function () {
      return promiseResolvedWith(undefined);
    };
    var cancelAlgorithm = function () {
      return promiseResolvedWith(undefined);
    };
    if (typeof underlyingSource.start === 'function') {
      // Not promiseFrom: what start throws propagates out of the constructor (spec,
      // and Chrome 158 — tests/web/cases/streams-byob-errors "start throws").
      startAlgorithm = function () {
        return underlyingSource.start(controller);
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
    var stream = newReadableStreamObject();
    var controller = ObjectCreate(ReadableStreamDefaultController.prototype);
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

  function newReadableStreamObject() {
    var stream = ObjectCreate(ReadableStream.prototype);
    stream._state = 'readable';
    stream._storedError = undefined;
    stream._reader = undefined;
    stream._disturbed = false;
    stream._controller = undefined;
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
  // Readable byte streams — ReadableByteStreamController, ReadableStreamBYOBReader,
  // ReadableStreamBYOBRequest and the byte tee (WHATWG Streams §4.7–4.10).
  //
  // The spec's algorithms run on null-prototype records, not on the page objects: a
  // controller, reader or request the page holds keeps one private field, the record,
  // which is also its brand (a page sees no own properties on any of the three). The
  // stream's `_controller` and `_reader` slots hold the record, so the generic reader
  // and stream algorithms above serve both kinds; `_isByte` / `_byob` say which.
  // ============================================================================

  var BC = 'ReadableByteStreamController';
  var BR = 'ReadableStreamBYOBRequest';
  var BYOB = 'ReadableStreamBYOBReader';
  var RS = 'ReadableStream';
  var INTERNAL = { __proto__: null };
  var MAX_SAFE = 9007199254740991;

  // Blink's text for the byte-stream states (Chrome 158,
  // tests/web/cases/streams-byob-errors.expected).
  var LOCKED_TEXT =
    'ReadableStreamBYOBReader constructor can only accept readable streams that are not yet ' +
    'locked to a reader';
  var NOT_BYTES_TEXT = 'Cannot use a BYOB reader with a non-byte stream';
  var RELEASED_READ_TEXT =
    'This readable stream reader has been released and cannot be used to read from its ' +
    'previous owner stream';
  var RELEASED_CANCEL_TEXT =
    'This readable stream reader has been released and cannot be used to cancel its ' +
    'previous owner stream';
  var EMPTY_VIEW_TEXT =
    'This readable stream reader cannot be used to read as the view has byte length equal to 0';
  var INVALIDATED_TEXT = 'Cannot respond to an invalidated ReadableStreamBYOBRequest';
  var NOT_READABLE_TEXT = 'stream is not readable';

  // The element size and constructor of each TypedArray kind, keyed by the name its
  // internal slot reports (TypedArrayPrototypeGetSymbolToStringTag), so neither a
  // subclass nor a forged Symbol.toStringTag picks the view a read resolves with.
  var VIEW_TYPES = { __proto__: null };
  for (var vt = 0; vt < TypedArrayPrototypes.length; vt++) {
    var viewCtor = TypedArrayPrototypes[vt][1];
    VIEW_TYPES[viewCtor.name] = {
      __proto__: null,
      ctor: viewCtor,
      size: viewCtor.BYTES_PER_ELEMENT,
    };
  }
  var DATA_VIEW_TYPE = { __proto__: null, ctor: DataViewP, size: 1 };
  var UINT8_TYPE = VIEW_TYPES.Uint8Array;

  function rangeError(iface, op, detail) {
    return pageError(new RangeErrorP(errorContext(iface, op) + detail));
  }

  function bareTypeError(text) {
    return pageError(new TypeErrorP(text));
  }

  // ---- views and buffers ------------------------------------------------------

  // The kind of an ArrayBufferView: VIEW_TYPES' entry, or DATA_VIEW_TYPE.
  function viewTypeOf(view) {
    var tag = TypedArrayPrototypeGetSymbolToStringTag(view);
    return tag === undefined ? DATA_VIEW_TYPE : VIEW_TYPES[tag];
  }

  function viewBuffer(view) {
    if (TypedArrayPrototypeGetSymbolToStringTag(view) !== undefined) {
      return TypedArrayPrototypeGetBuffer(view);
    }

    return DataViewPrototypeGetBuffer(view);
  }

  // A DataView's offset and length getters throw once its buffer is detached; a
  // TypedArray's answer 0. Both answer 0 here, which is what the spec's checks read.
  function viewByteOffset(view) {
    if (TypedArrayPrototypeGetSymbolToStringTag(view) !== undefined) {
      return TypedArrayPrototypeGetByteOffset(view);
    }

    return isDetached(DataViewPrototypeGetBuffer(view)) ? 0 : DataViewPrototypeGetByteOffset(view);
  }

  function viewByteLength(view) {
    if (TypedArrayPrototypeGetSymbolToStringTag(view) !== undefined) {
      return TypedArrayPrototypeGetByteLength(view);
    }

    return isDetached(DataViewPrototypeGetBuffer(view)) ? 0 : DataViewPrototypeGetByteLength(view);
  }

  function isDetached(buffer) {
    return ArrayBufferPrototypeGetDetached(buffer);
  }

  function transferBuffer(buffer) {
    return ArrayBufferPrototypeTransfer(buffer);
  }

  function copyBytes(dest, destOffset, src, srcOffset, n) {
    Uint8ArrayPrototypeSet(
      new Uint8ArrayP(dest, destOffset, n),
      new Uint8ArrayP(src, srcOffset, n),
      0,
    );
  }

  // The spec's CloneArrayBuffer(…, %ArrayBuffer%): a fresh buffer, never the
  // species-steerable ArrayBuffer.prototype.slice.
  function cloneBytes(buffer, byteOffset, byteLength) {
    var clone = new ArrayBufferP(byteLength);
    copyBytes(clone, 0, buffer, byteOffset, byteLength);
    return clone;
  }

  // ---- the byte queue -----------------------------------------------------------

  // Entries are {buf, start, count}: a byte range of a transferred buffer (pull-into
  // descriptors use the same names, which keep clear of the view accessors the
  // pollution ratchet watches). A head cursor, as util's SimpleQueue, so draining a
  // response body that arrived as many small chunks stays O(n).
  function byteQueueReset(c) {
    c._queue = [];
    c._queueHead = 0;
    c._queueTotalSize = 0;
  }

  function byteQueueLength(c) {
    return c._queue.length - c._queueHead;
  }

  function byteQueueShift(c) {
    var q = c._queue;
    var entry = q[c._queueHead];
    q[c._queueHead] = undefined;
    c._queueHead++;
    if (c._queueHead === q.length) {
      c._queue = [];
      c._queueHead = 0;
    } else if (c._queueHead > 64 && c._queueHead * 2 >= q.length) {
      c._queue = ArrayPrototypeSlice(q, c._queueHead);
      c._queueHead = 0;
    }

    return entry;
  }

  function byteControllerEnqueueChunkToQueue(c, buffer, byteOffset, byteLength) {
    ArrayPrototypePush1(c._queue, {
      __proto__: null,
      buf: buffer,
      start: byteOffset,
      count: byteLength,
    });
    c._queueTotalSize += byteLength;
  }

  function byteControllerEnqueueClonedChunkToQueue(c, buffer, byteOffset, byteLength) {
    var clone;
    try {
      clone = cloneBytes(buffer, byteOffset, byteLength);
    } catch (e) {
      byteControllerError(c, e);
      throw e;
    }

    byteControllerEnqueueChunkToQueue(c, clone, 0, byteLength);
  }

  // ---- ReadableByteStreamController ---------------------------------------------

  class ReadableByteStreamController {
    #s;

    static {
      byteControllerOf = function (o) {
        return o !== null && typeof o === 'object' && #s in o ? o.#s : undefined;
      };
    }

    constructor(internal, record) {
      // The interface object is `illegal`, so only newByteController gets here.
      if (internal !== INTERNAL) {
        throw typeError(BC, undefined, 'Illegal constructor');
      }

      this.#s = record;
    }

    /**
     * The BYOB request for the first pending read, created on first access.
     * @returns {ReadableStreamBYOBRequest|null}
     * @throws {TypeError} `Illegal invocation` — receiver is not a byte controller.
     * @node Chrome 158 (tests/web/cases/streams-bytes): a default reader's pull sees a
     *       request only with autoAllocateChunkSize; the view is a Uint8Array over the
     *       unfilled part of the read's buffer.
     * @deviates none
     */
    get byobRequest() {
      var c = byteControllerOf(this);
      if (c === undefined) {
        throw illegalInvocation();
      }

      var request = byteControllerGetBYOBRequest(c);
      return request === null ? null : request._self;
    }

    /**
     * @returns {number|null} highWaterMark minus the queued bytes; 0 once closed,
     *   null once errored.
     * @node Chrome 158 (tests/web/cases/streams-byob-errors).
     * @deviates none
     */
    get desiredSize() {
      var c = byteControllerOf(this);
      if (c === undefined) {
        throw illegalInvocation();
      }

      return byteControllerGetDesiredSize(c);
    }

    /**
     * @throws {TypeError} `Failed to execute 'close' on 'ReadableByteStreamController': …`
     *   — close already requested, stream not readable, or the first pending read
     *   holds part of an element (which also errors the stream).
     * @node Chrome 158 (tests/web/cases/streams-byob-errors).
     * @deviates none
     */
    close() {
      var c = byteControllerOf(this);
      if (c === undefined) {
        throw illegalInvocation();
      }

      if (c._closeRequested) {
        throw typeError(
          BC,
          'close',
          'Cannot close a readable stream that has already been requested to be closed',
        );
      }

      if (c._controlledReadableStream._state !== 'readable') {
        throw typeError(BC, 'close', 'Cannot close a readable stream that is not readable');
      }

      byteControllerClose(c);
    }

    /**
     * Queues `chunk`'s bytes, transferring (detaching) its buffer.
     * @param {ArrayBufferView} chunk
     * @throws {TypeError} argument count, `parameter 1 is not of type
     *   'ArrayBufferView'.`, `chunk is empty`, `close requested already`,
     *   `stream is not readable` — in that order.
     * @node Chrome 158 (tests/web/cases/streams-byob-errors, streams-bytes).
     * @deviates none
     */
    enqueue(chunk) {
      var c = byteControllerOf(this);
      if (c === undefined) {
        throw illegalInvocation();
      }

      if (arguments.length < 1) {
        throw typeError(BC, 'enqueue', argumentsRequired(1, 0));
      }

      if (!ArrayBufferIsView(chunk)) {
        throw typeError(BC, 'enqueue', notOfType(1, 'ArrayBufferView'));
      }

      if (
        viewByteLength(chunk) === 0 ||
        ArrayBufferPrototypeGetByteLength(viewBuffer(chunk)) === 0
      ) {
        throw typeError(BC, 'enqueue', 'chunk is empty');
      }

      if (c._closeRequested) {
        throw typeError(BC, 'enqueue', 'close requested already');
      }

      if (c._controlledReadableStream._state !== 'readable') {
        throw typeError(BC, 'enqueue', NOT_READABLE_TEXT);
      }

      byteControllerEnqueue(c, chunk);
    }

    error(e) {
      var c = byteControllerOf(this);
      if (c === undefined) {
        throw illegalInvocation();
      }

      byteControllerError(c, e);
    }
  }

  function newByteController() {
    var c = { __proto__: null, _isByte: true, _self: undefined };
    c._self = new ReadableByteStreamController(INTERNAL, c);
    return c;
  }

  function byteControllerCallPullIfNeeded(c) {
    if (!byteControllerShouldCallPull(c)) {
      return;
    }

    if (c._pulling) {
      c._pullAgain = true;
      return;
    }

    c._pulling = true;
    uponPromise(
      c._pullAlgorithm(),
      function () {
        c._pulling = false;
        if (c._pullAgain) {
          c._pullAgain = false;
          byteControllerCallPullIfNeeded(c);
        }
      },
      function (e) {
        byteControllerError(c, e);
      },
    );
  }

  function byteControllerShouldCallPull(c) {
    var stream = c._controlledReadableStream;
    if (stream._state !== 'readable' || c._closeRequested || !c._started) {
      return false;
    }

    var reader = stream._reader;
    if (reader !== undefined) {
      if (
        reader._byob === true
          ? reader._readIntoRequests.length > 0
          : reader._readRequests.length > 0
      ) {
        return true;
      }
    }

    return byteControllerGetDesiredSize(c) > 0;
  }

  function byteControllerClearAlgorithms(c) {
    c._pullAlgorithm = undefined;
    c._cancelAlgorithm = undefined;
  }

  function byteControllerClearPendingPullIntos(c) {
    byteControllerInvalidateBYOBRequest(c);
    c._pendingPullIntos = [];
  }

  function byteControllerClose(c) {
    var stream = c._controlledReadableStream;
    if (c._closeRequested || stream._state !== 'readable') {
      return;
    }

    if (c._queueTotalSize > 0) {
      c._closeRequested = true;
      return;
    }

    if (c._pendingPullIntos.length > 0) {
      var first = c._pendingPullIntos[0];
      if (first.bytesFilled % first.elementSize !== 0) {
        var e = typeError(BC, 'close', 'Cannot close while responding');
        byteControllerError(c, e);
        throw e;
      }
    }

    byteControllerClearAlgorithms(c);
    readableStreamClose(stream);
  }

  function byteControllerEnqueue(c, chunk) {
    var stream = c._controlledReadableStream;
    if (c._closeRequested || stream._state !== 'readable') {
      return;
    }

    var buffer = viewBuffer(chunk);
    var byteOffset = viewByteOffset(chunk);
    var byteLength = viewByteLength(chunk);
    if (isDetached(buffer)) {
      throw typeError(BC, 'enqueue', 'chunk is empty');
    }

    var transferred = transferBuffer(buffer);
    if (c._pendingPullIntos.length > 0) {
      var first = c._pendingPullIntos[0];
      if (isDetached(first.buf)) {
        throw typeError(BC, 'enqueue', "The BYOB request's buffer has been detached");
      }

      byteControllerInvalidateBYOBRequest(c);
      first.buf = transferBuffer(first.buf);
      if (first.readerType === 'none') {
        byteControllerEnqueueDetachedPullIntoToQueue(c, first);
      }
    }

    var reader = stream._reader;
    if (reader !== undefined && reader._byob !== true) {
      byteControllerProcessReadRequestsUsingQueue(c);
      if (reader._readRequests.length === 0) {
        byteControllerEnqueueChunkToQueue(c, transferred, byteOffset, byteLength);
      } else {
        if (c._pendingPullIntos.length > 0) {
          byteControllerShiftPendingPullInto(c);
        }

        readableStreamFulfillReadRequest(
          stream,
          new Uint8ArrayP(transferred, byteOffset, byteLength),
          false,
        );
      }
    } else if (reader !== undefined) {
      byteControllerEnqueueChunkToQueue(c, transferred, byteOffset, byteLength);
      var filled = byteControllerProcessPullIntoDescriptorsUsingQueue(c);
      for (var i = 0; i < filled.length; i++) {
        byteControllerCommitPullIntoDescriptor(stream, filled[i]);
      }
    } else {
      byteControllerEnqueueChunkToQueue(c, transferred, byteOffset, byteLength);
    }

    byteControllerCallPullIfNeeded(c);
  }

  function byteControllerEnqueueDetachedPullIntoToQueue(c, desc) {
    if (desc.bytesFilled > 0) {
      byteControllerEnqueueClonedChunkToQueue(c, desc.buf, desc.start, desc.bytesFilled);
    }

    byteControllerShiftPendingPullInto(c);
  }

  function byteControllerError(c, e) {
    var stream = c._controlledReadableStream;
    if (stream._state !== 'readable') {
      return;
    }

    byteControllerClearPendingPullIntos(c);
    byteQueueReset(c);
    byteControllerClearAlgorithms(c);
    readableStreamError(stream, e);
  }

  function byteControllerFillHeadPullIntoDescriptor(c, size, desc) {
    desc.bytesFilled += size;
  }

  function byteControllerFillPullIntoDescriptorFromQueue(c, desc) {
    var maxBytesToCopy = MathMin(c._queueTotalSize, desc.count - desc.bytesFilled);
    var maxBytesFilled = desc.bytesFilled + maxBytesToCopy;
    var totalBytesToCopyRemaining = maxBytesToCopy;
    var ready = false;
    var maxAlignedBytes = maxBytesFilled - (maxBytesFilled % desc.elementSize);
    if (maxAlignedBytes >= desc.minimumFill) {
      totalBytesToCopyRemaining = maxAlignedBytes - desc.bytesFilled;
      ready = true;
    }

    while (totalBytesToCopyRemaining > 0) {
      var head = c._queue[c._queueHead];
      var bytesToCopy = MathMin(totalBytesToCopyRemaining, head.count);
      copyBytes(desc.buf, desc.start + desc.bytesFilled, head.buf, head.start, bytesToCopy);
      if (head.count === bytesToCopy) {
        byteQueueShift(c);
      } else {
        head.start += bytesToCopy;
        head.count -= bytesToCopy;
      }

      c._queueTotalSize -= bytesToCopy;
      byteControllerFillHeadPullIntoDescriptor(c, bytesToCopy, desc);
      totalBytesToCopyRemaining -= bytesToCopy;
    }

    return ready;
  }

  function byteControllerFillReadRequestFromQueue(c, readRequest) {
    var entry = byteQueueShift(c);
    c._queueTotalSize -= entry.count;
    byteControllerHandleQueueDrain(c);
    readRequest.chunkSteps(new Uint8ArrayP(entry.buf, entry.start, entry.count));
  }

  function byteControllerGetBYOBRequest(c) {
    if (c._byobRequest === null && c._pendingPullIntos.length > 0) {
      var first = c._pendingPullIntos[0];
      var request = { __proto__: null, _controller: c, _view: null, _self: undefined };
      request._view = new Uint8ArrayP(
        first.buf,
        first.start + first.bytesFilled,
        first.count - first.bytesFilled,
      );
      request._self = new ReadableStreamBYOBRequest(INTERNAL, request);
      c._byobRequest = request;
    }

    return c._byobRequest;
  }

  function byteControllerGetDesiredSize(c) {
    var state = c._controlledReadableStream._state;
    if (state === 'errored') {
      return null;
    }

    if (state === 'closed') {
      return 0;
    }

    return c._strategyHWM - c._queueTotalSize;
  }

  function byteControllerHandleQueueDrain(c) {
    if (c._queueTotalSize === 0 && c._closeRequested) {
      byteControllerClearAlgorithms(c);
      readableStreamClose(c._controlledReadableStream);
    } else {
      byteControllerCallPullIfNeeded(c);
    }
  }

  function byteControllerInvalidateBYOBRequest(c) {
    var request = c._byobRequest;
    if (request === null) {
      return;
    }

    request._controller = undefined;
    request._view = null;
    c._byobRequest = null;
  }

  function byteControllerProcessPullIntoDescriptorsUsingQueue(c) {
    var filled = [];
    while (c._pendingPullIntos.length > 0) {
      if (c._queueTotalSize === 0) {
        break;
      }

      var desc = c._pendingPullIntos[0];
      if (byteControllerFillPullIntoDescriptorFromQueue(c, desc)) {
        byteControllerShiftPendingPullInto(c);
        ArrayPrototypePush1(filled, desc);
      }
    }

    return filled;
  }

  function byteControllerProcessReadRequestsUsingQueue(c) {
    var reader = c._controlledReadableStream._reader;
    while (reader._readRequests.length > 0) {
      if (c._queueTotalSize === 0) {
        return;
      }

      byteControllerFillReadRequestFromQueue(c, ArrayPrototypeShift(reader._readRequests));
    }
  }

  // ReadableByteStreamControllerPullInto: a BYOB read of `view`, done once `min`
  // elements are filled.
  function byteControllerPullInto(c, view, min, readIntoRequest) {
    var stream = c._controlledReadableStream;
    var type = viewTypeOf(view);
    var byteOffset = viewByteOffset(view);
    var byteLength = viewByteLength(view);
    var buffer;
    try {
      buffer = transferBuffer(viewBuffer(view));
    } catch (e) {
      readIntoRequest.errorSteps(e);
      return;
    }

    var desc = {
      __proto__: null,
      buf: buffer,
      bufferByteLength: ArrayBufferPrototypeGetByteLength(buffer),
      start: byteOffset,
      count: byteLength,
      bytesFilled: 0,
      minimumFill: min * type.size,
      elementSize: type.size,
      viewConstructor: type.ctor,
      readerType: 'byob',
    };
    if (c._pendingPullIntos.length > 0) {
      ArrayPrototypePush1(c._pendingPullIntos, desc);
      ArrayPrototypePush1(stream._reader._readIntoRequests, readIntoRequest);
      return;
    }

    if (stream._state === 'closed') {
      readIntoRequest.closeSteps(new type.ctor(buffer, byteOffset, 0));
      return;
    }

    if (c._queueTotalSize > 0) {
      if (byteControllerFillPullIntoDescriptorFromQueue(c, desc)) {
        var filledView = byteControllerConvertPullIntoDescriptor(desc);
        byteControllerHandleQueueDrain(c);
        readIntoRequest.chunkSteps(filledView);
        return;
      }

      if (c._closeRequested) {
        var e = bareTypeError('close requested');
        byteControllerError(c, e);
        readIntoRequest.errorSteps(e);
        return;
      }
    }

    ArrayPrototypePush1(c._pendingPullIntos, desc);
    ArrayPrototypePush1(stream._reader._readIntoRequests, readIntoRequest);
    byteControllerCallPullIfNeeded(c);
  }

  function byteControllerConvertPullIntoDescriptor(desc) {
    var buffer = transferBuffer(desc.buf);
    return new desc.viewConstructor(buffer, desc.start, desc.bytesFilled / desc.elementSize);
  }

  function byteControllerCommitPullIntoDescriptor(stream, desc) {
    var done = stream._state === 'closed';
    var filledView = byteControllerConvertPullIntoDescriptor(desc);
    if (desc.readerType === 'default') {
      readableStreamFulfillReadRequest(stream, filledView, done);
    } else {
      readableStreamFulfillReadIntoRequest(stream, filledView, done);
    }
  }

  function byteControllerRespond(c, bytesWritten) {
    var first = c._pendingPullIntos[0];
    if (c._controlledReadableStream._state === 'closed') {
      if (bytesWritten !== 0) {
        throw typeError(BR, 'respond', 'bytes written is not 0');
      }
    } else {
      if (bytesWritten === 0) {
        throw typeError(BR, 'respond', 'bytes written is 0');
      }

      if (first.bytesFilled + bytesWritten > first.count) {
        throw rangeError(
          BR,
          'respond',
          'available read buffer is too small for specified number of bytes',
        );
      }
    }

    first.buf = transferBuffer(first.buf);
    byteControllerRespondInternal(c, bytesWritten);
  }

  function byteControllerRespondInClosedState(c, first) {
    if (first.readerType === 'none') {
      byteControllerShiftPendingPullInto(c);
    }

    var stream = c._controlledReadableStream;
    var reader = stream._reader;
    if (reader !== undefined && reader._byob === true) {
      var filled = [];
      while (filled.length < reader._readIntoRequests.length) {
        ArrayPrototypePush1(filled, byteControllerShiftPendingPullInto(c));
      }

      for (var i = 0; i < filled.length; i++) {
        byteControllerCommitPullIntoDescriptor(stream, filled[i]);
      }
    }
  }

  function byteControllerRespondInReadableState(c, bytesWritten, desc) {
    byteControllerFillHeadPullIntoDescriptor(c, bytesWritten, desc);
    var stream = c._controlledReadableStream;
    var filled;
    var i;
    if (desc.readerType === 'none') {
      byteControllerEnqueueDetachedPullIntoToQueue(c, desc);
      filled = byteControllerProcessPullIntoDescriptorsUsingQueue(c);
      for (i = 0; i < filled.length; i++) {
        byteControllerCommitPullIntoDescriptor(stream, filled[i]);
      }

      return;
    }

    if (desc.bytesFilled < desc.minimumFill) {
      return;
    }

    byteControllerShiftPendingPullInto(c);
    var remainderSize = desc.bytesFilled % desc.elementSize;
    if (remainderSize > 0) {
      var end = desc.start + desc.bytesFilled;
      byteControllerEnqueueClonedChunkToQueue(c, desc.buf, end - remainderSize, remainderSize);
    }

    desc.bytesFilled -= remainderSize;
    filled = byteControllerProcessPullIntoDescriptorsUsingQueue(c);
    byteControllerCommitPullIntoDescriptor(stream, desc);
    for (i = 0; i < filled.length; i++) {
      byteControllerCommitPullIntoDescriptor(stream, filled[i]);
    }
  }

  function byteControllerRespondInternal(c, bytesWritten) {
    var first = c._pendingPullIntos[0];
    byteControllerInvalidateBYOBRequest(c);
    if (c._controlledReadableStream._state === 'closed') {
      byteControllerRespondInClosedState(c, first);
    } else {
      byteControllerRespondInReadableState(c, bytesWritten, first);
    }

    byteControllerCallPullIfNeeded(c);
  }

  function byteControllerRespondWithNewView(c, view) {
    var first = c._pendingPullIntos[0];
    var viewLength = viewByteLength(view);
    if (c._controlledReadableStream._state === 'closed') {
      if (viewLength !== 0) {
        throw typeError(BR, 'respondWithNewView', "view's byte length is not 0");
      }
    } else if (viewLength === 0) {
      throw typeError(BR, 'respondWithNewView', "view's byte length is 0");
    }

    if (first.start + first.bytesFilled !== viewByteOffset(view)) {
      throw rangeError(
        BR,
        'respondWithNewView',
        "supplied view's byte offset doesn't match the expected value",
      );
    }

    var buffer = viewBuffer(view);
    if (first.bufferByteLength !== ArrayBufferPrototypeGetByteLength(buffer)) {
      throw rangeError(BR, 'respondWithNewView', 'buffer byte lengths are not equal');
    }

    if (first.bytesFilled + viewLength > first.count) {
      throw rangeError(BR, 'respondWithNewView', 'supplied view is too large for the read buffer');
    }

    first.buf = transferBuffer(buffer);
    byteControllerRespondInternal(c, viewLength);
  }

  function byteControllerShiftPendingPullInto(c) {
    return ArrayPrototypeShift(c._pendingPullIntos);
  }

  // The controller's [[CancelSteps]], [[PullSteps]] and [[ReleaseSteps]].
  function byteControllerCancelSteps(c, reason) {
    byteControllerClearPendingPullIntos(c);
    byteQueueReset(c);
    var result = c._cancelAlgorithm(reason);
    byteControllerClearAlgorithms(c);
    return result;
  }

  function byteControllerPullSteps(c, readRequest) {
    var stream = c._controlledReadableStream;
    if (c._queueTotalSize > 0) {
      byteControllerFillReadRequestFromQueue(c, readRequest);
      return;
    }

    var size = c._autoAllocateChunkSize;
    if (size !== undefined) {
      var buffer;
      try {
        buffer = new ArrayBufferP(size);
      } catch (e) {
        readRequest.errorSteps(e);
        return;
      }

      ArrayPrototypePush1(c._pendingPullIntos, {
        __proto__: null,
        buf: buffer,
        bufferByteLength: size,
        start: 0,
        count: size,
        bytesFilled: 0,
        minimumFill: 1,
        elementSize: 1,
        viewConstructor: UINT8_TYPE.ctor,
        readerType: 'default',
      });
    }

    ArrayPrototypePush1(stream._reader._readRequests, readRequest);
    byteControllerCallPullIfNeeded(c);
  }

  function byteControllerReleaseSteps(c) {
    if (c._pendingPullIntos.length > 0) {
      var first = c._pendingPullIntos[0];
      first.readerType = 'none';
      c._pendingPullIntos = [first];
    }
  }

  function setUpReadableByteStreamController(
    stream,
    c,
    startAlgorithm,
    pullAlgorithm,
    cancelAlgorithm,
    highWaterMark,
    autoAllocateChunkSize,
  ) {
    c._controlledReadableStream = stream;
    c._pullAgain = false;
    c._pulling = false;
    c._byobRequest = null;
    byteQueueReset(c);
    c._closeRequested = false;
    c._started = false;
    c._strategyHWM = highWaterMark;
    c._pullAlgorithm = pullAlgorithm;
    c._cancelAlgorithm = cancelAlgorithm;
    c._autoAllocateChunkSize = autoAllocateChunkSize;
    c._pendingPullIntos = [];
    stream._controller = c;
    var startResult = startAlgorithm();
    uponPromise(
      promiseResolvedWith(startResult),
      function () {
        c._started = true;
        byteControllerCallPullIfNeeded(c);
      },
      function (r) {
        byteControllerError(c, r);
      },
    );
  }

  // The UnderlyingSource dictionary of a byte source, converted in Blink's order
  // (autoAllocateChunkSize, cancel, pull, start, type — tests/web/cases/
  // streams-byob-errors "order").
  function sourceCallback(source, member) {
    var value = source[member];
    if (value !== undefined && typeof value !== 'function') {
      throw typeError(
        RS,
        undefined,
        "Failed to read the '" +
          member +
          "' property from 'UnderlyingSource': The given value is not a function.",
      );
    }

    return value;
  }

  function setUpReadableByteStreamControllerFromUnderlyingSource(
    stream,
    source,
    highWaterMark,
    strategySize,
  ) {
    var autoAllocateChunkSize = source.autoAllocateChunkSize;
    if (autoAllocateChunkSize !== undefined) {
      autoAllocateChunkSize = toEnforcedUnsignedLongLong(
        autoAllocateChunkSize,
        RS,
        undefined,
        "Failed to read the 'autoAllocateChunkSize' property from 'UnderlyingSource': ",
      );
    }

    var cancel = sourceCallback(source, 'cancel');
    var pull = sourceCallback(source, 'pull');
    var start = sourceCallback(source, 'start');
    // Read again, as Blink's dictionary conversion does after its own `type` read.
    source.type;
    if (strategySize !== undefined) {
      throw rangeError(
        RS,
        undefined,
        'Cannot create byte stream with size() defined on the strategy',
      );
    }

    if (autoAllocateChunkSize === 0) {
      throw typeError(RS, undefined, 'autoAllocateChunkSize cannot be 0');
    }

    var c = newByteController();
    var controller = c._self;
    var startAlgorithm = noop;
    var pullAlgorithm = resolvedUndefined;
    var cancelAlgorithm = resolvedUndefined;
    if (start !== undefined) {
      startAlgorithm = function () {
        return ReflectApply(start, source, [controller]);
      };
    }

    if (pull !== undefined) {
      pullAlgorithm = function () {
        return promiseFrom(function () {
          return ReflectApply(pull, source, [controller]);
        });
      };
    }

    if (cancel !== undefined) {
      cancelAlgorithm = function (reason) {
        return promiseFrom(function () {
          return ReflectApply(cancel, source, [reason]);
        });
      };
    }

    setUpReadableByteStreamController(
      stream,
      c,
      startAlgorithm,
      pullAlgorithm,
      cancelAlgorithm,
      highWaterMark,
      autoAllocateChunkSize,
    );
  }

  function resolvedUndefined() {
    return promiseResolvedWith(undefined);
  }

  // CreateReadableByteStream, for the byte tee's branches.
  function createReadableByteStream(startAlgorithm, pullAlgorithm, cancelAlgorithm) {
    var stream = newReadableStreamObject();
    setUpReadableByteStreamController(
      stream,
      newByteController(),
      startAlgorithm,
      pullAlgorithm,
      cancelAlgorithm,
      0,
      undefined,
    );
    return stream;
  }

  // [EnforceRange] unsigned long long, with Blink's texts.
  function toEnforcedUnsignedLongLong(value, iface, op, prefix) {
    var x = NumberP(value);
    var detail;
    if (x !== x) {
      detail = "Value is not of type 'unsigned long long'.";
    } else if (x === Infinity || x === -Infinity) {
      detail = "Value is infinite and not of type 'unsigned long long'.";
    } else {
      x = MathTrunc(x);
      if (x >= 0 && x <= MAX_SAFE) {
        return x + 0;
      }

      detail = "Value is outside the 'unsigned long long' value range.";
    }

    throw typeError(iface, op, prefix + detail);
  }

  // ---- ReadableStreamBYOBRequest --------------------------------------------------

  class ReadableStreamBYOBRequest {
    #s;

    static {
      byobRequestOf = function (o) {
        return o !== null && typeof o === 'object' && #s in o ? o.#s : undefined;
      };
    }

    constructor(internal, record) {
      if (internal !== INTERNAL) {
        throw typeError(BR, undefined, 'Illegal constructor');
      }

      this.#s = record;
    }

    /**
     * @returns {Uint8Array|null} The unfilled part of the pending read's buffer; null
     *   once the request is answered or invalidated.
     * @node Chrome 158 (tests/web/cases/streams-byob-errors, streams-bytes).
     * @deviates none
     */
    get view() {
      var r = byobRequestOf(this);
      if (r === undefined) {
        throw illegalInvocation();
      }

      return r._view;
    }

    /**
     * @param {number} bytesWritten [EnforceRange] unsigned long long.
     * @throws {TypeError} invalidated request; 0 written while readable; non-zero
     *   written once closed.
     * @throws {RangeError} more bytes than the view holds.
     * @node Chrome 158 (tests/web/cases/streams-byob-errors).
     * @deviates none
     */
    respond(bytesWritten) {
      var r = byobRequestOf(this);
      if (r === undefined) {
        throw illegalInvocation();
      }

      if (arguments.length < 1) {
        throw typeError(BR, 'respond', argumentsRequired(1, 0));
      }

      var n = toEnforcedUnsignedLongLong(bytesWritten, BR, 'respond', '');
      if (r._controller === undefined) {
        throw typeError(BR, 'respond', INVALIDATED_TEXT);
      }

      if (isDetached(TypedArrayPrototypeGetBuffer(r._view))) {
        throw typeError(BR, 'respond', "The BYOB request's buffer has been detached");
      }

      byteControllerRespond(r._controller, n);
    }

    /**
     * @param {ArrayBufferView} view Over the pending read's (transferred) buffer, at
     *   the offset the request's view starts at.
     * @throws {TypeError} invalidated request; empty view while readable; non-empty
     *   view once closed.
     * @throws {RangeError} wrong offset, a buffer of another length, or past the read.
     * @node Chrome 158 (tests/web/cases/streams-byob-errors, streams-bytes).
     * @deviates none
     */
    respondWithNewView(view) {
      var r = byobRequestOf(this);
      if (r === undefined) {
        throw illegalInvocation();
      }

      if (arguments.length < 1) {
        throw typeError(BR, 'respondWithNewView', argumentsRequired(1, 0));
      }

      if (!ArrayBufferIsView(view)) {
        throw typeError(BR, 'respondWithNewView', notOfType(1, 'ArrayBufferView'));
      }

      if (r._controller === undefined) {
        throw typeError(BR, 'respondWithNewView', INVALIDATED_TEXT);
      }

      if (isDetached(viewBuffer(view))) {
        throw typeError(BR, 'respondWithNewView', "The view's buffer has been detached");
      }

      byteControllerRespondWithNewView(r._controller, view);
    }
  }

  // ---- ReadableStreamBYOBReader ---------------------------------------------------

  class ReadableStreamBYOBReader {
    #s;

    static {
      byobReaderOf = function (o) {
        return o !== null && typeof o === 'object' && #s in o ? o.#s : undefined;
      };
    }

    /**
     * @param {ReadableStream} stream An unlocked byte stream.
     * @throws {TypeError} argument count, `parameter 1 is not of type
     *   'ReadableStream'.`, a locked stream, a stream that is not a byte stream.
     * @node Chrome 158 (tests/web/cases/streams-byob-errors).
     * @deviates none
     */
    constructor(stream, internal, record) {
      if (internal === INTERNAL) {
        this.#s = record;
        return;
      }

      if (arguments.length < 1) {
        throw typeError(BYOB, undefined, argumentsRequired(1, 0));
      }

      if (!isReadableStream(stream)) {
        throw typeError(BYOB, undefined, notOfType(1, 'ReadableStream'));
      }

      var r = newBYOBReaderRecord(stream, BYOB, undefined);
      r._self = this;
      this.#s = r;
    }

    /**
     * @returns {Promise<undefined>} Settles with the stream; rejected once released.
     * @throws {TypeError} (as a rejection) `Failed to read the 'closed' property from
     *   'ReadableStreamBYOBReader': Illegal invocation` for another receiver;
     *   `This readable stream reader has been released and cannot be used to monitor
     *   the stream's state` once released.
     * @node Chrome 158 (tests/web/cases/streams-byob-errors).
     * @deviates none
     */
    get closed() {
      var r = byobReaderOf(this);
      if (r === undefined) {
        return promiseRejectedWith(
          bareTypeError(
            "Failed to read the 'closed' property from '" + BYOB + "': Illegal invocation",
          ),
        );
      }

      return r._closedDeferred.promise;
    }

    /**
     * Cancels the stream; pending reads resolve done with no value.
     * @param {*} [reason]
     * @returns {Promise<undefined>}
     * @throws {TypeError} (as a rejection) another receiver, a released reader.
     * @node Chrome 158 (tests/web/cases/streams-byob-errors, streams-bytes).
     * @deviates none
     */
    cancel(reason) {
      var r = byobReaderOf(this);
      if (r === undefined) {
        return promiseRejectedWith(typeError(BYOB, 'cancel', 'Illegal invocation'));
      }

      if (r._ownerReadableStream === undefined) {
        return promiseRejectedWith(typeError(BYOB, 'cancel', RELEASED_CANCEL_TEXT));
      }

      return readableStreamReaderGenericCancel(r, reason);
    }

    /**
     * Reads into `view`, transferring its buffer; resolves once `min` elements
     * (default 1) are filled, or done.
     * @param {ArrayBufferView} view
     * @param {{min?: number}} [options]
     * @returns {Promise<{value: ArrayBufferView|undefined, done: boolean}>}
     * @throws {TypeError} (as a rejection) argument count, view type, options type,
     *   `min` range, an empty or detached view, `min cannot be 0`, a released reader.
     * @throws {RangeError} (as a rejection) `min` past the view's length.
     * @node Chrome 158 (tests/web/cases/streams-byob-errors, streams-bytes).
     * @deviates none
     */
    read(view, options) {
      var r = byobReaderOf(this);
      if (r === undefined) {
        return promiseRejectedWith(typeError(BYOB, 'read', 'Illegal invocation'));
      }

      var min = 1;
      try {
        if (arguments.length < 1) {
          throw typeError(BYOB, 'read', argumentsRequired(1, 0));
        }

        if (!ArrayBufferIsView(view)) {
          throw typeError(BYOB, 'read', notOfType(1, 'ArrayBufferView'));
        }

        if (options !== undefined && options !== null) {
          if (typeof options !== 'object' && typeof options !== 'function') {
            throw typeError(
              BYOB,
              'read',
              "The provided value is not of type 'ReadableStreamBYOBReaderReadOptions'.",
            );
          }

          var rawMin = options.min;
          if (rawMin !== undefined) {
            min = toEnforcedUnsignedLongLong(
              rawMin,
              BYOB,
              'read',
              "Failed to read the 'min' property from 'ReadableStreamBYOBReaderReadOptions': ",
            );
          }
        }
      } catch (e) {
        return promiseRejectedWith(e);
      }

      var buffer = viewBuffer(view);
      if (
        viewByteLength(view) === 0 ||
        isDetached(buffer) ||
        ArrayBufferPrototypeGetByteLength(buffer) === 0
      ) {
        return promiseRejectedWith(typeError(BYOB, 'read', EMPTY_VIEW_TEXT));
      }

      if (min === 0) {
        return promiseRejectedWith(typeError(BYOB, 'read', 'min cannot be 0'));
      }

      var type = viewTypeOf(view);
      if (type !== DATA_VIEW_TYPE) {
        if (min > TypedArrayPrototypeGetLength(view)) {
          return promiseRejectedWith(
            rangeError(BYOB, 'read', "min cannot be larger than view's length"),
          );
        }
      } else if (min > viewByteLength(view)) {
        return promiseRejectedWith(
          rangeError(BYOB, 'read', "min cannot be larger than view's byteLength"),
        );
      }

      if (r._ownerReadableStream === undefined) {
        return promiseRejectedWith(typeError(BYOB, 'read', RELEASED_READ_TEXT));
      }

      var deferred = newDeferred();
      readableStreamBYOBReaderRead(r, view, min, {
        __proto__: null,
        chunkSteps: function (chunk) {
          deferred.resolve({ value: chunk, done: false });
        },
        closeSteps: function (chunk) {
          deferred.resolve({ value: chunk, done: true });
        },
        errorSteps: function (e) {
          deferred.reject(e);
        },
      });
      return deferred.promise;
    }

    /**
     * Releases the lock; pending reads reject with `Releasing BYOB reader`.
     * @throws {TypeError} `Illegal invocation` for another receiver.
     * @node Chrome 158 (tests/web/cases/streams-byob-errors).
     * @deviates none
     */
    releaseLock() {
      var r = byobReaderOf(this);
      if (r === undefined) {
        throw illegalInvocation();
      }

      if (r._ownerReadableStream === undefined) {
        return;
      }

      readableStreamBYOBReaderRelease(r);
    }
  }

  // SetUpReadableStreamBYOBReader on a fresh record, with the caller's error context
  // (the constructor's, or getReader's).
  function newBYOBReaderRecord(stream, iface, op) {
    if (isReadableStreamLocked(stream)) {
      throw typeError(iface, op, LOCKED_TEXT);
    }

    if (!isByteController(stream._controller)) {
      throw typeError(iface, op, NOT_BYTES_TEXT);
    }

    var r = {
      __proto__: null,
      _byob: true,
      _readIntoRequests: [],
      _ownerReadableStream: undefined,
      _closedDeferred: undefined,
      _self: undefined,
    };
    readableStreamReaderGenericInitialize(r, stream);
    return r;
  }

  function acquireReadableStreamBYOBReader(stream, iface, op) {
    var r = newBYOBReaderRecord(stream, iface, op);
    r._self = new ReadableStreamBYOBReader(undefined, INTERNAL, r);
    return r;
  }

  function isByteController(controller) {
    return controller !== undefined && controller !== null && controller._isByte === true;
  }

  function readableStreamBYOBReaderRead(reader, view, min, readIntoRequest) {
    var stream = reader._ownerReadableStream;
    stream._disturbed = true;
    if (stream._state === 'errored') {
      readIntoRequest.errorSteps(stream._storedError);
    } else {
      byteControllerPullInto(stream._controller, view, min, readIntoRequest);
    }
  }

  function readableStreamBYOBReaderRelease(reader) {
    readableStreamReaderGenericRelease(reader);
    readableStreamBYOBReaderErrorReadIntoRequests(reader, bareTypeError('Releasing BYOB reader'));
  }

  function readableStreamBYOBReaderErrorReadIntoRequests(reader, e) {
    var requests = reader._readIntoRequests;
    reader._readIntoRequests = [];
    for (var i = 0; i < requests.length; i++) {
      requests[i].errorSteps(e);
    }
  }

  function readableStreamFulfillReadIntoRequest(stream, chunk, done) {
    var readIntoRequest = ArrayPrototypeShift(stream._reader._readIntoRequests);
    if (done) {
      readIntoRequest.closeSteps(chunk);
    } else {
      readIntoRequest.chunkSteps(chunk);
    }
  }

  // ---- tee (bytes) ------------------------------------------------------------------

  // CloneAsUint8Array.
  function cloneAsUint8Array(view) {
    var byteLength = viewByteLength(view);
    return new Uint8ArrayP(cloneBytes(viewBuffer(view), viewByteOffset(view), byteLength));
  }

  // ReadableByteStreamTee: each branch pulls with a BYOB read into its own request's
  // view when it has one, and with a default read otherwise, swapping the source's
  // reader between the two kinds as the pulls alternate.
  function readableByteStreamTee(stream) {
    var reader = acquireReadableStreamDefaultReader(stream);
    var reading = false;
    var readAgainForBranch1 = false;
    var readAgainForBranch2 = false;
    var canceled1 = false;
    var canceled2 = false;
    var reason1;
    var reason2;
    var branch1;
    var branch2;
    var cancelDeferred = newDeferred();

    function forwardReaderError(thisReader) {
      uponPromise(thisReader._closedDeferred.promise, undefined, function (r) {
        if (thisReader !== reader) {
          return;
        }

        byteControllerError(branch1._controller, r);
        byteControllerError(branch2._controller, r);
        if (!canceled1 || !canceled2) {
          cancelDeferred.resolve(undefined);
        }
      });
    }

    function cloneOrCancel(chunk) {
      try {
        return cloneAsUint8Array(chunk);
      } catch (e) {
        byteControllerError(branch1._controller, e);
        byteControllerError(branch2._controller, e);
        cancelDeferred.resolve(readableStreamCancel(stream, e));
        return undefined;
      }
    }

    function pullWithDefaultReader() {
      if (reader._byob === true) {
        readableStreamBYOBReaderRelease(reader);
        reader = acquireReadableStreamDefaultReader(stream);
        forwardReaderError(reader);
      }

      readableStreamDefaultReaderRead(reader, {
        chunkSteps: function (chunk) {
          enqueueMicrotask(function () {
            readAgainForBranch1 = false;
            readAgainForBranch2 = false;
            var chunk1 = chunk;
            var chunk2 = chunk;
            if (!canceled1 && !canceled2) {
              chunk2 = cloneOrCancel(chunk);
              if (chunk2 === undefined) {
                return;
              }
            }

            if (!canceled1) {
              byteControllerEnqueue(branch1._controller, chunk1);
            }

            if (!canceled2) {
              byteControllerEnqueue(branch2._controller, chunk2);
            }

            reading = false;
            if (readAgainForBranch1) {
              pull1Algorithm();
            } else if (readAgainForBranch2) {
              pull2Algorithm();
            }
          });
        },
        closeSteps: function () {
          reading = false;
          if (!canceled1) {
            byteControllerClose(branch1._controller);
          }

          if (!canceled2) {
            byteControllerClose(branch2._controller);
          }

          if (branch1._controller._pendingPullIntos.length > 0) {
            byteControllerRespond(branch1._controller, 0);
          }

          if (branch2._controller._pendingPullIntos.length > 0) {
            byteControllerRespond(branch2._controller, 0);
          }

          if (!canceled1 || !canceled2) {
            cancelDeferred.resolve(undefined);
          }
        },
        errorSteps: function () {
          reading = false;
        },
      });
    }

    function pullWithBYOBReader(view, forBranch2) {
      if (reader._byob !== true) {
        readableStreamDefaultReaderRelease(reader);
        reader = acquireReadableStreamBYOBReader(stream, RS, 'tee');
        forwardReaderError(reader);
      }

      var byobBranch = forBranch2 ? branch2 : branch1;
      var otherBranch = forBranch2 ? branch1 : branch2;
      readableStreamBYOBReaderRead(reader, view, 1, {
        chunkSteps: function (chunk) {
          enqueueMicrotask(function () {
            readAgainForBranch1 = false;
            readAgainForBranch2 = false;
            var byobCanceled = forBranch2 ? canceled2 : canceled1;
            var otherCanceled = forBranch2 ? canceled1 : canceled2;
            if (!otherCanceled) {
              var cloned = cloneOrCancel(chunk);
              if (cloned === undefined) {
                return;
              }

              if (!byobCanceled) {
                byteControllerRespondWithNewView(byobBranch._controller, chunk);
              }

              byteControllerEnqueue(otherBranch._controller, cloned);
            } else if (!byobCanceled) {
              byteControllerRespondWithNewView(byobBranch._controller, chunk);
            }

            reading = false;
            if (readAgainForBranch1) {
              pull1Algorithm();
            } else if (readAgainForBranch2) {
              pull2Algorithm();
            }
          });
        },
        closeSteps: function (chunk) {
          reading = false;
          var byobCanceled = forBranch2 ? canceled2 : canceled1;
          var otherCanceled = forBranch2 ? canceled1 : canceled2;
          if (!byobCanceled) {
            byteControllerClose(byobBranch._controller);
          }

          if (!otherCanceled) {
            byteControllerClose(otherBranch._controller);
          }

          if (chunk !== undefined) {
            if (!byobCanceled) {
              byteControllerRespondWithNewView(byobBranch._controller, chunk);
            }

            if (!otherCanceled && otherBranch._controller._pendingPullIntos.length > 0) {
              byteControllerRespond(otherBranch._controller, 0);
            }
          }

          if (!byobCanceled || !otherCanceled) {
            cancelDeferred.resolve(undefined);
          }
        },
        errorSteps: function () {
          reading = false;
        },
      });
    }

    function pullAlgorithmFor(forBranch2) {
      if (reading) {
        if (forBranch2) {
          readAgainForBranch2 = true;
        } else {
          readAgainForBranch1 = true;
        }

        return promiseResolvedWith(undefined);
      }

      reading = true;
      var request = byteControllerGetBYOBRequest((forBranch2 ? branch2 : branch1)._controller);
      if (request === null) {
        pullWithDefaultReader();
      } else {
        pullWithBYOBReader(request._view, forBranch2);
      }

      return promiseResolvedWith(undefined);
    }

    function pull1Algorithm() {
      return pullAlgorithmFor(false);
    }

    function pull2Algorithm() {
      return pullAlgorithmFor(true);
    }

    function cancel1Algorithm(reason) {
      canceled1 = true;
      reason1 = reason;
      if (canceled2) {
        cancelDeferred.resolve(readableStreamCancel(stream, [reason1, reason2]));
      }

      return cancelDeferred.promise;
    }

    function cancel2Algorithm(reason) {
      canceled2 = true;
      reason2 = reason;
      if (canceled1) {
        cancelDeferred.resolve(readableStreamCancel(stream, [reason1, reason2]));
      }

      return cancelDeferred.promise;
    }

    branch1 = createReadableByteStream(noop, pull1Algorithm, cancel1Algorithm);
    branch2 = createReadableByteStream(noop, pull2Algorithm, cancel2Algorithm);
    forwardReaderError(reader);
    return [branch1, branch2];
  }

  module.exports = {
    ReadableStream: ReadableStream,
    ReadableStreamDefaultReader: ReadableStreamDefaultReader,
    ReadableStreamBYOBReader: ReadableStreamBYOBReader,
    ReadableStreamDefaultController: ReadableStreamDefaultController,
    ReadableByteStreamController: ReadableByteStreamController,
    ReadableStreamBYOBRequest: ReadableStreamBYOBRequest,
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
