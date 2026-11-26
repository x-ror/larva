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
  var TypeErrorP = P.TypeError;
  var StringP = P.String;

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
    return new TypeErrorP(context(iface, op) + detail);
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
    return new TypeErrorP('Illegal invocation');
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
  });
});
