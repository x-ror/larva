// node:diagnostics_channel — named pub/sub channels for diagnostics instrumentation.
// Core surface (channel/subscribe/unsubscribe/hasSubscribers/Channel) plus tracingChannel.
// AsyncLocalStorage integration (bindStore/runStores) is stubbed — there is no ALS yet.
(function (require, module) {
  'use strict';

  // Node dedups channels via a WeakRef registry so unused ones can be GC'd; a Map is
  // functionally equivalent (it just keeps them alive), which is fine here.
  var channels = new Map();

  function reportError(err) {
    // A throwing subscriber must not break the publisher; surface it out-of-band.
    process.nextTick(function () {
      throw err;
    });
  }

  function Channel(name) {
    this.name = name;
    this._subscribers = [];
  }
  Object.defineProperty(Channel.prototype, 'hasSubscribers', {
    get: function () {
      return this._subscribers.length > 0;
    },
    configurable: true,
  });
  Channel.prototype.subscribe = function (onMessage) {
    if (typeof onMessage !== 'function') {
      throw new TypeError('The "onMessage" argument must be of type function');
    }
    this._subscribers.push(onMessage);
  };
  Channel.prototype.unsubscribe = function (onMessage) {
    var idx = this._subscribers.indexOf(onMessage);
    if (idx === -1) return false;
    this._subscribers.splice(idx, 1);
    return true;
  };
  Channel.prototype.publish = function (message) {
    if (this._subscribers.length === 0) return;
    var list = this._subscribers.slice(); // snapshot: a subscriber may (un)subscribe
    for (var i = 0; i < list.length; i++) {
      try {
        list[i](message, this.name);
      } catch (err) {
        reportError(err);
      }
    }
  };
  // No AsyncLocalStorage yet — bindStore/unbindStore are no-ops; runStores just runs fn.
  Channel.prototype.bindStore = function () {};
  Channel.prototype.unbindStore = function () {};
  Channel.prototype.runStores = function (context, fn, thisArg) {
    return Reflect.apply(fn, thisArg, Array.prototype.slice.call(arguments, 3));
  };

  function channel(name) {
    var existing = channels.get(name);
    if (existing !== undefined) return existing;
    if (typeof name !== 'string' && typeof name !== 'symbol') {
      throw new TypeError('The "channel" argument must be one of type string or symbol');
    }
    var c = new Channel(name);
    channels.set(name, c);
    return c;
  }

  function hasSubscribers(name) {
    var c = channels.get(name);
    return c !== undefined && c.hasSubscribers;
  }

  function subscribe(name, onMessage) {
    channel(name).subscribe(onMessage);
  }

  function unsubscribe(name, onMessage) {
    var c = channels.get(name);
    if (c === undefined) return false;
    return c.unsubscribe(onMessage);
  }

  // --- tracingChannel ---

  function TracingChannel(group) {
    this.start = group.start;
    this.end = group.end;
    this.asyncStart = group.asyncStart;
    this.asyncEnd = group.asyncEnd;
    this.error = group.error;
  }
  Object.defineProperty(TracingChannel.prototype, 'hasSubscribers', {
    get: function () {
      return (
        this.start.hasSubscribers ||
        this.end.hasSubscribers ||
        this.asyncStart.hasSubscribers ||
        this.asyncEnd.hasSubscribers ||
        this.error.hasSubscribers
      );
    },
    configurable: true,
  });
  TracingChannel.prototype.subscribe = function (handlers) {
    for (var key in handlers) {
      if (this[key]) this[key].subscribe(handlers[key]);
    }
  };
  TracingChannel.prototype.unsubscribe = function (handlers) {
    var allRemoved = true;
    for (var key in handlers) {
      if (this[key] && !this[key].unsubscribe(handlers[key])) allRemoved = false;
    }
    return allRemoved;
  };
  TracingChannel.prototype.traceSync = function (fn, context, thisArg) {
    var args = Array.prototype.slice.call(arguments, 3);
    var ctx = context || {};
    this.start.publish(ctx);
    try {
      var result = Reflect.apply(fn, thisArg, args);
      ctx.result = result;
      return result;
    } catch (err) {
      ctx.error = err;
      this.error.publish(ctx);
      throw err;
    } finally {
      this.end.publish(ctx);
    }
  };
  TracingChannel.prototype.tracePromise = function (fn, context, thisArg) {
    var args = Array.prototype.slice.call(arguments, 3);
    var ctx = context || {};
    var self = this;
    this.start.publish(ctx);
    try {
      var promise = Promise.resolve(Reflect.apply(fn, thisArg, args));
      return promise.then(
        function (result) {
          ctx.result = result;
          self.asyncStart.publish(ctx);
          self.asyncEnd.publish(ctx);
          return result;
        },
        function (err) {
          ctx.error = err;
          self.error.publish(ctx);
          self.asyncStart.publish(ctx);
          self.asyncEnd.publish(ctx);
          throw err;
        },
      );
    } catch (err) {
      ctx.error = err;
      this.error.publish(ctx);
      throw err;
    } finally {
      this.end.publish(ctx);
    }
  };
  TracingChannel.prototype.traceCallback = function (fn, position, context, thisArg) {
    var args = Array.prototype.slice.call(arguments, 4);
    var ctx = context || {};
    var self = this;
    // Node's default is -1: negative positions resolve from the end (args.at),
    // so the wrapper REPLACES the last argument instead of being appended past it.
    if (position === undefined || position === null) position = -1;
    if (position < 0) position = args.length + position;
    var callback = args[position];
    if (typeof callback !== 'function') {
      throw new TypeError('The "callback" argument must be of type function');
    }
    args[position] = function (err) {
      if (err) {
        ctx.error = err;
        self.error.publish(ctx);
      } else {
        ctx.result = arguments[1];
      }
      self.asyncStart.publish(ctx);
      try {
        if (typeof callback === 'function') return Reflect.apply(callback, this, arguments);
      } finally {
        self.asyncEnd.publish(ctx);
      }
    };
    this.start.publish(ctx);
    try {
      return Reflect.apply(fn, thisArg, args);
    } catch (err) {
      ctx.error = err;
      this.error.publish(ctx);
      throw err;
    } finally {
      this.end.publish(ctx);
    }
  };

  function tracingChannel(nameOrChannels) {
    if (typeof nameOrChannels === 'string') {
      var n = nameOrChannels;
      return new TracingChannel({
        start: channel(n + ':start'),
        end: channel(n + ':end'),
        asyncStart: channel(n + ':asyncStart'),
        asyncEnd: channel(n + ':asyncEnd'),
        error: channel(n + ':error'),
      });
    }
    return new TracingChannel(nameOrChannels);
  }

  module.exports = {
    channel: channel,
    hasSubscribers: hasSubscribers,
    subscribe: subscribe,
    unsubscribe: unsubscribe,
    tracingChannel: tracingChannel,
    Channel: Channel,
  };
});
