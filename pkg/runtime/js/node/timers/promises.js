// node:timers/promises — promise-based timers backed by the global timer
// functions (setTimeout/setImmediate) and the event loop. All accept an
// AbortSignal via options.signal. Like Node, an abort always rejects with an
// AbortError ("The operation was aborted") and carries the signal's reason as
// the error's `cause` (so e.g. AbortSignal.timeout surfaces as cause.name
// === "TimeoutError").
(function (require, module, _exports) {
  'use strict';

  function abortError(signal) {
    var err = new Error('The operation was aborted');
    err.name = 'AbortError';
    err.code = 'ABORT_ERR';
    if (signal && signal.reason !== undefined) err.cause = signal.reason;
    return err;
  }

  function setTimeoutPromise(delay, value, options) {
    options = options || {};
    var signal = options.signal;
    return new Promise(function (resolve, reject) {
      if (signal && signal.aborted) {
        reject(abortError(signal));
        return;
      }
      var onAbort = null;
      var timer = setTimeout(function () {
        if (onAbort) signal.removeEventListener('abort', onAbort);
        resolve(value);
      }, delay);
      if (signal && typeof signal.addEventListener === 'function') {
        onAbort = function () {
          clearTimeout(timer);
          reject(abortError(signal));
        };
        signal.addEventListener('abort', onAbort);
      }
    });
  }

  function setImmediatePromise(value, options) {
    options = options || {};
    var signal = options.signal;
    return new Promise(function (resolve, reject) {
      if (signal && signal.aborted) {
        reject(abortError(signal));
        return;
      }
      var onAbort = null;
      var timer = setImmediate(function () {
        if (onAbort) signal.removeEventListener('abort', onAbort);
        resolve(value);
      });
      if (signal && typeof signal.addEventListener === 'function') {
        onAbort = function () {
          clearImmediate(timer);
          reject(abortError(signal));
        };
        signal.addEventListener('abort', onAbort);
      }
    });
  }

  async function* setIntervalAsync(delay, value, options) {
    options = options || {};
    var signal = options.signal;
    if (signal && signal.aborted) throw abortError(signal);

    // A single repeating setInterval buffers missed ticks so a slow consumer
    // catches up immediately rather than drifting by one full delay per tick.
    var queue = []; // pending ticks not yet consumed
    var waiting = null; // resolve fn for a parked next() call, if any
    var aborted = false;
    var abortErr = null;
    var timer = null;

    function onTick() {
      if (aborted) return;
      if (waiting) {
        var r = waiting;
        waiting = null;
        r(false);
      } else {
        queue.push(true);
      }
    }

    function stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      if (signal) signal.removeEventListener('abort', onAbort);
    }

    function onAbort() {
      aborted = true;
      abortErr = abortError(signal);
      stop();
      if (waiting) {
        var r = waiting;
        waiting = null;
        r(true);
      }
    }

    timer = setInterval(onTick, delay);
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onAbort);
    }

    try {
      while (true) {
        if (aborted) throw abortErr;
        if (queue.length > 0) {
          queue.shift();
        } else {
          var didAbort = await new Promise(function (r) {
            waiting = r;
          });
          if (didAbort) throw abortErr;
        }
        yield value;
      }
    } finally {
      stop();
    }
  }

  var scheduler = {
    wait: function (delay, options) {
      return setTimeoutPromise(delay, undefined, options);
    },
    yield: function () {
      return setImmediatePromise(undefined);
    },
  };

  module.exports = {
    setTimeout: setTimeoutPromise,
    setImmediate: setImmediatePromise,
    setInterval: setIntervalAsync,
    scheduler: scheduler,
  };
});
