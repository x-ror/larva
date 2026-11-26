// Work JavaScriptCore defers to its RunLoop, put back on the page's own event loop.
//
// JSC runs two page-visible things from its WTF::RunLoop instead of inside an API call:
// a FinalizationRegistry's cleanup callback (#91) and the settlement of
// WebAssembly.compile/instantiate (#97: a JSC worker thread compiles, then posts the
// result back to the RunLoop). Lava drives that RunLoop at thread level
// (pkg/jsc/runloop_linux.odin): between page ticks, outside every page's CPU window,
// and on a runner thread while some OTHER page of the thread may be next to run. So
// nothing a page wrote runs from there. What runs there is this module's own shim, which
// only queues the page's callback and asks the page's loop for a turn (`native.schedule`);
// the queue is flushed inside one of the page's own ticks, so the callback is charged to
// that page's CPU budget, a throw is that page's uncaught error, and a page that has
// closed has no loop left to run it — its queue dies with its realm.
//
// Installed before user code (an eager module, loader.js), on every surface. It replaces
// two globals' values and adds no name to globalThis.
//
// Chrome (the Window profile's oracle) is what the shapes below keep: the constructor
// and both functions are Proxies over the engine's own, so `name`, `length`,
// `prototype`, `instanceof`, subclassing and the engine's own TypeErrors (a non-callable
// cleanup, a call without `new`, a bad wasm buffer) are JSC's, unchanged — the same
// engine traits as any other built-in — and each replaced property keeps the attributes
// the engine gave it. Checked against Chrome 158's recording in
// cmd/lava/testdata/deferred-chrome/ (record-chrome.py beside it); what differs there is
// the engine's, not this module's (runloop_drive_test.odin lists it).
(function (require, module, exports, native) {
  'use strict';

  var P = require('internal/primordials');
  var ReflectApply = P.ReflectApply;
  var ReflectConstruct = P.Reflect.construct;
  var ObjectDefineProperty = P.ObjectDefineProperty;
  var ObjectGetOwnPropertyDescriptor = P.ObjectGetOwnPropertyDescriptor;
  var PromiseCtor = P.Promise;
  // Module-eval reads of the engine's own globals: this module is eager, so they run
  // before any page script and see the pristine values.
  var ProxyCtor = Proxy;
  var promiseThen = PromiseCtor.prototype.then;
  var global = globalThis;

  // Nothing to bind on an embedder that installs no natives: the engine's own
  // constructors stay, as before this module existed.
  if (!native) return;

  var schedule = native.schedule;
  var hold = native.hold;
  var release = native.release;
  var reportUncaught = native.reportUncaught;

  // The page's queue: (callback, argument) pairs, flushed in order. A null-prototype
  // object with two cursors, not an array: an index write on an array consults a setter
  // a page may have put on Array.prototype.
  var items = { __proto__: null };
  var head = 0;
  var tail = 0;
  var scheduled = false;

  // enqueue runs `fn(arg)` in the page's next tick. Called from the RunLoop shim, so at
  // thread level: it queues and returns, and runs nothing of the page. When the page has
  // no loop to run it on — it has closed, or it never had one — the queue is dropped.
  function enqueue(fn, arg) {
    items[tail] = fn;
    items[tail + 1] = arg;
    tail += 2;

    if (scheduled) return;
    if (schedule()) {
      scheduled = true;
      return;
    }

    items = { __proto__: null };
    head = 0;
    tail = 0;
  }

  // flush runs every queued callback in one task, as JSC and Chrome run one registry's
  // cleanups: back to back, with the microtasks they queue drained after the task.
  // Native calls it through invoke_user_callback, inside the page's tick. A throw is
  // reported like any uncaught callback error and does not stop the rest; a limit kill
  // (an uncatchable termination) does, and the page is over.
  function flush() {
    scheduled = false;
    var end = tail;
    while (head < end) {
      var fn = items[head];
      var arg = items[head + 1];
      items[head] = undefined;
      items[head + 1] = undefined;
      head += 2;
      try {
        ReflectApply(fn, undefined, [arg]);
      } catch (err) {
        reportUncaught(err);
      }
    }

    if (head === tail) {
      items = { __proto__: null };
      head = 0;
      tail = 0;
    } else if (!scheduled && schedule()) {
      // Queued by a callback of this flush: the next tick runs them.
      scheduled = true;
    }
  }

  native.setFlush(flush);

  // replaceValue swaps the value of an existing data property and keeps the engine's
  // attributes, whatever they are: a wrapped built-in must not become more or less
  // enumerable than the one it stands for.
  function replaceValue(object, key, value) {
    var d = ObjectGetOwnPropertyDescriptor(object, key);
    ObjectDefineProperty(object, key, {
      __proto__: null,
      value: value,
      writable: d.writable,
      enumerable: d.enumerable,
      configurable: d.configurable,
    });
  }

  // FinalizationRegistry: the cleanup the engine holds is a shim that queues the page's
  // callback. Everything else is the engine's constructor — `prototype`, statics,
  // `new.target` (so a subclass gets its own prototype) — and a non-callable cleanup or
  // a call without `new` reaches it unchanged, to throw its own TypeError.
  var FinalizationRegistryCtor = global.FinalizationRegistry;

  if (typeof FinalizationRegistryCtor === 'function') {
    var registryProxy = new ProxyCtor(FinalizationRegistryCtor, {
      __proto__: null,
      construct: function (target, args, newTarget) {
        var cleanup = args.length > 0 ? args[0] : undefined;
        if (typeof cleanup !== 'function') return ReflectConstruct(target, args, newTarget);
        var shim = function (heldValue) {
          enqueue(cleanup, heldValue);
        };
        return ReflectConstruct(target, [shim], newTarget);
      },
    });
    replaceValue(FinalizationRegistryCtor.prototype, 'constructor', registryProxy);
    replaceValue(global, 'FinalizationRegistry', registryProxy);
  }

  // WebAssembly.compile/instantiate(+Streaming where the engine has them): the page's
  // loop is held until the engine's promise settles, as node keeps its process alive for
  // a pending compile, and the promise the page gets settles in the page's own tick.
  // `hold` is refused where nothing drives the RunLoop (another platform, a thread whose
  // RunLoop was not adopted): the engine's promise is then returned as it is, since a
  // held loop would wait for a settlement that never comes.
  function settle(settleOuter, value) {
    // Queue first, release second: the queued turn takes its own hold, so the loop's
    // count never drops to zero in between.
    enqueue(settleOuter, value);
    release();
  }

  function relay(inner) {
    if (!hold()) return inner;
    var resolveOuter;
    var rejectOuter;
    var outer = new PromiseCtor(function (resolve, reject) {
      resolveOuter = resolve;
      rejectOuter = reject;
    });
    try {
      ReflectApply(promiseThen, inner, [
        function (value) {
          settle(resolveOuter, value);
        },
        function (reason) {
          settle(rejectOuter, reason);
        },
      ]);
    } catch (err) {
      release();
      throw err;
    }
    return outer;
  }

  var WebAssemblyNs = global.WebAssembly;

  function relayed(name) {
    var fn = WebAssemblyNs[name];
    if (typeof fn !== 'function') return;
    var wrapped = new ProxyCtor(fn, {
      __proto__: null,
      apply: function (target, thisArg, args) {
        return relay(ReflectApply(target, thisArg, args));
      },
    });
    replaceValue(WebAssemblyNs, name, wrapped);
  }

  if (WebAssemblyNs !== null && typeof WebAssemblyNs === 'object') {
    relayed('compile');
    relayed('instantiate');
    relayed('compileStreaming');
    relayed('instantiateStreaming');
  }
});
