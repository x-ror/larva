// Helpers every Web Streams file shares — the Lava side of node's
// lib/internal/webstreams/util.js: the promise plumbing, the spec's queue-with-sizes,
// and the strategy extraction the three stream constructors run.
(function (require, module) {
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

  // ---- strategy extraction (node keeps these in util.js too) ------------------

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

  module.exports = {
    noop: noop,
    newPromise: newPromise,
    promiseFrom: promiseFrom,
    promiseResolvedWith: promiseResolvedWith,
    promiseRejectedWith: promiseRejectedWith,
    newDeferred: newDeferred,
    uponPromise: uponPromise,
    setPromiseIsHandled: setPromiseIsHandled,
    enqueueMicrotask: enqueueMicrotask,
    resetQueue: resetQueue,
    dequeueValue: dequeueValue,
    enqueueValueWithSize: enqueueValueWithSize,
    peekQueueValue: peekQueueValue,
    extractHighWaterMark: extractHighWaterMark,
    extractSizeAlgorithm: extractSizeAlgorithm,
  };
});
