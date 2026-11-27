/**
 * @fileoverview Web Storage (HTML §12.2): the `Storage` interface and the
 * `localStorage`/`sessionStorage` attributes of the global, installed at module-eval.
 *
 * A Storage object is a WebIDL legacy platform object: besides its five operations and
 * `length`, every stored key is a named property (`localStorage.foo = 1` stores "1",
 * `delete localStorage.foo` removes it, Object.keys lists the keys). Chrome builds that
 * from V8 interceptors; a page-visible JS object can only get it from a Proxy, so each
 * area is a Proxy whose target is an empty ordinary object inheriting Storage.prototype.
 * The traps follow what Chrome 158 does, recorded in tests/web/cases/storage-named,
 * which is WebIDL's algorithm except where Chrome departs from it:
 *   - a key the prototype chain has (`getItem`, `length`, `toString`) is never a named
 *     property: reads, `in`, delete and own-property queries go to the ordinary object;
 *   - an assignment to such a key, or one through a receiver other than the area itself
 *     (an object inheriting from it), is an ordinary [[Set]]: `localStorage.key = 'k'`
 *     defines an own data property and stores nothing, as Chrome's does (WebIDL would
 *     call the named setter);
 *   - preventExtensions answers false, so the area stays extensible (Chrome: the same).
 *
 * Each area keeps its items in a null-prototype dictionary rather than a Map, so no
 * replaced Map.prototype method or iterator can steer it, and counts its size in UTF-16
 * code units of keys plus values against Chrome's quota (QUOTA below).
 *
 * The brand is a WeakMap from the Proxy to its area, not a private field: a method is
 * called with the Proxy as `this`, and a private name is never found through a Proxy.
 * The area itself keeps its state in private fields.
 *
 * Both areas live in this module's closure, and the loader instantiates a fresh copy of
 * it for every page's context, so a page never sees another page's items — a second
 * page in a reused VM starts empty (cmd/lava/storage_isolation_test.odin).
 *
 * Deviations (docs/LARVA.md decision 1 asks each to be written down):
 *   - Nothing is persisted: localStorage lives as long as the page, exactly like
 *     sessionStorage; two pages of one origin do not share it, and no `storage` event
 *     is fired. Larva is a headless engine without a profile directory (a non-goal).
 *   - An opaque origin (`lava run` without --origin) still gets both areas, as a
 *     file: page does in Chrome, where Chrome throws a SecurityError for a sandboxed or
 *     data: document.
 *   - Key order is the dictionary's (array indices ascending, then insertion order);
 *     Chrome's is its hash table's. An item shadowed by the prototype is left out of
 *     Object.keys, where Chrome lists it. A non-configurable data descriptor is refused
 *     (a Proxy cannot report a non-configurable property its target lacks), where
 *     Chrome stores the value. Reflect.defineProperty with an accessor answers false
 *     (WebIDL), where Chrome answers true and stores nothing. All four pinned by the
 *     known gap storage-named-gaps.
 *
 * Instantiated eagerly (the loader names it), so every capture below is pristine.
 *
 * @module lava/internal/storage
 */

