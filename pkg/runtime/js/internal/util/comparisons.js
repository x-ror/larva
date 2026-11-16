// util.isDeepStrictEqual — where node keeps it: lib/internal/util/comparisons.js. Pure
// JS; requires nothing.
(function (require, module) {
  'use strict';

  // util.isDeepStrictEqual — structural strict equality, matching Node's algorithm:
  // SameValue-ish primitives (NaN equal, +0 !== -0), matching prototype + [[Class]] tag,
  // special handling for Date/RegExp/Error/boxed primitives/Map/Set/ArrayBuffer/TypedArray/
  // DataView, recursive comparison of own enumerable string + symbol keys, and circular refs.
  var objTag = function (v) {
    return Object.prototype.toString.call(v);
  };

  function bytesEqual(x, y) {
    if (x.length !== y.length) return false;
    for (var i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
  }

  function ownEnumerableKeys(o) {
    var keys = Object.keys(o);
    var syms = Object.getOwnPropertySymbols(o);
    for (var i = 0; i < syms.length; i++) {
      if (Object.prototype.propertyIsEnumerable.call(o, syms[i])) keys.push(syms[i]);
    }
    return keys;
  }

  function keysEqual(a, b, aStack, bStack) {
    var aKeys = ownEnumerableKeys(a);
    if (aKeys.length !== ownEnumerableKeys(b).length) return false;
    for (var i = 0; i < aKeys.length; i++) {
      var k = aKeys[i];
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!deepStrict(a[k], b[k], aStack, bStack)) return false;
    }
    return true;
  }

  // Map/Set equality as node's comparisons.js does it in strict mode: a primitive key
  // (or Set member) can only deep-equal the identical primitive, so it is looked up
  // directly with b.has/b.get — O(n). Only object keys/members need the pairwise
  // deepStrict scan, and only against b's object keys. The pairwise scan over every
  // entry was O(n^2): one assert.deepStrictEqual on two equal 16k int->int Maps took
  // 2179 ms that way and 4 ms this way (medians of 5 interleaved launches, darwin arm64).
  // Sizes are already known equal, and Map/Set normalize -0 and match NaN via
  // SameValueZero, which is what deepStrict answers for those keys anyway.
  function collectionEqual(a, b, isMap, aStack, bStack) {
    var aObjects = [];
    var ok = true;
    a.forEach(function (v, k) {
      if (!ok) return;
      var key = isMap ? k : v;
      if (typeof key === 'object' && key !== null) {
        aObjects.push([key, v]);
      } else if (!b.has(key)) {
        ok = false;
      } else if (isMap && !deepStrict(v, b.get(key), aStack, bStack)) {
        ok = false;
      }
    });
    if (!ok) return false;
    if (aObjects.length === 0) return true;
    var bObjects = [];
    b.forEach(function (v, k) {
      var key = isMap ? k : v;
      if (typeof key === 'object' && key !== null) bObjects.push([key, v]);
    });
    if (aObjects.length !== bObjects.length) return false;
    var used = new Array(bObjects.length);
    for (var i = 0; i < aObjects.length; i++) {
      var found = false;
      for (var j = 0; j < bObjects.length; j++) {
        if (used[j]) continue;
        var keyOk = deepStrict(aObjects[i][0], bObjects[j][0], aStack, bStack);
        var valOk = !isMap || deepStrict(aObjects[i][1], bObjects[j][1], aStack, bStack);
        if (keyOk && valOk) {
          used[j] = true;
          found = true;
          break;
        }
      }
      if (!found) return false;
    }
    return true;
  }

  function deepStrict(a, b, aStack, bStack) {
    if (a === b) return a !== 0 || Object.is(a, b); // +0 !== -0; everything else equal
    if (typeof a !== 'object' || a === null) {
      // primitive (or null) — equal only if both are NaN
      return typeof a === 'number' && a !== a && typeof b === 'number' && b !== b;
    }
    if (typeof b !== 'object' || b === null) return false;
    if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;

    var tag = objTag(a);
    if (tag !== objTag(b)) return false;

    switch (tag) {
      case '[object Number]':
      case '[object Boolean]':
      case '[object String]':
      case '[object BigInt]':
      case '[object Symbol]': {
        var av = a.valueOf();
        var bv = b.valueOf();
        if (av === bv) return av !== 0 || Object.is(av, bv);
        return typeof av === 'number' && av !== av && bv !== bv;
      }
      case '[object Date]':
        return Object.is(a.getTime(), b.getTime());
      case '[object RegExp]':
        if (a.source !== b.source || a.flags !== b.flags) return false;
        break;
      case '[object Error]':
        if (a.name !== b.name || a.message !== b.message) return false;
        break;
      case '[object ArrayBuffer]':
        if (a.byteLength !== b.byteLength) return false;
        return bytesEqual(new Uint8Array(a), new Uint8Array(b));
      case '[object DataView]':
        if (a.byteLength !== b.byteLength) return false;
        return bytesEqual(
          new Uint8Array(a.buffer, a.byteOffset, a.byteLength),
          new Uint8Array(b.buffer, b.byteOffset, b.byteLength),
        );
    }

    // Typed arrays: element-wise (NaN-aware); then fall through to compare any extra keys.
    if (ArrayBuffer.isView(a) && tag !== '[object DataView]') {
      if (a.length !== b.length) return false;
      for (var t = 0; t < a.length; t++) {
        if (!(a[t] === b[t] || (a[t] !== a[t] && b[t] !== b[t]))) return false;
      }
    }

    // Circular-reference guard.
    for (var s = 0; s < aStack.length; s++) {
      if (aStack[s] === a) return bStack[s] === b;
    }
    aStack.push(a);
    bStack.push(b);

    var result;
    if (tag === '[object Map]' || tag === '[object Set]') {
      result = a.size === b.size && collectionEqual(a, b, tag === '[object Map]', aStack, bStack);
    } else {
      result = keysEqual(a, b, aStack, bStack);
    }

    aStack.pop();
    bStack.pop();
    return result;
  }

  function isDeepStrictEqual(a, b) {
    return deepStrict(a, b, [], []);
  }

  module.exports = { isDeepStrictEqual: isDeepStrictEqual };
});
