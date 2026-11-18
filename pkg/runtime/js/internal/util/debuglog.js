// util.debuglog (aliased as util.debug) — where node keeps it:
// lib/internal/util/debuglog.js. Formats its lines through internal/util/inspect.
(function (require, module) {
  'use strict';

  // Captured for debugEnvPattern below, which replaced three global-flag replaces on the
  // NODE_DEBUG path.
  var UtilPrimordials = require('internal/primordials');
  var StringPrototypeCharCodeAt = UtilPrimordials.StringPrototypeCharCodeAt;
  var StringPrototypeSlice = UtilPrimordials.StringPrototypeSlice;
  var StringPrototypeToUpperCase = UtilPrimordials.StringPrototypeToUpperCase;
  var inspectModule = require('internal/util/inspect');
  var format = inspectModule.format;
  var formatWithOptions = inspectModule.formatWithOptions;

  // --- util.debuglog / util.debug ---
  // NODE_DEBUG is a comma-separated list of sections (no whitespace trimming); `*` is a
  // wildcard and matching is case-insensitive. Node compiles it once into an anchored regex
  // (escape regex specials, then `*` -> `.*`, `,` -> alternation) tested against the
  // upper-cased section name.
  // debugEnvPattern compiles NODE_DEBUG into the body of that anchored regex in ONE
  // pass, where Node (and this file, before) chained three global replaces:
  //
  //   .replace(/[|\\{}()[\]^$+?.]/g, '\\$&')   escape the regex specials
  //   .replace(/\*/g, '.*')                    '*' is the wildcard
  //   .replace(/,/g, '$|^')                    ',' separates sections
  //
  // Three global replaces are three spin-forever sites: under a forged
  // `RegExp.prototype.exec` a global replace never advances `lastIndex`, so it does not
  // answer wrongly, it never returns — and this one runs on the FIRST debuglog call, so
  // the process wedges at the point it tries to emit a diagnostic. node answers
  // correctly under the same poison, so it was a Lava-only defect; pinned by
  // tests/node-compat/cases/59-global-replace-hangs.js.
  //
  // Collapsing the three passes into one is sound because they cannot feed each other:
  // the escape set contains neither `*` nor `,`, so those survive step 1 untouched, and
  // neither `.*` nor `$|^` introduces a character a later step would rewrite.
  function debugEnvPattern(env) {
    var out = '';
    for (var i = 0; i < env.length; i++) {
      var c = StringPrototypeCharCodeAt(env, i);
      if (c === 0x2a) {
        out += '.*'; // '*' wildcard
      } else if (c === 0x2c) {
        out += '$|^'; // ',' section separator
      } else if (isRegExpSpecial(c)) {
        out += '\\' + StringPrototypeSlice(env, i, i + 1);
      } else {
        out += StringPrototypeSlice(env, i, i + 1);
      }
    }
    return StringPrototypeToUpperCase(out);
  }

  // The `[|\\{}()[\]^$+?.]` class, as code units. `*` and `,` are deliberately absent —
  // they are the two the caller rewrites rather than escapes.
  function isRegExpSpecial(c) {
    return (
      c === 0x7c || // |
      c === 0x5c || // \
      c === 0x7b || // {
      c === 0x7d || // }
      c === 0x28 || // (
      c === 0x29 || // )
      c === 0x5b || // [
      c === 0x5d || // ]
      c === 0x5e || // ^
      c === 0x24 || // $
      c === 0x2b || // +
      c === 0x3f || // ?
      c === 0x2e //    .
    );
  }

  var debugEnvRegex = /^$/;
  var debugEnvInitialized = false;
  function initDebugEnv() {
    if (debugEnvInitialized) return;
    debugEnvInitialized = true;
    var env = typeof process !== 'undefined' && process.env ? process.env.NODE_DEBUG : '';
    if (env) {
      debugEnvRegex = new RegExp('^' + debugEnvPattern(env) + '$', 'i');
    }
  }
  function testEnabled(section) {
    initDebugEnv();
    return debugEnvRegex.exec(section) !== null;
  }

  var debugImpls = { __proto__: null };
  function debuglogImpl(enabled, section) {
    if (debugImpls[section] === undefined) {
      if (enabled) {
        debugImpls[section] = function () {
          var args = [{}];
          for (var i = 0; i < arguments.length; i++) args[i + 1] = arguments[i];
          var msg = formatWithOptions.apply(null, args);
          var pid = typeof process !== 'undefined' && process.pid ? process.pid : 0;
          process.stderr.write(format('%s %d: %s\n', section, pid, msg));
        };
      } else {
        debugImpls[section] = function () {};
      }
    }
    return debugImpls[section];
  }

  function debuglog(set, cb) {
    var enabled;
    function init() {
      set = String(set).toUpperCase();
      enabled = testEnabled(set);
    }
    // The heavy impl is built lazily on the first call; the optional callback is invoked then
    // (once) with the real logger so callers can capture/replace it.
    var debug = function () {
      init();
      debug = debuglogImpl(enabled, set);
      if (typeof cb === 'function') {
        Object.defineProperty(debug, 'enabled', {
          get: function () {
            return enabled;
          },
          configurable: true,
          enumerable: true,
        });
        cb(debug);
      }
      return debug.apply(this, arguments);
    };
    var test = function () {
      init();
      test = function () {
        return enabled;
      };
      return enabled;
    };
    var logger = function () {
      if (enabled === false) return;
      return debug.apply(this, arguments);
    };
    Object.defineProperty(logger, 'enabled', {
      get: function () {
        return test();
      },
      configurable: true,
      enumerable: true,
    });
    return logger;
  }

  module.exports = { debuglog: debuglog };
});
