// internal/errors — the ONE place a builtin builds a Node-shaped coded error.
//
// Builtins used to carry private copies of node's ERR_* constructors — a dozen spellings
// of the "Received …" describer alone, across buffer, encoding, crypto, os, fs, util,
// parse_env, events, url, dns, path and stream. They drifted from node
// AND from each other — path printed "Received type number" with no value, crypto
// "type string" with none either and no `_` grouping on large integers, dns
// "type undefined (undefined)", url "type object ()" — and each fix landed in one copy
// while the rest kept the bug. The file splits that follow this module would have copied
// them again. A builtin requires this module instead; a local copy is a review reject
// (CLAUDE.md §5).
//
// TWO SHAPES, because node has two and String(e) tells them apart (node 26.13.0, probed
// through each consumer's public API — tests/node-compat/cases/76-coded-error-shape.js):
//   nodeError    node's JS layer (`new ERR_X(...)` in lib/internal/errors.js). The code is
//                spliced into String(e) by an inherited toString:
//                `TypeError [ERR_INVALID_ARG_TYPE]: The "size" argument …`.
//   nativeError  node's C++ layer (THROW_ERR_X — URL parsing, the encoding binding,
//                sqlite, timingSafeEqual). A bare TypeError/RangeError/Error with a `code`
//                own property; String(e) is `TypeError: Invalid URL`.
// Two constructors for one idea would be the smell CLAUDE.md warns about if the idea
// were one; here the observable surface differs, so a consumer must pick the shape its
// node counterpart throws, and the name says which.
//
// Hardened from day one: every intrinsic comes from primordials, captured at module-eval.
// This module is EAGER (buffer, url and crypto require it at their top level, and the
// loader instantiates those before user code), so those captures are pristine; the
// exports table is frozen, so a lazy consumer capturing a function from it gets the
// same pristine function.
(function (require, module) {
  'use strict';

  var P = require('internal/primordials');
  var TypeErrorP = P.TypeError;
  var RangeErrorP = P.RangeError;
  var StringP = P.String;
  var ObjectCreate = P.ObjectCreate;
  var ObjectFreeze = P.ObjectFreeze;
  var ObjectSetPrototypeOf = P.ObjectSetPrototypeOf;
  var ArrayIsArray = P.ArrayIsArray;
  var ArrayPrototypeIndexOf = P.ArrayPrototypeIndexOf;
  var ArrayPrototypeJoin = P.ArrayPrototypeJoin;
  var ArrayPrototypePop = P.ArrayPrototypePop;
  var ArrayPrototypePush1 = P.ArrayPrototypePush1;
  var ArrayPrototypeSplice = P.ArrayPrototypeSplice;
  var JSONStringify = P.JSONStringify;
  var NumberIsInteger = P.NumberIsInteger;
  var StringPrototypeCharCodeAt = P.StringPrototypeCharCodeAt;
  var StringPrototypeEndsWith = P.StringPrototypeEndsWith;
  var StringPrototypeIndexOf = P.StringPrototypeIndexOf;
  var StringPrototypeSlice = P.StringPrototypeSlice;
  var StringPrototypeToLowerCase = P.StringPrototypeToLowerCase;

  // util.inspect, for the three places node renders a value through it: a constructor-less
  // object in determineSpecificType, every ERR_INVALID_ARG_VALUE, and an ERR_OUT_OF_RANGE
  // received value that is not a plain number. Taken from internal/util/inspect — the
  // module node:util re-exports it from — not from node:util itself, so a coded error
  // raised on the Window surface does not instantiate a js/node/ module (node:util and
  // everything it requires), which `.Web` must never load
  // (cmd/lava/global_surface_test.odin, global_surface_web_loads_no_node_module). Looked
  // up on first use: internal/util/inspect is LAZY, and making it eager would put its
  // factory on every script's startup for text that is only ever built when a call is
  // already failing. It also closes the residual the node:util lookup had: a replaced
  // `require('util').inspect` no longer steers this text, since user code cannot reach
  // an internal/ module.
  var inspectFn = null;
  function inspect(value, opts) {
    if (inspectFn === null) inspectFn = require('internal/util/inspect').inspect;
    return inspectFn(value, opts);
  }

  // One prototype per (Base, code), holding node's toString. node builds a subclass per
  // code (makeNodeErrorWithCode) whose toString closes over the key; the observable parts
  // are kept — `e.name`, `e.constructor === TypeError`, `instanceof`, no own `toString`,
  // and String(e) reading the CURRENT name/message but the ORIGINAL code — while node's
  // second prototype level and its kIsNodeError symbol are not, as nothing outside node's
  // own internals reads either.
  var protoTables = [];
  function protoFor(Base, code) {
    var table = null;
    for (var i = 0; i < protoTables.length; i += 2) {
      if (protoTables[i] === Base) {
        table = protoTables[i + 1];
        break;
      }
    }
    if (table === null) {
      table = { __proto__: null };
      ArrayPrototypePush1(protoTables, Base);
      ArrayPrototypePush1(protoTables, table);
    }
    var proto = table[code];
    if (proto === undefined) {
      proto = ObjectCreate(Base.prototype, {
        toString: {
          value: function toString() {
            return this.name + ' [' + code + ']: ' + this.message;
          },
          writable: true,
          enumerable: false,
          configurable: true,
        },
      });
      table[code] = proto;
    }
    return proto;
  }

  /**
   * Builds an error the way node's JS layer does (`new ERR_X(...)`).
   * @param {Function} Base P.Error / P.TypeError / P.RangeError from primordials.
   * @param {string} code
   * @param {string} message
   * @returns {Error} `code` is an enumerable own data property, `message` a
   *   non-enumerable one, and String(e) is `${name} [${code}]: ${message}`.
   * @node `String(e)` for Buffer.alloc('x') is `TypeError [ERR_INVALID_ARG_TYPE]: …`,
   *       Object.keys(e) is ['code'], e.constructor === TypeError (node 26.13.0, case 76).
   * @deviates Own property names are JSC's (message, code, line, column, sourceURL,
   *   stack) rather than V8's (stack, code, message), and `e.stack` carries no
   *   `TypeError [CODE]: msg` header line — both are engine traits shared by every
   *   Error in Lava, not something an error constructor can change.
   */
  function nodeError(Base, code, message) {
    var e = new Base(message);
    ObjectSetPrototypeOf(e, protoFor(Base, code));
    e.code = code;
    return e;
  }

  /**
   * Builds an error the way node's C++ layer does (THROW_ERR_X): no code in String(e).
   * @param {Function} Base
   * @param {string} code
   * @param {string} message
   * @returns {Error}
   * @node `new URL('nope')` stringifies as `TypeError: Invalid URL` with code
   *       ERR_INVALID_URL; sqlite and timingSafeEqual likewise (node 26.13.0, case 76).
   * @deviates none
   */
  function nativeError(Base, code, message) {
    var e = new Base(message);
    e.code = code;
    return e;
  }

  /**
   * Node's determineSpecificType: the "Received …" tail of ERR_INVALID_ARG_TYPE.
   * @param {*} value
   * @returns {string}
   * @node null/undefined bare; `type number (-0)`; `type bigint (5n)`;
   *       `type symbol (Symbol(s))`; `function named` (`function ` for an anonymous one,
   *       a class is a function); `an instance of Foo`; a string cut to 25 chars + '...'
   *       when longer than 28, quoted with ' unless it contains one, then JSON-quoted.
   *       Every branch is pinned by case 76 (node 26.13.0).
   * @deviates A null-prototype object goes through util.inspect as node's does, and
   *   Lava's inspect renders it `{}` where node prints `[Object: null prototype] {}`
   *   (#331) — an inspect gap, not one of this function's.
   */
  function determineSpecificType(value) {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    var type = typeof value;
    if (type === 'string') {
      if (value.length > 28) value = StringPrototypeSlice(value, 0, 25) + '...';
      if (StringPrototypeIndexOf(value, "'", 0) === -1) return "type string ('" + value + "')";
      return 'type string (' + JSONStringify(value) + ')';
    }
    // -0: string concatenation erases the sign, node prints it.
    if (type === 'number')
      return 'type number (' + (value === 0 && 1 / value < 0 ? '-0' : value) + ')';
    if (type === 'bigint') return 'type bigint (' + value + 'n)';
    if (type === 'boolean') return 'type boolean (' + value + ')';
    if (type === 'symbol') return 'type symbol (' + StringP(value) + ')';
    if (type === 'function') return 'function ' + value.name;
    // node reads the RECEIVER's `.constructor.name` for this text, so reading it is what
    // parity requires — a captured getter would answer for the wrong object. A forged
    // constructor changes the text of an error already being thrown, nothing else.
    var ctor = value.constructor; // primordials-ok: accessor
    if (ctor && 'name' in ctor) return 'an instance of ' + ctor.name;
    return inspect(value, { depth: -1 });
  }

  // node's classRegExp, /^([A-Z][a-z0-9]*)+$/, as a code-unit loop (CLAUDE.md §5: no
  // RegExp where a character class will do). The pattern accepts exactly an ASCII
  // alphanumeric string whose first unit is an upper-case letter.
  function isClassName(s) {
    var n = s.length;
    if (n === 0) return false;
    var c = StringPrototypeCharCodeAt(s, 0);
    if (c < 0x41 || c > 0x5a) return false;
    for (var i = 1; i < n; i++) {
      c = StringPrototypeCharCodeAt(s, i);
      if (!((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a))) {
        return false;
      }
    }
    return true;
  }

  var kTypes = [
    'string',
    'function',
    'number',
    'object',
    'Function',
    'Object',
    'boolean',
    'bigint',
    'symbol',
  ];

  // ', ' join with ', or <last>' for three and more — node's list form, shared by the
  // three groups below.
  function listOf(items, prefix) {
    if (items.length > 2) {
      var last = ArrayPrototypePop(items);
      return prefix + ArrayPrototypeJoin(items, ', ') + ', or ' + last;
    }
    return null;
  }

  /**
   * ERR_INVALID_ARG_TYPE (TypeError, JS shape).
   * @param {string} name Argument name; `x.y` reads "property", `first argument` is
   *   spliced bare, anything else is quoted as an "argument".
   * @param {string|string[]} expected node's list: type names (`'number'`), class names
   *   (`'Buffer'`) and free text (`'Array-like Object'`), in any mix — never a prebuilt
   *   phrase such as 'of type number'.
   * @param {*} actual Rendered by determineSpecificType.
   * @returns {TypeError}
   * @node lib/internal/errors.js's template, case for case: `of type string or an
   *       instance of Buffer, TypedArray, or DataView`, `one of type string or object`,
   *       `an instance of Buffer or Uint8Array`, `an Array-like Object` (node 26.13.0,
   *       case 76 through buffer/fs/crypto/stream/url).
   * @deviates none
   */
  function ERR_INVALID_ARG_TYPE(name, expected, actual) {
    if (!ArrayIsArray(expected)) expected = [expected];
    var msg = 'The ';
    if (StringPrototypeEndsWith(name, ' argument')) msg += name + ' ';
    else
      msg +=
        '"' +
        name +
        '" ' +
        (StringPrototypeIndexOf(name, '.', 0) !== -1 ? 'property ' : 'argument ');
    msg += 'must be ';

    var types = [];
    var instances = [];
    var other = [];
    for (var i = 0; i < expected.length; i++) {
      var value = expected[i];
      if (ArrayPrototypeIndexOf(kTypes, value) !== -1)
        ArrayPrototypePush1(types, StringPrototypeToLowerCase(value));
      else if (isClassName(value)) ArrayPrototypePush1(instances, value);
      else ArrayPrototypePush1(other, value);
    }
    // `object` next to class names is spelled as the class `Object`, so the sentence
    // contrasts instances with instances.
    if (instances.length > 0) {
      var pos = ArrayPrototypeIndexOf(types, 'object');
      if (pos !== -1) {
        ArrayPrototypeSplice(types, pos, 1);
        ArrayPrototypePush1(instances, 'Object');
      }
    }

    if (types.length > 0) {
      msg +=
        listOf(types, 'one of type ') ||
        (types.length === 2
          ? 'one of type ' + types[0] + ' or ' + types[1]
          : 'of type ' + types[0]);
      if (instances.length > 0 || other.length > 0) msg += ' or ';
    }
    if (instances.length > 0) {
      msg +=
        listOf(instances, 'an instance of ') ||
        'an instance of ' + instances[0] + (instances.length === 2 ? ' or ' + instances[1] : '');
      if (other.length > 0) msg += ' or ';
    }
    if (other.length > 0) {
      var others = listOf(other, 'one of ');
      if (others !== null) msg += others;
      else if (other.length === 2) msg += 'one of ' + other[0] + ' or ' + other[1];
      else msg += (StringPrototypeToLowerCase(other[0]) !== other[0] ? 'an ' : '') + other[0];
    }
    return nodeError(
      TypeErrorP,
      'ERR_INVALID_ARG_TYPE',
      msg + '. Received ' + determineSpecificType(actual),
    );
  }

  /**
   * ERR_INVALID_ARG_VALUE (TypeError, JS shape).
   * @param {string} name `x.y` reads "property", anything else "argument".
   * @param {*} value Rendered by util.inspect, cut to 128 chars + '...'.
   * @param {string} [reason='is invalid']
   * @returns {TypeError}
   * @node `The argument 'hints' is invalid. Received 999999`, `The property
   *       'options.family' must be one of: 0, 4, 6. Received '4'` (node 26.13.0, case 76).
   * @deviates none
   */
  function ERR_INVALID_ARG_VALUE(name, value, reason) {
    var inspected = inspect(value);
    if (inspected.length > 128) inspected = StringPrototypeSlice(inspected, 0, 128) + '...';
    var kind = StringPrototypeIndexOf(name, '.', 0) !== -1 ? 'property' : 'argument';
    return nodeError(
      TypeErrorP,
      'ERR_INVALID_ARG_VALUE',
      'The ' +
        kind +
        " '" +
        name +
        "' " +
        (reason === undefined ? 'is invalid' : reason) +
        '. Received ' +
        inspected,
    );
  }

  // node's addNumericalSeparator: `_` every three digits from the right, the sign kept
  // out of the grouping. Applied to String(input) verbatim, so an exponent form is
  // grouped as text exactly as node groups it.
  function addNumericalSeparator(val) {
    var res = '';
    var i = val.length;
    var start = StringPrototypeCharCodeAt(val, 0) === 0x2d ? 1 : 0;
    for (; i >= start + 4; i -= 3) res = '_' + StringPrototypeSlice(val, i - 3, i) + res;
    return StringPrototypeSlice(val, 0, i) + res;
  }

  /**
   * ERR_OUT_OF_RANGE (RangeError, JS shape).
   * @param {string} name
   * @param {string} range Spliced after "It must be ".
   * @param {*} input
   * @returns {RangeError}
   * @node An integer whose magnitude exceeds 2 ** 32 is `_`-grouped
   *       (`1_099_511_627_776`), a bigint past ±2n ** 32n too and always suffixed `n`;
   *       anything else is util.inspect'd (`1.5`, `-0`). node 26.13.0, case 76 through
   *       buffer/crypto/os.
   * @deviates none
   */
  function ERR_OUT_OF_RANGE(name, range, input) {
    var received;
    if (NumberIsInteger(input) && (input > 4294967296 || input < -4294967296)) {
      received = addNumericalSeparator(StringP(input));
    } else if (typeof input === 'bigint') {
      received = StringP(input);
      if (input > 4294967296n || input < -4294967296n) received = addNumericalSeparator(received);
      received += 'n';
    } else if (typeof input === 'number') {
      // inspect's answer for a number, without loading util on the common path.
      received = input === 0 && 1 / input < 0 ? '-0' : StringP(input);
    } else {
      received = inspect(input);
    }
    return nodeError(
      RangeErrorP,
      'ERR_OUT_OF_RANGE',
      'The value of "' + name + '" is out of range. It must be ' + range + '. Received ' + received,
    );
  }

  /**
   * ERR_MISSING_ARGS (TypeError, JS shape) for one missing argument — the only form any
   * builtin raises today; node's multi-name forms are not reproduced until one does.
   * @param {string} name
   * @returns {TypeError}
   * @node `The "streams" argument must be specified` (pipeline), `The "input" argument
   *       must be specified` (atob) — node 26.13.0, case 76.
   * @deviates none
   */
  function ERR_MISSING_ARGS(name) {
    return nodeError(
      TypeErrorP,
      'ERR_MISSING_ARGS',
      'The "' + name + '" argument must be specified',
    );
  }

  /**
   * ERR_UNKNOWN_ENCODING (TypeError, JS shape).
   * @param {*} encoding Concatenated as-is, as node's template does.
   * @returns {TypeError}
   * @node `Unknown encoding: bogus` for buf.toString, stream write and StringDecoder
   *       (node 26.13.0, case 76).
   * @deviates none
   */
  function ERR_UNKNOWN_ENCODING(encoding) {
    return nodeError(TypeErrorP, 'ERR_UNKNOWN_ENCODING', 'Unknown encoding: ' + encoding);
  }

  module.exports = ObjectFreeze({
    __proto__: null,
    nodeError: nodeError,
    nativeError: nativeError,
    determineSpecificType: determineSpecificType,
    ERR_INVALID_ARG_TYPE: ERR_INVALID_ARG_TYPE,
    ERR_INVALID_ARG_VALUE: ERR_INVALID_ARG_VALUE,
    ERR_OUT_OF_RANGE: ERR_OUT_OF_RANGE,
    ERR_MISSING_ARGS: ERR_MISSING_ARGS,
    ERR_UNKNOWN_ENCODING: ERR_UNKNOWN_ENCODING,
  });
});
