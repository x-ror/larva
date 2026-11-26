/**
 * @fileoverview DOMException and its QuotaExceededError subclass (WebIDL §"DOMException",
 * Chrome 158's shape), installed as globals on both surfaces at module-eval. Node has
 * both globals too, with the same shape, so this is not a Window-only addition; what
 * differs per surface is the text the THROWERS pass in (internal/web_errors).
 *
 * An instance is a real Error — created by the Error constructor with the subclass's
 * prototype, so it carries a stack and `Error.isError(e)` is true, as Chrome answers —
 * and its state lives in private fields stamped onto that object, not in properties a
 * page can see or replace. `name`, `message` and `code` are enumerable accessors on the
 * prototype that brand-check their receiver, so `DOMException.prototype.name` is
 * "Illegal invocation" as in Chrome, not "Error" inherited from Error.prototype.
 *
 * Instantiated eagerly (the loader names it, and internal/abort requires it), so every
 * capture below is pristine.
 *
 * @module lava/internal/domexception
 */

(function (require, module) {
  'use strict';

  var P = require('internal/primordials');
  var webErrors = require('internal/web_errors');
  var ErrorP = P.Error;
  var NumberP = P.Number;
  var NumberIsFinite = P.NumberIsFinite;
  var ObjectDefineProperty = P.ObjectDefineProperty;
  var ObjectDefineProperties = P.ObjectDefineProperties;
  var ObjectGetOwnPropertyDescriptors = P.ObjectGetOwnPropertyDescriptors;
  var ObjectSetPrototypeOf = P.ObjectSetPrototypeOf;
  var ReflectConstruct = P.ReflectConstruct;
  var SymbolToStringTag = P.SymbolToStringTag;
  var illegalInvocation = webErrors.illegalInvocation;
  var toDOMString = webErrors.toDOMString;
  var typeError = webErrors.typeError;

  // WebIDL's error names table: the names that carry a legacy code. A name outside it
  // (including the table's own "DOMStringSizeError"-era spellings Chrome answers 0 for,
  // and `constructor`/`__proto__`) reads code 0 — hence the null prototype.
  var CODES = {
    __proto__: null,
    IndexSizeError: 1,
    HierarchyRequestError: 3,
    WrongDocumentError: 4,
    InvalidCharacterError: 5,
    NoModificationAllowedError: 7,
    NotFoundError: 8,
    NotSupportedError: 9,
    InUseAttributeError: 10,
    InvalidStateError: 11,
    SyntaxError: 12,
    InvalidModificationError: 13,
    NamespaceError: 14,
    InvalidAccessError: 15,
    TypeMismatchError: 17,
    SecurityError: 18,
    NetworkError: 19,
    AbortError: 20,
    URLMismatchError: 21,
    QuotaExceededError: 22,
    TimeoutError: 23,
    InvalidNodeTypeError: 24,
    DataCloneError: 25,
  };

  // The legacy constants, in Chrome's order; defined on both the interface object and
  // its prototype, enumerable, neither writable nor configurable.
  var CONSTANTS = [
    'INDEX_SIZE_ERR',
    1,
    'DOMSTRING_SIZE_ERR',
    2,
    'HIERARCHY_REQUEST_ERR',
    3,
    'WRONG_DOCUMENT_ERR',
    4,
    'INVALID_CHARACTER_ERR',
    5,
    'NO_DATA_ALLOWED_ERR',
    6,
    'NO_MODIFICATION_ALLOWED_ERR',
    7,
    'NOT_FOUND_ERR',
    8,
    'NOT_SUPPORTED_ERR',
    9,
    'INUSE_ATTRIBUTE_ERR',
    10,
    'INVALID_STATE_ERR',
    11,
    'SYNTAX_ERR',
    12,
    'INVALID_MODIFICATION_ERR',
    13,
    'NAMESPACE_ERR',
    14,
    'INVALID_ACCESS_ERR',
    15,
    'VALIDATION_ERR',
    16,
    'TYPE_MISMATCH_ERR',
    17,
    'SECURITY_ERR',
    18,
    'NETWORK_ERR',
    19,
    'ABORT_ERR',
    20,
    'URL_MISMATCH_ERR',
    21,
    'QUOTA_EXCEEDED_ERR',
    22,
    'TIMEOUT_ERR',
    23,
    'INVALID_NODE_TYPE_ERR',
    24,
    'DATA_CLONE_ERR',
    25,
  ];

  // A base whose constructor returns the object it is handed. A class deriving from it
  // has its private fields installed on THAT object when it calls super(target) — the
  // standard way to give an object the engine created (an Error, here) a private,
  // unforgeable slot. `#name in o` is then a brand check no prototype edit can fake.
  class Stamp {
    constructor(target) {
      return target;
    }
  }

  // Brand readers for the two slots, assigned in the static block below — the one
  // place outside the class body that may name its private fields.
  var nameOf;
  var messageOf;
  class DOMExceptionSlots extends Stamp {
    #name;
    #message;
    constructor(target, name, message) {
      super(target);
      this.#name = name;
      this.#message = message;
    }

    static {
      nameOf = function (o) {
        if (typeof o !== 'object' || o === null || !(#name in o)) {
          throw illegalInvocation();
        }

        return o.#name;
      };
      messageOf = function (o) {
        if (typeof o !== 'object' || o === null || !(#message in o)) {
          throw illegalInvocation();
        }

        return o.#message;
      };
    }
  }

  /**
   * new DOMException(message = '', name = 'Error')
   * @param {*} [message] DOMString; undefined reads ''.
   * @param {*} [name] DOMString; undefined reads 'Error'.
   * @throws {TypeError} `Failed to construct 'DOMException': Cannot convert a Symbol
   *   value to a string` — message converted first, then name.
   * @node Same shape as node 26's global DOMException (probed: AbortSignal.abort().reason
   *       is [object DOMException], code 20, no own `code`). Chrome 158 recorded in
   *       tests/web/cases/domexception-class.expected and domexception-errors.expected.
   * @deviates Own property names are JSC's Error ones (line, column, sourceURL, stack)
   *   where Chrome has none on a constructed instance — an engine trait of every Error
   *   in Lava, not printed by any case. Calling it without `new` throws JSC's
   *   class-constructor TypeError text, not Blink's "Please use the 'new' operator"
   *   (CLAUDE.md §5: a class's call-without-new text is the engine's).
   */
  class DOMException {
    constructor() {
      // `arguments` rather than parameters: the interface's length is 0 in Chrome.
      var message = arguments.length > 0 ? arguments[0] : undefined;
      var name = arguments.length > 1 ? arguments[1] : undefined;
      message = message === undefined ? '' : toDOMString(message, 'DOMException');
      name = name === undefined ? 'Error' : toDOMString(name, 'DOMException');
      var self = ReflectConstruct(ErrorP, [], new.target);
      new DOMExceptionSlots(self, name, message);
      return self;
    }
  }

  ObjectSetPrototypeOf(DOMException.prototype, ErrorP.prototype);
  // Object-literal accessors are enumerable and configurable — the WebIDL attribute
  // shape — and their getters are named "get name" etc., as Blink's are.
  ObjectDefineProperties(
    DOMException.prototype,
    ObjectGetOwnPropertyDescriptors({
      get code() {
        var code = CODES[nameOf(this)];
        return code === undefined ? 0 : code;
      },
      get name() {
        return nameOf(this);
      },
      get message() {
        return messageOf(this);
      },
    }),
  );
  for (var i = 0; i < CONSTANTS.length; i += 2) {
    var constant = {
      value: CONSTANTS[i + 1],
      writable: false,
      enumerable: true,
      configurable: false,
    };
    ObjectDefineProperty(DOMException, CONSTANTS[i], constant);
    ObjectDefineProperty(DOMException.prototype, CONSTANTS[i], constant);
  }

  ObjectDefineProperty(DOMException.prototype, SymbolToStringTag, {
    value: 'DOMException',
    writable: false,
    enumerable: false,
    configurable: true,
  });

  // QuotaExceededErrorOptions member: an absent or undefined member stays null; anything
  // else is a `double`, so ToNumber and a finiteness check.
  function quotaMember(options, key) {
    var value = options[key];
    if (value === undefined) return null;
    value = NumberP(value);
    if (!NumberIsFinite(value)) {
      throw typeError(
        'QuotaExceededError',
        undefined,
        "Failed to read the '" +
          key +
          "' property from 'QuotaExceededErrorOptions': The provided double value is non-finite.",
      );
    }

    return value;
  }

  // QuotaExceededError's brand readers, assigned in its static block.
  var quotaOf;
  var requestedOf;

  /**
   * new QuotaExceededError(message = '', options = {}) — name and code fixed
   * (QuotaExceededError, 22); `quota`/`requested` read null unless given.
   * @param {*} [message] DOMString.
   * @param {{quota?: number, requested?: number}} [options] Read quota then requested.
   * @throws {TypeError} options is neither nullish nor an object, or a member is
   *   non-finite — Chrome's text, tests/web/cases/domexception-errors.expected.
   * @node Chrome 158 accepts a negative quota and requested < quota (no RangeError,
   *       though the spec draft has one); recorded, followed.
   * @deviates As DOMException (own Error property names; call-without-new text).
   */
  class QuotaExceededError extends DOMException {
    #quota;
    #requested;
    constructor() {
      // WebIDL converts every argument before the constructor steps run: the message,
      // then the dictionary. The message is converted here, once — super() is handed
      // the string, so a toString on it is not called twice.
      var message = arguments.length > 0 ? arguments[0] : undefined;
      var options = arguments.length > 1 ? arguments[1] : undefined;
      message = message === undefined ? '' : toDOMString(message, 'QuotaExceededError');
      var quota = null;
      var requested = null;
      if (options !== undefined && options !== null) {
        if (typeof options !== 'object' && typeof options !== 'function') {
          throw typeError(
            'QuotaExceededError',
            undefined,
            "The provided value is not of type 'QuotaExceededErrorOptions'.",
          );
        }

        // Dictionary members are read in lexicographic order.
        quota = quotaMember(options, 'quota');
        requested = quotaMember(options, 'requested');
      }

      super(message, 'QuotaExceededError');
      this.#quota = quota;
      this.#requested = requested;
    }

    static {
      quotaOf = function (o) {
        if (typeof o !== 'object' || o === null || !(#quota in o)) {
          throw illegalInvocation();
        }

        return o.#quota;
      };
      requestedOf = function (o) {
        if (typeof o !== 'object' || o === null || !(#requested in o)) {
          throw illegalInvocation();
        }

        return o.#requested;
      };
    }
  }

  ObjectDefineProperties(
    QuotaExceededError.prototype,
    ObjectGetOwnPropertyDescriptors({
      get quota() {
        return quotaOf(this);
      },
      get requested() {
        return requestedOf(this);
      },
    }),
  );
  ObjectDefineProperty(QuotaExceededError.prototype, SymbolToStringTag, {
    value: 'QuotaExceededError',
    writable: false,
    enumerable: false,
    configurable: true,
  });

  // Interface objects are writable, configurable, non-enumerable globals.
  ObjectDefineProperty(globalThis, 'DOMException', {
    value: DOMException,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  ObjectDefineProperty(globalThis, 'QuotaExceededError', {
    value: QuotaExceededError,
    writable: true,
    enumerable: false,
    configurable: true,
  });

  module.exports = P.ObjectFreeze({
    __proto__: null,
    DOMException: DOMException,
    QuotaExceededError: QuotaExceededError,
  });
});
