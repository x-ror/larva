// node:events — EventEmitter plus the static once(emitter, name) helper.
// Pure JS; the common synchronous + Promise-based surface real code relies on.
(function (require, module) {
  'use strict';

  // Pristine intrinsics (see primordials.js) so a script that mutates
  // Array.prototype/Object/etc. cannot alter EventEmitter's internal bookkeeping.
  var P = require('primordials');
  var defaultMaxListeners = 10;

  // Species-free array helpers. Array.prototype.slice/map/splice consult
  // constructor[Symbol.species] (ArraySpeciesCreate), so a polluted species could
  // throw inside emit()/listeners() before any listener runs. These copy/remove via
  // an array literal and index access only — no prototype method, no species — so a
  // listener array cannot be hijacked through @@species (matches Node's arrayClone/
  // spliceOne).
  function arrayClone(arr) {
    var n = arr.length;
    var copy = [];
    for (var i = 0; i < n; i++) copy[i] = arr[i];
    return copy;
  }
  function spliceOne(list, index) {
    for (; index + 1 < list.length; index++) list[index] = list[index + 1];
    P.ArrayPrototypePop(list);
  }

  function EventEmitter() {
    EventEmitter.init.call(this);
  }

  EventEmitter.init = function () {
    if (this._events === undefined || this._events === P.ObjectGetPrototypeOf(this)._events) {
      this._events = P.ObjectCreate(null);
      this._eventsCount = 0;
    }
    this._maxListeners = this._maxListeners || undefined;
  };

  EventEmitter.prototype._events = undefined;
  EventEmitter.prototype._maxListeners = undefined;

  function validateMaxListeners(n) {
    if (typeof n !== 'number') {
      throw typeError('setMaxListeners', 'of type number', n);
    }
    if (n < 0 || n !== n) {
      var e = new RangeError(
        'The value of "setMaxListeners" is out of range. It must be >= 0. Received ' + n,
      );
      e.code = 'ERR_OUT_OF_RANGE';
      throw e;
    }
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
    if (typeof listener !== 'function') {
      throw new TypeError('The "listener" argument must be of type function');
    }
    if (target._events === undefined) EventEmitter.init.call(target);
    var events = target._events;
    if (events.newListener !== undefined) {
      target.emit(
        'newListener',
        type,
        listener.listener !== undefined ? listener.listener : listener,
      );
      events = target._events;
    }
    var existing = events[type];
    if (existing === undefined) {
      events[type] = listener;
      target._eventsCount++;
    } else if (typeof existing === 'function') {
      events[type] = prepend ? [listener, existing] : [existing, listener];
    } else if (prepend) {
      P.ArrayPrototypeUnshift(existing, listener);
    } else {
      P.ArrayPrototypePush(existing, listener);
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
      return P.FunctionPrototypeApply(listener, target, arguments);
    }
    wrapped.listener = listener;
    return wrapped;
  }

  EventEmitter.prototype.once = function (type, listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('The "listener" argument must be of type function');
    }
    // Route through this.on (not the internal addListener): Node does the same,
    // and subclasses that override on() to observe listener registration —
    // node:stream Readable arms flow/'readable' plumbing there — must see
    // once() registrations too.
    this.on(type, onceWrap(this, type, listener));
    return this;
  };

  EventEmitter.prototype.prependOnceListener = function (type, listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('The "listener" argument must be of type function');
    }
    this.prependListener(type, onceWrap(this, type, listener));
    return this;
  };

  EventEmitter.prototype.removeListener = function (type, listener) {
    if (this._events === undefined) return this;
    var events = this._events;
    var list = events[type];
    if (list === undefined) return this;
    if (list === listener || list.listener === listener) {
      if (--this._eventsCount === 0) this._events = P.ObjectCreate(null);
      else {
        delete events[type];
        if (events.removeListener !== undefined) {
          this.emit('removeListener', type, list.listener || listener);
        }
      }
    } else if (typeof list !== 'function') {
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
    if (events.removeListener === undefined) {
      if (arguments.length === 0) {
        this._events = P.ObjectCreate(null);
        this._eventsCount = 0;
      } else if (events[type] !== undefined) {
        if (--this._eventsCount === 0) this._events = P.ObjectCreate(null);
        else delete events[type];
      }
      return this;
    }
    if (arguments.length === 0) {
      var keys = P.ReflectOwnKeys(events);
      for (var k = 0; k < keys.length; k++) {
        var key = keys[k];
        if (key === 'removeListener') continue;
        this.removeAllListeners(key);
      }
      this.removeAllListeners('removeListener');
      this._events = P.ObjectCreate(null);
      this._eventsCount = 0;
      return this;
    }
    var listeners = events[type];
    if (typeof listeners === 'function') {
      this.removeListener(type, listeners);
    } else if (listeners !== undefined) {
      for (var i = listeners.length - 1; i >= 0; i--) {
        this.removeListener(type, listeners[i]);
      }
    }
    return this;
  };

  EventEmitter.prototype.emit = function (type) {
    var events = this._events;
    var handler = events === undefined ? undefined : events[type];
    if (handler === undefined) {
      if (type === 'error') {
        var err = arguments[1];
        if (err instanceof Error) throw err;
        var e = new Error('Unhandled error.' + (err !== undefined ? ' (' + err + ')' : ''));
        e.context = err;
        throw e;
      }
      return false;
    }
    var args = P.ArrayPrototypeSlice(arguments, 1);
    if (typeof handler === 'function') {
      P.FunctionPrototypeApply(handler, this, args);
    } else {
      var listeners = arrayClone(handler);
      for (var i = 0; i < listeners.length; i++) {
        P.FunctionPrototypeApply(listeners[i], this, args);
      }
    }
    return true;
  };

  EventEmitter.prototype.listeners = function (type) {
    var events = this._events;
    if (events === undefined) return [];
    var handler = events[type];
    if (handler === undefined) return [];
    if (typeof handler === 'function') return [handler.listener || handler];
    var copy = arrayClone(handler);
    for (var i = 0; i < copy.length; i++) copy[i] = copy[i].listener || copy[i];
    return copy;
  };

  EventEmitter.prototype.rawListeners = function (type) {
    var events = this._events;
    if (events === undefined) return [];
    var handler = events[type];
    if (handler === undefined) return [];
    return typeof handler === 'function' ? [handler] : arrayClone(handler);
  };

  EventEmitter.prototype.listenerCount = function (type, listener) {
    var events = this._events;
    if (events === undefined) return 0;
    var handler = events[type];
    if (handler === undefined) return 0;
    if (typeof handler === 'function') {
      if (listener !== undefined) {
        return handler === listener || handler.listener === listener ? 1 : 0;
      }
      return 1;
    }
    if (listener !== undefined) {
      var count = 0;
      for (var i = 0; i < handler.length; i++) {
        if (handler[i] === listener || handler[i].listener === listener) count++;
      }
      return count;
    }
    return handler.length;
  };

  EventEmitter.prototype.eventNames = function () {
    return this._eventsCount > 0 ? P.ReflectOwnKeys(this._events) : [];
  };

  // once(emitter, name[, options]) — resolves with the emitted arguments on the next
  // matching event, or rejects if 'error' fires first or options.signal aborts.
  function once(emitter, name, options) {
    var signal = options && options.signal;
    if (signal !== undefined) {
      if (!isAbortSignal(signal)) {
        return P.Promise.reject(typeError('options.signal', 'an instance of AbortSignal', signal));
      }
      if (signal.aborted) {
        return P.Promise.reject(makeAbortError());
      }
    }
    return new P.Promise(function (resolve, reject) {
      var errorListener;
      var abortListener;
      function cleanup() {
        if (typeof emitter.removeListener === 'function') {
          emitter.removeListener(name, eventListener);
          if (errorListener !== undefined) emitter.removeListener('error', errorListener);
        } else if (typeof emitter.removeEventListener === 'function') {
          emitter.removeEventListener(name, eventListener);
        }
        if (abortListener !== undefined) {
          signal.removeEventListener('abort', abortListener);
        }
      }
      function eventListener() {
        cleanup();
        resolve(P.ArrayPrototypeSlice(arguments));
      }
      if (signal !== undefined) {
        abortListener = function () {
          cleanup();
          reject(makeAbortError());
        };
        signal.addEventListener('abort', abortListener, { once: true });
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
        emitter.addEventListener(name, eventListener, { once: true });
      } else {
        cleanup();
        reject(typeError('emitter', 'an EventEmitter or EventTarget', emitter));
      }
    });
  }

  // --- static helpers (Node parity) ---

  function typeError(name, expected, actual) {
    var e = new TypeError(
      'The "' + name + '" argument must be ' + expected + '. Received ' + typeof actual,
    );
    e.code = 'ERR_INVALID_ARG_TYPE';
    return e;
  }

  function isAbortSignal(s) {
    return s != null && typeof s.addEventListener === 'function' && 'aborted' in s;
  }

  function makeAbortError() {
    var e = new Error('The operation was aborted');
    e.name = 'AbortError';
    e.code = 'ABORT_ERR';
    return e;
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
  function setMaxListeners(n) {
    n = n === undefined ? EventEmitter.defaultMaxListeners : n;
    validateMaxListeners(n);
    var targets = P.ArrayPrototypeSlice(arguments, 1);
    if (targets.length === 0) {
      EventEmitter.defaultMaxListeners = n;
    } else {
      for (var i = 0; i < targets.length; i++) {
        if (typeof targets[i].setMaxListeners === 'function') targets[i].setMaxListeners(n);
      }
    }
  }

  // events.listenerCount(emitter, name) — the deprecated static form.
  function staticListenerCount(emitter, type) {
    return emitter.listenerCount(type);
  }

  // events.addAbortListener(signal, listener) — once-listener for 'abort' that fires even
  // if the signal is already aborted; returns a { [Symbol.dispose]() } to remove it.
  function addAbortListener(signal, listener) {
    if (!isAbortSignal(signal)) throw typeError('signal', 'an instance of AbortSignal', signal);
    if (typeof listener !== 'function') throw typeError('listener', 'a function', listener);
    var removeEventListener;
    if (signal.aborted) {
      queueMicrotask(function () {
        listener();
      });
    } else {
      signal.addEventListener('abort', listener, { once: true });
      removeEventListener = function () {
        signal.removeEventListener('abort', listener);
      };
    }
    var disposable = {};
    if (typeof Symbol !== 'undefined' && Symbol.dispose) {
      disposable[Symbol.dispose] = function () {
        if (removeEventListener) removeEventListener();
      };
    }
    return disposable;
  }

  // events.on(emitter, eventName[, options]) — an async iterator that yields the args of
  // each matching event. 'error' rejects; options.signal aborts; return()/throw() clean up.
  function on(emitter, event, options) {
    options = options || {};
    var signal = options.signal;
    if (signal !== undefined && !isAbortSignal(signal)) {
      throw typeError('options.signal', 'an instance of AbortSignal', signal);
    }
    if (signal && signal.aborted) throw makeAbortError();

    var unconsumedEvents = [];
    var unconsumedPromises = [];
    var error = null;
    var finished = false;

    var useEmitter = typeof emitter.on === 'function' && typeof emitter.off === 'function';
    if (!useEmitter && typeof emitter.addEventListener !== 'function') {
      throw typeError('emitter', 'an EventEmitter or EventTarget', emitter);
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
    function eventHandler() {
      var args = P.ArrayPrototypeSlice(arguments);
      if (unconsumedPromises.length > 0) {
        P.ArrayPrototypeShift(unconsumedPromises).resolve(result(args, false));
      } else {
        P.ArrayPrototypePush(unconsumedEvents, args);
      }
    }
    function errorHandler(err) {
      if (unconsumedPromises.length > 0) {
        P.ArrayPrototypeShift(unconsumedPromises).reject(err);
      } else {
        error = err;
      }
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
      while (unconsumedPromises.length > 0) {
        P.ArrayPrototypeShift(unconsumedPromises).resolve(result(undefined, true));
      }
    }

    addListener(event, eventHandler);
    if (event !== 'error' && useEmitter) addListener('error', errorHandler);
    if (signal) signal.addEventListener('abort', abortHandler, { once: true });

    var iterator = {
      next: function () {
        if (unconsumedEvents.length > 0) {
          return P.Promise.resolve(result(P.ArrayPrototypeShift(unconsumedEvents), false));
        }
        if (error) {
          var e = error;
          error = null;
          return P.Promise.reject(e);
        }
        if (finished) return P.Promise.resolve(result(undefined, true));
        return new P.Promise(function (resolve, reject) {
          P.ArrayPrototypePush(unconsumedPromises, { resolve: resolve, reject: reject });
        });
      },
      return: function () {
        closeHandler();
        return P.Promise.resolve(result(undefined, true));
      },
      throw: function (err) {
        closeHandler();
        return P.Promise.reject(err);
      },
    };
    iterator[Symbol.asyncIterator] = function () {
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
  EventEmitter.defaultMaxListeners = defaultMaxListeners;

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
