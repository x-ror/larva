// queueMicrotask, and the dispatcher every event-loop callback runs through.
//
// queueMicrotask lives *inside* JSC's own promise-job queue: it schedules a JSC
// microtask (a resolved-promise reaction), so it shares one FIFO with page promise
// jobs — exactly as the HTML microtask queue is shared. JSC drains that queue at every
// C-API boundary — the end of JSEvaluateScript and the end of each timer/I/O callback
// invocation — which is the microtask checkpoint after each task.
//
// `dispatch` runs one event-loop callback (timer / I/O / fetch completion) with
// `this` the global object; native calls every callback through it
// (globals.odin invoke_user_callback), so a callback's stack shows this one frame of
// the runtime whatever scheduled it, and internal/web_errors scrubs it.
//
// Errors: a throw from a queueMicrotask callback is reported as an uncaught exception
// (the page's error event in Chrome), not an unhandled rejection: every callback runs
// guarded and a throw goes to reportUncaught — the same native reporter the timer path
// uses (report_uncaught + mark_async_failed).
//
// Hardening: every intrinsic the scheduler relies on is captured at install
// time — before any page code runs — so reassigning them afterwards cannot
// silently break scheduling. Function.prototype.bind/call are captured to build
// an uncurryThis helper, which then captures Promise.resolve, Promise.prototype
// .then, and Array.prototype.slice as standalone functions invoked via [[Call]]
// (not through the page-mutable .call); Reflect.apply is captured for callback
// invocation.
//
// The factory returns { dispatch, dispatchCleanups } so install_microtasks can hand
// them to native (see globals.odin install_microtasks / invoke_user_callback).
(function (globalObject, reportUncaught, nativeShape) {
  'use strict';

  var PromiseCtor = Promise;
  var bind = Function.prototype.bind;
  var call = Function.prototype.call;
  var uncurryThis = bind.bind(call);
  var promiseResolve = uncurryThis(Promise.resolve);
  var promiseThen = uncurryThis(Promise.prototype.then);
  var arraySlice = uncurryThis(Array.prototype.slice);
  var functionApply = Reflect.apply;
  var EMPTY = [];
  var resolved = promiseResolve(PromiseCtor);

  function runGuarded(fn, args) {
    try {
      functionApply(fn, undefined, args);
    } catch (error) {
      reportUncaught(error);
    }
  }

  // dispatch runs one event-loop callback. It does not catch: a throw propagates so
  // the native caller reports it as an uncaught async exception, exactly as a direct
  // call would.
  function dispatch(fn) {
    var args = arguments.length > 1 ? arraySlice(arguments, 1) : EMPTY;
    // `this` is globalThis to preserve the prior call sites' semantics, where
    // native passed NULL as thisObject (JSC binds the global object for NULL).
    return functionApply(fn, globalObject, args);
  }

  // dispatchCleanups runs one FinalizationRegistry's due cleanups (pkg/runtime/deferred.odin)
  // as ONE task: each with its held value alone and `this` undefined, a throw reported
  // and the rest still run, the microtasks they queue drained when native's call returns
  // — HTML's cleanup job, which Chrome runs per registry. Named `dispatch` like its
  // sibling, and calling each cleanup straight from here: a cleanup's stack shows the
  // same one frame of this file a timer callback's does, and nothing else of the runtime.
  var dispatchCleanups = function dispatch(fns, values, count) {
    for (var i = 0; i < count; i++) {
      try {
        functionApply(fns[i], undefined, [values[i]]);
      } catch (error) {
        reportUncaught(error);
      }
    }
  };

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

  // The global a page sees is internal/native_shape's operation around this one
  // (native toString, no `prototype`, Chrome's length; tests/web/cases/shape-operations),
  // handed in by install_microtasks from the module loader. An embedder without the
  // loader gets the plain function.
  if (nativeShape) {
    nativeShape.defineOperation('queueMicrotask', queueMicrotask, 1);
  } else {
    globalObject.queueMicrotask = queueMicrotask;
  }

  return { dispatch: dispatch, dispatchCleanups: dispatchCleanups };
});