(function (require, module) {
  'use strict';

  var P = require('internal/primordials');
  var nativeShape = require('internal/native_shape');
  var webErrors = require('internal/web_errors');
  var QuotaExceededError = require('internal/domexception').QuotaExceededError;

  var ObjectCreate = P.ObjectCreate;
  var ObjectHasOwn = P.ObjectHasOwn;
  var ObjectKeys = P.ObjectKeys;
  var ProxyP = P.Proxy;
  var ReflectDefineProperty = P.ReflectDefineProperty;
  var ReflectDeleteProperty = P.ReflectDeleteProperty;
  var ReflectGet = P.ReflectGet;
  var ReflectGetOwnPropertyDescriptor = P.ReflectGetOwnPropertyDescriptor;
  var ReflectHas = P.ReflectHas;
  var ReflectOwnKeys = P.ReflectOwnKeys;
  var ReflectSet = P.ReflectSet;
  var TypeErrorP = P.TypeError;
  var WeakMapCtor = P.WeakMap;
  var WeakMapPrototypeGet = P.WeakMapPrototypeGet;
  var WeakMapPrototypeSet = P.WeakMapPrototypeSet;
  var argumentsRequired = webErrors.argumentsRequired;
  var context = webErrors.context;
  var illegalInvocation = webErrors.illegalInvocation;
  var namedSetterContext = webErrors.namedSetterContext;
  var pageError = webErrors.pageError;
  var scrubThrown = webErrors.scrubThrown;
  var toDOMString = webErrors.toDOMString;
  var toDOMStringIn = webErrors.toDOMStringIn;
  var toNumber = webErrors.toNumber;
  var typeError = webErrors.typeError;

  var IFACE = 'Storage';
  // Chrome's per-area quota, in UTF-16 code units of every key plus every value
  // (10 MiB of UTF-16). Recorded, not read off a header: a 1-unit key with a
  // 5 MiB - 1 value is stored and one more unit is refused, and an empty key takes a
  // 5 MiB value (tests/web/cases/storage-errors.expected). Each area has its own.
  var QUOTA = 5 * 1024 * 1024;

  // Proxy -> its StorageArea; the brand every Storage member checks.
  var areas = new WeakMapCtor();

  /**
   * One storage area's items. Internal: a page reaches it only through the Storage
   * members and the Proxy traps.
   */
  class StorageArea {
    #items = { __proto__: null };
    #count = 0;
    // Code units of every key plus every value, against QUOTA.
    #used = 0;
    // The key list key() indexes, rebuilt after a key is added or removed: a page that
    // walks key(0..length-1) costs one ObjectKeys, not one per call.
    #keys = null;

    get length() {
      return this.#count;
    }

    has(key) {
      return ObjectHasOwn(this.#items, key);
    }

    get(key) {
      return ObjectHasOwn(this.#items, key) ? this.#items[key] : null;
    }

    key(index) {
      if (index >= this.#count) return null;
      if (this.#keys === null) this.#keys = ObjectKeys(this.#items);
      return this.#keys[index];
    }

    keyList() {
      if (this.#keys === null) this.#keys = ObjectKeys(this.#items);
      return this.#keys;
    }

    // `op` names the operation for the quota error's prefix; null for the named setter.
    set(key, value, op) {
      var items = this.#items;
      var had = ObjectHasOwn(items, key);
      var next = this.#used + key.length + value.length;
      if (had) next -= key.length + items[key].length;
      if (next > QUOTA) {
        var prefix = op === null ? namedSetterContext(IFACE, key) : context(IFACE, op);
        throw pageError(
          new QuotaExceededError(prefix + "Setting the value of '" + key + "' exceeded the quota."),
        );
      }

      items[key] = value;
      this.#used = next;
      if (!had) {
        this.#count++;
        this.#keys = null;
      }
    }

    remove(key) {
      var items = this.#items;
      if (!ObjectHasOwn(items, key)) return;
      this.#used -= key.length + items[key].length;
      delete items[key];
      this.#count--;
      this.#keys = null;
    }

    clear() {
      this.#items = { __proto__: null };
      this.#count = 0;
      this.#used = 0;
      this.#keys = null;
    }
  }

  function areaOf(o) {
    var area = WeakMapPrototypeGet(areas, o);
    if (area === undefined) throw illegalInvocation();
    return area;
  }

  function requireArguments(op, required, present) {
    if (present < required) throw typeError(IFACE, op, argumentsRequired(required, present));
  }

  /**
   * Storage (HTML §12.2.1). A page cannot construct one; the two areas are its only
   * instances.
   * @throws {TypeError} `Illegal invocation` — any member on a receiver that is not an
   *   area; `<context>N argument(s) required, but only M present.`; a Symbol key or
   *   value (`Cannot convert a Symbol value to a string`), a Symbol or BigInt index.
   * @throws {QuotaExceededError} `<context>Setting the value of '<key>' exceeded the
   *   quota.` — the area would pass QUOTA.
   * @node Chrome 158, tests/web/cases/storage-basic, storage-named, storage-errors and
   *   shape-storage: the receiver is checked first, then the argument count, then the
   *   key and the value in that order.
   * @deviates Not persisted, not shared between pages, key order (file comment).
   */
  class Storage {
    constructor() {
      throw new TypeErrorP('Illegal constructor');
    }

    get length() {
      return areaOf(this).length;
    }

    clear() {
      areaOf(this).clear();
    }

    getItem(key) {
      var area = areaOf(this);
      requireArguments('getItem', 1, arguments.length);
      return area.get(toDOMString(key, IFACE, 'getItem'));
    }

    key(index) {
      var area = areaOf(this);
      requireArguments('key', 1, arguments.length);
      // WebIDL `unsigned long`: ToNumber, then ToUint32 (NaN and the infinities to 0).
      return area.key(toNumber(index, IFACE, 'key') >>> 0);
    }

    removeItem(key) {
      var area = areaOf(this);
      requireArguments('removeItem', 1, arguments.length);
      area.remove(toDOMString(key, IFACE, 'removeItem'));
    }

    setItem(key, value) {
      var area = areaOf(this);
      requireArguments('setItem', 2, arguments.length);
      key = toDOMString(key, IFACE, 'setItem');
      area.set(key, toDOMString(value, IFACE, 'setItem'), 'setItem');
    }
  }

  // The named property setter, for an assignment or a data descriptor: Blink's text
  // names the property in place of an operation.
  function namedSet(area, name, value) {
    try {
      area.set(
        name,
        typeof value === 'string' ? value : toDOMStringIn(value, namedSetterContext(IFACE, name)),
        null,
      );
    } catch (e) {
      // A page's own toString may have thrown through our frames.
      throw scrubThrown(e, IFACE);
    }
  }

  // A new area: the Proxy a page sees, over an empty object inheriting Storage.prototype.
  // A name is a named property when the area holds it and the object (own properties
  // and prototype chain) does not have it — WebIDL's named property visibility.
  function makeStorage() {
    var area = new StorageArea();
    var target = ObjectCreate(Storage.prototype);
    var proxy;

    function visible(t, p) {
      return typeof p === 'string' && area.has(p) && !ReflectHas(t, p);
    }

    var handler = {
      __proto__: null,
      get(t, p, receiver) {
        if (visible(t, p)) return area.get(p);
        return ReflectGet(t, p, receiver);
      },
      set(t, p, value, receiver) {
        if (receiver === proxy && typeof p === 'string' && !ReflectHas(t, p)) {
          namedSet(area, p, value);
          return true;
        }

        return ReflectSet(t, p, value, receiver);
      },
      has(t, p) {
        return (typeof p === 'string' && area.has(p)) || ReflectHas(t, p);
      },
      deleteProperty(t, p) {
        if (visible(t, p)) {
          area.remove(p);
          return true;
        }

        return ReflectDeleteProperty(t, p);
      },
      defineProperty(t, p, desc) {
        if (typeof p === 'string' && !ReflectHas(t, p)) {
          if (ObjectHasOwn(desc, 'get') || ObjectHasOwn(desc, 'set')) return false;
          // Deviation (file comment): the Proxy invariant forbids reporting success.
          if (ObjectHasOwn(desc, 'configurable') && !desc.configurable) return false;
          namedSet(area, p, desc.value);
          return true;
        }

        return ReflectDefineProperty(t, p, desc);
      },
      getOwnPropertyDescriptor(t, p) {
        if (visible(t, p)) {
          return {
            __proto__: null,
            value: area.get(p),
            writable: true,
            enumerable: true,
            configurable: true,
          };
        }

        return ReflectGetOwnPropertyDescriptor(t, p);
      },
      // Chrome's order: the object's own string keys, then the items, then its symbols.
      ownKeys(t) {
        var own = ReflectOwnKeys(t);
        var keys = area.keyList();
        var out = [];
        var symbols = [];
        var n = 0;
        var s = 0;
        var i;
        for (i = 0; i < own.length; i++) {
          if (typeof own[i] === 'string') out[n++] = own[i];
          else symbols[s++] = own[i];
        }
        for (i = 0; i < keys.length; i++) {
          if (!ReflectHas(t, keys[i])) out[n++] = keys[i];
        }
        for (i = 0; i < s; i++) out[n++] = symbols[i];
        return out;
      },
      preventExtensions() {
        return false;
      },
    };

    proxy = new ProxyP(target, handler);
    WeakMapPrototypeSet(areas, proxy, area);
    return proxy;
  }

  nativeShape.defineInterface({
    name: IFACE,
    impl: Storage,
    length: 0,
    illegal: true,
    members: [
      'length',
      'clear',
      'getItem',
      'key',
      'removeItem',
      'setItem',
      'constructor',
      '@@toStringTag',
    ],
  });

  // Made on first read: a page that never touches storage pays for no Proxy.
  var local = null;
  var session = null;
  nativeShape.defineGlobalAttribute('localStorage', function () {
    if (local === null) local = makeStorage();
    return local;
  });
  nativeShape.defineGlobalAttribute('sessionStorage', function () {
    if (session === null) session = makeStorage();
    return session;
  });

  module.exports = P.ObjectFreeze({ __proto__: null });
});
