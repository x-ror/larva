// FinalizationRegistry cleanups, put back on the page's own event loop (#91).
//
// JSC runs a registry's cleanup from its WTF::RunLoop, not inside an API call. Lava
// drives that RunLoop at thread level (pkg/jsc/runloop_linux.odin): between page ticks,
// outside every page's CPU window, and on a runner thread while some OTHER page of the
// thread may be next to run. So the cleanup the engine holds is never the page's own:
// FinalizationRegistry is a native constructor (pkg/runtime/deferred.odin,
// fr_construct_host) that hands the engine `wrap(cleanup)` instead, and what the engine
// runs is the shim below, which only hands the page's callback to `native.enqueue`. The
// queue is native; it is run inside one of the page's own ticks, one registry per task,
// through the microtask shim — so a cleanup is charged to its page's CPU budget, a throw
// is that page's uncaught error, a page that has closed runs nothing, and a cleanup's
// stack holds nothing of this file (cmd/lava/testdata/deferred-chrome pins it).
//
// Installed before user code (an eager module, loader.js), on every surface. The shim is
// the only function here, and it runs at thread level only: it touches no property a
// page can hook.
(function (require, module, exports, native) {
  'use strict';

  var PromiseReject = require('internal/primordials').PromiseReject;
  var enqueue = native ? native.enqueue : null;
  // Every registry, and every reported exception, gets an identity of its own, so the
  // cleanups of one registry make one task and each report a task of its own.
  var registries = 0;

  function rethrow(error) {
    throw error;
  }

  /**
   * HTML's "report an exception" for a page callback the platform called and must
   * outlive (an event listener, internal/event_target): the error becomes the page's
   * uncaught error — the path a throwing timer callback takes (report_uncaught and a
   * non-zero exit) — and the caller goes on with the rest of its callbacks.
   * @param {*} error
   * @deviates Reported one task later, from the cleanup queue above, where Chrome
   *   reports before the next listener runs: no JS entry reaches report_uncaught
   *   synchronously, and the order is visible only on stderr, which no oracle reads.
   *   Without the queue (no natives, or a page without a loop) it surfaces as an
   *   unhandled rejection rather than not at all.
   */
  function reportException(error) {
    if (enqueue !== null && enqueue(rethrow, error, ++registries)) return;
    PromiseReject(error);
  }

  module.exports = { __proto__: null, reportException: reportException };

  // Nothing to bind on an embedder that installs no natives: the engine's own
  // constructor stays (and page_create deletes it where the RunLoop is driven).
  if (!native) return;

  // wrap(cleanup) is what each new registry holds in place of the page's cleanup.
  native.installFinalizationRegistry(function (cleanup) {
    var registry = ++registries;
    return function (heldValue) {
      enqueue(cleanup, heldValue, registry);
    };
  });
});
