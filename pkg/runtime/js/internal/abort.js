// AbortController / AbortSignal (WHATWG DOM standard, also used across Node).
// Installed as globals at module-eval. AbortSignal derives from internal/event_target's
// EventTarget and fires its `abort` event through that module's dispatch.
(function (require, module, _exports) {
  'use strict';

  var ABORT = 'abort';
  var P = require('internal/primordials');
  var DOMException = require('internal/domexception').DOMException;
  var eventTarget = require('internal/event_target');
  var webErrors = require('internal/web_errors');
  var defineInterface = require('internal/native_shape').defineInterface;
  var ArrayFrom = P.ArrayFrom;
  var ArrayPrototypePush1 = P.ArrayPrototypePush1;
  var TypeErrorP = P.TypeError;
  var EventTargetImpl = eventTarget.EventTargetImpl;
  var attachHandler = eventTarget.attachHandler;
  var detachHandler = eventTarget.detachHandler;
  var fireEvent = eventTarget.fireEvent;
  var typeError = webErrors.typeError;
  var pageError = webErrors.pageError;
  var illegalInvocation = webErrors.illegalInvocation;

  // The default reasons are DOMExceptions (name AbortError/TimeoutError, legacy code
  // 20/23, no own `code`) with Chrome 158's text (tests/web/cases/abort-reason-shape.expected).
  // pageError gives each the stack a page sees in Chrome: from the page's own frame,
  // none of this file's.
  function abortError() {
    return pageError(new DOMException('signal is aborted without reason', 'AbortError'));
  }

  function timeoutError() {
    return pageError(new DOMException('signal timed out', 'TimeoutError'));
  }

  // The platform mints signals through newSignal; a page reaches native_shape's
  // interface object, which refuses construction itself (`illegal`), so the token
  // check below only keeps internal code honest.
  var INTERNAL = { __proto__: null };

  // Brand readers and the abort steps, assigned in the static block below — the one
  // place outside the class body that may name the private fields.
  var isSignal;
  var newSignal;
  var abortedSignal;
  var signalAborted;
  var signalReason;
  var signalAbort;
  var addAbortAlgorithm;
  var follow;
  var readOnabort;

  /**
   * AbortSignal (DOM Standard §3.2): an EventTarget whose one event is `abort`.
   * @node n/a — Chrome 158: tests/web/cases/abort-*.expected, shape-abort.expected and
   *   events-target.expected (the `abort` event is trusted; `onabort` takes its place
   *   in listener order when first set; a page's own `abort` Event runs the listeners
   *   without aborting the signal).
   * @deviates A signal from AbortSignal.any() follows the signals it was given, not
   *   their own sources (the standard flattens a dependent source to its sources), and
   *   a live source holds it strongly until that source aborts, where the standard
   *   holds dependents weakly.
   */
  class AbortSignal extends EventTargetImpl {
    #aborted = false;
    #reason = undefined;
    #onabort = null;
    // The listener entry `onabort` occupies while it is non-null.
    #handler = null;
    // The standard's abort algorithms: internal steps run before the event fires (a
    // listener's `signal` option).
    #algorithms = [];
    // Signals from AbortSignal.any() that abort with this one.
    #dependents = null;

    constructor(token) {
      if (token !== INTERNAL) throw new TypeErrorP('Illegal constructor');
      super();
    }

    get aborted() {
      if (!isSignal(this)) throw illegalInvocation();
      return this.#aborted;
    }

    get reason() {
      if (!isSignal(this)) throw illegalInvocation();
      return this.#reason;
    }

    get onabort() {
      if (!isSignal(this)) throw illegalInvocation();
      return this.#onabort;
    }

    set onabort(fn) {
      if (!isSignal(this)) throw illegalInvocation();
      this.#onabort = typeof fn === 'function' ? fn : null;
      if (this.#onabort !== null && this.#handler === null) {
        this.#handler = attachHandler(this, ABORT, readOnabort);
      } else if (this.#onabort === null && this.#handler !== null) {
        detachHandler(this, ABORT, this.#handler);
        this.#handler = null;
      }
    }

    throwIfAborted() {
      if (!isSignal(this)) throw illegalInvocation();
      if (this.#aborted) throw this.#reason;
    }

    static {
      isSignal = function (o) {
        return typeof o === 'object' && o !== null && #aborted in o;
      };
      newSignal = function () {
        return new AbortSignal(INTERNAL);
      };
      abortedSignal = function (reason) {
        var signal = new AbortSignal(INTERNAL);
        signal.#aborted = true;
        signal.#reason = reason === undefined ? abortError() : reason;
        return signal;
      };
      signalAborted = function (signal) {
        return signal.#aborted;
      };
      signalReason = function (signal) {
        return signal.#reason;
      };
      readOnabort = function (signal) {
        return signal.#onabort;
      };
      addAbortAlgorithm = function (signal, algorithm) {
        if (!signal.#aborted) ArrayPrototypePush1(signal.#algorithms, algorithm);
      };
      follow = function (dependent, source) {
        if (source.#dependents === null) source.#dependents = [];
        ArrayPrototypePush1(source.#dependents, dependent);
      };
      // Algorithms are dropped once run: an aborted signal never runs them again, and
      // what they close over (a listener's whole target) becomes collectable.
      var runAbortSteps = function (signal) {
        var algorithms = signal.#algorithms;
        signal.#algorithms = [];
        for (var i = 0; i < algorithms.length; i++) algorithms[i]();
        fireEvent(signal, ABORT);
      };
      // The standard's "signal abort": the reason goes on the signal and on every
      // dependent first; then each runs its abort steps (its algorithms, then the
      // trusted `abort` event), the signal before its dependents.
      signalAbort = function (signal, reason) {
        if (signal.#aborted) return;
        signal.#aborted = true;
        signal.#reason = reason === undefined ? abortError() : reason;
        var dependents = signal.#dependents;
        signal.#dependents = null;
        var toAbort = [];
        if (dependents !== null) {
          for (var i = 0; i < dependents.length; i++) {
            var dependent = dependents[i];
            if (dependent.#aborted) continue;
            dependent.#aborted = true;
            dependent.#reason = signal.#reason;
            ArrayPrototypePush1(toAbort, dependent);
          }
        }

        runAbortSteps(signal);
        for (var j = 0; j < toAbort.length; j++) runAbortSteps(toAbort[j]);
      };
    }
  }

  AbortSignal.abort = function (reason) {
    return abortedSignal(reason);
  };

  AbortSignal.timeout = function (delay) {
    var signal = newSignal();
    var timer = setTimeout(function () {
      signalAbort(signal, timeoutError());
    }, delay);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return signal;
  };

  AbortSignal.any = function (signals) {
    if (!signals || typeof signals[Symbol.iterator] !== 'function') {
      // WebIDL's sequence conversion: a non-object is refused before its iterator is
      // looked at (tests/web/cases/abort-errors.expected).
      throw typeError(
        'AbortSignal',
        'any',
        signals === null || (typeof signals !== 'object' && typeof signals !== 'function')
          ? 'The provided value cannot be converted to a sequence.'
          : 'The object must have a callable @@iterator property.',
      );
    }
    var list = ArrayFrom(signals);
    for (var i = 0; i < list.length; i++) {
      if (!isSignal(list[i])) {
        throw typeError('AbortSignal', 'any', "Failed to convert value to 'AbortSignal'.");
      }
    }

    // A source already aborted gives a signal born aborted, with no event.
    for (var j = 0; j < list.length; j++) {
      if (signalAborted(list[j])) return abortedSignal(signalReason(list[j]));
    }

    var combined = newSignal();
    for (var k = 0; k < list.length; k++) follow(combined, list[k]);
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
      signalAbort(this.#signal, reason);
    }
  }

  // The interface objects a page sees (internal/native_shape), in Blink's member order
  // (Chrome 158, tests/web/cases/shape-abort.expected).
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
    parent: eventTarget.EventTarget,
    statics: ['abort:0', 'any:1', 'timeout:1'],
    members: ['aborted', 'reason', 'onabort', 'throwIfAborted:0', 'constructor', '@@toStringTag'],
  });

  module.exports = P.ObjectFreeze({
    __proto__: null,
    AbortController: PublicAbortController,
    AbortSignal: PublicAbortSignal,
    // For internal/event_target's `signal` option.
    isSignal: isSignal,
    signalAborted: signalAborted,
    addAbortAlgorithm: addAbortAlgorithm,
  });
});
