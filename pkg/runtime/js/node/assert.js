// node:assert (strict semantics) — real assertions that throw AssertionError,
// replacing the previous no-op stubs. Uses util.inspect for readable messages.
(function (require, module) {
  'use strict';

  var util = require('util');
  var inspect = util.inspect;
  var isDeepStrictEqual = util.isDeepStrictEqual;

  function AssertionError(options) {
    var message = options.message;
    if (!message) {
      message = inspect(options.actual) + ' ' + options.operator + ' ' + inspect(options.expected);
    }
    var err = new Error(message);
    err.name = 'AssertionError';
    err.code = 'ERR_ASSERTION';
    err.actual = options.actual;
    err.expected = options.expected;
    err.operator = options.operator;
    if (Error.captureStackTrace) Error.captureStackTrace(err, options.stackStartFn || assert);
    return err;
  }

  function fail(actual, expected, message, operator, stackStartFn) {
    if (arguments.length === 1) {
      throw AssertionError({ message: actual, operator: 'fail', stackStartFn: fail });
    }
    throw AssertionError({
      actual: actual,
      expected: expected,
      message: message,
      operator: operator || 'fail',
      stackStartFn: stackStartFn || fail,
    });
  }

  function innerOk(fn, value, message) {
    if (!value) {
      if (message instanceof Error) throw message;
      throw AssertionError({
        actual: value,
        expected: true,
        message: message,
        operator: '==',
        stackStartFn: fn,
      });
    }
  }

  function assert(value, message) {
    innerOk(assert, value, message);
  }
  var ok = assert;

  function equal(actual, expected, message) {
    if (!Object.is(actual, expected) && actual !== expected) {
      throw AssertionError({
        actual: actual,
        expected: expected,
        message: message,
        operator: 'strictEqual',
        stackStartFn: equal,
      });
    }
  }

  function notEqual(actual, expected, message) {
    if (actual === expected) {
      throw AssertionError({
        actual: actual,
        expected: expected,
        message: message,
        operator: 'notStrictEqual',
        stackStartFn: notEqual,
      });
    }
  }

  function deepEqual(actual, expected, message) {
    if (!isDeepStrictEqual(actual, expected)) {
      throw AssertionError({
        actual: actual,
        expected: expected,
        message: message,
        operator: 'deepStrictEqual',
        stackStartFn: deepEqual,
      });
    }
  }

  function notDeepEqual(actual, expected, message) {
    if (isDeepStrictEqual(actual, expected)) {
      throw AssertionError({
        actual: actual,
        expected: expected,
        message: message,
        operator: 'notDeepStrictEqual',
        stackStartFn: notDeepEqual,
      });
    }
  }

  // From primordials, not `Object.prototype.*` read at module-eval: assert is LAZY, so that
  // read happens after user code could have replaced `Object` or the methods (#426).
  var P = require('internal/primordials');
  var hasOwn = P.ObjectPrototypeHasOwnProperty;
  var isEnum = P.ObjectPrototypePropertyIsEnumerable;

  // Own enumerable keys, strings then enumerable symbols (matching strict deep equality).
  function ownEnumKeys(obj) {
    var keys = Object.keys(obj);
    var syms = Object.getOwnPropertySymbols(obj);
    for (var i = 0; i < syms.length; i++) {
      if (isEnum(obj, syms[i])) keys.push(syms[i]);
    }
    return keys;
  }

  function isArrayIndex(key) {
    return typeof key === 'string' && /^(?:0|[1-9]\d*)$/.test(key) && key <= '4294967294';
  }

  // Byte-exact comparison of two ArrayBuffer regions.
  function sameBytes(bufA, offA, lenA, bufB, offB, lenB) {
    if (lenA !== lenB) return false;
    var va = new Uint8Array(bufA, offA, lenA);
    var vb = new Uint8Array(bufB, offB, lenB);
    for (var i = 0; i < lenA; i++) if (va[i] !== vb[i]) return false;
    return true;
  }

  // Match each expected item to a DISTINCT actual item via `pred` (bipartite, backtracking).
  function bipartiteMatch(actualList, expectedList, pred) {
    var used = [];
    var from = function (ei) {
      if (ei >= expectedList.length) return true;
      for (var ai = 0; ai < actualList.length; ai++) {
        if (!used[ai] && pred(actualList[ai], expectedList[ei])) {
          used[ai] = true;
          if (from(ei + 1)) return true;
          used[ai] = false;
        }
      }
      return false;
    };
    return from(0);
  }

  function collect(iterable) {
    var out = [];
    iterable.forEach(function () {
      out.push(arguments.length > 1 ? [arguments[1], arguments[0]] : arguments[0]);
    });
    return out;
  }

  // Partial deep-equality: every part of `expected` must appear in `actual`, recursively.
  // Primitives compare with Object.is (so -0 ≠ 0, NaN = NaN); a plain object's own enumerable
  // keys (strings + symbols) must each be present-and-enumerable on actual and partially match;
  // an array/typed-array expected must be an ordered subsequence of actual (typed-array
  // elements compared with Object.is, i.e. by value bits); a Set's elements / a Map's entries
  // must each match a distinct actual one (keys partially, order-independent); ArrayBuffers and
  // DataViews compare byte-exact; Errors compare name+message (plus enumerable props);
  // Dates/RegExps compare wholly. `actual` may carry extra properties/elements.
  function partialMatch(actual, expected, seen) {
    if (Object.is(actual, expected)) return true;
    if (typeof expected !== 'object' || expected === null) return Object.is(actual, expected);
    if (typeof actual !== 'object' || actual === null) return false;

    if (Object.prototype.toString.call(actual) !== Object.prototype.toString.call(expected)) {
      return false;
    }
    if (expected instanceof Date) return Object.is(actual.getTime(), expected.getTime());
    if (expected instanceof RegExp) {
      return (
        actual.source === expected.source &&
        actual.flags === expected.flags &&
        actual.lastIndex === expected.lastIndex
      );
    }

    seen = seen || [];
    for (var s = 0; s < seen.length; s++) {
      if (seen[s][0] === actual && seen[s][1] === expected) return true;
    }
    seen = seen.concat([[actual, expected]]);

    if (expected instanceof ArrayBuffer) {
      return sameBytes(actual, 0, actual.byteLength, expected, 0, expected.byteLength);
    }
    if (typeof DataView !== 'undefined' && expected instanceof DataView) {
      return sameBytes(
        actual.buffer,
        actual.byteOffset,
        actual.byteLength,
        expected.buffer,
        expected.byteOffset,
        expected.byteLength,
      );
    }
    // TypedArray: ordered subsequence; Object.is compares element bits (so ±0 differ).
    if (ArrayBuffer.isView(expected)) {
      var ti = 0;
      for (var te = 0; te < expected.length; te++) {
        while (ti < actual.length && !Object.is(actual[ti], expected[te])) ti++;
        if (ti >= actual.length) return false;
        ti++;
      }
      return true;
    }

    if (expected instanceof Map) {
      return bipartiteMatch(collect(actual), collect(expected), function (ae, ee) {
        return partialMatch(ae[0], ee[0], seen) && partialMatch(ae[1], ee[1], seen);
      });
    }
    if (expected instanceof Set) {
      return bipartiteMatch(collect(actual), collect(expected), function (av, ev) {
        return partialMatch(av, ev, seen);
      });
    }

    if (Array.isArray(expected)) {
      if (!Array.isArray(actual)) return false;
      var ai2 = 0;
      for (var ei2 = 0; ei2 < expected.length; ei2++) {
        if (!(ei2 in expected)) continue; // sparse holes are ignored
        while (ai2 < actual.length && !partialMatch(actual[ai2], expected[ei2], seen)) ai2++;
        if (ai2 >= actual.length) return false;
        ai2++;
      }
      // fall through to also require expected's own non-index enumerable properties
    } else if (expected instanceof Error) {
      if (actual.name !== expected.name || actual.message !== expected.message) return false;
      // fall through to compare enumerable own props (e.g. cause, custom fields)
    }

    var keysE = ownEnumKeys(expected);
    for (var i = 0; i < keysE.length; i++) {
      var key = keysE[i];
      if (Array.isArray(expected) && isArrayIndex(key)) continue; // matched as a subsequence
      if (!hasOwn(actual, key) || !isEnum(actual, key)) return false;
      if (!partialMatch(actual[key], expected[key], seen)) return false;
    }
    return true;
  }

  function partialDeepStrictEqual(actual, expected, message) {
    if (!partialMatch(actual, expected)) {
      throw AssertionError({
        actual: actual,
        expected: expected,
        message: message,
        operator: 'partialDeepStrictEqual',
        stackStartFn: partialDeepStrictEqual,
      });
    }
  }

  function match(value, regexp, message) {
    if (!(regexp instanceof RegExp)) {
      throw new TypeError('The "regexp" argument must be an instance of RegExp');
    }
    if (!regexp.test(value)) {
      throw AssertionError({
        actual: value,
        expected: regexp,
        message: message,
        operator: 'match',
        stackStartFn: match,
      });
    }
  }

  function doesNotMatch(value, regexp, message) {
    if (!(regexp instanceof RegExp)) {
      throw new TypeError('The "regexp" argument must be an instance of RegExp');
    }
    if (regexp.test(value)) {
      throw AssertionError({
        actual: value,
        expected: regexp,
        message: message,
        operator: 'doesNotMatch',
        stackStartFn: doesNotMatch,
      });
    }
  }

  // classExtendsError reports whether `fn` is an Error constructor (Error itself
  // or a subclass), so `throws(fn, TypeError)` does an instanceof check.
  function classExtendsError(fn) {
    if (typeof fn !== 'function') return false;
    if (fn === Error) return true;
    return fn.prototype != null && fn.prototype instanceof Error;
  }

  // expectedMatches checks a thrown/rejected value against the Node matcher
  // forms: RegExp (vs the message), an Error constructor (instanceof), a
  // validation function (truthy return), or a plain object (each property must
  // deep-equal, with RegExp values tested against the stringified property).
  function expectedMatches(actual, expected) {
    if (expected instanceof RegExp) {
      return expected.test(
        String(actual && actual.message !== undefined ? actual.message : actual),
      );
    }
    if (classExtendsError(expected)) {
      return actual instanceof expected;
    }
    if (typeof expected === 'function') {
      return !!expected(actual);
    }
    if (expected && typeof expected === 'object') {
      var keys = Object.keys(expected);
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        var exp = expected[key];
        var act = actual == null ? undefined : actual[key];
        if (exp instanceof RegExp) {
          if (!exp.test(String(act))) return false;
        } else if (!isDeepStrictEqual(act, exp)) {
          return false;
        }
      }
      return true;
    }
    return true; // no/unknown expectation: only "did it throw" matters
  }

  function throws(fn, expected, message) {
    if (typeof expected === 'string') {
      message = expected;
      expected = undefined;
    }
    var threw = false;
    var actual;
    try {
      fn();
    } catch (e) {
      threw = true;
      actual = e;
    }
    if (!threw) {
      throw AssertionError({
        message: message || 'Missing expected exception.',
        operator: 'throws',
        stackStartFn: throws,
      });
    }
    if (expected !== undefined && expected !== null && !expectedMatches(actual, expected)) {
      throw actual;
    }
  }

  function doesNotThrow(fn, message) {
    try {
      fn();
    } catch {
      throw AssertionError({
        message: (message ? message + ': ' : '') + 'Got unwanted exception.',
        operator: 'doesNotThrow',
        stackStartFn: doesNotThrow,
      });
    }
  }

  function settle(promiseOrFn) {
    if (typeof promiseOrFn === 'function') return Promise.resolve().then(promiseOrFn);
    return Promise.resolve(promiseOrFn);
  }

  function rejects(promiseOrFn, expected, message) {
    if (typeof expected === 'string') {
      message = expected;
      expected = undefined;
    }
    return settle(promiseOrFn).then(
      function () {
        throw AssertionError({
          message: message || 'Missing expected rejection.',
          operator: 'rejects',
          stackStartFn: rejects,
        });
      },
      function (actual) {
        if (expected !== undefined && expected !== null && !expectedMatches(actual, expected)) {
          throw actual;
        }
      },
    );
  }

  function doesNotReject(promiseOrFn, expected, message) {
    if (typeof expected === 'string') {
      message = expected;
      expected = undefined;
    }
    return settle(promiseOrFn).then(undefined, function (actual) {
      throw AssertionError({
        message: (message ? message + ': ' : '') + 'Got unwanted rejection.\n' + inspect(actual),
        operator: 'doesNotReject',
        stackStartFn: doesNotReject,
      });
    });
  }

  function ifError(value) {
    if (value !== null && value !== undefined) {
      throw AssertionError({
        actual: value,
        expected: null,
        message: 'ifError got unwanted exception: ' + inspect(value),
        operator: 'ifError',
        stackStartFn: ifError,
      });
    }
  }

  assert.ok = ok;
  assert.fail = fail;
  assert.AssertionError = AssertionError;
  assert.equal = equal;
  assert.strictEqual = equal;
  assert.notEqual = notEqual;
  assert.notStrictEqual = notEqual;
  assert.deepEqual = deepEqual;
  assert.deepStrictEqual = deepEqual;
  assert.notDeepEqual = notDeepEqual;
  assert.notDeepStrictEqual = notDeepEqual;
  assert.partialDeepStrictEqual = partialDeepStrictEqual;
  assert.match = match;
  assert.doesNotMatch = doesNotMatch;
  assert.throws = throws;
  assert.doesNotThrow = doesNotThrow;
  assert.rejects = rejects;
  assert.doesNotReject = doesNotReject;
  assert.ifError = ifError;
  assert.strict = assert;

  module.exports = assert;
});
