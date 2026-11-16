// node:util — the subset Lava needs today. Pure JS, no native dependencies.
//
// The implementation is split along node's lib/internal/util seams, so a throw from
// inside one names its file exactly as node's does: internal/util/inspect (inspect,
// format, formatWithOptions, stripVTControlCharacters, the inspect.colors table),
// internal/util/comparisons (isDeepStrictEqual), internal/util/debuglog (debuglog) and
// internal/util (promisify, deprecate). This file stays the public entry: it keeps what
// node's lib/util.js keeps — callbackify, inherits, styleText, toUSVString — plus
// aborted, and assembles the exports in their old order. util is lazy, and so is every
// file it requires.
(function (require, module) {
  'use strict';

  var UtilPrimordials = require('internal/primordials');
  var errors = require('internal/errors');
  var ERR_INVALID_ARG_TYPE = errors.ERR_INVALID_ARG_TYPE;
  var ERR_INVALID_ARG_VALUE = errors.ERR_INVALID_ARG_VALUE;
  var inspectModule = require('internal/util/inspect');
  // The live table util.inspect.colors exposes: styleText reads it per call, so a
  // caller-added style is honored. Same object, not a copy.
  var inspectColors = inspectModule.inspectColors;
  var internalUtil = require('internal/util');
  var debuglog = require('internal/util/debuglog').debuglog;

  // util.callbackify — the inverse: wrap an async/Promise-returning function as one
  // taking a Node-style (err, value) callback. Rejections are delivered on a fresh tick;
  // a falsy rejection reason is wrapped like Node.
  function callbackify(original) {
    if (typeof original !== 'function') {
      throw new TypeError('The "original" argument must be of type function');
    }
    function callbackified() {
      var args = Array.prototype.slice.call(arguments);
      var cb = args.pop();
      if (typeof cb !== 'function') {
        throw new TypeError('The last argument must be of type function');
      }
      var self = this;
      Promise.resolve(Reflect.apply(original, self, args)).then(
        function (ret) {
          process.nextTick(cb.bind(self, null, ret));
        },
        function (rej) {
          var reason = rej;
          if (!reason) {
            reason = new Error('Promise was rejected with a falsy value');
            reason.reason = rej;
          }
          process.nextTick(cb.bind(self, reason));
        },
      );
    }
    Object.setPrototypeOf(callbackified, Object.getPrototypeOf(original));
    Object.defineProperties(callbackified, Object.getOwnPropertyDescriptors(original));
    return callbackified;
  }

  // util.inherits — set up classic prototypal inheritance and the `super_` back-link.
  function inherits(ctor, superCtor) {
    if (ctor == null || typeof ctor !== 'function') {
      throw new TypeError('The "ctor" argument must be of type function');
    }
    if (superCtor == null || typeof superCtor !== 'function') {
      throw new TypeError('The "superCtor" argument must be of type function');
    }
    if (superCtor.prototype === undefined) {
      throw new TypeError('The "superCtor.prototype" property must be of type object');
    }
    Object.defineProperty(ctor, 'super_', {
      value: superCtor,
      writable: true,
      configurable: true,
    });
    Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
  }

  function styleText(format, text, options) {
    if (typeof text !== 'string') {
      throw ERR_INVALID_ARG_TYPE('text', 'string', text);
    }
    var formats = Array.isArray(format) ? format : [format];
    var open = '';
    var close = '';
    for (var i = 0; i < formats.length; i++) {
      var f = formats[i];
      if (f === 'none') continue;
      // Read from the live inspectColors so a caller-added/overridden style is honored.
      var codes = typeof f === 'string' ? inspectColors[f] : undefined;
      if (codes === undefined) {
        // node's reason lists ObjectKeys(inspect.colors); Lava's colors table has a
        // different key set (aliases enumerable), so the list would not match anyway.
        throw ERR_INVALID_ARG_VALUE('format', f, 'must be a valid style');
      }
      open += '\x1b[' + codes[0] + 'm';
      close = '\x1b[' + codes[1] + 'm' + close; // closes unwind in reverse
    }

    options = options || {};
    var validateStream = options.validateStream;
    // null/undefined default to true (Node uses `?? true`); other falsy values force color.
    if (validateStream === undefined || validateStream === null) validateStream = true;
    // A falsy validateStream forces the codes (skips the TTY check); a truthy non-boolean
    // is rejected — Node only type-checks it on this path.
    if (validateStream) {
      if (typeof validateStream !== 'boolean') {
        throw ERR_INVALID_ARG_TYPE('options.validateStream', 'boolean', validateStream);
      }
      var stream =
        options.stream !== undefined
          ? options.stream
          : typeof process !== 'undefined'
            ? process.stdout
            : undefined;
      if (!stream || !stream.isTTY) return text;
    }
    return open + text + close;
  }

  // util.toUSVString — coerce to a string of Unicode scalar values, replacing each lone
  // surrogate with U+FFFD. Matches Node: it string-coerces via `${value}` (the string hint,
  // so an object's toString wins over valueOf — `'' + value` would use the default hint and
  // diverge) then well-forms. A Symbol throws on coercion, as in Node.
  function toUSVString(value) {
    var str = `${value}`;
    if (typeof str.toWellFormed === 'function') return str.toWellFormed();
    // Fallback for engines without String.prototype.toWellFormed (ES2024).
    var out = '';
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        var next = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
        if (next >= 0xdc00 && next <= 0xdfff) {
          out += str[i] + str[i + 1];
          i++;
        } else {
          out += '\uFFFD';
        }
      } else if (c >= 0xdc00 && c <= 0xdfff) {
        out += '\uFFFD';
      } else {
        out += str[i];
      }
    }
    return out;
  }

  function isAbortSignalLike(s) {
    return (
      s !== null &&
      typeof s === 'object' &&
      typeof s.addEventListener === 'function' &&
      typeof s.aborted === 'boolean'
    );
  }

  // util.aborted(signal, resource) — like Node, an async function: the returned Promise
  // fulfills when `signal` aborts (with the abort event) or immediately (with undefined) if it
  // is already aborted, and a bad argument REJECTS rather than throwing synchronously. The
  // `resource` must be an object/function — Node holds it weakly so the listener drops when the
  // resource is GC'd; the weak ref is not observable here, but the type check is.
  async function aborted(signal, resource) {
    if (!isAbortSignalLike(signal)) {
      // node's webidl AbortSignal converter: a bare TypeError, no Received tail.
      throw errors.nativeError(
        UtilPrimordials.TypeError,
        'ERR_INVALID_ARG_TYPE',
        'signal is not of type AbortSignal.',
      );
    }
    if (resource === null || (typeof resource !== 'object' && typeof resource !== 'function')) {
      throw ERR_INVALID_ARG_TYPE('resource', 'object', resource);
    }
    if (signal.aborted) return undefined;
    return new Promise(function (resolve) {
      // lava's AbortSignal.addEventListener ignores the options object, so `{ once: true }`
      // would not auto-remove the listener — wrap the resolver and remove it explicitly so
      // repeated aborted() calls on a long-lived signal cannot accumulate dead listeners.
      function onAbort(event) {
        signal.removeEventListener('abort', onAbort);
        resolve(event);
      }
      signal.addEventListener('abort', onAbort);
    });
  }

  module.exports = {
    inspect: inspectModule.inspect,
    format: inspectModule.format,
    formatWithOptions: inspectModule.formatWithOptions,
    promisify: internalUtil.promisify,
    callbackify: callbackify,
    inherits: inherits,
    deprecate: internalUtil.deprecate,
    isDeepStrictEqual: require('internal/util/comparisons').isDeepStrictEqual,
    debuglog: debuglog,
    debug: debuglog, // Node aliases util.debug to util.debuglog
    aborted: aborted,
    parseArgs: require('internal/parse_args').parseArgs,
    parseEnv: require('internal/parse_env').parseEnv,
    MIMEType: require('internal/mime').MIMEType,
    MIMEParams: require('internal/mime').MIMEParams,
    styleText: styleText,
    stripVTControlCharacters: inspectModule.stripVTControlCharacters,
    toUSVString: toUSVString,
    // Node exposes the same object via require('node:util').types and
    // require('node:util/types'); many packages use the former.
    types: require('util/types'),
  };
});
