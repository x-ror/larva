// AbortController / AbortSignal (WHATWG DOM standard, also used across Node).
// Installed as globals like Buffer. AbortSignal is a minimal EventTarget that
// only carries the "abort" event, which is all the platform uses it for.
(function (require, module, _exports) {
  'use strict';

  var ABORT = 'abort';
  var DOMException = require('internal/domexception').DOMException;
  var webErrors = require('internal/web_errors');
  var defineInterface = require('internal/native_shape').defineInterface;
  var web = webErrors.web;
  var typeError = webErrors.typeError;
  var pageError = webErrors.pageError;

  // The default reasons are DOMExceptions on both surfaces — Chrome's and node's shape
  // alike (name AbortError/TimeoutError, legacy code 20/23, no own `code`). Only the text
  // is per surface: Chrome 158's (tests/web/cases/abort-reason-shape.expected) on the
  // Window surface, node 26's on the Node one (probed: AbortSignal.abort().reason.message,
  // AbortSignal.timeout(1)'s reason after it fires). pageError gives each the stack a
  // page sees in Chrome: from the page's own frame, none of this file's.
  function abortError() {
    return pageError(
      new DOMException(
        web ? 'signal is aborted without reason' : 'This operation was aborted',
        'AbortError',
      ),
    );
  }

  function timeoutError() {
    return pageError(
      new DOMException(
        web ? 'signal timed out' : 'The operation was aborted due to timeout',
        'TimeoutError',
      ),
    );
  }

  // The implementation's constructor is never called: a page reaches native_shape's
  // interface object, which refuses construction itself (`illegal`), and the platform
  // mints signals through newSignal.
  function AbortSignal() {
    throw new TypeError('Illegal constructor');
  }

  // Internal constructor: AbortSignal is not directly constructable, so
  // controllers and the static factories mint instances through here.
  function newSignal() {
    var signal = Object.create(AbortSignal.prototype);
    signal._aborted = false;
    signal._reason = undefined;
    signal._listeners = [];
    signal._onabort = null;
    return signal;
  }

  function fireAbort(signal) {
    var event = { type: ABORT, target: signal, currentTarget: signal };
    if (typeof signal._onabort === 'function') {
      try {
        signal._onabort.call(signal, event);
      } catch (e) {
        reportOrIgnore(e);
      }
    }
    var listeners = signal._listeners.slice();
    for (var i = 0; i < listeners.length; i++) {
      if (listeners[i].once) {
        var at = signal._listeners.indexOf(listeners[i]);
        if (at !== -1) signal._listeners.splice(at, 1);
      }
      try {
        listeners[i].fn.call(signal, event);
      } catch (e) {
        reportOrIgnore(e);
      }
    }
  }

  // Node calls reportError() for listener throws; surface via console.error as a
  // best-effort equivalent (keeps throw from silently swallowing or propagating).
  function reportOrIgnore(e) {
    if (typeof console !== 'undefined' && typeof console.error === 'function') {
      console.error('Unhandled error in abort listener:', e);
    }
  }

  function runAbort(signal, reason) {
    if (signal._aborted) return;
    signal._aborted = true;
    signal._reason = reason === undefined ? abortError() : reason;
    fireAbort(signal);
    // An aborted signal can never fire again: drop every listener so their
    // closures (and anything they capture) become collectable immediately.
    signal._listeners.length = 0;
  }

  Object.defineProperty(AbortSignal.prototype, 'aborted', {
    get: function () {
      return this._aborted;
    },
    configurable: true,
  });
  Object.defineProperty(AbortSignal.prototype, 'reason', {
    get: function () {
      return this._reason;
    },
    configurable: true,
  });
  Object.defineProperty(AbortSignal.prototype, 'onabort', {
    get: function () {
      return this._onabort;
    },
    set: function (fn) {
      this._onabort = typeof fn === 'function' ? fn : null;
    },
    configurable: true,
  });
  AbortSignal.prototype.throwIfAborted = function () {
    if (this._aborted) throw this._reason;
  };
  function findListener(list, listener) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].fn === listener) return i;
    }
    return -1;
  }
  AbortSignal.prototype.addEventListener = function (type, listener, options) {
    if (type !== ABORT || typeof listener !== 'function') return;
    if (findListener(this._listeners, listener) === -1) {
      this._listeners.push({ fn: listener, once: !!(options && options.once) });
    }
  };
  AbortSignal.prototype.removeEventListener = function (type, listener) {
    if (type !== ABORT) return;
    var index = findListener(this._listeners, listener);
    if (index !== -1) this._listeners.splice(index, 1);
  };
  AbortSignal.prototype.dispatchEvent = function (event) {
    if (event && event.type === ABORT) fireAbort(this);
    return true;
  };

  AbortSignal.abort = function (reason) {
    var signal = newSignal();
    signal._aborted = true;
    signal._reason = reason === undefined ? abortError() : reason;
    return signal;
  };

  AbortSignal.timeout = function (delay) {
    var signal = newSignal();
    var timer = setTimeout(function () {
      runAbort(signal, timeoutError());
    }, delay);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return signal;
  };

  AbortSignal.any = function (signals) {
    if (!signals || typeof signals[Symbol.iterator] !== 'function') {
      // WebIDL's sequence conversion: a non-object is refused before its iterator is
      // looked at (tests/web/cases/abort-errors.expected).
      if (!web) {
        throw new TypeError('AbortSignal.any requires an iterable');
      }

      throw typeError(
        'AbortSignal',
        'any',
        signals === null || (typeof signals !== 'object' && typeof signals !== 'function')
          ? 'The provided value cannot be converted to a sequence.'
          : 'The object must have a callable @@iterator property.',
      );
    }
    var combined = newSignal();
    var list = Array.from(signals);
    for (var i = 0; i < list.length; i++) {
      if (list[i]._aborted) {
        runAbort(combined, list[i]._reason);
        return combined;
      }
    }
    // Keep per-source listeners so we can unsubscribe them all once the combined
    // signal fires — prevents a leak on long-lived parent signals.
    var handlers = [];
    function onSourceAbort(source) {
      return function () {
        // Remove all handlers from all sources before triggering the combined abort.
        for (var j = 0; j < list.length; j++) {
          list[j].removeEventListener(ABORT, handlers[j]);
        }
        runAbort(combined, source._reason);
      };
    }
    for (var k = 0; k < list.length; k++) {
      var handler = onSourceAbort(list[k]);
      handlers.push(handler);
      list[k].addEventListener(ABORT, handler);
    }
    return combined;
  };

  // A class: the call-without-new text is native_shape's interface object's, and the
  // signal lives in a private field behind Blink's `signal` accessor on the prototype
  // (no own property on the instance, as in Chrome).
  class AbortController {
    #signal = newSignal();

    get signal() {
      return this.#signal;
    }

    abort(reason) {
      runAbort(this.#signal, reason);
    }
  }

  // The interface objects a page sees (internal/native_shape), in Blink's member order
  // (Chrome 158, tests/web/cases/shape-abort.expected). AbortSignal's EventTarget
  // methods are its own until EventTarget exists (a known gap of shape-abort).
  var PublicAbortController = defineInterface({
    name: 'AbortController',
    impl: AbortController,
    length: 0,
    members: ['signal', 'abort:0', 'constructor', '@@toStringTag'],
  });
  var PublicAbortSignal = defineInterface({
    name: 'AbortSignal',
    impl: AbortSignal,
    length: 0,
    illegal: true,
    statics: ['abort:0', 'any:1', 'timeout:1'],
    members: [
      // EventTarget's, here until EventTarget exists; first, so Blink's own order
      // follows them.
      'addEventListener:2',
      'removeEventListener:2',
      'dispatchEvent:1',
      'aborted',
      'reason',
      'onabort',
      'throwIfAborted:0',
      'constructor',
      '@@toStringTag',
    ],
  });

  module.exports = { AbortController: PublicAbortController, AbortSignal: PublicAbortSignal };
});
