// process.nextTick and queueMicrotask, ordered to match Node on JavaScriptCore.
//
// JSC drains its own promise-job (microtask) queue automatically at every C-API
// boundary — the end of JSEvaluateScript and the end of each timer/I/O callback
// invocation — and the JSC C API exposes no portable hook to drain an embedder
// queue ahead of it. queueMicrotask therefore lives *inside* that queue: it
// schedules a JSC microtask (a resolved-promise reaction), so it shares one FIFO
// with user promise jobs — exactly as Node's queueMicrotask shares the microtask
// queue with Promise jobs.
//
// process.nextTick keeps Node's higher, ABSOLUTE priority by NOT living in JSC's
// queue. nextTick callbacks accumulate in a plain queue here, and native drains
// that queue at the two checkpoints that recreate Node's
//   do { drain nextTicks fully; run microtasks fully } while (nextTicks)
// loop on top of JSC's auto-draining promise queue:
//
//   Checkpoint 1 (`dispatch`): every event-loop callback (timer / immediate /
//   I/O / fetch completion) is invoked THROUGH `dispatch`, which runs it and then
//   drains the nextTick queue in a `finally` — i.e. *before* returning to native,
//   so before JSC auto-drains the promise jobs the callback queued. That is what
//   gives a nextTick priority over a promise job registered earlier in the same
//   turn (`Promise.resolve().then(p); process.nextTick(nt)` → nt, then p). The
//   top-level script is handled the same way: native appends a drain to the
//   source so it runs before JSEvaluateScript returns.
//
//   Checkpoint 2 (`drainNextTicks`, looped by native): after the callback's
//   C-API call returns and JSC auto-drains its promise jobs, native re-drains the
//   nextTick queue — running nextTicks those promise jobs queued — and repeats
//   until a drain does no work (each native drain call is itself a C-API boundary,
//   so JSC re-drains promises between iterations). That is what makes a nextTick
//   queued *first inside a microtask* still run after the microtask queue empties
//   (`queueMicrotask(() => { nextTick(nt); queueMicrotask(qm); })` → qm, then nt).
//
// Errors: a throw from a nextTick/queueMicrotask callback is an *uncaught
// exception* in Node (it reaches uncaughtException), NOT an unhandled rejection.
// We therefore run every callback guarded and route a throw to reportUncaught —
// the same native reporter the timer path uses (report_uncaught +
// mark_async_failed) — so the category matches and one throwing callback does
// not abort the rest of the drain. (Like the timer path, Lava reports and keeps
// draining rather than halting the process the instant a callback throws; the
// process still exits non-zero.)
//
// Hardening: every intrinsic the scheduler relies on is captured at install
// time — before any user code runs — so reassigning them afterwards cannot
// silently break scheduling. Function.prototype.bind/call are captured to build
// an uncurryThis helper, which then captures Promise.resolve, Promise.prototype
// .then, and Array.prototype.slice as standalone functions invoked via [[Call]]
// (not through the user-mutable .call); Reflect.apply is captured for callback
// invocation; and the nextTick queue is stored/advanced by index rather than via
// Array.prototype.push/shift. (The runtime otherwise avoids primordials; the
// scheduler is special because every async API depends on it.)
//
// The factory returns { drainNextTicks, dispatch } so install_microtasks can hand
// them to native (see globals.odin install_microtasks / invoke_user_callback).
(function (globalObject, process, reportUncaught) {
  'use strict';

  var PromiseCtor = Promise;
  var bind = Function.prototype.bind;
  var call = Function.prototype.call;
  var uncurryThis = bind.bind(call);
  var promiseResolve = uncurryThis(Promise.resolve);
  var promiseThen = uncurryThis(Promise.prototype.then);
  var arraySlice = uncurryThis(Array.prototype.slice);
  var functionApply = Reflect.apply;
  var objectDefineProperty = Object.defineProperty;
  var EMPTY = [];
  var resolved = promiseResolve(PromiseCtor);

  function runGuarded(fn, args) {
    try {
      functionApply(fn, undefined, args);
    } catch (error) {
      reportUncaught(error);
    }
  }

  var queue = [];
  var head = 0;
  var tail = 0;
  var draining = false;

  // drainNextTicks empties the process.nextTick queue — including nextTicks
  // queued *by* draining callbacks and nested ones — and returns true if it ran
  // at least one callback. The reentrancy guard makes a nested call a no-op (a
  // nextTick callback cannot re-drain mid-drain), so native's checkpoint-2 loop
  // and dispatch's checkpoint-1 finally never double-run a callback.
  function drainNextTicks() {
    if (draining || head >= tail) return false;
    draining = true;
    var ran = false;
    try {
      while (head < tail) {
        var task = queue[head];
        queue[head] = undefined;
        head = head + 1;
        ran = true;
        runGuarded(task.fn, task.args);
      }
      head = 0;
      tail = 0;
      queue.length = 0;
    } finally {
      draining = false;
    }
    return ran;
  }

  // dispatch runs one event-loop callback and then drains nextTicks before
  // returning to native (checkpoint 1). It does not catch: a throw propagates so
  // the native caller reports it as an uncaught async exception, exactly as a
  // direct call would — the `finally` still drains the ticks queued before the
  // throw.
  function dispatch(fn) {
    var args = arguments.length > 1 ? arraySlice(arguments, 1) : EMPTY;
    try {
      // `this` is globalThis to preserve the prior call sites' semantics, where
      // native passed NULL as thisObject (JSC binds the global object for NULL).
      return functionApply(fn, globalObject, args);
    } finally {
      drainNextTicks();
    }
  }

  function nextTick(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError(
        'The "callback" argument must be of type function. Received ' + typeof callback,
      );
    }
    var args = arguments.length > 1 ? arraySlice(arguments, 1) : EMPTY;
    queue[tail] = { fn: callback, args: args };
    tail = tail + 1;
  }

  function queueMicrotask(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError(
        'The "callback" argument must be of type function. Received ' + typeof callback,
      );
    }
    promiseThen(resolved, function () {
      runGuarded(callback, EMPTY);
    });
  }

  process.nextTick = nextTick;
  globalObject.queueMicrotask = queueMicrotask;

  // Internal, non-enumerable global so the native top-level drain shim (a trailing
  // statement appended to the entry source) can reach checkpoint 1 before
  // JSEvaluateScript returns. Native also receives drainNextTicks directly via the
  // factory return below; this hook exists only for the JS-source-level drain.
  objectDefineProperty(globalObject, '__lavaDrainNextTicks', {
    value: drainNextTicks,
    writable: false,
    enumerable: false,
    configurable: false,
  });

  // Pre-create the binding the top-level drain assigns to, as a non-enumerable
  // property. The appended `var __lava_tl_drain = ...` (a VariableStatement, kept
  // for its empty completion value — see runtime.odin) would otherwise create an
  // *enumerable*, non-configurable global; redeclaring an existing own property
  // instead writes through without changing this descriptor, so the internal name
  // stays out of `Object.keys(globalThis)` / `for...in`.
  objectDefineProperty(globalObject, '__lava_tl_drain', {
    value: undefined,
    writable: true,
    enumerable: false,
    configurable: false,
  });

  return { drainNextTicks: drainNextTicks, dispatch: dispatch };
});
