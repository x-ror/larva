// node:console — export the intrinsic console object captured at context init.
//
// Params: (require, module, exports, intrinsic) — `intrinsic` is natives['console'],
//   the real console object placed there by install_internal_modules before user
//   code runs.
// Returns: the console object (same reference as the original globalThis.console).
// Node: require('node:console') is the intrinsic regardless of global mutation
//   (node 26.13.0, verified by tests/node-compat/cases/66 and 67). When the global is
//   untouched, require === console.
// Deviates: none. The Console constructor for custom-stream consoles is not yet
//   provided on either the global or the module (pre-existing gap, not this fix).
//
// Never re-read the global. A dependency that reassigns or deletes
// globalThis.console before the first require('node:console') would otherwise
// poison every later consumer of the builtin (issue #247). Fail closed if the
// natives channel did not hand us the object.
(function (require, module, exports, intrinsic) {
  'use strict';
  // Through primordials, not a bare `new Error(...)` — same reason as process.js:
  // a lazy factory body is call-time code, so the global it reads is whatever user
  // code left there before the first require.
  var ErrorG = require('internal/primordials').Error;
  if (intrinsic == null) {
    throw new ErrorG('node:console intrinsic missing at context init');
  }
  module.exports = intrinsic;
});
