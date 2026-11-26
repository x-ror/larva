// FinalizationRegistry cleanups, put back on the page's own event loop (#91).
//
// JSC runs a registry's cleanup from its WTF::RunLoop, not inside an API call. Lava
// drives that RunLoop at thread level (pkg/jsc/runloop_linux.odin): between page ticks,
// outside every page's CPU window, and on a runner thread while some OTHER page of the
// thread may be next to run. So the cleanup the engine holds is never the page's own:
// FinalizationRegistry is a native constructor (pkg/runtime/deferred.odin,
// fr_construct_host) that hands the engine `wrap(cleanup)` instead, and what the engine
// runs is this module's shim, which only queues the page's callback and asks the page's
// loop for a turn (`native.schedule`). The queue is flushed inside one of the page's own
// ticks, so the callback is charged to that page's CPU budget, a throw is that page's
// uncaught error, and a page that has closed has no loop left to run it — its queue dies
// with its realm.
//
// Installed before user code (an eager module, loader.js), on every surface. It replaces
// one global's value and adds no name to globalThis.
//
// What a page can see, checked against Chrome 158: the constructor itself is the
// engine's in every respect a page can probe (tests/web/cases/finalization-shape.js);
// each registry's cleanups run as one task, with the microtasks they queue after them
// and before the next registry's (cmd/lava/testdata/deferred-chrome). A cleanup's stack
// shows this module's flush and the loop's dispatch below it, as a timer callback's shows
// the dispatch (not pinned: no recorded case prints a stack).
(function (require, module, exports, native) {
  'use strict';

  var P = require('internal/primordials');
  var ReflectApply = P.ReflectApply;

  // Nothing to bind on an embedder that installs no natives: the engine's own
  // constructor stays, as before this module existed.
  if (!native) return;

  var schedule = native.schedule;
  var reportUncaught = native.reportUncaught;

  // The page's queue: (callback, held value, registry) triples, flushed in order. A
  // null-prototype object with two cursors, not an array: an index write on an array
  // consults a setter a page may have put on Array.prototype.
  var items = { __proto__: null };
  var head = 0;
  var tail = 0;
  var scheduled = false;

  // enqueue runs `fn(arg)` in a later tick of the page. Called from the RunLoop shim, so
  // at thread level: it queues and returns, and runs nothing of the page. When the page
  // has no loop to run it on — it has closed, or it never had one — the queue is dropped.
  function enqueue(fn, arg, registry) {
    items[tail] = fn;
    items[tail + 1] = arg;
    items[tail + 2] = registry;
    tail += 3;

    if (scheduled) return;
    if (schedule()) {
      scheduled = true;
      return;
    }

    items = { __proto__: null };
    head = 0;
    tail = 0;
  }

  // flush runs ONE registry's queued cleanups as one task — back to back, with the
  // microtasks they queue drained when the task returns, before the next registry's
  // task (HTML queues a cleanup task per registry; Chrome prints AAmmBBmm). Native calls
  // it through invoke_user_callback, inside the page's tick. A throw is reported like any
  // uncaught callback error and does not stop the rest; a limit kill (an uncatchable
  // termination) does, and the page is over.
  function flush() {
    scheduled = false;
    if (head < tail) {
      var registry = items[head + 2];
      while (head < tail && items[head + 2] === registry) {
        var fn = items[head];
        var arg = items[head + 1];
        items[head] = undefined;
        items[head + 1] = undefined;
        items[head + 2] = undefined;
        head += 3;
        try {
          ReflectApply(fn, undefined, [arg]);
        } catch (err) {
          reportUncaught(err);
        }
      }
    }

    if (head === tail) {
      items = { __proto__: null };
      head = 0;
      tail = 0;
    } else if (!scheduled && schedule()) {
      // The next registry's cleanups, or ones queued by this flush: their own task.
      scheduled = true;
    }
  }

  native.setFlush(flush);

  // wrap(cleanup) is what each new registry holds in place of the page's cleanup. Every
  // registry gets an identity of its own, so flush can tell where one registry's
  // cleanups end.
  var registries = 0;
  native.installFinalizationRegistry(function (cleanup) {
    var registry = ++registries;
    return function (heldValue) {
      enqueue(cleanup, heldValue, registry);
    };
  });
});
