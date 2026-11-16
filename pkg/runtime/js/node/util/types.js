// node:util/types — runtime type predicates. Most are derived from the object's
// internal [[Class]] tag (Object.prototype.toString) plus instanceof / ArrayBuffer.isView,
// which matches Node for ordinary values. A few predicates rely on V8-internal hooks in
// Node and cannot be detected from pure JS (isProxy, isExternal, isModuleNamespaceObject);
// those are best-effort and documented inline.
(function (require, module, exports) {
  'use strict';

  var toString = Object.prototype.toString;
  function tag(v) {
    return toString.call(v); // e.g. "[object Date]"
  }
  function tagged(v, name) {
    return tag(v) === '[object ' + name + ']';
  }

  var TYPED_ARRAY_TAGS = {
    '[object Int8Array]': true,
    '[object Uint8Array]': true,
    '[object Uint8ClampedArray]': true,
    '[object Int16Array]': true,
    '[object Uint16Array]': true,
    '[object Int32Array]': true,
    '[object Uint32Array]': true,
    '[object Float32Array]': true,
    '[object Float64Array]': true,
    '[object BigInt64Array]': true,
    '[object BigUint64Array]': true,
  };

  function isTypedArray(v) {
    return TYPED_ARRAY_TAGS[tag(v)] === true;
  }

  // Per-kind typed array checks via the tag.
  function typedArrayOf(name) {
    return function (v) {
      return tagged(v, name);
    };
  }

  function isArrayBuffer(v) {
    return tagged(v, 'ArrayBuffer');
  }
  function isSharedArrayBuffer(v) {
    return tagged(v, 'SharedArrayBuffer');
  }

  var types = {
    isDate: function (v) {
      return tagged(v, 'Date');
    },
    isRegExp: function (v) {
      return tagged(v, 'RegExp');
    },
    isMap: function (v) {
      return tagged(v, 'Map');
    },
    isSet: function (v) {
      return tagged(v, 'Set');
    },
    isWeakMap: function (v) {
      return tagged(v, 'WeakMap');
    },
    isWeakSet: function (v) {
      return tagged(v, 'WeakSet');
    },
    isPromise: function (v) {
      return tagged(v, 'Promise');
    },
    isArrayBuffer: isArrayBuffer,
    isSharedArrayBuffer: isSharedArrayBuffer,
    isAnyArrayBuffer: function (v) {
      return isArrayBuffer(v) || isSharedArrayBuffer(v);
    },
    isDataView: function (v) {
      return tagged(v, 'DataView');
    },
    isArrayBufferView: function (v) {
      return ArrayBuffer.isView(v); // typed array or DataView — Node's exact definition
    },
    isTypedArray: isTypedArray,
    isFloat16Array: typedArrayOf('Float16Array'),
    isMapIterator: function (v) {
      return tagged(v, 'Map Iterator');
    },
    isSetIterator: function (v) {
      return tagged(v, 'Set Iterator');
    },
    isUint8Array: typedArrayOf('Uint8Array'),
    isUint8ClampedArray: typedArrayOf('Uint8ClampedArray'),
    isUint16Array: typedArrayOf('Uint16Array'),
    isUint32Array: typedArrayOf('Uint32Array'),
    isInt8Array: typedArrayOf('Int8Array'),
    isInt16Array: typedArrayOf('Int16Array'),
    isInt32Array: typedArrayOf('Int32Array'),
    isFloat32Array: typedArrayOf('Float32Array'),
    isFloat64Array: typedArrayOf('Float64Array'),
    isBigInt64Array: typedArrayOf('BigInt64Array'),
    isBigUint64Array: typedArrayOf('BigUint64Array'),
    isArgumentsObject: function (v) {
      return tagged(v, 'Arguments');
    },
    isGeneratorFunction: function (v) {
      var t = tag(v);
      // Node counts async generator functions as generator functions too.
      return t === '[object GeneratorFunction]' || t === '[object AsyncGeneratorFunction]';
    },
    isAsyncFunction: function (v) {
      var t = tag(v);
      // Node counts async generator functions as async functions too.
      return t === '[object AsyncFunction]' || t === '[object AsyncGeneratorFunction]';
    },
    isGeneratorObject: function (v) {
      return tagged(v, 'Generator');
    },
    isNativeError: function (v) {
      return v instanceof Error && tagged(v, 'Error');
    },
    isBooleanObject: function (v) {
      return tagged(v, 'Boolean') && typeof v === 'object';
    },
    isNumberObject: function (v) {
      return tagged(v, 'Number') && typeof v === 'object';
    },
    isStringObject: function (v) {
      return tagged(v, 'String') && typeof v === 'object';
    },
    isSymbolObject: function (v) {
      return tagged(v, 'Symbol') && typeof v === 'object';
    },
    isBigIntObject: function (v) {
      return tagged(v, 'BigInt') && typeof v === 'object';
    },
    isBoxedPrimitive: function (v) {
      return (
        types.isBooleanObject(v) ||
        types.isNumberObject(v) ||
        types.isStringObject(v) ||
        types.isSymbolObject(v) ||
        types.isBigIntObject(v)
      );
    },
    isCryptoKey: function (v) {
      return typeof CryptoKey !== 'undefined' && v instanceof CryptoKey;
    },
    // Not detectable from pure JS (V8-internal / native-handle in Node) — best-effort
    // false. isProxy can never be true here (a Proxy is transparent to JS); isKeyObject
    // needs node:crypto's KeyObject; isExternal wraps a C++ pointer.
    isProxy: function () {
      return false;
    },
    isExternal: function () {
      return false;
    },
    isKeyObject: function () {
      return false;
    },
    isModuleNamespaceObject: function (v) {
      return tagged(v, 'Module');
    },
  };

  module.exports = types;
});
