// node:events — EventEmitter plus the static helpers (once, on, getEventListeners,
// get/setMaxListeners, listenerCount, addAbortListener).
//
// How this module stays immune to user code that mutates intrinsics:
//   * It is EAGER — the loader instantiates it before user code (it is in
//     lazy_builtins_test's STATIC_EAGER set) — so every capture below is pristine.
//   * A LISTENER is caller-supplied and may carry its own `call`/`apply` or a swapped
//     prototype. node invokes it with ReflectApply, which reads neither (node 26.13,
//     probed; pinned by tests/node-compat/cases/72-events-parity.js "invoke:").
//     Lava spells the same thing `apply.call(listener, thisArg, args)` on the
//     CAPTURED apply: Function.prototype.call/apply/bind are locked before user code
//     (#450), so neither read can be steered and the listener's own properties are
//     never consulted. Not ReflectApply and not the FunctionPrototypeApply wrapper,
//     because both stop JSC from sinking emit()'s rest array on the no-listener
//     path. Scratch micro, Linux arm64 JSC 2.52.6, best of 5 x 1e6 emit() calls per
//     launch, 2-3 launches per variant: a miss took 1.6 ms with `apply.call` and
//     20-25 ms with either alternative; one listener 2.5 ms vs 3.8-4.1 through the
//     wrapper. The ratchet still counts these sites as `invoke`; each carries a
//     marker until the detector can tell a captured callee from a caller-supplied one.
//   * Data this module owns is handled with plain language on objects it created:
//     `_events` is a null-prototype object, listener arrays are written by index and
//     copied by array literal, so a replaced Array.prototype.push/unshift/splice/
//     slice or a poisoned Symbol.species never reaches emit(). Pinned, Lava-only, by
//     cmd/lava/primordials_test.odin (primordials_ and events_pollution_immunity) —
//     node's own emitter uses a live push and is not immune, so no oracle can.
//   * Per-instance null-prototype objects come from ObjectCreate(null), not a
//     `{ __proto__: null }` literal: JSC sinks the first and not the second (0.3 vs
//     31.9 ms per 1e6 allocations, Linux arm64 JSC 2.52.6, best of 5, 3 launches).
//     The literal is fine for a once-per-call options bag.
(function (require, module) {
  'use strict';

  var P = require('internal/primordials');
  var ReflectOwnKeys = P.ReflectOwnKeys;
  var ObjectCreate = P.ObjectCreate;
  var ObjectGetPrototypeOf = P.ObjectGetPrototypeOf;
  var ArrayIsArray = P.ArrayIsArray;
  var ArrayPrototypePop = P.ArrayPrototypePop;
  var ArrayPrototypeUnshift = P.ArrayPrototypeUnshift;
  var PromiseResolve = P.PromiseResolve;
  var PromiseReject = P.PromiseReject;
  var PromiseCtor = P.Promise;
  var ErrorCtor = P.Error;
  var TypeErrorCtor = P.TypeError;
  var SymbolAsyncIterator = P.Symbol.asyncIterator;
  // Symbol.dispose is absent from older JSC builds; the disposable then has no key.
  var SymbolDispose = P.Symbol.dispose;

  // The captured apply, invoked as `apply.call(listener, thisArg, args)`. See the
  // header for why this and not ReflectApply or the FunctionPrototypeApply wrapper.
  var apply = Function.prototype.apply;

  var errors = require('internal/errors');
  var ERR_INVALID_ARG_TYPE = errors.ERR_INVALID_ARG_TYPE;
  var ERR_OUT_OF_RANGE = errors.ERR_OUT_OF_RANGE;

  // `options` stand-in for on(): a missing options object must not inherit `signal`
  // from a poisoned Object.prototype. node defaults to its frozen kEmptyObject too.
  var kEmptyObject = P.ObjectFreeze({ __proto__: null });

  function EventEmitter() {
    // A live read of EventEmitter.init, and a plain `.call` on it, because node does
    // both: a program that replaces EventEmitter.init (or gives the replacement its
    // own `call`) sees it run on every construction, on node and here. The ratchet
    // counts this `invoke`, correctly: it IS steerable, by design.
    EventEmitter.init.call(this);
  }

  EventEmitter.init = function () {
    if (this._events === undefined || this._events === ObjectGetPrototypeOf(this)._events) {
      this._events = ObjectCreate(null);
      this._eventsCount = 0;
    }
    this._maxListeners = this._maxListeners || undefined;
  };

  EventEmitter.prototype._events = undefined;
  EventEmitter.prototype._maxListeners = undefined;

  // The argument checks, each made once at the public entry; everything below them
  // trusts its data. The listener message is not node's yet (no code, no "Received"
  // tail; #432) and stays as it was: this rewrite changes no observable behavior.
  function checkListener(listener) {
    if (typeof listener !== 'function') {
      throw new TypeErrorCtor('The "listener" argument must be of type function');
    }
  }

  function validateMaxListeners(n) {
    if (typeof n !== 'number') throw ERR_INVALID_ARG_TYPE('setMaxListeners', 'number', n);
    if (n < 0 || n !== n) throw ERR_OUT_OF_RANGE('setMaxListeners', '>= 0', n);
  }

  // node's arrayClone: an array literal for the common sizes, an index loop past
  // them. A literal DEFINES its elements, so neither a replaced Array.prototype
  // method, Symbol.species, nor an index setter on Array.prototype sees the copy;
  // the loop's writes walk the prototype chain like any push does. A literal is also
  // the cheapest copy on JSC, which matters because emit() takes one per call.
  function arrayClone(list) {
    switch (list.length) {
      case 2:
        return [list[0], list[1]];
      case 3:
        return [list[0], list[1], list[2]];
      case 4:
        return [list[0], list[1], list[2], list[3]];
      case 5:
        return [list[0], list[1], list[2], list[3], list[4]];
      case 6:
        return [list[0], list[1], list[2], list[3], list[4], list[5]];
    }
    var copy = [];
    for (var i = 0; i < list.length; i++) copy[i] = list[i];
    return copy;
  }

  // node's spliceOne: shift the tail down over `index`, then drop the last slot. The
  // captured pop, not `list.length -= 1`: the length write measured 1.5x pop on
  // Linux arm64 JSC (35.8 vs 24.1 ms per 1e6 two-element splices, best of 5, 3 launches).
  function spliceOne(list, index) {
    for (; index + 1 < list.length; index++) list[index] = list[index + 1];
    ArrayPrototypePop(list);
  }

  EventEmitter.prototype.setMaxListeners = function (n) {
    validateMaxListeners(n);
    this._maxListeners = n;
    return this;
  };

  EventEmitter.prototype.getMaxListeners = function () {
    // Read the live default so events.setMaxListeners(n) (and EventEmitter.defaultMaxListeners = n)
    // take effect on instances that never set their own limit.
    return this._maxListeners === undefined ? EventEmitter.defaultMaxListeners : this._maxListeners;
  };

  function addListener(target, type, listener, prepend) {
    checkListener(listener);
    // Live init, as in the constructor; an emitter built by Object.create(proto) lands here.
    if (target._events === undefined) EventEmitter.init.call(target);
    var events = target._events;
    if (events.newListener !== undefined) {
      target.emit(
        'newListener',
        type,
        listener.listener !== undefined ? listener.listener : listener,
      );
      // A newListener handler may have rebuilt _events (removeAllListeners does).
      events = target._events;
    }
    var existing = events[type];
    if (existing === undefined) {
      // One listener is stored bare; the array only appears with the second.
      events[type] = listener;
      target._eventsCount++;
    } else if (typeof existing === 'function') {
      events[type] = prepend ? [listener, existing] : [existing, listener];
    } else if (prepend) {
      ArrayPrototypeUnshift(existing, listener);
    } else {
      existing[existing.length] = listener;
    }
    return target;
  }

  EventEmitter.prototype.addListener = function (type, listener) {
    return addListener(this, type, listener, false);
  };
  EventEmitter.prototype.on = EventEmitter.prototype.addListener;

  EventEmitter.prototype.prependListener = function (type, listener) {
    return addListener(this, type, listener, true);
  };

  function onceWrap(target, type, listener) {
    var fired = false;
    function wrapped() {
      if (fired) return;
      fired = true;
      target.removeListener(type, wrapped);
      // A ratchet false positive, like the two in emit(): captured `apply`, locked `.call`.
      return apply.call(listener, target, arguments); // primordials-ok: invoke
    }
    wrapped.listener = listener;
    return wrapped;
  }

  EventEmitter.prototype.once = function (type, listener) {
    checkListener(listener);
    // Route through this.on (not the internal addListener): Node does the same,
    // and subclasses that override on() to observe listener registration —
    // node:stream Readable arms flow/'readable' plumbing there — must see
    // once() registrations too.
    this.on(type, onceWrap(this, type, listener));
    return this;
  };

  EventEmitter.prototype.prependOnceListener = function (type, listener) {
    checkListener(listener);
    this.prependListener(type, onceWrap(this, type, listener));
    return this;
  };

  EventEmitter.prototype.removeListener = function (type, listener) {
    var events = this._events;
    if (events === undefined) return this;
    var list = events[type];
    if (list === undefined) return this;
    if (list === listener || list.listener === listener) {
      if (--this._eventsCount === 0) this._events = ObjectCreate(null);
      else {
        delete events[type];
        if (events.removeListener !== undefined) {
          this.emit('removeListener', type, list.listener || listener);
        }
      }
    } else if (typeof list !== 'function') {
      // Last match wins, as in node: removing one of two identical registrations
      // takes the most recent.
      var position = -1;
      for (var i = list.length - 1; i >= 0; i--) {
        if (list[i] === listener || list[i].listener === listener) {
          position = i;
          break;
        }
      }
      if (position < 0) return this;
      var removed = list[position];
      spliceOne(list, position);
      if (list.length === 1) events[type] = list[0];
      if (events.removeListener !== undefined) {
        this.emit('removeListener', type, removed.listener || listener);
      }
    }
    return this;
  };
  EventEmitter.prototype.off = EventEmitter.prototype.removeListener;

  EventEmitter.prototype.removeAllListeners = function (type) {
    var events = this._events;
    if (events === undefined) return this;
    // Without a removeListener listener nobody can observe the order, so drop in bulk.
    if (events.removeListener === undefined) {
      if (arguments.length === 0) {
        this._events = ObjectCreate(null);
        this._eventsCount = 0;
      } else if (events[type] !== undefined) {
        if (--this._eventsCount === 0) this._events = ObjectCreate(null);
        else delete events[type];
      }
      return this;
    }
    if (arguments.length === 0) {
      var keys = ReflectOwnKeys(events);
      for (var k = 0; k < keys.length; k++) {
        if (keys[k] !== 'removeListener') this.removeAllListeners(keys[k]);
      }
      this.removeAllListeners('removeListener');
      this._events = ObjectCreate(null);
      this._eventsCount = 0;
      return this;
    }
    // LIFO, so 'removeListener' fires in reverse registration order, as in node.
    var listeners = events[type];
    if (typeof listeners === 'function') {
      this.removeListener(type, listeners);
    } else if (listeners !== undefined) {
      for (var i = listeners.length - 1; i >= 0; i--) this.removeListener(type, listeners[i]);
    }
    return this;
  };

  EventEmitter.prototype.emit = function (type, ...args) {
    var events = this._events;
    var handler = events === undefined ? undefined : events[type];
    if (handler === undefined) {
      if (type === 'error') {
        var err = args[0];
        if (err instanceof ErrorCtor) throw err;
        var e = new ErrorCtor('Unhandled error.' + (err !== undefined ? ' (' + err + ')' : ''));
        e.context = err;
        throw e;
      }
      return false;
    }
    // Both `apply.call` sites are false positives for the ratchet: `apply` is the
    // captured Function.prototype.apply and `.call` is locked (#450).
    if (typeof handler === 'function') {
      apply.call(handler, this, args); // primordials-ok: invoke
    } else {
      // A snapshot: listeners added or removed by a listener take effect next emit.
      var listeners = arrayClone(handler);
      for (var i = 0; i < listeners.length; i++) {
        apply.call(listeners[i], this, args); // primordials-ok: invoke
      }
    }
    return true;
  };

  EventEmitter.prototype.listeners = function (type) {
    var events = this._events;
    var handler = events === undefined ? undefined : events[type];
    if (handler === undefined) return [];
    if (typeof handler === 'function') return [handler.listener || handler];
    var copy = arrayClone(handler);
    for (var i = 0; i < copy.length; i++) copy[i] = copy[i].listener || copy[i];
    return copy;
  };

  EventEmitter.prototype.rawListeners = function (type) {
    var events = this._events;
    var handler = events === undefined ? undefined : events[type];
    if (handler === undefined) return [];
    return typeof handler === 'function' ? [handler] : arrayClone(handler);
  };

  EventEmitter.prototype.listenerCount = function (type, listener) {
    var events = this._events;
    var handler = events === undefined ? undefined : events[type];
    if (handler === undefined) return 0;
    if (typeof handler === 'function') {
      if (listener === undefined) return 1;
      return handler === listener || handler.listener === listener ? 1 : 0;
    }
    if (listener === undefined) return handler.length;
    var count = 0;
    for (var i = 0; i < handler.length; i++) {
      if (handler[i] === listener || handler[i].listener === listener) count++;
    }
    return count;
  };

  EventEmitter.prototype.eventNames = function () {
    return this._eventsCount > 0 ? ReflectOwnKeys(this._events) : [];
  };

  // --- static helpers (Node parity) ---

  function isAbortSignal(s) {
    return s != null && typeof s.addEventListener === 'function' && 'aborted' in s;
  }

  function makeAbortError() {
    var e = new ErrorCtor('The operation was aborted');
    e.name = 'AbortError';
    e.code = 'ABORT_ERR';
    return e;
  }

  // once(emitter, name[, options]) — resolves with the emitted arguments on the next
  // matching event, or rejects if 'error' fires first or options.signal aborts.
  function once(emitter, name, options) {
    // Node's validateObject(options, 'options'): undefined is the only non-object
    // allowed; null, scalars, arrays and functions reject (node 26.13.0, probed;
    // pinned by tests/node-compat/cases/72-events-parity.js). Rejects rather than
    // throws because node's once is an async function.
    if (
      options !== undefined &&
      (options === null || typeof options !== 'object' || ArrayIsArray(options))
    ) {
      return PromiseReject(ERR_INVALID_ARG_TYPE('options', 'object', options));
    }
    var signal = options && options.signal;
    if (signal !== undefined) {
      if (!isAbortSignal(signal)) {
        return PromiseReject(ERR_INVALID_ARG_TYPE('options.signal', 'AbortSignal', signal));
      }
      if (signal.aborted) return PromiseReject(makeAbortError());
    }
    return new PromiseCtor(function (resolve, reject) {
      var errorListener;
      var abortListener;
      function cleanup() {
        if (typeof emitter.removeListener === 'function') {
          emitter.removeListener(name, eventListener);
          if (errorListener !== undefined) emitter.removeListener('error', errorListener);
        } else if (typeof emitter.removeEventListener === 'function') {
          emitter.removeEventListener(name, eventListener);
        }
        if (abortListener !== undefined) signal.removeEventListener('abort', abortListener);
      }
      function eventListener(...args) {
        cleanup();
        resolve(args);
      }
      if (signal !== undefined) {
        abortListener = function () {
          cleanup();
          reject(makeAbortError());
        };
        signal.addEventListener('abort', abortListener, { __proto__: null, once: true });
      }
      if (typeof emitter.once === 'function') {
        if (name !== 'error') {
          errorListener = function (err) {
            cleanup();
            reject(err);
          };
          emitter.once('error', errorListener);
        }
        emitter.once(name, eventListener);
      } else if (typeof emitter.addEventListener === 'function') {
        emitter.addEventListener(name, eventListener, { __proto__: null, once: true });
      } else {
        cleanup();
        reject(ERR_INVALID_ARG_TYPE('emitter', 'EventEmitter', emitter));
      }
    });
  }

  // events.getEventListeners(emitter, name) — the listeners for `name`.
  function getEventListeners(emitterOrTarget, name) {
    if (typeof emitterOrTarget.listeners === 'function') {
      return emitterOrTarget.listeners(name);
    }
    return []; // a DOM-style EventTarget keeps its listeners private here
  }

  // events.getMaxListeners(emitter).
  function getMaxListeners(emitterOrTarget) {
    if (typeof emitterOrTarget.getMaxListeners === 'function') {
      return emitterOrTarget.getMaxListeners();
    }
    return EventEmitter.defaultMaxListeners;
  }

  // events.setMaxListeners(n[, ...targets]) — with no targets, sets the global default.
  function setMaxListeners(n, ...targets) {
    n = n === undefined ? EventEmitter.defaultMaxListeners : n;
    validateMaxListeners(n);
    if (targets.length === 0) {
      EventEmitter.defaultMaxListeners = n;
      return;
    }
    for (var i = 0; i < targets.length; i++) {
      if (typeof targets[i].setMaxListeners === 'function') targets[i].setMaxListeners(n);
    }
  }

  // events.listenerCount(emitter, name) — the deprecated static form.
  function staticListenerCount(emitter, type) {
    return emitter.listenerCount(type);
  }

  // events.addAbortListener(signal, listener) — once-listener for 'abort' that fires even
  // if the signal is already aborted; returns a { [Symbol.dispose]() } to remove it.
  function addAbortListener(signal, listener) {
    if (!isAbortSignal(signal)) throw ERR_INVALID_ARG_TYPE('signal', 'AbortSignal', signal);
    if (typeof listener !== 'function') {
      throw ERR_INVALID_ARG_TYPE('listener', 'function', listener);
    }
    var removeEventListener;
    if (signal.aborted) {
      // Read live, not captured: bootstrap/microtasks.js installs queueMicrotask
      // AFTER the loader has instantiated this module (globals.odin install_microtasks),
      // so a module-eval capture would be undefined.
      queueMicrotask(function () {
        listener();
      });
    } else {
      signal.addEventListener('abort', listener, { __proto__: null, once: true });
      removeEventListener = function () {
        signal.removeEventListener('abort', listener);
      };
    }
    var disposable = {};
    if (SymbolDispose !== undefined) {
      disposable[SymbolDispose] = function () {
        if (removeEventListener) removeEventListener();
      };
    }
    return disposable;
  }

  // The FIFO behind each events.on() iterator's two queues. Never handed to user
  // code, so its slots live in a null-prototype object: an index write there walks no
  // prototype chain, where an Array's push/shift could be replaced and an
  // Array.prototype index setter would see every queued value.
  class Fifo {
    constructor() {
      this.slots = ObjectCreate(null);
      this.head = 0;
      this.tail = 0;
    }
    get size() {
      return this.tail - this.head;
    }
    enqueue(value) {
      this.slots[this.tail++] = value;
    }
    dequeue() {
      var value = this.slots[this.head];
      delete this.slots[this.head++];
      return value;
    }
  }

  // events.on(emitter, eventName[, options]) — an async iterator that yields the args of
  // each matching event. 'error' rejects; options.signal aborts; return()/throw() clean up.
  function on(emitter, event, options) {
    options = options || kEmptyObject;
    var signal = options.signal;
    if (signal !== undefined && !isAbortSignal(signal)) {
      throw ERR_INVALID_ARG_TYPE('options.signal', 'AbortSignal', signal);
    }
    if (signal && signal.aborted) throw makeAbortError();

    var unconsumedEvents = new Fifo();
    var unconsumedPromises = new Fifo();
    var error = null;
    var finished = false;

    var useEmitter = typeof emitter.on === 'function' && typeof emitter.off === 'function';
    if (!useEmitter && typeof emitter.addEventListener !== 'function') {
      throw ERR_INVALID_ARG_TYPE('emitter', 'EventEmitter', emitter);
    }
    function addListener(name, h) {
      if (useEmitter) emitter.on(name, h);
      else emitter.addEventListener(name, h);
    }
    function removeListener(name, h) {
      if (useEmitter) emitter.off(name, h);
      else emitter.removeEventListener(name, h);
    }

    function result(value, done) {
      return { value: value, done: done };
    }
    function eventHandler(...args) {
      if (unconsumedPromises.size > 0) unconsumedPromises.dequeue().resolve(result(args, false));
      else unconsumedEvents.enqueue(args);
    }
    function errorHandler(err) {
      if (unconsumedPromises.size > 0) unconsumedPromises.dequeue().reject(err);
      else error = err;
      closeHandler();
    }
    function abortHandler() {
      errorHandler(makeAbortError());
    }
    function removeAll() {
      removeListener(event, eventHandler);
      if (event !== 'error' && useEmitter) removeListener('error', errorHandler);
      if (signal) signal.removeEventListener('abort', abortHandler);
    }
    function closeHandler() {
      removeAll();
      finished = true;
      while (unconsumedPromises.size > 0) {
        unconsumedPromises.dequeue().resolve(result(undefined, true));
      }
    }

    addListener(event, eventHandler);
    if (event !== 'error' && useEmitter) addListener('error', errorHandler);
    if (signal) signal.addEventListener('abort', abortHandler, { __proto__: null, once: true });

    var iterator = {
      next: function () {
        if (unconsumedEvents.size > 0) {
          return PromiseResolve(result(unconsumedEvents.dequeue(), false));
        }
        if (error) {
          var e = error;
          error = null;
          return PromiseReject(e);
        }
        if (finished) return PromiseResolve(result(undefined, true));
        return new PromiseCtor(function (resolve, reject) {
          unconsumedPromises.enqueue({ resolve: resolve, reject: reject });
        });
      },
      return: function () {
        closeHandler();
        return PromiseResolve(result(undefined, true));
      },
      throw: function (err) {
        closeHandler();
        return PromiseReject(err);
      },
    };
    iterator[SymbolAsyncIterator] = function () {
      return this;
    };
    return iterator;
  }

  EventEmitter.EventEmitter = EventEmitter;
  EventEmitter.once = once;
  EventEmitter.on = on;
  EventEmitter.getEventListeners = getEventListeners;
  EventEmitter.getMaxListeners = getMaxListeners;
  EventEmitter.setMaxListeners = setMaxListeners;
  EventEmitter.listenerCount = staticListenerCount;
  EventEmitter.addAbortListener = addAbortListener;
  EventEmitter.defaultMaxListeners = 10;

  module.exports = EventEmitter;
  module.exports.EventEmitter = EventEmitter;
  module.exports.once = once;
  module.exports.on = on;
  module.exports.getEventListeners = getEventListeners;
  module.exports.getMaxListeners = getMaxListeners;
  module.exports.setMaxListeners = setMaxListeners;
  module.exports.listenerCount = staticListenerCount;
  module.exports.addAbortListener = addAbortListener;
});
