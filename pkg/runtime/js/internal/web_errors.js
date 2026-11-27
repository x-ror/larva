/**
 * @fileoverview The ONE place shared Web API code takes its error text from (CLAUDE.md
 * §5 "Errors follow the profile").
 *
 * A page's errors are what Chrome throws: a plain TypeError / RangeError or a
 * DOMException, no `code` own property, and Blink's WebIDL text — "Failed to execute
 * 'getRandomValues' on 'Crypto': parameter 1 is not of type 'ArrayBufferView'." The
 * builders below produce that text; a shared module never spells "Failed to execute"
 * itself, so the wording lives in one file and changes in one file.
 *
 * Instantiated eagerly (internal/abort and internal/crypto/random require it at their
 * top level), so the captures below are pristine.
 *
 * @module lava/internal/web_errors
 */

(function (require, module) {
  'use strict';

  var P = require('internal/primordials');
  var ErrorP = P.Error;
  var TypeErrorP = P.TypeError;
  var StringP = P.String;
  var NumberP = P.Number;
  var ObjectDefineProperty = P.ObjectDefineProperty;
  var ObjectHasOwn = P.ObjectHasOwn;
  var ObjectGetOwnPropertyDescriptor = P.ObjectGetOwnPropertyDescriptor;
  // Error.isError: a brand check that runs no page code. Captured at this eager eval.
  var ErrorIsError = ErrorP.isError;
  var StringPrototypeCharCodeAt = P.StringPrototypeCharCodeAt;
  var StringPrototypeIndexOf = P.StringPrototypeIndexOf;
  var StringPrototypeSlice = P.StringPrototypeSlice;
  var StringPrototypeStartsWith = P.StringPrototypeStartsWith;

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
   * The context prefix of an error thrown by a named property setter
   * (`localStorage.x = Symbol()`).
   * @param {string} iface
   * @param {string} name The property being set.
   * @returns {string} `Failed to set a named property '<name>' on '<iface>': `.
   * @node n/a — Chrome 158's wording, tests/web/cases/storage-errors.expected.
   * @deviates none
   */
  function namedSetterContext(iface, name) {
    return "Failed to set a named property '" + name + "' on '" + iface + "': ";
  }

  /**
   * The context prefix Blink puts in front of an attribute's error message.
   * @param {string} iface Interface name, as in `'XMLHttpRequest'`.
   * @param {string} attr Attribute name.
   * @param {boolean} set true for the setter, false for the getter.
   * @returns {string} `Failed to set the '<attr>' property on '<iface>': ` or
   *   `Failed to read the '<attr>' property from '<iface>': `.
   * @node n/a — Chrome's wording, recorded in tests/web/cases/xhr-errors.expected
   *       (Chrome 158).
   * @deviates none
   */
  function attributeContext(iface, attr, set) {
    if (set) return "Failed to set the '" + attr + "' property on '" + iface + "': ";
    return "Failed to read the '" + attr + "' property from '" + iface + "': ";
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
  // `node:internal/<id>` and the bootstrap scripts `lava:<name>`), and JSC's location
  // for a host or builtin frame.
  var INTERNAL_URL = 'node:internal/';
  var BOOTSTRAP_URL = 'lava:';
  var NATIVE_LOCATION = '[native code]';
  var NATIVE_SUFFIX = '@' + NATIVE_LOCATION;

  // The '@' that ends a frame's function name: the LAST one, since a name may itself
  // hold one. -1 for a frame that is a bare location.
  function frameAt(stack, start, end) {
    for (var i = end - 1; i >= start; i--) {
      if (StringPrototypeCharCodeAt(stack, i) === 0x40) return i;
    }

    return -1;
  }

  // 0 for a page frame, 1 for one of ours, 2 for a native one. A JSC frame is
  // `name@location:line:column` or a bare location.
  function frameKind(stack, start, end) {
    var location = StringPrototypeSlice(stack, frameAt(stack, start, end) + 1, end);
    if (StringPrototypeStartsWith(location, INTERNAL_URL, 0)) return 1;
    if (StringPrototypeStartsWith(location, BOOTSTRAP_URL, 0)) return 1;
    if (location === NATIVE_LOCATION) return 2;
    return 0;
  }

  // `stack` without our frames, which a page must never see (#114):
  //   - the leading run, up to the page's first frame, goes: the error was made or
  //     thrown inside the platform. A native frame inside that run goes with it
  //     (Reflect.construct under DOMException's constructor); one after the last of
  //     ours stays, since it is the page's (`[x].forEach(atob)` keeps forEach);
  //   - a run between two page frames — a page callback the platform called — becomes
  //     ONE frame, `NAME@[native code]`, named after the outermost of ours (the entry
  //     point the page called): the line JSC itself writes for a native caller, as
  //     `forEach@[native code]` above;
  //   - the trailing run, below the page's last frame (the loop's dispatch), goes.
  // A code-unit scan, not split('\n'): a string separator still consults
  // String.prototype[Symbol.split], which a page can define.
  function scrubStack(stack) {
    var n = stack.length;
    var out = '';
    var seenPage = false;
    // The current run of non-page frames: where it starts, where its last frame of
    // ours ends, and that frame's function name.
    var runStart = 0;
    var oursStart = -1;
    var oursEnd = -1;
    var oursName = '';
    var start = 0;
    while (start < n) {
      var end = StringPrototypeIndexOf(stack, '\n', start);
      if (end === -1) end = n;
      var kind = frameKind(stack, start, end);
      if (kind === 1) {
        if (oursStart === -1) oursStart = start;
        oursEnd = end;
        var at = frameAt(stack, start, end);
        oursName = at === -1 ? '' : StringPrototypeSlice(stack, start, at);
      } else if (kind === 0) {
        out = flushRun(out, stack, runStart, start, oursStart, oursEnd, seenPage ? oursName : null);
        out = appendFrame(out, StringPrototypeSlice(stack, start, end));
        seenPage = true;
        runStart = end + 1;
        oursStart = -1;
      }
      start = end + 1;
    }

    // The trailing run: our frames and everything between them go.
    if (oursStart !== -1) {
      out = appendFrame(
        out,
        StringPrototypeSlice(stack, runStart, oursStart > runStart ? oursStart - 1 : runStart),
      );
    } else if (runStart < n) {
      out = appendFrame(out, StringPrototypeSlice(stack, runStart, n));
    }

    return out;
  }

  // Appends the run [runStart, runEnd) to `out` with its frames of ours, from the first
  // (oursStart) to the last (ending at oursEnd), dropped with everything above them
  // (name === null: the leading run) or replaced by one native frame named `name`.
  function flushRun(out, stack, runStart, runEnd, oursStart, oursEnd, name) {
    if (oursStart === -1) {
      return runEnd > runStart
        ? appendFrame(out, StringPrototypeSlice(stack, runStart, runEnd - 1))
        : out;
    }

    // The leading run loses everything up to its last frame of ours, natives above it
    // included; a later run keeps the natives around its span of ours.
    if (name !== null && oursStart > runStart) {
      out = appendFrame(out, StringPrototypeSlice(stack, runStart, oursStart - 1));
    }
    if (name !== null) out = appendFrame(out, name + NATIVE_SUFFIX);
    if (oursEnd + 1 < runEnd)
      out = appendFrame(out, StringPrototypeSlice(stack, oursEnd + 1, runEnd - 1));
    return out;
  }

  function appendFrame(out, frames) {
    if (frames === '') return out;
    return out === '' ? frames : out + '\n' + frames;
  }

  /**
   * Scrubs an error on its way out of a Web API entry point (internal/native_shape's
   * wrappers) — one the platform made, the engine threw inside our code, or the page
   * threw from a callback we called: its `stack` loses our frames (scrubStack), and an
   * error the engine raised inside our sources loses its `line`/`column`/`sourceURL`,
   * which point there. A page's own error keeps everything but our frames.
   * @param {*} e The thrown value; only a real Error (Error.isError, which runs no page
   *   code — a Proxy's traps are never consulted) is touched.
   * @returns {*} `e`.
   * @node n/a — Chrome 158 names no internal frame (tests/web/cases/shape-stacks).
   * @deviates The frames are JSC's format, and a page callback's caller reads
   *   `NAME@[native code]`, JSC's line for a native caller, where V8 writes
   *   `at NAME (<anonymous>)` — an engine trait.
   */
  function scrubThrown(e, _name) {
    if (ErrorIsError === undefined || !ErrorIsError(e)) return e;
    var desc = ObjectGetOwnPropertyDescriptor(e, 'stack');
    if (desc === undefined || typeof desc.value !== 'string') return e;
    var stack = desc.value;
    if (
      StringPrototypeIndexOf(stack, INTERNAL_URL, 0) === -1 &&
      StringPrototypeIndexOf(stack, BOOTSTRAP_URL, 0) === -1
    ) {
      return e;
    }

    var source = ObjectGetOwnPropertyDescriptor(e, 'sourceURL');
    if (
      source !== undefined &&
      typeof source.value === 'string' &&
      StringPrototypeStartsWith(source.value, INTERNAL_URL, 0)
    ) {
      delete e.line;
      delete e.column;
      delete e.sourceURL;
    }

    if (desc.writable) e.stack = scrubStack(stack);
    return e;
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
    if (typeof value === 'symbol') throw symbolToString(context(iface, op));
    return StringP(value);
  }

  /**
   * toDOMString under an explicit context prefix (namedSetterContext's).
   * @param {*} value
   * @param {string} prefix
   * @returns {string}
   * @throws {TypeError} `<prefix>Cannot convert a Symbol value to a string`.
   * @deviates none
   */
  function toDOMStringIn(value, prefix) {
    if (typeof value === 'symbol') throw symbolToString(prefix);
    return StringP(value);
  }

  function symbolToString(prefix) {
    return pageError(new TypeErrorP(prefix + 'Cannot convert a Symbol value to a string'));
  }

  /**
   * WebIDL's ToNumber step for an integer argument: a Symbol or a BigInt throws.
   * @param {*} value
   * @param {string} iface
   * @param {string} op
   * @returns {number} The number, before the integer type's own clamping or wrapping.
   * @throws {TypeError} `<context>Cannot convert a Symbol value to a number` (or
   *   `a BigInt value`) — Chrome's text; Number(1n) would have answered 1.
   * @node n/a — Chrome 158, tests/web/cases/storage-errors.expected (`key(1n)`).
   * @deviates none
   */
  function toNumber(value, iface, op) {
    if (typeof value === 'symbol') {
      throw typeError(iface, op, 'Cannot convert a Symbol value to a number');
    }

    if (typeof value === 'bigint') {
      throw typeError(iface, op, 'Cannot convert a BigInt value to a number');
    }

    return NumberP(value);
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
    TypeError: TypeErrorP,
    RangeError: P.RangeError,
    context: context,
    namedSetterContext: namedSetterContext,
    toDOMStringIn: toDOMStringIn,
    toNumber: toNumber,
    attributeContext: attributeContext,
    typeError: typeError,
    argumentsRequired: argumentsRequired,
    notOfType: notOfType,
    toDOMString: toDOMString,
    illegalInvocation: illegalInvocation,
    pageError: pageError,
    scrubThrown: scrubThrown,
  });
});
