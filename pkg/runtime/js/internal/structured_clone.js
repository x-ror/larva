// structuredClone (HTML structured clone algorithm), installed as a global like
// Buffer. JavaScriptCore's classic C API does not expose a native structuredClone,
// so this is an original JS implementation covering the cloneable types Node
// supports: primitives, Date, RegExp, ArrayBuffer + views, DataView, Map, Set,
// Array, Error, boxed primitives, and plain/own-enumerable objects. Cyclic and
// shared references are preserved via a memory map. Non-cloneable inputs
// (functions, symbols, Promise/WeakMap/WeakSet, and the `transfer` option) throw
// a DataCloneError rather than being silently mishandled.
(function (require, module, _exports) {
  'use strict';

  function dataCloneError(message) {
    // Node throws a DOMException named "DataCloneError"; Lava has no
    // DOMException, so we surface an Error carrying the same `.name`.
    var err = new Error(message);
    err.name = 'DataCloneError';
    return err;
  }

  var toString = Object.prototype.toString;

  var P = require('internal/primordials');
  // DOMException is a serializable interface: its clone steps live with its private
  // slots (internal/domexception), which nothing here can read.
  var cloneDOMException = require('internal/domexception').cloneDOMException;
  // Rebuilding a view through `value.constructor` is a configurable
  // prototype-chain read: poisoning `Uint8Array.prototype.constructor` made
  // structuredClone invoke attacker code with the internals' freshly cloned
  // ArrayBuffer and hand back an arbitrary object as the clone.
  //
  // The replacement is PROTOTYPE IDENTITY, not the brand tag. Keying off
  // `Object.prototype.toString` looked equivalent and was not:
  // `Object.prototype.toString` consults `Symbol.toStringTag`, a configurable
  // accessor, so `Object.defineProperty(v, Symbol.toStringTag, …)` or a subclass
  // getter forged the brand — which made a legitimate clone THROW and could
  // select the wrong constructor. A prototype cannot be forged by assignment.
  //
  // The chain is walked, not matched once, because Node clones a SUBCLASS to its
  // nearest built-in (`class My extends Uint8Array {}` clones to a plain
  // Uint8Array), and Buffer is a Uint8Array subclass — so the first match going
  // up is exactly Node's answer.
  var VIEW_PROTOS = P.TypedArrayPrototypes;
  var ReflectGetPrototypeOf = P.ReflectGetPrototypeOf;
  var TypedArrayPrototypeGetBuffer = P.TypedArrayPrototypeGetBuffer;
  var TypedArrayPrototypeGetByteOffset = P.TypedArrayPrototypeGetByteOffset;
  var TypedArrayPrototypeGetByteLength = P.TypedArrayPrototypeGetByteLength;
  // DataView's three accessors are SEPARATE properties from %TypedArray%'s — they
  // live on DataView.prototype, not on the shared %TypedArray% prototype — so
  // capturing the typed-array trio above leaves the DataView arm unprotected.
  // That is exactly how this module shipped: the typed-array half read through
  // captured getters while the DataView half still read `value.byteOffset` live.
  var DataViewPrototypeGetBuffer = P.DataViewPrototypeGetBuffer;
  var DataViewPrototypeGetByteOffset = P.DataViewPrototypeGetByteOffset;
  var DataViewPrototypeGetByteLength = P.DataViewPrototypeGetByteLength;
  var StringPrototypeSlice = P.StringPrototypeSlice;
  var DataViewG = DataView;
  var DataViewPrototype = DataView.prototype;

  function viewConstructorOf(value) {
    var proto = ReflectGetPrototypeOf(value);
    while (proto !== null) {
      for (var i = 0; i < VIEW_PROTOS.length; i++) {
        if (VIEW_PROTOS[i][0] === proto) return VIEW_PROTOS[i][1];
      }
      proto = ReflectGetPrototypeOf(proto);
    }
    return undefined;
  }

  // Is `target` anywhere on `value`'s prototype chain? The subclass-tolerant brand
  // test, and the reason it is a chain walk rather than one comparison: a
  // `class MyView extends DataView` instance must still take the DataView arm.
  // Uses the captured ReflectGetPrototypeOf, so a poisoned `__proto__` accessor
  // cannot redirect the walk.
  function hasPrototypeInChain(value, target) {
    var proto = ReflectGetPrototypeOf(value);
    while (proto !== null) {
      if (proto === target) return true;
      proto = ReflectGetPrototypeOf(proto);
    }
    return false;
  }

  // `__proto__: null` because the key is `value.name`, straight off the object
  // under clone: without it, `err.name = 'toString'` reached
  // Object.prototype.toString and `new` on it threw, and a poisoned
  // `Object.prototype.<anything>` supplied an arbitrary constructor. Node
  // normalizes an unrecognized name to Error, which the `|| Error` fallback now
  // actually reaches for every name.
  var ERROR_CTORS = {
    __proto__: null,
    Error: Error,
    EvalError: EvalError,
    RangeError: RangeError,
    ReferenceError: ReferenceError,
    SyntaxError: SyntaxError,
    TypeError: TypeError,
    URIError: URIError,
  };

  // Copy `src`'s own enumerable string-keyed properties onto `dst`, deep-cloning
  // each value. Symbol keys and non-enumerable / inherited properties are dropped,
  // and getters are read to a plain data value — matching structuredClone.
  function copyOwnEnumerable(src, dst, seen) {
    var keys = Object.keys(src);
    for (var i = 0; i < keys.length; i++) {
      dst[keys[i]] = clone(src[keys[i]], seen);
    }
  }

  function clone(value, seen) {
    if (value === null) return null;
    var t = typeof value;
    if (
      t === 'string' ||
      t === 'number' ||
      t === 'boolean' ||
      t === 'undefined' ||
      t === 'bigint'
    ) {
      return value;
    }
    if (t === 'symbol') throw dataCloneError('Symbol could not be cloned.');
    if (t === 'function') throw dataCloneError('Function could not be cloned.');

    if (seen.has(value)) return seen.get(value);

    var domException = cloneDOMException(value);
    if (domException !== undefined) {
      seen.set(value, domException);
      return domException;
    }

    var tag = toString.call(value);

    if (tag === '[object Promise]' || tag === '[object WeakMap]' || tag === '[object WeakSet]') {
      throw dataCloneError(StringPrototypeSlice(tag, 8, -1) + ' could not be cloned.');
    }

    if (tag === '[object Date]') {
      var date = new Date(value.getTime());
      seen.set(value, date);
      return date;
    }
    // lastIndex is intentionally not carried (Node resets it to 0).
    if (tag === '[object RegExp]') {
      var re = new RegExp(value);
      seen.set(value, re);
      return re;
    }

    if (tag === '[object ArrayBuffer]') {
      var bufCopy = value.slice(0);
      seen.set(value, bufCopy);
      return bufCopy;
    }

    // Typed arrays and DataView: clone the backing buffer through `seen` so
    // multiple views over one buffer keep sharing a single cloned buffer.
    if (ArrayBuffer.isView(value)) {
      // Every read of the window goes through a captured getter, on BOTH arms:
      // `clone()` copies the WHOLE backing ArrayBuffer and then re-slices the copy,
      // so the offset/length read here decide what the clone exposes. A poisoned
      // pair selects across the shared allocUnsafe pool — reproduced on the
      // DataView arm returning a neighbouring Buffer's `SECRET-TOKEN…` where node
      // clones 2 bytes. Pinned by both window vectors in 13-structured-clone.js.
      // NOT `value instanceof DataViewG`: `instanceof` dispatches through
      // `DataView[Symbol.hasInstance]`, a configurable own property of the
      // constructor, so the brand is forgeable in both directions. Forged to false
      // it misrouted a genuine DataView into the typed-array arm, where the
      // captured %TypedArray% getter rejected the receiver and threw
      // `TypeError: Receiver should be a typed array view` on a value node clones
      // fine. The prototype chain cannot be re-pointed on an already-constructed
      // object, which is why `viewConstructorOf` above uses it too — same fix, and
      // the same one the `Symbol.toStringTag` forgery already forced here.
      var isDataView = hasPrototypeInChain(value, DataViewPrototype);
      var srcBuffer = isDataView
        ? DataViewPrototypeGetBuffer(value)
        : TypedArrayPrototypeGetBuffer(value);
      var srcOffset = isDataView
        ? DataViewPrototypeGetByteOffset(value)
        : TypedArrayPrototypeGetByteOffset(value);
      var srcByteLength = isDataView
        ? DataViewPrototypeGetByteLength(value)
        : TypedArrayPrototypeGetByteLength(value);
      var clonedBuffer = clone(srcBuffer, seen);
      var view;
      if (isDataView) {
        view = new DataViewG(clonedBuffer, srcOffset, srcByteLength);
      } else {
        var Ctor = viewConstructorOf(value);
        if (Ctor === undefined) {
          throw dataCloneError(StringPrototypeSlice(tag, 8, -1) + ' could not be cloned.');
        }
        view = new Ctor(clonedBuffer, srcOffset, srcByteLength / Ctor.BYTES_PER_ELEMENT);
      }
      seen.set(value, view);
      return view;
    }

    if (tag === '[object Map]') {
      var map = new Map();
      seen.set(value, map);
      value.forEach(function (v, k) {
        map.set(clone(k, seen), clone(v, seen));
      });
      return map;
    }

    if (tag === '[object Set]') {
      var set = new Set();
      seen.set(value, set);
      value.forEach(function (v) {
        set.add(clone(v, seen));
      });
      return set;
    }

    if (value instanceof Error) {
      // Node NORMALIZES an unrecognized name to Error rather than carrying it
      // over: `e.name = 'NotAnError'` clones to `name === 'Error'` (verified
      // against node 26.13.0). Preserving it was a quiet divergence, and reapplying
      // it unconditionally is also what made `e.name = 'toString'` interesting —
      // the un-nulled table reached Object.prototype and `new` on the result
      // threw.
      var recognized = ERROR_CTORS[value.name];
      var Ctor = recognized || Error;
      var errClone = new Ctor(value.message);
      seen.set(value, errClone);
      if (recognized !== undefined && value.name !== errClone.name) errClone.name = value.name;
      errClone.stack = value.stack;
      if ('cause' in value) errClone.cause = clone(value.cause, seen);
      return errClone;
    }

    if (tag === '[object Boolean]' || tag === '[object Number]' || tag === '[object String]') {
      var boxed = Object(value.valueOf());
      seen.set(value, boxed);
      return boxed;
    }

    if (Array.isArray(value)) {
      // Must be a SPARSE array (real holes), not Array.from({length}) which fills
      // dense undefined: structuredClone preserves holes, and copyOwnEnumerable
      // below only copies indices actually present in the source. A dense array
      // here would turn every hole into an own `undefined` (breaking `i in clone`).
      var arr = new Array(value.length);
      seen.set(value, arr);
      copyOwnEnumerable(value, arr, seen);
      return arr;
    }

    // Plain objects and ordinary class instances clone to a fresh object with
    // %Object.prototype% (the original prototype is not preserved).
    var obj = {};
    seen.set(value, obj);
    copyOwnEnumerable(value, obj, seen);
    return obj;
  }

  function structuredClone(value, options) {
    if (arguments.length === 0) {
      throw new TypeError('structuredClone requires at least 1 argument');
    }
    if (options != null && options.transfer != null) {
      var transfer = options.transfer;
      var hasItems = typeof transfer.length === 'number' ? transfer.length > 0 : false;
      if (hasItems) {
        throw dataCloneError('structuredClone transfer is not supported.');
      }
    }
    return clone(value, new Map());
  }

  if (globalThis.structuredClone === undefined) {
    globalThis.structuredClone = structuredClone;
  }

  module.exports = { structuredClone: structuredClone };
});
