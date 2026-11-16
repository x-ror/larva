// Primordials — pristine references to the JS intrinsics the internal modules
// rely on, captured once at startup *before any user code runs* (the loader
// eager-requires this module first; see loader.js). Internal modules consume it
// via `require('internal/primordials')` so their behavior cannot be altered by a script
// that mutates a shared prototype (Array.prototype.push = …) or replaces a global
// (globalThis.Object = …). Mirrors Node's lib/internal/primordials in spirit:
// captured statics plus prototype methods callable as fn(thisArg, ...args).
//
// JSC COST MODEL (why this is not Node's uncurryThis). Node builds its
// uncurried methods with `bind.bind(call)`, which V8 inlines through the bound
// wrapper for free. JSC does NOT inline through a JSBoundFunction — measured
// ~28x vs a direct call for `charCodeAt` in a hot loop — so the classic
// uncurryThis is a hot-path tax here. JSC composes `.call` well instead
// (~1.3–2x), so every wrapper below is a fixed-arity closure over the captured
// method that invokes it via `.call`. Variadic methods (push/unshift/splice/
// concat) use a small arguments switch (~7x, but they are never in a per-char
// loop). The tightest-arity path keeps `P.StringPrototypeCharCodeAt(s, i)` at
// ~2x, so internal modules can route through primordials without a separate
// capture-and-.call dance for the common case.
//
// THREAT MODEL / RESIDUAL. The captured method makes these wrappers immune to
// prototype-method pollution (Array.prototype.push = …) and global replacement
// (globalThis.Array = …) — the realistic axes. They invoke through `.call`,
// which reads Function.prototype.call dynamically, so a script that overrides
// `Function.prototype.call/apply` still reaches them. This file used to call that
// axis "exotic … self-defeating as an attack"; that was wrong twice over, and the
// `invoke` ratchet class made it measurable. Wrapping `Function.prototype.call` is
// something instrumentation, tracing and coverage libraries do on purpose, so the
// trigger need not be an attacker at all — and the outcome is not a uniform
// breakage but a SPLIT: TextDecoder/TextEncoder construction, Buffer.from,
// buf.toString, Buffer.concat and new URL throw where node succeeds, while
// URLSearchParams.get answers `null` and util.format answers `'undefined'` where
// node is right. A silent wrong answer from a URL parameter lookup is the sharp
// end of that. See the measured table above caller0 below; closed completely only
// by lockIntrinsics(), which is written, exported, called from nowhere, and
// tracked in ROADMAP.
// The accessor axis (a setter on a numeric-index property of Array/Object.proto)
// is not a method concern and is handled per-hot-array with null prototypes in
// the consuming modules.
(function (require, module) {
  'use strict';

  var FunctionProto = Function.prototype;
  var call = FunctionProto.call;
  var apply = FunctionProto.apply;
  var bind = FunctionProto.bind;

  var ObjectProto = Object.prototype;
  var ArrayProto = Array.prototype;
  var StringProto = String.prototype;

  // --- the `.call` residual, and where it is NOT acceptable ---------------
  //
  // Every wrapper below invokes through `fn.call(t, …)`, which READS
  // Function.prototype.call at call time. That property is writable, so a script
  // that replaces it reaches every primordial — the residual this file's header
  // has always documented, "closed only by lockIntrinsics(), applied opt-in".
  //
  // It is not theoretical. Poisoning ONLY Function.prototype.call — leaving the
  // byteOffset/byteLength descriptors untouched — reproduced a full Buffer-pool
  // disclosure through TextDecoder.decode(), because the captured view getters
  // were reached through `.call` like everything else.
  //
  // Reflect.apply is immune (a plain call, no `.call` read). Two costs, and only
  // the second one justifies anything — measured on this JSC, `bin/lava` vs a
  // build with caller0..3 rewritten to reflectApply:
  //
  //   wrapper alone   1.3 -> 33.7 ns/op (25x). A bound captured `call`
  //                   (reflectApply(bind, call, [fn])) is worse still, 47.0.
  //   end to end      new URL 1.76x · EventEmitter.emit 1.63x · decode(5B) 1.49x
  //                   · URLSearchParams.get 1.41x · toString('hex') 1.28x ·
  //                   TextDecoder ctor 1.21x · decode(1800B) 1.11x — and ~1.00x
  //                   for Buffer.from, TextEncoder.encode, util.format,
  //                   path.join, structuredClone.
  //
  // So the ratio tracks wrapper density, not the surface. Both of the worst rows
  // are genuinely hot, though not where an earlier version of this comment claimed:
  // the http.js SERVER path constructs no URL at all — checked, there is no
  // `new URL` in it — and the real consumers are fetch.js, which parses once per
  // request (fetch.js:581), plus three more per redirect (:810, and twice at :830).
  // EventEmitter.emit is on every request. That is the reason the hot wrappers keep
  // `.call`:
  //
  //   caller0..callerN  keep `.call`     — hot, per-element, per-character
  //   safeGetter        Reflect.apply    — security-critical reads whose RESULT
  //                                       selects a memory window
  //
  // The view accessors below are `safeGetter`: three calls per decode against a
  // ~1-4us decode, so the 33ns each is under 3% and buys immunity on the path
  // where a forged answer reads another request's bytes.
  //
  // What the residual actually costs today, since the `invoke` class is now
  // counted and therefore measurable: with `Function.prototype.call` replaced,
  // Lava diverges from Node on TextDecoder/TextEncoder construction, Buffer.from,
  // buf.toString, Buffer.concat and new URL (they throw where Node succeeds) and
  // — worse — answers WRONGLY on URLSearchParams.get (null) and util.format
  // ('undefined'). lockIntrinsics() closes all of it at zero per-call cost; it is
  // written, exported, and called from nowhere. Wiring it at bootstrap is the
  // complete answer and is tracked in ROADMAP with this table.
  var reflectApply = Reflect.apply;
  var NO_ARGS = Object.freeze([]);
  function safeGetter(fn) {
    return function (t) {
      return reflectApply(fn, t, NO_ARGS);
    };
  }

  // The one-argument sibling, for a COLD call site whose answer is a security
  // decision. Allocates an args array per call, which is why it is not the default
  // — see the measured table above — and why nothing per-character uses it.
  function safeCaller1(fn) {
    return function (t, a) {
      return reflectApply(fn, t, [a]);
    };
  }

  // Captured ONCE. Both the raw and the predicate export below close over this, so
  // there is exactly one wrapper object rather than a fresh closure per call.
  var regExpExec = safeCaller1(RegExp.prototype.exec);
  var stringCharCodeAt = caller1(StringProto.charCodeAt);
  // Locals rather than reads off the export table: a bare identifier beats a property
  // read on a per-call path, and a local cannot be re-pointed after the table is frozen.
  // (Both are also exported below under their canonical names; these are the same
  // captured methods, not second captures of a different object.)
  var StringPrototypeSliceP = caller2(StringProto.slice);
  var StringPrototypeIndexOfP = caller2(StringProto.indexOf);

  // Free globals captured at primordials module-eval — the loader runs this before
  // user code. A lazy consumer that writes `var parseIntG = parseInt` at ITS own
  // factory time is not the same: http.js is not eager, so a dependency that
  // poisons `globalThis.parseInt` before `require('node:http')` binds the gadget
  // into Content-Length / chunk-size conversion and frames the body as whatever
  // the gadget returns. url.js is eager and happened to be safe; http.js was not.
  // Capture here once; every consumer reads the pristine binding.
  var parseIntG = parseInt;
  var NumberG = Number;
  // Static predicates on Number are also writable data properties of the Number
  // constructor. Capturing the functions (not the receiver) is enough: they do not
  // re-read off Number at call time. Same reason parseInt is captured above.
  var numberIsInteger = Number.isInteger;
  var numberIsSafeInteger = Number.isSafeInteger;

  // brandedAs is the UNFORGEABLE replacement for `value instanceof Ctor` on a
  // hardening path. `instanceof` dispatches through `Ctor[Symbol.hasInstance]`, a
  // configurable own property of the constructor, so a caller can flip the answer
  // in EITHER direction and misroute a value into the wrong arm. That is not
  // hypothetical in this tree: forging `DataView[Symbol.hasInstance]` made
  // structuredClone throw on a genuine DataView, and made TextDecoder.decode()
  // return "" — a silent empty decode — for valid input node decodes fine.
  //
  // A prototype-chain walk cannot be redirected the same way: the chain of an
  // already-constructed object is fixed, and ReflectGetPrototypeOf is captured, so
  // a poisoned `__proto__` accessor does not steer it. It is a CHAIN walk, not one
  // comparison, so subclasses still match — `Buffer extends Uint8Array` and
  // `class MyView extends DataView` both brand correctly.
  //
  // It is a prototype test, not a slot test: `Object.create(Uint8Array.prototype)`
  // passes and has no backing store. So did `instanceof`, and the natives reject a
  // slotless receiver either way — this is strictly stronger than what it replaces,
  // not a complete brand. Where a true slot test is needed, call a captured getter
  // and let it throw.
  var reflectGetPrototypeOf = Reflect.getPrototypeOf;
  function brandedAs(value, prototype) {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
    var proto = reflectGetPrototypeOf(value);
    while (proto !== null) {
      if (proto === prototype) return true;
      proto = reflectGetPrototypeOf(proto);
    }
    return false;
  }

  // Fixed-arity `.call` wrappers — the fast path on JSC. `fn` is the captured
  // pristine method; the closure forwards a known number of positional args.
  function caller0(fn) {
    return function (t) {
      return fn.call(t);
    };
  }
  function caller1(fn) {
    return function (t, a) {
      return fn.call(t, a);
    };
  }
  function caller2(fn) {
    return function (t, a, b) {
      return fn.call(t, a, b);
    };
  }
  function caller3(fn) {
    return function (t, a, b, c) {
      return fn.call(t, a, b, c);
    };
  }
  // Variadic fallback for genuinely variadic methods. The arguments switch costs
  // more than a fixed-arity closure on JSC, but push/unshift/splice/concat are
  // never in a per-character loop, so it does not matter in practice.
  function callerN(fn) {
    return function (t) {
      switch (arguments.length) {
        case 1:
          return fn.call(t);
        case 2:
          return fn.call(t, arguments[1]);
        case 3:
          return fn.call(t, arguments[1], arguments[2]);
        case 4:
          return fn.call(t, arguments[1], arguments[2], arguments[3]);
        default: {
          // >3 args: hand off to the captured apply with a copied args tail.
          var n = arguments.length - 1;
          var rest = [];
          for (var i = 0; i < n; i++) rest[i] = arguments[i + 1];
          return apply.call(fn, t, rest);
        }
      }
    };
  }

  // uncurryThis keeps its name and variadic contract for any external caller and
  // for parity with Node's export, but is now `.call`-based (not bind.bind(call)).
  var uncurryThis = callerN;

  // lockIntrinsics pins Function.prototype.call/apply/bind so the wrappers'
  // `.call` route cannot be poisoned. Opt-in: the runtime applies it only under
  // the frozen-intrinsics flag (npm packages that legitimately reassign these
  // are vanishingly rare but not proven absent). Idempotent; safe to call once
  // at bootstrap, before user code. Locking keeps the methods callable — it only
  // forbids reassignment.
  function lockIntrinsics() {
    var def = Object.defineProperty;
    var lock = function (obj, name, value) {
      try {
        def(obj, name, { value: value, writable: false, configurable: false });
      } catch (e) {
        /* already locked / non-configurable — leave as is */
      }
    };
    lock(FunctionProto, 'call', call);
    lock(FunctionProto, 'apply', apply);
    lock(FunctionProto, 'bind', bind);
  }

  module.exports = {
    uncurryThis: uncurryThis,
    lockIntrinsics: lockIntrinsics,
    brandedAs: brandedAs,

    // --- Constructors / namespaces (captured so a replaced global is ignored) ---
    Object: Object,
    Array: Array,
    Promise: Promise,
    Map: Map,
    Set: Set,
    WeakMap: WeakMap,
    Symbol: Symbol,
    // The METHOD, not just the object. Capturing `Symbol` alone is not enough: `.for` is a
    // writable property on it, so a lazily-evaluated module reading `P.Symbol.for` at its
    // own module-eval still reads whatever user code left there.
    SymbolFor: Symbol.for,
    Reflect: Reflect,
    JSON: JSON,
    Math: Math,
    Number: Number,
    RegExp: RegExp,
    // The String CONSTRUCTOR, for `String(x)` coercion — a replaceable global like
    // any other, and a load-bearing one where the coerced value is then emitted:
    // esm.js builds every string literal in its generated CommonJS as
    // JSONStringify(String(v)), so a replaced String reaches the emitted source.
    String: String,
    Error: Error,
    TypeError: TypeError,
    RangeError: RangeError,
    Uint8Array: Uint8Array,
    Uint16Array: Uint16Array,
    ArrayBuffer: ArrayBuffer,

    // --- Object statics ---
    ObjectCreate: Object.create,
    ObjectKeys: Object.keys,
    ObjectValues: Object.values,
    ObjectEntries: Object.entries,
    ObjectAssign: Object.assign,
    ObjectFreeze: Object.freeze,
    ObjectIs: Object.is,
    ObjectDefineProperty: Object.defineProperty,
    ObjectDefineProperties: Object.defineProperties,
    ObjectGetPrototypeOf: Object.getPrototypeOf,
    ObjectSetPrototypeOf: Object.setPrototypeOf,
    ObjectGetOwnPropertyNames: Object.getOwnPropertyNames,
    ObjectGetOwnPropertyDescriptor: Object.getOwnPropertyDescriptor,
    ObjectGetOwnPropertyDescriptors: Object.getOwnPropertyDescriptors,
    ObjectGetOwnPropertySymbols: Object.getOwnPropertySymbols,
    // The static, not a wrapper: a direct call with no `.call` read, so it costs a per-key
    // loop nothing. ObjectPrototypeHasOwnProperty (caller1) measured +5% on a 20-key
    // querystring.parse (14.3 -> 15.0 us, medians of 7 interleaved launches, bin/lava darwin).
    ObjectHasOwn: Object.hasOwn,

    // --- Array / Reflect / JSON / Math / Number statics ---
    ArrayIsArray: Array.isArray,
    ArrayFrom: Array.from,
    ArrayOf: Array.of,
    ArrayBufferIsView: ArrayBuffer.isView,
    ReflectApply: Reflect.apply,
    ReflectOwnKeys: Reflect.ownKeys,
    ReflectGetPrototypeOf: Reflect.getPrototypeOf,
    JSONStringify: JSON.stringify,
    JSONParse: JSON.parse,
    MathTrunc: Math.trunc,
    MathMax: Math.max,
    MathMin: Math.min,
    MathFloor: Math.floor,
    NumberIsInteger: Number.isInteger,
    NumberIsFinite: Number.isFinite,
    NumberIsNaN: Number.isNaN,

    // --- Object.prototype.* (call as fn(obj, ...)) ---
    ObjectPrototypeHasOwnProperty: caller1(ObjectProto.hasOwnProperty),
    ObjectPrototypePropertyIsEnumerable: caller1(ObjectProto.propertyIsEnumerable),
    // safeGetter (Reflect.apply, immune to a forged Function.prototype.call), for a caller
    // whose tag SELECTS something — a constructor, a memory window. No consumer today:
    // structured_clone, the one it was written for, now brands by prototype identity
    // (TypedArrayPrototypes below) and no longer reads the tag at all.
    ObjectPrototypeToString: safeGetter(ObjectProto.toString),
    // caller0, for a hot per-call predicate where a forged tag can only answer the predicate
    // wrongly (util/types.js). Measured isDate+isUint8Array pair, medians of 7 interleaved
    // launches, 5e6 iterations, bin/lava darwin: 516 ns with the pre-#426 live `toString.call`,
    // 666 via safeGetter, 573 via caller0. +10% accepted as the cost of dropping the
    // lazy-time `Object` read. A dedicated non-shared wrapper measured the same (572).
    ObjectPrototypeToStringFast: caller0(ObjectProto.toString),

    // --- Function.prototype.* ---
    FunctionPrototypeApply: caller2(apply),
    FunctionPrototypeCall: callerN(call),
    FunctionPrototypeBind: callerN(bind),

    // --- Array.prototype.* (ArrayPrototypePush(arr, x)) ---
    ArrayPrototypePush: callerN(ArrayProto.push),
    // Fixed-arity push. callerN's arguments switch is ~7x a direct call, which is
    // fine for the cold call sites it was written for but not in a per-element
    // codec loop: routing encoding.js's decoders through callerN cost 1.43x on
    // the JS decode path (median of 16 paired launches). These two are the same
    // captured method on the same `.call` route — identical immunity, ~1.02-1.04x.
    ArrayPrototypePush1: caller1(ArrayProto.push),
    ArrayPrototypePush2: caller2(ArrayProto.push),
    ArrayPrototypePop: caller0(ArrayProto.pop),
    ArrayPrototypeShift: caller0(ArrayProto.shift),
    ArrayPrototypeUnshift: callerN(ArrayProto.unshift),
    ArrayPrototypeSlice: caller2(ArrayProto.slice),
    ArrayPrototypeSplice: callerN(ArrayProto.splice),
    ArrayPrototypeIndexOf: caller2(ArrayProto.indexOf),
    ArrayPrototypeIncludes: caller2(ArrayProto.includes),
    ArrayPrototypeForEach: caller2(ArrayProto.forEach),
    ArrayPrototypeMap: caller2(ArrayProto.map),
    ArrayPrototypeFilter: caller2(ArrayProto.filter),
    ArrayPrototypeJoin: caller1(ArrayProto.join),
    ArrayPrototypeConcat: callerN(ArrayProto.concat),
    ArrayPrototypeReverse: caller0(ArrayProto.reverse),
    ArrayPrototypeSort: caller1(ArrayProto.sort),

    // --- String.prototype.* (StringPrototypeSlice(str, ...)) ---
    StringPrototypeSlice: caller2(StringProto.slice),
    StringPrototypeIndexOf: caller2(StringProto.indexOf),
    StringPrototypeCharCodeAt: caller1(StringProto.charCodeAt),
    StringPrototypeCharAt: caller1(StringProto.charAt),
    StringPrototypeCodePointAt: caller1(StringProto.codePointAt),
    StringPrototypeReplace: caller2(StringProto.replace),
    StringPrototypeReplaceAll: caller2(StringProto.replaceAll),
    StringPrototypeSplit: caller2(StringProto.split),
    StringPrototypeToLowerCase: caller0(StringProto.toLowerCase),
    StringPrototypeToUpperCase: caller0(StringProto.toUpperCase),
    StringPrototypeTrim: caller0(StringProto.trim),
    StringPrototypeStartsWith: caller2(StringProto.startsWith),
    StringPrototypeEndsWith: caller2(StringProto.endsWith),
    StringPrototypeNormalize: caller1(StringProto.normalize),
    StringPrototypeSubstr: caller2(StringProto.substr),
    StringPrototypePadStart: caller2(StringProto.padStart),

    Uint8ArrayPrototypeSet: caller2(Uint8Array.prototype.set),
    // %TypedArray%.prototype.subarray — shared by every view type, so reading it
    // off Uint8Array captures the same function Uint16Array uses. Zero-copy, which
    // is why encoding.js's chunked fromCharCode wants it rather than a slice.
    TypedArrayPrototypeSubarray: caller2(Uint8Array.prototype.subarray),
    // %TypedArray%.prototype's `buffer` accessor. `view.buffer` resolves through
    // this CONFIGURABLE prototype getter — the one pollution axis a null
    // prototype cannot close on a typed array — so a hardened module reading
    // .buffer on an internal view must call the capture instead: a poisoned
    // getter substitutes an attacker's ArrayBuffer as the backing store. Node's
    // primordials export the same getter (TypedArrayPrototypeGetBuffer).
    TypedArrayPrototypeGetBuffer: safeGetter(
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'buffer').get,
    ),
    // The other two view accessors, for the same reason. Poisoning these does
    // not widen a view — every native re-derives the real length from the
    // engine's internal slots — but it does move the WINDOW a JS-side reader
    // computes, which is how a poisoned pair turned TextDecoder.decode() into a
    // read across the whole shared Buffer pool. Captured so a hardened module
    // can compute its window from the real slots.
    TypedArrayPrototypeGetByteOffset: safeGetter(
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteOffset')
        .get,
    ),
    TypedArrayPrototypeGetByteLength: safeGetter(
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength')
        .get,
    ),

    // The BRAND, taken from the prototype rather than from Symbol.toStringTag.
    // structured_clone used to key its constructor table off
    // Object.prototype.toString, which CONSULTS Symbol.toStringTag — a
    // configurable accessor — so `Object.defineProperty(v, Symbol.toStringTag,
    // …)` or a subclass getter forged the brand and made a legitimate clone
    // throw. A prototype identity cannot be forged by assignment.
    TypedArrayPrototypes: Object.freeze([
      [Uint8Array.prototype, Uint8Array],
      [Uint8ClampedArray.prototype, Uint8ClampedArray],
      [Int8Array.prototype, Int8Array],
      [Uint16Array.prototype, Uint16Array],
      [Int16Array.prototype, Int16Array],
      [Uint32Array.prototype, Uint32Array],
      [Int32Array.prototype, Int32Array],
      [Float32Array.prototype, Float32Array],
      [Float64Array.prototype, Float64Array],
      [BigInt64Array.prototype, BigInt64Array],
      [BigUint64Array.prototype, BigUint64Array],
      // Float16Array is Node 24+/JSC-version dependent. Omitting it made
      // structuredClone THROW on a type Node clones, so it is included
      // conditionally rather than assumed present.
      ...(typeof Float16Array === 'function' ? [[Float16Array.prototype, Float16Array]] : []),
    ]),

    // %TypedArray%.prototype.length — configurable like the rest. Excluded from
    // the ratchet's ACCESSOR list because a poisoned length cannot WIDEN a view
    // (natives re-derive), but it does decide the range a JS-side reader asks
    // for: poisoned to 0 it made every Buffer#toString return "".
    TypedArrayPrototypeGetLength: safeGetter(
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'length').get,
    ),

    // DataView's three accessors are SEPARATE properties from %TypedArray%'s and
    // equally configurable. encoding.js re-wraps a non-Uint8Array view as a
    // Uint8Array over the same range, so a forged answer here selects a window
    // out of the shared Buffer pool — reproduced through a DataView input.
    // The prototype itself, for a brand check that does not depend on `instanceof`
    // (forgeable through Symbol.hasInstance) or on a try/catch around a getter. Captured
    // here rather than in the consumer because stream.js is a LAZY module — see #333.
    DataViewPrototype: DataView.prototype,
    DataViewPrototypeGetBuffer: safeGetter(
      Object.getOwnPropertyDescriptor(DataView.prototype, 'buffer').get,
    ),
    DataViewPrototypeGetByteOffset: safeGetter(
      Object.getOwnPropertyDescriptor(DataView.prototype, 'byteOffset').get,
    ),
    DataViewPrototypeGetByteLength: safeGetter(
      Object.getOwnPropertyDescriptor(DataView.prototype, 'byteLength').get,
    ),
    // As much brand checks as lengths: each getter throws on any receiver that is not
    // a real buffer of its kind, which a Symbol.toStringTag look-alike cannot fake.
    // SharedArrayBuffer is absent from some JSC builds, hence the undefined arm.
    // Note it still reads the receiver's `constructor` / Symbol.species, per spec — the
    // method is pristine, not the species lookup. Node's own primordial does the same.
    ArrayBufferPrototypeSlice: caller2(ArrayBuffer.prototype.slice),
    ArrayBufferPrototypeGetByteLength: safeGetter(
      Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get,
    ),
    SharedArrayBufferPrototypeGetByteLength:
      typeof SharedArrayBuffer === 'function'
        ? safeGetter(Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength').get)
        : undefined,

    // RegExp.prototype.exec is a writable DATA property — an ordinary assignment
    // replaces it, no defineProperty needed. Every framing validator in http.js and
    // the header-name validator in fetch.js runs a regex over attacker-controlled
    // bytes, so this is the pollution axis with the shortest path to the wire.
    // Measured against the real server over a socket: with `RegExp.prototype.exec`
    // replaced, `Content-Length: abc` answered 200 OK instead of 400 and
    // `Transfer-Encoding: gzip` was accepted as chunked — request smuggling, with
    // the other 18 malformed-input checks still passing. Pinned by the
    // malformed-poisoned phases of run-http-smoke.sh.
    //
    // THERE IS DELIBERATELY NO `RegExpPrototypeTest`. It cannot be made sound: the
    // spec's RegExpExec abstract operation re-reads `R.exec` off the RECEIVER
    // before falling back to the builtin, so replacing `RegExp.prototype.exec`
    // steers `test` even when `test` itself was captured pristine at module-eval
    // and invoked through Reflect.apply. Verified identically on node 26.13.0 and
    // bin/lava. Exporting a `Test` that looks safe and is not would be worse than
    // exporting nothing. The predicate form below, `RegExpMatches(re, s)`, is the
    // spelling a validator should use; `RegExpPrototypeExec` stays exported for a
    // caller that needs the match OBJECT rather than a yes/no.
    //
    // Reflect.apply rather than `.call`, unlike the hot wrappers above, and for a
    // security reason rather than a cost one: a validator immune to a poisoned
    // `exec` but not to a poisoned `Function.prototype.call` has simply moved the
    // vector one property along.
    //
    // The cost is NOT invisible, which this comment used to claim without a number
    // and four independent reviews called out. Measured on JSC, min of 7 pinned
    // launches, N=2e6, rotating input pool: `.test` 18.9 ns/op, `exec !== null`
    // through `.call` 51.5, through Reflect.apply 81.2 — so the wrapper alone is
    // ~1.5x the entire original match, and the migration ~4x it. What justifies it
    // is the count, not the unit: 1-2 of these per request against a ~17 us request
    // is under 0.6%, and two interleaved HTTP A/Bs plus a mem/conn A/B came back
    // neutral-to-positive. Where the count is NOT small — 4-7 per `new URL` — the
    // right answer was to leave RegExp behind entirely; see `allChars` below
    // (call sites in url.js / http.js).
    RegExpPrototypeExec: regExpExec,

    // Bootstrap-captured free globals. See the capture block above the export table.
    parseInt: parseIntG,
    Number: NumberG,
    NumberIsInteger: numberIsInteger,
    NumberIsSafeInteger: numberIsSafeInteger,

    // allChars(s, pred) is `/^[class]+$/` without a RegExp — true when s is non-empty
    // and every code unit satisfies `pred`. It lives here for the reason RegExpMatches
    // does, and because the alternative already happened: the commit that centralised
    // RegExpMatches wrote `allDigits` privately into url.js AND http.js in the same
    // change, and the two had diverged by the time they landed (one grew a radix-8 arm,
    // the other inlined the hex test url.js had already factored out).
    //
    // A predicate, not a radix enum. The private copies branched on an integer PER
    // CHARACTER and silently treated an unknown radix as decimal; `allChars(s, pred)`
    // mirrors the shape of `stripChars(s, pred)` its callers already use.
    //
    // Empty is FALSE, matching the `+` in the patterns it replaces.
    allChars: function (s, pred) {
      var n = s.length;
      if (n === 0) return false;
      for (var i = 0; i < n; i++) {
        if (!pred(stringCharCodeAt(s, i))) return false;
      }
      return true;
    },

    // replaceCharAll(s, code, repl) is `s.replace(/<c>/g, repl)` without a RegExp —
    // every occurrence of the single code unit `code` becomes the string `repl`.
    //
    // It exists because a GLOBAL-flag replace is the shape that does not answer wrongly
    // under a forged `exec`, it never RETURNS: `RegExp.prototype[Symbol.replace]` loops
    // on RegExpExec and only advances `lastIndex` on an EMPTY match, so a forged
    // non-empty result spins until the string exhausts memory (observed as either a hang
    // or a RangeError, depending on how fast the runner hits the cap). Capturing the
    // replace does nothing, because the re-read of `R.exec` is inside it — so the fix is
    // to have no regex in the expression at all, which drops exec / test / @@replace /
    // lastIndex together. Same reasoning as `allChars` above, and the same reason there
    // is deliberately no `RegExpPrototypeTest`.
    //
    // `needle` is a ONE-CHARACTER string, not a code unit, so the scan can be the
    // engine's native `indexOf` rather than a per-character JS loop. That is not a
    // style choice — the first version of this helper walked every code unit through
    // the `caller1` wrapper and was measured at **187x** the old regex on a 100 KB
    // no-match input (144 194 ns vs 769), 41.8% of a `querystring.parse` profile where
    // the native `replace` had been 2.6%. `StringPrototypeIndexOf` with a string needle
    // reads no `@@match`/`@@replace` and never enters RegExpExec, so it keeps every
    // availability property this helper exists for while being faster than BOTH the
    // regex it replaces and the loop that replaced it.
    //
    // `repl` is appended LITERALLY: unlike `String.prototype.replace`, `$&`, `$$`,
    // `` $` `` and `$'` are not substituted. That is the behavior wanted here, and it
    // is stated because this is a frozen-table export the next reader will reuse from
    // the comment alone.
    //
    // Returns `s` itself when the needle is absent — one native scan, no allocation —
    // so callers do not need their own `indexOf` guard in front of it.
    replaceCharAll: function (s, needle, repl) {
      var at = StringPrototypeIndexOfP(s, needle, 0);
      if (at === -1) return s;
      var out = '';
      var from = 0;
      var n = s.length;
      while (at !== -1) {
        if (at > from) out += StringPrototypeSliceP(s, from, at);
        out += repl;
        from = at + 1;
        at = StringPrototypeIndexOfP(s, needle, from);
      }
      return from < n ? out + StringPrototypeSliceP(s, from) : out;
    },

    // The character classes those validators actually need, so a caller cannot get
    // the boundaries subtly wrong in its own copy.
    isAsciiDigit: function (c) {
      return c >= 0x30 && c <= 0x39;
    },
    isAsciiHexDigit: function (c) {
      return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
    },
    isAsciiOctalDigit: function (c) {
      return c >= 0x30 && c <= 0x37;
    },

    // RegExpMatches is the PREDICATE form, and the only spelling a validator should
    // use. It lives here rather than in each consumer because three modules each
    // rewrote it privately during the migration — http.js and url.js as byte-identical
    // closures, fetch.js inline and INVERTED — which is three chances to get the
    // negation backwards on the surface where backwards means header injection.
    // There is deliberately no RegExpPrototypeTest to pair with it: see above.
    RegExpMatches: function (re, s) {
      return regExpExec(re, s) !== null;
    },

    // Constructors for the view types structured_clone rebuilds. It used to
    // reach them through `value.constructor`, which is a configurable
    // prototype-chain read: poisoning `Uint8Array.prototype.constructor` made
    // `structuredClone(view)` invoke attacker code with the internals' freshly
    // cloned ArrayBuffer, and hand back an arbitrary object as the clone.
    TypedArrayConstructors: Object.freeze({
      __proto__: null,
      '[object Uint8Array]': Uint8Array,
      '[object Uint8ClampedArray]': Uint8ClampedArray,
      '[object Int8Array]': Int8Array,
      '[object Uint16Array]': Uint16Array,
      '[object Int16Array]': Int16Array,
      '[object Uint32Array]': Uint32Array,
      '[object Int32Array]': Int32Array,
      '[object Float32Array]': Float32Array,
      '[object Float64Array]': Float64Array,
      '[object BigInt64Array]': BigInt64Array,
      '[object BigUint64Array]': BigUint64Array,
    }),
  };

  // Freeze the table so a consumer (or a leak) cannot mutate the shared set.
  Object.freeze(module.exports);
});
