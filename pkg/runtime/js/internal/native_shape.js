/**
 * @fileoverview Makes the Web APIs Larva implements in JS look like the native
 * built-ins Chrome has (#114) — in ONE place, so no API carries its own disguise.
 *
 * What a page can read off a built-in without calling it, and what Chrome answers:
 *   - Function.prototype.toString: `function NAME() { [native code] }` for the interface
 *     object, every operation, and every accessor (`function get href() …`);
 *   - an operation or accessor has no `prototype` and refuses `new`; its `name` and
 *     `length` are WebIDL's;
 *   - the interface object called without `new` throws Blink's "Please use the 'new'
 *     operator" (or "Illegal constructor" for one a page cannot construct);
 *   - operations, attributes and constants are enumerable; `constructor` is not; the
 *     own keys come in Blink's order; the global is writable, configurable and, for an
 *     interface, not enumerable;
 *   - nothing thrown to the page names one of our sources in its stack.
 * A JS class gives none of that, so the public surface is built here instead, around
 * the implementation: `defineInterface` makes the interface object and re-lays the
 * prototype; `defineOperation` makes a global operation. The implementation itself —
 * the class, its private fields, its methods — is untouched and stays what internal
 * code uses.
 *
 * Each public function is a thin wrapper, a method shorthand (so: no `prototype`, not a
 * constructor), that forwards `this` and `arguments` to the implementation and, on a
 * throw, takes our frames out of the error's stack (scrubThrown). What that costs,
 * bin/lava -o:speed against master (19e8d43), Linux x64, best of 7 runs per launch,
 * medians of 5 interleaved launches per arm: URLSearchParams.get 6.2 -> 7.0 ns, URL's
 * href getter 55.3 -> 54.0 ns, TextDecoder.decode of 5 bytes 66.2 -> 74.3 ns,
 * `new URL(…)` 1092 -> 1155 ns, `new Headers()` + has 200 -> 205 ns.
 *
 * Function.prototype.toString is replaced here, at this module's eval, by a mask that
 * answers from a registry of the functions built here (a WeakMap only this closure
 * holds, so a page can neither add to it nor read it) and folds JSC's multi-line native
 * text (`function push() {\n    [native code]\n}`) into V8's one-line form for every
 * other native. The mask is itself a method shorthand registered with itself, so
 * `toString.call(toString)` is native, `toString.prototype` is absent and `new toString`
 * throws, as for the intrinsic. Its cost (same method as above): 0.5 -> 14.9 ns on a
 * script function (JSC caches that text; the mask adds the registry miss and a call),
 * 31.8 -> 34.5 ns on Array.prototype.push, 30.1 -> 31.4 ns on atob. It is JS, not a
 * host function: a host function would be indistinguishable too, but its two C-API
 * calls cost 146 ns on a script function and 289 ns on a native (a prototype on
 * host_native_create, same harness, best of 7 runs of 1e6 calls) — and buy nothing a
 * page can see.
 *
 * Every page builds its ~87 interfaces here (~770 members), in JSC's interpreter: the
 * page's copy of this code is discarded with it, so it never tiers up, and the cost is
 * the count of calls and allocations per member. So layMembers parses, decides and
 * defines in one pass with no object per entry or descriptor; an accessor's functions
 * are method shorthands, not read back off a literal's descriptor; and an operation
 * whose WebIDL length is 0 or 1 is made with that length rather than redefined.
 * Measured against master (b3d6d08), bench/pages -o:speed, N=1, 300 pages a launch,
 * performance.now() around every defineInterface and around the loader, medians of the
 * per-page values (first 10 dropped) over 5 interleaved launches per arm, Linux x64:
 * defineInterface 2.81 -> 2.06 ms a page, the whole loader 10.02 -> 8.41 ms (with the
 * deletes taken out of Navigator and navigator_apis, and the throw out of the page-URL
 * parse, internal/url parseStringOrNull).
 *
 * Instantiated eagerly, before any module that installs a global (the loader names it
 * right after the intrinsics are locked), so the captures below are pristine and the
 * mask is in before any page code runs.
 *
 * @module lava/internal/native_shape
 */

