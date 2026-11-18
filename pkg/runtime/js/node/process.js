// node:process — export the intrinsic process object captured at context init.
//
// Params: (require, module, exports, intrinsic) — `intrinsic` is natives['process'],
//   the real process object placed there by install_internal_modules before user
//   code runs.
// Returns: the process object (same reference as the original globalThis.process).
// Node: require('node:process') is the intrinsic regardless of global mutation
//   (node 26.13.0, verified by tests/node-compat/cases/66 and 67). When the global is
//   untouched, require === process.
// Deviates: none.
//
// Never re-read the global. A dependency that reassigns or deletes
// globalThis.process before the first require('node:process') would otherwise
// poison every later consumer of the builtin (issue #247). Fail closed if the
// natives channel did not hand us the object — exporting undefined would look
// like "not a builtin" and fall through to MODULE_NOT_FOUND.
(function (require, module, exports, intrinsic) {
  'use strict';
  // Through primordials, not a bare `new Error(...)`: this module is LAZY, so its
  // factory body runs at the user's FIRST require — after user code has had every
  // chance to replace globalThis.Error. The ratchet cannot see this (it exempts
  // every read at module-eval depth, which is what a factory body is), so the same
  // blind spot that shipped #333 applies to the fail-closed branch below.
  var ErrorG = require('internal/primordials').Error;
  if (intrinsic == null) {
    throw new ErrorG('node:process intrinsic missing at context init');
  }
  module.exports = intrinsic;
});
