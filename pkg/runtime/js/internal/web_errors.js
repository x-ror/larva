/**
 * @fileoverview The ONE place shared Web API code takes its error text from: which
 * surface the context runs (docs/LARVA.md decision 1) and the wording each surface's
 * oracle uses (CLAUDE.md §5 "Errors follow the profile").
 *
 * On the Window surface a page's errors are what Chrome throws: a plain TypeError /
 * RangeError or a DOMException, no `code` own property, and Blink's WebIDL text —
 * "Failed to execute 'getRandomValues' on 'Crypto': parameter 1 is not of type
 * 'ArrayBufferView'." The builders below produce that text; a shared module never
 * spells "Failed to execute" itself, so the wording lives in one file and changes in
 * one file. On the Node surface the same module keeps node's text, which is what
 * `web` is for: a call site picks between the two strings, and the node arm is deleted
 * with the Node surface (stage S5b of the removal plan) rather than abstracted over
 * now — the two oracles disagree per call site, not per template, so a table keyed by
 * message would only move the per-site choice somewhere harder to read.
 *
 * Node's coded errors stay in internal/errors.js and must not be reached from a web
 * arm: a page never sees an `ERR_*` code (tests/web/cases/*-errors.js print `own code`).
 *
 * `profile` is the fourth factory argument, handed in by bootstrap/loader.js as a
 * frozen `{ web }` — set from Global_Surface before any module runs, never read off a
 * global user code could reach.
 *
 * Instantiated eagerly (internal/abort and internal/crypto/random require it at their
 * top level), so the captures below are pristine.
 *
 * @module lava/internal/web_errors
 */

