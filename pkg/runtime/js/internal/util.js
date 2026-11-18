// util.promisify and util.deprecate — where node keeps them: lib/internal/util.js.
(function (require, module) {
  'use strict';

  // Through the primordials table rather than the live `Symbol` global: this file is
  // evaluated lazily (node/util is its only requirer), so a module-eval read here is not
  // the pre-user-code read §5's exemption assumes.
  var SymbolFor = require('internal/primordials').SymbolFor;

  // util.promisify — wrap a (…args, callback(err, value)) function as one returning a
  // Promise. Honors the util.promisify.custom symbol and copies the original's own
  // properties / prototype, matching Node (the multi-arg `customArgs` form is omitted).
  // Guarded like customInspect in internal/util/inspect, on the same primordial: an
  // unguarded call here made a
  // missing SymbolFor throw inside util's factory and masked what the 57-format-single-arg
  // mutation pins (the inspect hook rendering a Buffer).
  var kCustomPromisify = SymbolFor ? SymbolFor('nodejs.util.promisify.custom') : null;

  function promisify(original) {
    if (typeof original !== 'function') {
      throw new TypeError('The "original" argument must be of type function');
    }
    if (original[kCustomPromisify]) {
      var custom = original[kCustomPromisify];
      if (typeof custom !== 'function') {
        throw new TypeError('The "util.promisify.custom" property must be of type function');
      }
      return custom;
    }
    function fn() {
      var args = Array.prototype.slice.call(arguments);
      var self = this;
      return new Promise(function (resolve, reject) {
        args.push(function (err, value) {
          if (err) reject(err);
          else resolve(value);
        });
        Reflect.apply(original, self, args);
      });
    }
    Object.setPrototypeOf(fn, Object.getPrototypeOf(original));
    Object.defineProperty(fn, kCustomPromisify, {
      value: fn,
      enumerable: false,
      writable: false,
      configurable: true,
    });
    return Object.defineProperties(fn, Object.getOwnPropertyDescriptors(original));
  }
  promisify.custom = kCustomPromisify;

  // util.deprecate — return a wrapper that emits a one-time deprecation warning, then
  // delegates to fn. Suppressed entirely when process.noDeprecation is set.
  function deprecate(fn, msg, code) {
    if (process.noDeprecation === true) return fn;
    var warned = false;
    function deprecated() {
      if (!warned) {
        warned = true;
        if (typeof process.emitWarning === 'function') {
          process.emitWarning(msg, 'DeprecationWarning', code);
        } else {
          console.error('DeprecationWarning: ' + msg);
        }
      }
      return Reflect.apply(fn, this, arguments);
    }
    return deprecated;
  }

  module.exports = { promisify: promisify, deprecate: deprecate };
});
