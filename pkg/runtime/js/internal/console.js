/**
 * @fileoverview Shapes the `console` namespace as Blink's and adds the members the
 * bootstrap prelude cannot: context(), createTask() and the `memory` accessor.
 *
 * bootstrap/console.js runs before the module loader and has no `require`, so it
 * builds the logging functions and nothing else; this module, instantiated eagerly
 * (the loader names it right after internal/native_shape, before any page code),
 * re-lays them through native_shape and adds the three members Chrome 158 has after
 * timeStamp (tests/web/cases/shape-console.expected). Every capture below is pristine.
 *
 * @module lava/internal/console
 */

(function (require, module) {
  'use strict';

  var P = require('internal/primordials');
  var nativeShape = require('internal/native_shape');
  var webErrors = require('internal/web_errors');
  var ErrorP = P.Error;
  var ObjectCreate = P.ObjectCreate;
  var ObjectProto = P.Object.prototype;
  var ObjectDefineProperty = P.ObjectDefineProperty;
  var ReflectApply = P.ReflectApply;
  var StringP = P.String;
  var TypeErrorP = P.TypeError;
  var illegalInvocation = webErrors.illegalInvocation;
  var pageError = webErrors.pageError;
  var wrapOperation = nativeShape.wrapOperation;

  var console = globalThis.console;
  var EMPTY = [];
  // Mints MemoryInfo objects; a page reaches no constructor at all.
  var INTERNAL = { __proto__: null };
  // A page's own data property: defined, not assigned, so a setter a page put on
  // Object.prototype is not run.
  function defineData(object, key, value) {
    ObjectDefineProperty(object, key, {
      __proto__: null,
      value: value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }

  // Blink's namespace order (Chrome 158, tests/web/cases/shape-console.expected).
  var MEMBERS = [
    'debug',
    'error',
    'info',
    'log',
    'warn',
    'dir',
    'dirxml',
    'table',
    'trace',
    'group',
    'groupCollapsed',
    'groupEnd',
    'clear',
    'count',
    'countReset',
    'assert',
    'profile',
    'profileEnd',
    'time',
    'timeLog',
    'timeEnd',
    'timeStamp',
    'context:1',
    'createTask:0',
    '@@toStringTag',
  ];

  // The members of an object console.context() returns, in Blink's order there (a
  // different one from the namespace's; Chrome 158, tests/web/cases/console-extras).
  var CONTEXT_MEMBERS = [
    'dir',
    'dirxml',
    'table',
    'groupEnd',
    'clear',
    'count',
    'countReset',
    'profile',
    'profileEnd',
    'debug',
    'error',
    'info',
    'log',
    'warn',
    'trace',
    'group',
    'groupCollapsed',
    'time',
    'timeLog',
    'timeEnd',
    'timeStamp',
    'assert',
  ];

  // The prelude's own functions, held before the namespace is re-laid: a context
  // object's members call them, not whatever a page later stores on `console`.
  var impls = { __proto__: null };
  for (var i = 0; i < CONTEXT_MEMBERS.length; i++) {
    impls[CONTEXT_MEMBERS[i]] = console[CONTEXT_MEMBERS[i]];
  }

  function plainError(text) {
    return pageError(new ErrorP(text));
  }

  /**
   * console.context(name): a fresh object of the logging functions.
   * @param {*} [name] Converted to a string, and otherwise unused: a context only
   *   labels DevTools output, and a headless page has no DevTools.
   * @returns {Object} An object over an empty one; each member is its own function of length 1.
   * @node n/a — Chrome 158, tests/web/cases/console-extras.expected.
   * @deviates none
   */
  function context(name) {
    if (name !== undefined) StringP(name);
    // Its [[Prototype]] is a fresh empty object, as a namespace's (Chrome 158).
    var out = ObjectCreate(ObjectCreate(ObjectProto));
    for (var j = 0; j < CONTEXT_MEMBERS.length; j++) {
      var key = CONTEXT_MEMBERS[j];
      defineData(out, key, wrapOperation(key, impls[key], 1));
    }

    return out;
  }

  // A task's [[Prototype]]: an object whose only own key is an anonymous native
  // `constructor` (Chrome 158). One per page.
  var TASK_PROTO = ObjectCreate(ObjectProto);
  ObjectDefineProperty(TASK_PROTO, 'constructor', {
    __proto__: null,
    value: wrapOperation(
      '',
      function () {
        throw illegalInvocation();
      },
      0,
    ),
    writable: true,
    enumerable: false,
    configurable: true,
  });

  // task.run(f): calls `f` with no arguments and no receiver, returning its result.
  var run = wrapOperation(
    'run',
    function (f) {
      if (typeof f !== 'function') throw plainError('First argument must be a function.');
      return ReflectApply(f, undefined, EMPTY);
    },
    0,
  );

  /**
   * console.createTask(name): an async-stack-tagging task (DevTools' "linked" stacks).
   * @param {string} name
   * @returns {Object} `{ run }`, whose run(f) calls f and returns its result.
   * @throws {Error} `First argument must be a non-empty string.` — a plain Error, as
   *   Chrome's (a non-string is refused, not converted); run() throws `First argument
   *   must be a function.` likewise.
   * @node n/a — Chrome 158, tests/web/cases/console-extras.expected.
   * @deviates none: the tagging itself is DevTools-only, so run() is all a page sees.
   */
  function createTask(name) {
    if (typeof name !== 'string' || name === '') {
      throw plainError('First argument must be a non-empty string.');
    }

    var task = ObjectCreate(TASK_PROTO);
    defineData(task, 'run', run);
    return task;
  }

  /**
   * MemoryInfo: what console.memory and (in Chrome) performance.memory return.
   * @node n/a — Chrome 158: no MemoryInfo global; the prototype holds the three
   *   getters and @@toStringTag only, and every read of console.memory is a new object.
   * @deviates The numbers are fixed (10 MB used and total, Chrome's 4 GiB 64-bit
   *   limit), not the engine's: JSC exposes no heap size to the page, and Chrome
   *   itself reports coarse, bucketed values unless started with
   *   --enable-precise-memory-info. Pinned by tests/web/cases/console-extras (it prints
   *   only the relations Chrome's values hold to).
   */
  class MemoryInfo {
    #used = 10000000;

    constructor(token) {
      if (token !== INTERNAL) throw new TypeErrorP('Illegal constructor');
    }

    static #check(o) {
      if (typeof o !== 'object' || o === null || !(#used in o)) throw illegalInvocation();
      return o;
    }

    get totalJSHeapSize() {
      return MemoryInfo.#check(this).#used;
    }

    get usedJSHeapSize() {
      return MemoryInfo.#check(this).#used;
    }

    get jsHeapSizeLimit() {
      MemoryInfo.#check(this);
      return 4294705152;
    }
  }

  nativeShape.defineInterface({
    name: 'MemoryInfo',
    impl: MemoryInfo,
    length: 0,
    illegal: true,
    global: false,
    members: ['totalJSHeapSize', 'usedJSHeapSize', 'jsHeapSizeLimit', '@@toStringTag'],
  });
  // Not an interface a page can name: its prototype has no `constructor`.
  delete MemoryInfo.prototype.constructor; // primordials-ok: accessor — a delete on our own class prototype

  defineData(console, 'context', context);
  defineData(console, 'createTask', createTask);
  nativeShape.defineNamespace(console, 'console', MEMBERS);
  // node's console.Console constructor: not a member of Chrome's console namespace.
  delete console.Console;
  // An accessor whose getter and setter are anonymous natives (Chrome 158); assigning
  // to console.memory does nothing.
  ObjectDefineProperty(console, 'memory', {
    __proto__: null,
    get: wrapOperation(
      '',
      function () {
        return new MemoryInfo(INTERNAL);
      },
      0,
    ),
    set: wrapOperation('', function () {}, 1),
    enumerable: true,
    configurable: true,
  });
});