(function (require, module, _exports, profile) {
  'use strict';

  var P = require('internal/primordials');
  var ErrorP = P.Error;
  var TypeErrorP = P.TypeError;
  var StringP = P.String;
  var ObjectDefineProperty = P.ObjectDefineProperty;
  var ObjectHasOwn = P.ObjectHasOwn;
  var StringPrototypeCharCodeAt = P.StringPrototypeCharCodeAt;
  var StringPrototypeIndexOf = P.StringPrototypeIndexOf;
  var StringPrototypeSlice = P.StringPrototypeSlice;
  var StringPrototypeStartsWith = P.StringPrototypeStartsWith;

  var web = profile !== undefined && profile !== null && profile.web === true;

  /**
   * The context prefix Blink puts in front of every WebIDL error message.
   * @param {string} iface Interface name, as in `'Crypto'`.
   * @param {string} [op] Operation name; omitted for a constructor.
   * @returns {string} `Failed to execute '<op>' on '<iface>': ` or
   *   `Failed to construct '<iface>': `.
   * @node n/a — Chrome's wording, recorded in tests/web/cases/*-errors.expected
   *       (Chrome 158).
   * @deviates none
   */
  function context(iface, op) {
    if (op === undefined) return "Failed to construct '" + iface + "': ";
    return "Failed to execute '" + op + "' on '" + iface + "': ";
  }

  /**
   * A WebIDL TypeError as Chrome throws it: plain TypeError, no `code`.
   * @param {string} iface
   * @param {string|undefined} op
   * @param {string} detail The text after the context prefix.
   * @returns {TypeError}
   * @deviates none
   */
  function typeError(iface, op, detail) {
    return pageError(new TypeErrorP(context(iface, op) + detail));
  }

  // Where the embedded sources run (globals.odin names internal modules
  // `node:internal/<id>`), and JSC's location for a host or builtin frame.
  var INTERNAL_URL = 'node:internal/';
  var NATIVE_LOCATION = '[native code]';

  // 0 for a page frame, 1 for one of ours, 2 for a native one. A JSC frame is
  // `name@location:line:column` or a bare location; the location is what follows
  // the LAST '@', since a function name may itself hold one.
  function frameKind(stack, start, end) {
    var at = -1;
    for (var i = end - 1; i >= start; i--) {
      if (StringPrototypeCharCodeAt(stack, i) === 0x40) {
        at = i;
        break;
      }
    }

    var location = StringPrototypeSlice(stack, at + 1, end);
    if (StringPrototypeStartsWith(location, INTERNAL_URL, 0)) return 1;
    if (location === NATIVE_LOCATION) return 2;
    return 0;
  }

  // `stack` without its leading run of our own frames. A native frame inside that run
  // goes with it (Reflect.construct under DOMException's constructor); one after the
  // last of ours stays, since it is the page's (`[x].forEach(atob)` keeps forEach).
  // A code-unit scan, not split('\n'): a string separator still consults
  // String.prototype[Symbol.split], which a page can define.
  function scrubStack(stack) {
    var cut = 0;
    var start = 0;
    var n = stack.length;
    while (start < n) {
      var end = StringPrototypeIndexOf(stack, '\n', start);
      if (end === -1) end = n;
      var kind = frameKind(stack, start, end);
      if (kind === 0) break;
      start = end + 1;
      if (kind === 1) cut = start;
    }

    return cut === 0 ? stack : StringPrototypeSlice(stack, cut, n);
  }

  /**
   * Readies an error the platform throws (or hands out as a reason) for the page that
   * will catch it: drops JSC's `line`/`column`/`sourceURL` own properties, which a
   * Chrome error does not have and which here would point into our sources, and gives
   * it a `stack` that starts at the page's own frame — captured now when it has none
   * (a DOMException, whose constructor leaves none on the Window surface). Every
   * thrower in shared Web API code passes its error through this once.
   * @param {Error} e
   * @returns {Error} `e`.
   * @node n/a. Chrome 158: a thrown TypeError owns `stack` and `message`, a thrown
   *       DOMException owns `stack` only, and no frame names an internal source
   *       (tests/web/cases/errors-stack.expected).
   * @deviates The frames themselves are JSC's format (`fn@url:line:col`), an engine
   *   trait; only which frames appear is ours.
   */
  function pageError(e) {
    delete e.line;
    delete e.column;
    delete e.sourceURL;
    if (ObjectHasOwn(e, 'stack')) {
      e.stack = scrubStack(StringP(e.stack));
    } else {
      ObjectDefineProperty(e, 'stack', {
        value: scrubStack(StringP(new ErrorP().stack)),
        writable: true,
        enumerable: false,
        configurable: true,
      });
    }

    return e;
  }

  /**
   * The detail for a call with too few arguments.
   * @param {number} required
   * @param {number} present
   * @returns {string} `1 argument required, but only 0 present.`
   * @deviates none
   */
  function argumentsRequired(required, present) {
    return (
      required +
      (required === 1 ? ' argument' : ' arguments') +
      ' required, but only ' +
      present +
      ' present.'
    );
  }

  /**
   * The detail for an argument that fails its interface-type conversion.
   * @param {number} index 1-based, as Blink counts.
   * @param {string} type The IDL type, as in `'ArrayBufferView'`.
   * @returns {string} `parameter 1 is not of type 'ArrayBufferView'.`
   * @deviates none
   */
  function notOfType(index, type) {
    return 'parameter ' + index + " is not of type '" + type + "'.";
  }

  /**
   * WebIDL's DOMString conversion: ToString, which throws on a Symbol.
   * @param {*} value
   * @param {string} iface
   * @param {string} [op]
   * @returns {string}
   * @throws {TypeError} `<context>Cannot convert a Symbol value to a string` — Chrome's
   *   text; JSC's own String() would have answered "Symbol(…)" and not thrown.
   * @deviates none
   */
  function toDOMString(value, iface, op) {
    if (typeof value === 'symbol') {
      throw typeError(iface, op, 'Cannot convert a Symbol value to a string');
    }

    return StringP(value);
  }

  /**
   * What Blink throws for an operation or accessor called on a receiver that is not
   * an instance of its interface (`Object.getOwnPropertyDescriptor(DOMException.prototype,
   * 'code').get.call({})`). No context prefix, in Chrome either.
   * @returns {TypeError} `Illegal invocation`
   * @deviates none
   */
  function illegalInvocation() {
    return pageError(new TypeErrorP('Illegal invocation'));
  }

  module.exports = P.ObjectFreeze({
    __proto__: null,
    web: web,
    TypeError: TypeErrorP,
    RangeError: P.RangeError,
    context: context,
    typeError: typeError,
    argumentsRequired: argumentsRequired,
    notOfType: notOfType,
    toDOMString: toDOMString,
    illegalInvocation: illegalInvocation,
    pageError: pageError,
  });
});