(function (require, module) {
  'use strict';

  // The install-time helpers below run once per interface member on every page, enough
  // calls for JSC to DFG-compile each of them per page, for nothing (bootstrap/loader.js
  // says why): kept in the baseline tier, marked before any of them first runs. Not the
  // functions they make (`op`, `get attr`, `set attr`, the interface objects): those are
  // what a page calls, and keep every tier.
  require.neverOptimize(
    markNative,
    nameNative,
    wrapOperation,
    wrapGetter,
    wrapSetter,
    parseEntry,
    wellKnown,
    layMembers,
    findMember,
    installGlobal,
    defineInterface,
    defineOperation,
    defineGlobalAttribute,
    defineNamespace,
  );
  var P = require('internal/primordials');
  var webErrors = require('internal/web_errors');

  var ObjectDefineProperty = P.ObjectDefineProperty;
  var ObjectGetOwnPropertyDescriptor = P.ObjectGetOwnPropertyDescriptor;
  var ObjectHasOwn = P.ObjectHasOwn;
  var ObjectSetPrototypeOf = P.ObjectSetPrototypeOf;
  var ObjectGetPrototypeOf = P.ObjectGetPrototypeOf;
  var ObjectProto = P.Object.prototype;
  var ReflectApply = P.ReflectApply;
  var ReflectConstruct = P.ReflectConstruct;
  var ReflectOwnKeys = P.ReflectOwnKeys;
  var StringPrototypeCharCodeAt = P.StringPrototypeCharCodeAt;
  var StringPrototypeIndexOf = P.StringPrototypeIndexOf;
  var StringPrototypeSlice = P.StringPrototypeSlice;
  var TypeErrorP = P.TypeError;
  var WeakMapCtor = P.WeakMap;
  var pageError = webErrors.pageError;
  var scrubThrown = webErrors.scrubThrown;

  // Captured at this eager eval: the intrinsic the mask defers to, and the registry's
  // methods (a page that later replaces WeakMap.prototype.get reaches neither).
  var FunctionProto = Function.prototype;
  var intrinsicToString = FunctionProto.toString;
  var WeakMapPrototypeGet = P.WeakMapPrototypeGet;
  var WeakMapPrototypeSet = P.WeakMapPrototypeSet;
  var SymbolToStringTag = P.SymbolToStringTag;
  var SymbolIterator = P.Symbol.iterator;
  var SymbolAsyncIterator = P.Symbol.asyncIterator;
  var EMPTY = [];

  var NEW_TEXT =
    "Please use the 'new' operator, this DOM object constructor cannot be called as a function.";
  // JSC's native source tail and V8's.
  var JSC_NATIVE_TAIL = '() {\n    [native code]\n}';
  var V8_NATIVE_TAIL = '() { [native code] }';
  var FUNCTION_HEAD = 'function ';

  var PROXY_NAME = 'ProxyObject';
  var BOUND_PREFIX = 'bound ';

  var nativeSources = new WeakMapCtor();

  function isBoundName(fn, name) {
    var desc = ObjectGetOwnPropertyDescriptor(fn, 'name');
    return desc !== undefined && desc.value === BOUND_PREFIX + name;
  }

  /**
   * Registers `fn` with the toString mask under `name`.
   * @param {Function} fn
   * @param {string} name Chrome's name for it: `append`, `get href`, `URL`.
   * @returns {Function} `fn`.
   */
  function markNative(fn, name) {
    // The name, not the text: the text is built on the rare toString call rather than
    // for every member of every page.
    WeakMapPrototypeSet(nativeSources, fn, name);
    return fn;
  }

  /**
   * Function.prototype.toString as Chrome answers it.
   * @returns {string} The registered text for a function built here; for any other
   *   native, JSC's text in V8's one-line form; for a script function, its source.
   * @throws {TypeError} `Function.prototype.toString requires that 'this' be a
   *   Function` — Chrome 158's text (JSC's intrinsic says "Type error").
   * @node n/a — Chrome 158, tests/web/cases/shape-tostring.expected and shape-*.
   * @deviates A bound function whose `name` a page redefined prints its target's
   *   name, where V8 prints none: JSC's text is the target's, and the rename hides the
   *   one mark of a bound function this can read without running page code.
   */
  var maskedToString = {
    toString() {
      if (typeof this !== 'function') {
        throw pageError(
          new TypeErrorP("Function.prototype.toString requires that 'this' be a Function"),
        );
      }

      var registered = WeakMapPrototypeGet(nativeSources, this);
      if (registered !== undefined) return FUNCTION_HEAD + registered + V8_NATIVE_TAIL;
      var text = ReflectApply(intrinsicToString, this, EMPTY);
      // No script source can end in `[native code]`, so this folds natives only. The
      // last-character test keeps a long source from being sliced at all.
      var n = text.length;
      if (
        n > FUNCTION_HEAD.length + JSC_NATIVE_TAIL.length &&
        StringPrototypeCharCodeAt(text, n - 2) === 0x0a &&
        StringPrototypeSlice(text, n - JSC_NATIVE_TAIL.length, n) === JSC_NATIVE_TAIL &&
        StringPrototypeSlice(text, 0, FUNCTION_HEAD.length) === FUNCTION_HEAD
      ) {
        var name = StringPrototypeSlice(text, FUNCTION_HEAD.length, n - JSC_NATIVE_TAIL.length);
        // V8 names neither a bound function nor a callable Proxy; JSC prints the bound
        // target's name and `ProxyObject`. A bound function is the one whose own name
        // is `bound <that name>` — read as a descriptor, so no getter runs; a Proxy's
        // text is recognised before anything is read off it, so no trap runs either.
        if (name === PROXY_NAME || isBoundName(this, name)) name = '';
        // Remembered: a native's text never changes, so the next call is a registry hit
        // instead of a fold (Array.prototype.push 131 -> 34.5 ns a call, measured as in
        // the file comment).
        WeakMapPrototypeSet(nativeSources, this, name);
        text = FUNCTION_HEAD + name + V8_NATIVE_TAIL;
      }

      return text;
    },
  }.toString;
  markNative(maskedToString, 'toString');
  // A put on the existing property: it keeps the intrinsic's attributes (writable,
  // non-enumerable, configurable) and its place in the own-key order.
  ObjectDefineProperty(FunctionProto, 'toString', { __proto__: null, value: maskedToString });

  // The wrapper around an operation (a method or a static). Method shorthand with a
  // computed key: named `name`, no `prototype`, not a constructor.
  // An operation forwards `arguments` whole (Reflect.apply): fixed-arity `impl.call`
  // arms measured no better on it (URLSearchParams.get 7.1 -> 8.8 ns). An accessor
  // calls `impl.call(this)`, the spelling JSC inlines (primordials.js, the `.call`
  // section): Reflect.apply cost URL's href getter 7 ns a read (54.9 -> 62.2 ns, against
  // 55.2 with `.call`). Safe although a `fn.call` read is steerable in general:
  // Function.prototype.call is locked, and `impl` is unreachable from user code — the
  // wrapper replaced it everywhere a page could read it — so no page can give it an own
  // `call` or a new prototype.
  // The key in each literal below is fixed, and the name is set afterwards: a computed
  // key gives every member's holder object a Structure of its own, one per distinct
  // name per page. Measured cold, as every page runs this (a fresh process, 400
  // wrappers): 310 us with computed keys, 240 us fixed with the name defined after.
  // The literal is picked by WebIDL length, so the common lengths come out right and
  // only `name` is defined afterwards: 0 and 1 are ~85% of the operations on a page,
  // and each `length` defined was a property reification and a define per operation.
  // The named parameters are never read; the body forwards `arguments` either way.
  function wrapOperation(name, impl, length) {
    var fn;
    var natural = length;
    if (length === 0) {
      fn = {
        op() {
          try {
            return ReflectApply(impl, this, arguments);
          } catch (e) {
            throw scrubThrown(e, name);
          }
        },
      }.op;
    } else if (length === 1) {
      fn = {
        op(_a) {
          try {
            return ReflectApply(impl, this, arguments);
          } catch (e) {
            throw scrubThrown(e, name);
          }
        },
      }.op;
    } else {
      natural = 0;
      fn = {
        op() {
          try {
            return ReflectApply(impl, this, arguments);
          } catch (e) {
            throw scrubThrown(e, name);
          }
        },
      }.op;
    }

    return nameNative(fn, name, length, natural);
  }

  // An accessor's functions are method shorthands too, not `get`/`set` literals read
  // back through their descriptor: what a page can tell a getter-kind function by — no
  // `prototype`, not a constructor, strict — a method has as well, and its name, length
  // and text are set here either way. The descriptor read was an object and an
  // accessor pair per accessor, ~265 of them on every page.
  function wrapGetter(name, impl) {
    var fn = {
      attr() {
        try {
          return impl.call(this); // primordials-ok: invoke — impl is unreachable from user code
        } catch (e) {
          throw scrubThrown(e, 'get ' + name);
        }
      },
    }.attr;
    return nameNative(fn, 'get ' + name, 0, 0);
  }

  function wrapSetter(name, impl) {
    var fn = {
      attr(value) {
        try {
          impl.call(this, value); // primordials-ok: invoke — impl is unreachable from user code
        } catch (e) {
          throw scrubThrown(e, 'set ' + name);
        }
      },
    }.attr;
    return nameNative(fn, 'set ' + name, 1, 1);
  }

  // Gives a wrapper its WebIDL name and length (both stay non-writable, non-enumerable,
  // configurable, as a built-in's) and registers it with the toString mask. `natural`
  // is the length the literal already has, which is then left alone. The descriptor
  // objects are reused: this runs for every member of every page.
  var NAME_DESC = { __proto__: null, value: '' };
  var LENGTH_DESC = { __proto__: null, value: 0 };
  function nameNative(fn, name, length, natural) {
    if (length !== natural) {
      LENGTH_DESC.value = length;
      ObjectDefineProperty(fn, 'length', LENGTH_DESC);
    }
    NAME_DESC.value = name;
    ObjectDefineProperty(fn, 'name', NAME_DESC);
    return markNative(fn, name);
  }

  // A member entry: `name`, `name:length` for an operation whose WebIDL length is not
  // the implementation's, `@@toStringTag`, `@@iterator=entries` (an alias of another
  // member's function, as Blink's iterator is its `entries`), or a constant's name.
  // Parsed inside layMembers' one pass, into these three rather than an object per
  // entry: a length is the digits after the last `:`, so a plain name — most entries —
  // is told by its last character alone, with no search. Only a well-known symbol's
  // entry names an alias.
  var entryKey = '';
  var entryLength = -1;
  var entryAlias = null;
  function parseEntry(entry) {
    entryKey = entry;
    entryLength = -1;
    entryAlias = null;
    if (entry[0] === '@') {
      var eq = StringPrototypeIndexOf(entry, '=', 0);
      if (eq !== -1) {
        entryKey = StringPrototypeSlice(entry, 0, eq);
        entryAlias = StringPrototypeSlice(entry, eq + 1, entry.length);
      }

      return;
    }

    var end = entry.length - 1;
    var at = end;
    while (at > 0 && entry[at] >= '0' && entry[at] <= '9') at--;
    if (at < end && entry[at] === ':') {
      entryKey = StringPrototypeSlice(entry, 0, at);
      entryLength = +StringPrototypeSlice(entry, at + 1, entry.length);
    }
  }

  function wellKnown(key) {
    if (key === '@@toStringTag') return SymbolToStringTag;
    if (key === '@@iterator') return SymbolIterator;
    if (key === '@@asyncIterator') return SymbolAsyncIterator;
    return key;
  }

  // The two descriptors every member is defined through, refilled per member rather
  // than allocated: ObjectDefineProperty reads a descriptor's fields and keeps nothing
  // of the object. Nothing between filling one and defining it re-enters layMembers
  // (the target is ours, never a Proxy, and wrapping runs no page code); layMembers
  // clears them before it returns, so they hold no page's functions.
  var DATA_DESC = {
    __proto__: null,
    value: undefined,
    writable: true,
    enumerable: true,
    configurable: true,
  };
  var ACCESSOR_DESC = {
    __proto__: null,
    get: undefined,
    set: undefined,
    enumerable: true,
    configurable: true,
  };

  // Re-lays `target`'s own members in `entries` order, each wrapped. A member the list
  // names is taken off and defined again at the end, so the listed ones end up in the
  // list's order after anything unlisted. `source` holds the implementation (the same
  // object for a prototype; the implementation class for statics).
  //
  // Which members can be redefined where they are rather than taken off and appended:
  // the longest run from the start of the list — strings and symbols separately, as
  // Reflect.ownKeys orders them — that is already in the list's order on `target` (a
  // member the target lacks ends the run: it is appended). Everything after it moves.
  // A delete is what costs here (it turns the object into a dictionary): a class
  // prototype is already in Blink's order but for `constructor`, which a class puts
  // first, so most members stay. Re-laying every member took 7.2 us a 14-member
  // prototype against 1.1 us for the class itself (best of 300, bin/lava).
  //
  // Every page lays ~770 members through here (87 interfaces) in JSC's interpreter —
  // the page's copy of this code never runs long enough to tier up — where each call
  // counts, and a primordial is three: the wrapper, the locked `call` getter, the
  // method. So one pass parses, decides and defines, with no object per entry or per
  // descriptor, and the run is found by walking the own keys forward from its last
  // member (the very next key, as a rule) instead of searching them per entry. The run
  // is decided against the keys as they were before the first member is touched, as a
  // separate pass would decide it. What this saved is in the file comment.
  function layMembers(iface, target, source, entries, constants, ctor) {
    var done = { __proto__: null };
    var own = ReflectOwnKeys(target);
    var count = own.length;
    var lastString = -1;
    var lastSymbol = -1;
    var stringRun = true;
    var symbolRun = true;
    for (var i = 0; i < entries.length; i++) {
      parseEntry(entries[i]);
      var name = entryKey;
      var key = name[0] === '@' ? wellKnown(name) : name;
      var keep = false;
      var j;
      if (typeof key === 'symbol') {
        if (symbolRun) {
          j = lastSymbol + 1;
          while (j < count && own[j] !== key) j++;
          symbolRun = j < count;
          if (symbolRun) lastSymbol = j;
          keep = symbolRun;
        }
      } else if (stringRun) {
        j = lastString + 1;
        while (j < count && own[j] !== key) j++;
        stringRun = j < count;
        if (stringRun) lastString = j;
        keep = stringRun;
      }

      var desc = DATA_DESC;
      if (name === 'constructor') {
        desc.value = ctor;
        desc.writable = true;
        desc.enumerable = false;
        desc.configurable = true;
      } else if (name === '@@toStringTag') {
        desc.value = iface;
        desc.writable = false;
        desc.enumerable = false;
        desc.configurable = true;
      } else if (entryAlias !== null) {
        desc.value = done[entryAlias];
        desc.writable = true;
        desc.enumerable = false;
        desc.configurable = true;
      } else if (constants !== null && name in constants) {
        desc.value = constants[name];
        desc.writable = false;
        desc.enumerable = true;
        desc.configurable = false;
      } else {
        var length = entryLength;
        var impl = ObjectGetOwnPropertyDescriptor(source, key);
        if (impl === undefined) impl = findMember(source, key);
        if (impl === undefined) {
          throw new TypeErrorP('native_shape: ' + iface + ' has no member ' + name);
        }

        if (ObjectHasOwn(impl, 'value')) {
          var fn = wrapOperation(name, impl.value, length !== -1 ? length : impl.value.length);
          done[name] = fn;
          desc.value = fn;
          desc.writable = true;
          desc.enumerable = true;
          desc.configurable = true;
        } else {
          desc = ACCESSOR_DESC;
          desc.get = impl.get === undefined ? undefined : wrapGetter(name, impl.get);
          desc.set = impl.set === undefined ? undefined : wrapSetter(name, impl.set);
        }
      }

      // Not kept: taken off if the target has it (no earlier entry adds or removes this
      // key), and defined again at the end.
      if (!keep && ObjectHasOwn(target, key)) delete target[key];
      ObjectDefineProperty(target, key, desc);
    }

    DATA_DESC.value = undefined;
    ACCESSOR_DESC.get = undefined;
    ACCESSOR_DESC.set = undefined;
  }

  // The descriptor of `key` on `source` or the nearest object it inherits it from
  // (short of Object.prototype): a mixin's member — fetch's Body — is defined on each
  // interface that includes it, as WebIDL does.
  function findMember(source, key) {
    for (var o = source; o !== null && o !== ObjectProto; o = ObjectGetPrototypeOf(o)) {
      var desc = ObjectGetOwnPropertyDescriptor(o, key);
      if (desc !== undefined) return desc;
    }

    return undefined;
  }

  // Interface objects are writable, configurable and non-enumerable on the global;
  // operations (atob, fetch) are enumerable.
  function installGlobal(name, value, enumerable) {
    ObjectDefineProperty(globalThis, name, {
      __proto__: null,
      value: value,
      writable: true,
      enumerable: enumerable,
      configurable: true,
    });
  }

  /**
   * Builds the interface object for `spec.impl` and re-lays its prototype as Blink's.
   * @param {{
   *   name: string,
   *   impl: Function,
   *   length: number,
   *   illegal?: boolean,
   *   parent?: Function,
   *   statics?: string[],
   *   members: string[],
   *   constants?: Object,
   *   global?: boolean,
   *   source?: Object,
   * }} spec `impl` is the implementation, whose `prototype` becomes the interface
   *   prototype object; `illegal` makes every construction throw "Illegal constructor";
   *   `parent` is the parent interface object; `statics`/`members` list the interface
   *   object's and the prototype's keys in Blink's order (parseEntry); `constants`
   *   maps a constant's name to its value, defined on both; `source` holds the
   *   prototype's member implementations when they are not on the prototype itself —
   *   an empty prototype is laid with no member moved (layMembers' deletes), which is
   *   what an interface whose `constructor` Blink lists mid-way (Navigator) needs.
   * @returns {Function} The interface object, installed on the global unless
   *   `global: false`.
   * @node n/a — Chrome 158: tests/web/cases/shape-*.expected.
   * @deviates none
   */
  function defineInterface(spec) {
    var name = spec.name;
    var impl = spec.impl;
    var illegal = spec.illegal === true;
    var constants = spec.constants === undefined ? null : spec.constants;
    // A function, not a class: only a function can choose what a call without `new`
    // throws. It is never what internal code constructs (that is `impl`, directly).
    var ctor = {
      [name]: function () {
        if (new.target === undefined) {
          throw pageError(
            new TypeErrorP(
              illegal ? 'Illegal constructor' : "Failed to construct '" + name + "': " + NEW_TEXT,
            ),
          );
        }

        if (illegal) {
          throw pageError(
            new TypeErrorP("Failed to construct '" + name + "': Illegal constructor"),
          );
        }

        try {
          // The page's own `new X(…)` constructs the implementation directly, with
          // the arguments it was given (an implementation may count them); a subclass
          // goes through Reflect.construct for its new.target.
          if (new.target === ctor) {
            switch (arguments.length) {
              case 0:
                return new impl();
              case 1:
                return new impl(arguments[0]);
              case 2:
                return new impl(arguments[0], arguments[1]);
              case 3:
                return new impl(arguments[0], arguments[1], arguments[2]);
            }
          }
          return ReflectConstruct(impl, arguments, new.target);
        } catch (e) {
          throw scrubThrown(e, name);
        }
      },
    }[name];
    ObjectDefineProperty(ctor, 'length', { __proto__: null, value: spec.length });
    ObjectDefineProperty(ctor, 'prototype', {
      __proto__: null,
      value: impl.prototype,
      writable: false,
    });
    if (spec.parent !== undefined) ObjectSetPrototypeOf(ctor, spec.parent);
    markNative(ctor, name);
    if (spec.statics !== undefined) layMembers(name, ctor, impl, spec.statics, constants, ctor);
    var proto = impl.prototype;
    var source = spec.source === undefined ? proto : spec.source;
    layMembers(name, proto, source, spec.members, constants, ctor);
    if (spec.global !== false) installGlobal(name, ctor, false);
    return ctor;
  }

  /**
   * Builds a global operation (atob, fetch, structuredClone) around `impl`.
   * @param {string} name
   * @param {Function} impl
   * @param {number} length WebIDL's: the count of required arguments.
   * @returns {Function} The installed operation.
   * @node n/a — Chrome 158: tests/web/cases/shape-operations.expected.
   * @deviates none
   */
  function defineOperation(name, impl, length) {
    var fn = wrapOperation(name, impl, length);
    installGlobal(name, fn, true);
    return fn;
  }

  /**
   * Defines a read-only attribute of the global object (`crypto`): an enumerable,
   * configurable accessor whose getter is native-shaped (`get crypto`).
   * @param {string} name
   * @param {Function} get The implementation's getter.
   * @param {boolean} [replaceable] WebIDL's [Replaceable] (`performance`): a native
   *   `set NAME` that replaces the accessor with a plain data property holding the
   *   value assigned, as Blink's does.
   * @node n/a — Chrome 158: tests/web/cases/shape-crypto.expected,
   *   shape-performance.expected (`performance = 5` then reads 5).
   * @deviates none
   */
  function defineGlobalAttribute(name, get, replaceable) {
    var set;
    if (replaceable === true) {
      set = wrapSetter(name, function (value) {
        installGlobal(name, value, true);
      });
    }

    ObjectDefineProperty(globalThis, name, {
      __proto__: null,
      get: wrapGetter(name, get),
      set: set,
      enumerable: true,
      configurable: true,
    });
  }

  /**
   * Re-lays a namespace object (`console`) as Blink's: its listed function members
   * native-shaped in `members` order, a @@toStringTag of `tag`, and an empty object as
   * its [[Prototype]], as WebIDL gives a namespace.
   * @param {Object} object
   * @param {string} tag
   * @param {string[]} members parseEntry's syntax; an operation's length defaults to 0.
   * @node n/a — Chrome 158: tests/web/cases/shape-console.expected.
   * @deviates none
   */
  function defineNamespace(object, tag, members) {
    var entries = [];
    for (var i = 0; i < members.length; i++) {
      var e = members[i];
      entries[i] = e === '@@toStringTag' || StringPrototypeIndexOf(e, ':', 0) !== -1 ? e : e + ':0';
    }
    layMembers(tag, object, object, entries, null, null);
    ObjectSetPrototypeOf(object, P.ObjectCreate(ObjectProto));
  }

  module.exports = P.ObjectFreeze({
    __proto__: null,
    defineInterface: defineInterface,
    defineOperation: defineOperation,
    markNative: markNative,
    wrapOperation: wrapOperation,
    wrapGetter: wrapGetter,
    wrapSetter: wrapSetter,
    installGlobal: installGlobal,
    defineGlobalAttribute: defineGlobalAttribute,
    defineNamespace: defineNamespace,
  });
});
