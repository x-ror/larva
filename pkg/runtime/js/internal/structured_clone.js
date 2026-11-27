// structuredClone (HTML structured clone algorithm), installed as a global.
// JavaScriptCore's classic C API does not expose a native structuredClone, so this is
// an original JS implementation covering the serializable types: primitives, Date,
// RegExp, ArrayBuffer + views, DataView, Map, Set, Array, Error, boxed primitives
// (BigInt included), DOMException, Blob and File, and plain/own-enumerable objects.
// Cyclic and shared references are preserved via a memory map. A non-serializable
// input (a function, a symbol, Promise/WeakMap/WeakSet/WeakRef, a detached buffer)
// throws a DataCloneError DOMException with V8's description of the value, as Chrome
// does; the `transfer` option moves ArrayBuffers (see structuredClone).
//
// Deviates: a Proxy is cloned through its traps where Chrome refuses it ("#<Object>
// could not be cloned."): JS cannot tell a Proxy from its target, and no native
// answers it yet.
(function (require, module, _exports) {
  'use strict';

  var toString = Object.prototype.toString;

  var P = require('internal/primordials');
  var DOMException = require('internal/domexception').DOMException;
  var webErrors = require('internal/web_errors');
  var context = webErrors.context;
  var typeError = webErrors.typeError;
  var argumentsRequired = webErrors.argumentsRequired;
  var pageError = webErrors.pageError;
  // Blob and File are serializable interfaces whose clone steps live with their private
  // fields (internal/blob, internal/file).
  var cloneBlobOrFile = require('internal/file').cloneBlobOrFile;
  var ReflectApply = P.ReflectApply;
  var ArrayPrototypePush1 = P.ArrayPrototypePush1;
  var ArrayPrototypeIndexOf = P.ArrayPrototypeIndexOf;
  var ArrayBufferPrototypeSlice = P.ArrayBufferPrototypeSlice;
  var ArrayBufferPrototypeGetByteLength = P.ArrayBufferPrototypeGetByteLength;
  var StringG = P.String;
  var ObjectP = P.Object;
  var SymbolIterator = P.Symbol.iterator;
  // Captured at this eager eval: native_shape has already masked toString, so a
  // function's description is the V8-style text Chrome prints (`function max() {
  // [native code] }`), and BigInt's valueOf for unboxing.
  var FunctionPrototypeToString = Function.prototype.toString;
  var BigIntPrototypeValueOf = BigInt.prototype.valueOf;
  var ArrayBufferPrototypeTransfer = ArrayBuffer.prototype.transfer;
  var ArrayBufferPrototypeGetDetached = Object.getOwnPropertyDescriptor(
    ArrayBuffer.prototype,
    'detached',
  ).get;

  // DataCloneError (DOMException code 25), its message carrying Blink's context prefix.
  function dataCloneError(detail) {
    return pageError(
      new DOMException(context('Window', 'structuredClone') + detail, 'DataCloneError'),
    );
  }

  // A TypeError from the argument conversions, in Blink's text.
  function conversionError(detail) {
    return typeError('Window', 'structuredClone', detail);
  }

  function isDetached(buffer) {
    return ReflectApply(ArrayBufferPrototypeGetDetached, buffer, []);
  }

  // An ArrayBuffer by its slot: the byteLength getter throws for anything else.
  function isArrayBuffer(value) {
    if (value === null || typeof value !== 'object') return false;
    try {
      ArrayBufferPrototypeGetByteLength(value);
      return true;
    } catch {
      return false;
    }
  }
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
    // V8 describes the value it refuses: a symbol as String(symbol), a function as
    // its source text (Chrome 158, tests/web/cases/clone-transfer).
    if (t === 'symbol') throw dataCloneError(StringG(value) + ' could not be cloned.');
    if (t === 'function') {
      throw dataCloneError(
        ReflectApply(FunctionPrototypeToString, value, []) + ' could not be cloned.',
      );
    }

    if (seen.has(value)) return seen.get(value);

    var domException = cloneDOMException(value);
    if (domException !== undefined) {
      seen.set(value, domException);
      return domException;
    }

    var blobClone = cloneBlobOrFile(value);
    if (blobClone !== undefined) {
      seen.set(value, blobClone);
      return blobClone;
    }

    var tag = toString.call(value);

    if (
      tag === '[object Promise]' ||
      tag === '[object WeakMap]' ||
      tag === '[object WeakSet]' ||
      tag === '[object WeakRef]' ||
      tag === '[object FinalizationRegistry]'
    ) {
      // V8's `#<Ctor>` description of an object.
      throw dataCloneError('#<' + StringPrototypeSlice(tag, 8, -1) + '> could not be cloned.');
    }

    if (tag === '[object Symbol]') throw dataCloneError(tag + ' could not be cloned.');

    if (tag === '[object BigInt]') {
      var bigBoxed = ObjectP(ReflectApply(BigIntPrototypeValueOf, value, []));
      seen.set(value, bigBoxed);
      return bigBoxed;
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
      if (isDetached(value)) {
        throw dataCloneError('An ArrayBuffer is detached and could not be cloned.');
      }

      var bufCopy = ArrayBufferPrototypeSlice(value, 0);
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

  /**
   * structuredClone(value, options): a deep copy of `value`, moving the ArrayBuffers
   * `options.transfer` lists.
   * @param {*} value
   * @param {{transfer?: Iterable<object>}} [options]
   * @returns {*}
   * @throws {TypeError} no argument, a non-object `options`, or a `transfer` that is not
   *   a sequence.
   * @throws {DOMException} DataCloneError: a non-ArrayBuffer, duplicate or detached
   *   buffer in `transfer` (named by its index), or anything not serializable.
   * @node Chrome 158 (tests/web/cases/clone-transfer, clone-structured): `transfer` is
   *       read and checked before `value` is walked; a transferred buffer is detached
   *       only once the whole clone succeeded, so a failed clone leaves it intact; one
   *       that is not inside `value` is detached all the same.
   * @deviates A transferred buffer's bytes are copied into the clone and the source
   *   then detached, where Chrome moves the backing store: the same observable result,
   *   at the cost of one copy. Moving first would leave the source detached on a clone
   *   that then fails, and moving last would need every view over it rebuilt.
   */
  function structuredClone(value, options) {
    if (arguments.length === 0) {
      throw typeError('Window', 'structuredClone', argumentsRequired(1, 0));
    }

    var transfer = convertTransfer(options);
    var seen = new Map();
    for (var i = 0; i < transfer.length; i++) {
      var buffer = transfer[i];
      if (!isArrayBuffer(buffer)) {
        throw dataCloneError('Value at index ' + i + ' does not have a transferable type.');
      }

      if (ArrayPrototypeIndexOf(transfer, buffer) !== i) {
        throw dataCloneError(
          'ArrayBuffer at index ' + i + ' is a duplicate of an earlier ArrayBuffer.',
        );
      }

      if (isDetached(buffer)) {
        throw dataCloneError('ArrayBuffer at index ' + i + ' is already detached.');
      }

      seen.set(buffer, ArrayBufferPrototypeSlice(buffer, 0));
    }

    var result = clone(value, seen);
    for (var j = 0; j < transfer.length; j++)
      ReflectApply(ArrayBufferPrototypeTransfer, transfer[j], []);
    return result;
  }

  // StructuredSerializeOptions: a dictionary whose one member, `transfer`, is a
  // `sequence<object>` (default empty).
  function convertTransfer(options) {
    var out = [];
    if (options === undefined || options === null) return out;
    if (typeof options !== 'object' && typeof options !== 'function') {
      throw conversionError("The provided value is not of type 'StructuredSerializeOptions'.");
    }

    var list = options.transfer;
    if (list === undefined) return out;
    var member = "Failed to read the 'transfer' property from 'StructuredSerializeOptions': ";
    if (list === null || (typeof list !== 'object' && typeof list !== 'function')) {
      throw conversionError(member + 'The provided value cannot be converted to a sequence.');
    }

    var method = list[SymbolIterator];
    if (typeof method !== 'function') {
      throw conversionError(member + 'The object must have a callable @@iterator property.');
    }

    var iterator = ReflectApply(method, list, []);
    var next = iterator.next;
    for (;;) {
      var step = ReflectApply(next, iterator, []);
      if (step === null || (typeof step !== 'object' && typeof step !== 'function')) {
        throw conversionError(member + 'Expected iterator.next() to return an Object.');
      }

      if (step.done) return out;
      var item = step.value;
      if (item === null || (typeof item !== 'object' && typeof item !== 'function')) {
        throw conversionError(member + "The provided value is not of type 'object'.");
      }

      ArrayPrototypePush1(out, item);
    }
  }

  // The global a page sees: internal/native_shape's operation around this one (native
  // toString, no `prototype`, Chrome's length 1; tests/web/cases/shape-operations).
  module.exports = {
    structuredClone: require('internal/native_shape').defineOperation(
      'structuredClone',
      structuredClone,
      1,
    ),
  };
});
