// Fixture table for the pollution ratchet's detector — see
// scripts/lib/primordials-detect.mjs. Kept in its own module so ONE table
// serves two consumers: the fail-closed gate inside the ratchet itself (a
// detector that has gone blind must not report on the tree, nor rebaseline),
// and scripts/check-primordials.test.mjs, which runs the same fixtures under
// node:test for named subtests and a real diff on failure.
//
// A fixture FILE under pkg/runtime/js would be counted as production source,
// which is why these are inline strings rather than files on disk.

import { KINDS, countSource } from './primordials-detect.mjs';

// --- self-test -------------------------------------------------------------
//
// The ratchet is a security control, and a blind one is worse than none: it
// reports "OK" and a reviewer stops looking. So the detector proves itself on
// every run against fixtures with EXACT per-class expectations, and refuses to
// report on the tree if any of them regresses.
//
// Exact counts, not "includes": an `includes` assertion passes while the
// detector also over-fires, which is how a `length`-in-ACCESSOR regression and a
// double-count both slipped past the previous harness.
//
// Fixtures are inline strings on purpose: a fixture FILE under the scanned
// directory would be counted as production source.
const E = (o = {}) => ({ method: 0, invoke: 0, accessor: 0, global: 0, ...o });
const WRAP = (body) => `(function (require, module) {\n${body}\n})`;
const STRICT = (body) => WRAP(`'use strict';\n${body}`);

const SELF_TEST = [
  // --- the four classes, each in its plainest form ---
  { name: 'method call', src: 'arr.push(x);', expect: E({ method: 1 }) },
  { name: 'accessor read', src: 'var b = view.buffer;', expect: E({ accessor: 1 }) },
  { name: 'two accessor reads', src: 'f(v.byteOffset, v.byteLength);', expect: E({ accessor: 2 }) },
  { name: 'dynamic .call', src: 'fn.call(thisArg, a);', expect: E({ invoke: 1 }) },
  { name: 'dynamic .apply', src: 'fn.apply(thisArg, args);', expect: E({ invoke: 1 }) },
  {
    name: 'live global call',
    src: WRAP('function f() { return String(x); }'),
    expect: E({ global: 1 }),
  },
  {
    name: 'bare global read',
    src: WRAP('function f() { return String; }'),
    expect: E({ global: 1 }),
  },
  {
    name: 'qualified via globalThis',
    src: WRAP('function f() { return globalThis.String(x); }'),
    expect: E({ global: 1 }),
  },

  // --- the prototypes added after a reproduced exploit ---
  // A poisoned RegExp.prototype.test let a CRLF-bearing header name through
  // fetch.js's validator and onto the wire, and made http.js read
  // Content-Length as NaN (smuggling desync). Both are writable data properties.
  {
    name: 'RegExp test is pollutable',
    src: 'if (RE.test(name)) return;',
    expect: E({ method: 1 }),
  },
  { name: 'RegExp exec is pollutable', src: 'var m = RE.exec(s);', expect: E({ method: 1 }) },
  { name: 'Promise then is pollutable', src: 'p.then(f);', expect: E({ method: 1 }) },

  // --- read vs write vs callee: the structural distinctions a scanner got wrong ---
  // A write does not resolve a getter. This was 24% of the old accessor count.
  // `Stream` is not a counted global, so a correct detector reports NOTHING here
  // — the point is that `.constructor` on the left of `=` is a write.
  {
    name: 'assignment target is not a read',
    src: 'Stream.prototype.constructor = Stream;',
    expect: E(),
  },
  {
    name: 'accessor write via a global receiver',
    src: WRAP('function f(g) { Object.prototype.toString = g; }'),
    expect: E({ global: 1 }),
  },
  // `new v.constructor(…)` DOES reach the prototype chain — the old trailing-"("
  // rule skipped it and hid a reproduced structured_clone.js vector.
  {
    name: 'constructor as a callee is a read',
    src: 'var v = new value.constructor(buf, 0, n);',
    expect: E({ accessor: 1 }),
  },
  // A static call on a global constructor reads the constructor's own property.
  {
    name: 'static call on a global',
    src: WRAP('function f() { return Buffer.byteLength(s); }'),
    expect: E({ global: 1 }),
  },
  // `this.buffer` is the object's own field — every stream.js accessor hit.
  { name: 'own field via this', src: WRAP('function f() { return this.buffer; }'), expect: E() },

  // --- computed and destructured reads: the ratchet must not pay for a rename ---
  { name: 'computed accessor read', src: "var b = view['buffer'];", expect: E({ accessor: 1 }) },
  { name: 'computed method call', src: "arr['push'](x);", expect: E({ method: 1 }) },
  { name: 'destructured accessor read', src: 'var { buffer } = view;', expect: E({ accessor: 1 }) },
  // A fully dynamic key is not in the source — documented as not covered.
  { name: 'fully dynamic key is not counted', src: 'var b = view[k];', expect: E() },

  // --- the capture exemption, which is only sound at module-eval ---
  { name: 'capture at module level', src: WRAP('  var BufferFrom = Buffer.from;'), expect: E() },
  {
    name: 'capture inside a function body',
    src: WRAP(
      '  function d(x) {\n    const BufferFrom = Buffer.from;\n    return BufferFrom(x);\n  }',
    ),
    expect: E({ global: 1 }),
  },
  // The arrow form. Pinned because the regex scanner this replaced decided
  // "is the enclosing thing a function?" from a 3-character lookback, and so
  // missed `=>` followed by a newline — re-opening the very blind spot the
  // lookback was written to close. The AST cannot regress that way; the fixture
  // stays because the *rule* (depth, not statement shape) is what it pins.
  // A class field holding a BARE global reference, not a call. The `Identifier`
  // visitor's shadow-check did `parent.params.includes(node)` unguarded, and
  // `PropertyDefinition` is in FUNCTION_TYPES (it is a call-time context for the
  // depth rule) but has no `.params` — so this threw
  // `Cannot read properties of undefined (reading 'includes')` and crashed the
  // whole scan on valid syntax. `shadowedByParam` had already been guarded for
  // exactly this; the twin check had not, and the existing fixtures only covered
  // the CALL form `x = String()`, whose parent is a CallExpression.
  // At function depth 2 it is a live read, so it counts.
  {
    name: 'class field holding a bare global reference',
    src: WRAP('  function f() { class C { x = String; } return C; }'),
    expect: E({ global: 1 }),
  },
  // The call form, kept beside it so the pair cannot drift apart again.
  {
    name: 'class field calling a global',
    src: WRAP('  function f() { class C { x = String(); } return C; }'),
    expect: E({ global: 1 }),
  },

  {
    name: 'capture inside an arrow body',
    src: WRAP(
      '  var d = (x) =>\n  {\n    const BufferFrom = Buffer.from;\n    return BufferFrom(x);\n  };',
    ),
    expect: E({ global: 1 }),
  },
  {
    // At module-eval the SHAPE does not matter — a capture and a use both read a
    // pristine binding, because the loader runs the module body before user
    // code. Inside a function both are live reads. That is why the detector
    // asks "when does this run", not "does this line look like a capture".
    name: 'use at module level is safe',
    src: WRAP('  var b = Buffer.from(x);'),
    expect: E(),
  },
  {
    name: 'the same use inside a function',
    src: WRAP('function f() { var b = Buffer.from(x); return b; }'),
    expect: E({ global: 1 }),
  },
  {
    name: 'export table is the capture',
    src: WRAP('  module.exports = { Object: Object, Array: Array };'),
    expect: E(),
  },

  // --- ...and only in a module the loader instantiates BEFORE user code ---
  // `lazy: true` scans the source as a module outside the eager set (see
  // lib/js-graph.mjs eagerModules): its factory runs on the user's first require,
  // after user code could have replaced `String`, so the capture IS the live read.
  // #333 shipped exactly this — `var StringG = String` at the top of net.js scored 0.
  // Every fixture without the flag is scanned as eager, which is what they pinned
  // before the distinction existed.
  {
    name: 'eager module: the same capture is pristine',
    src: WRAP('  var StringG = String;'),
    expect: E(),
  },
  {
    name: 'lazy module: module-eval capture is a live read',
    src: WRAP('  var StringG = String;'),
    lazy: true,
    expect: E({ global: 1 }),
  },
  {
    name: 'lazy module: module-eval globalThis capture is a live read',
    src: WRAP('  var StringG = globalThis.String;'),
    lazy: true,
    expect: E({ global: 1 }),
  },
  // The FIX in a lazy module is the loader's handle, which is not a global read:
  // the primordials table was captured before user code, and so was pristineBuffer.
  {
    name: 'lazy module: primordials and pristineBuffer are not global reads',
    src: WRAP(
      "  var P = require('internal/primordials');\n" +
        '  var { StringPrototypeTrim, String: S } = P;\n' +
        '  var BufferG = require.pristineBuffer.Buffer;',
    ),
    lazy: true,
    expect: E(),
  },

  // --- positions that are not reads at all ---
  { name: 'object key is not a read', src: 'var t = { __proto__: null, String: 1 };', expect: E() },
  {
    name: 'ternary reads both globals',
    src: WRAP('function f(c) { return c ? String : Number; }'),
    expect: E({ global: 2 }),
  },
  {
    name: 'case label is a read',
    src: WRAP('function f(x) { switch (x) { case String: return 1; } }'),
    expect: E({ global: 1 }),
  },
  {
    name: 'param shadows the global',
    src: WRAP('function f(String) { return String; }'),
    expect: E(),
  },
  { name: '__proto__ read', src: 'var p = obj.__proto__;', expect: E({ accessor: 1 }) },
  { name: 'primordial wrapper call', src: 'ArrayPrototypePush(arr, x);', expect: E() },
  { name: 'ReflectApply is the fix', src: 'ReflectApply(fn, null, args);', expect: E() },

  // --- forms that used to be a free way to lower a count -------------------
  // Each of these is the SAME read as its dotted sibling; counting one and not
  // the other is a ratchet that pays for a rename.
  { name: 'template-literal key', src: 'var b = view[`buffer`];', expect: E({ accessor: 1 }) },
  { name: 'method via template key', src: 'arr[`push`](x);', expect: E({ method: 1 }) },
  {
    name: 'string-literal pattern key',
    src: "var { 'buffer': b } = view;",
    expect: E({ accessor: 1 }),
  },
  {
    name: 'computed global read as a key',
    src: WRAP('function f(o) { return o[String]; }'),
    expect: E({ global: 1 }),
  },
  {
    name: 'named property is not a global read',
    src: WRAP('function f(o) { return o.String; }'),
    expect: E(),
  },

  // A class instance field runs at construction, i.e. after user code — so it is
  // NOT module-eval however high in the file it sits.
  {
    name: 'class field initializer is call-time',
    src: WRAP('  class C { x = String(); }'),
    expect: E({ global: 1 }),
  },
  {
    name: 'static block is class-definition time',
    src: WRAP('  class C { static { var s = String(); } }'),
    expect: E(),
  },

  // The marker must be the WHOLE comment; "primordials-okay" is not it.
  {
    name: 'marker typo does not suppress',
    src: 'q.push(x); // primordials-okay',
    expect: E({ method: 1 }),
  },
  {
    name: 'marker with trailing prose does not suppress',
    src: 'q.push(x); // primordials-ok because queue',
    expect: E({ method: 1 }),
  },
  {
    name: 'block comment does not suppress',
    src: 'q.push(x); /* primordials-ok */',
    expect: E({ method: 1 }),
  },

  // A PLAIN `=` is the only assignment form that does not resolve the getter:
  // spec order is PutValue with no preceding GetValue.
  // `Stream.prototype.constructor = Stream` was 24% of the old accessor count.
  { name: 'plain assignment target is not a read', src: 'o.constructor = X;', expect: E() },

  // Everything else in the assignment family READS FIRST — GetValue -> op ->
  // PutValue — so the getter runs and the site counts. The detector used to
  // exempt the whole family, which handed the ratchet a rename it would pay for:
  // `if (o.constructor === undefined) o.constructor = X` counted 1 accessor and
  // `o.constructor ??= X` counted 0, same live read, lower number, and lowering is
  // the always-allowed direction. Verified against a real accessor: each of the
  // forms below invokes the getter exactly once.
  {
    name: 'update expression reads the getter',
    src: 'v.byteLength++;',
    expect: E({ accessor: 1 }),
  },
  { name: 'prefix update reads the getter', src: '--v.byteOffset;', expect: E({ accessor: 1 }) },
  {
    name: 'compound assignment reads the getter',
    src: 'view.byteOffset += 1;',
    expect: E({ accessor: 1 }),
  },
  {
    name: 'logical assignment reads the getter',
    src: 'o.constructor ??= X;',
    expect: E({ accessor: 1 }),
  },
  { name: 'or-assignment reads the getter', src: 'o.__proto__ ||= P;', expect: E({ accessor: 1 }) },
  {
    name: 'computed logical assignment reads the getter too',
    src: "o['constructor'] ??= X;",
    expect: E({ accessor: 1 }),
  },
  // The `global` class reaches the same conclusion by the same route: a live
  // globalThis read is a read whether or not a write follows it. (An internal
  // module writing a global is separately barred by CLAUDE.md section 5; the
  // point here is only that the detector must not score it 0.)
  {
    name: 'logical assignment to a global is still a live read',
    src: WRAP('  function f() { globalThis.String ??= S; }'),
    expect: E({ global: 1 }),
  },

  // --- lexical contexts: inert text must stay inert, executable text must not ---
  { name: 'method in a comment', src: '// arr.push(x)', expect: E() },
  { name: 'method in a string', src: 'var s = "arr.push(x)";', expect: E() },
  {
    name: 'escaped quote keeps the string inert',
    src: 'var s = "a \\" arr.push(x) \\" b";',
    expect: E(),
  },
  { name: 'regex literal is inert', src: 'var re = /\\.push\\(|String/;', expect: E() },
  {
    name: 'division is not a regex',
    src: WRAP('function f() { var h = len / 2; return String(h); }'),
    expect: E({ global: 1 }),
  },
  // A template HOLE executes; the literal text around it does not.
  { name: 'method in a template hole', src: 'var s = `${arr.push(x)}`;', expect: E({ method: 1 }) },
  {
    name: 'global in a template hole',
    src: WRAP('function f() { return `${String(y)}`; }'),
    expect: E({ global: 1 }),
  },
  { name: 'template text is inert', src: 'var s = `arr.push(x) String(y)`;', expect: E() },
  // A brace inside a string inside a template hole. The replaced scanner tracked
  // template nesting by counting braces, so this desynchronised it and blanked
  // the REST OF THE FILE — url.js went from 80 counted sites to 0 and read as
  // clean. Worth a fixture even under a real parser: a blinded file scoring 0 is
  // the one failure mode this gate cannot survive.
  {
    name: 'brace in a hole string does not blind the rest',
    src: "var t = `${ o['}'] }`;\narr.push(x);",
    expect: E({ method: 1 }),
  },
  {
    name: 'regex after return does not blind the rest',
    src: WRAP('function f(s) { return /[\'"]/.test(s); }\nfunction g() { arr.push(x); }'),
    expect: E({ method: 2 }),
  },

  // --- line attribution, which suppression depends on ---
  {
    name: 'line survives a multiline template',
    src: 'var m = `${a}\n${b}`;\narr.push(x);',
    expectLine: 3,
    expect: E({ method: 1 }),
  },

  // --- suppression ---
  { name: 'single-class line is suppressed', src: 'q.push(x); // primordials-ok', expect: E() },
  {
    name: 'marker inside a string does not suppress',
    src: 'function f(){ q.push(x); var s = "// primordials-ok"; }',
    expect: E({ method: 1 }),
  },
  {
    name: 'mixed line is not blanket-suppressed',
    src: WRAP('function f() { q.push(x); String(y); } // primordials-ok'),
    expect: E({ method: 1, global: 1 }),
  },
  {
    name: 'mixed line, one class named',
    src: WRAP('function f() { q.push(x); String(y); } // primordials-ok: method'),
    expect: E({ global: 1 }),
  },
  {
    name: 'mixed line, both classes named',
    src: WRAP('function f() { q.push(x); String(y); } // primordials-ok: method, global'),
    expect: E(),
  },
  {
    name: 'unknown class name suppresses nothing',
    src: 'q.push(x); // primordials-ok: methods',
    expect: E({ method: 1 }),
  },

  // --- marker with a reason: ` — ` (an em dash) and nothing else ---
  {
    name: 'named marker with a reason suppresses',
    src: 'fn.call(t, a); // primordials-ok: invoke — receiver is our own closure',
    expect: E(),
  },
  {
    name: 'bare marker with a reason suppresses',
    src: 'q.push(x); // primordials-ok — q is a Fifo, not an Array',
    expect: E(),
  },
  {
    name: 'typo class with a reason still suppresses nothing',
    src: 'fn.call(t, a); // primordials-ok: invok — receiver is our own closure',
    expect: E({ invoke: 1 }),
  },
  {
    name: 'a separator other than the em dash suppresses nothing',
    src: 'fn.call(t, a); // primordials-ok: invoke -- receiver is our own closure',
    expect: E({ invoke: 1 }),
  },
  {
    name: 'an empty reason suppresses nothing',
    src: 'fn.call(t, a); // primordials-ok: invoke —',
    expect: E({ invoke: 1 }),
  },

  // --- invoke: the captured-callee exemption (see capturedCallees) ---
  // The one shape that is exempt: a strict, file-private function declaration
  // that never escapes, so no user code can hold it to give it an own `call`.
  {
    name: 'private function declaration: .call/.apply/.bind exempt',
    src: STRICT(
      'function g(a) { return a; }\n' +
        'function f(t, x) { g.call(t, x); g.apply(t, [x]); return g.bind(t); }\n' +
        'f(1, 2);',
    ),
    expect: E(),
  },
  {
    name: 'parameter receiver is counted',
    src: STRICT('function f(cb, t) { return cb.call(t); }'),
    expect: E({ invoke: 1 }),
  },
  {
    name: 'reassigned declaration is counted',
    src: STRICT('function g() {}\ng = h;\nfunction f(t) { return g.call(t); }'),
    expect: E({ invoke: 1 }),
  },
  {
    name: 'local alias of a callback is counted',
    src: STRICT('function f(cb, t) { var g = cb; return g.call(t); }'),
    expect: E({ invoke: 1 }),
  },
  {
    name: 'shadowing parameter inside a function is counted',
    src: STRICT('function g() {}\nfunction f(g, t) { return g.call(t); }\nf(1, 2);'),
    expect: E({ invoke: 1 }),
  },
  {
    name: 'shadowing local inside a function is counted',
    src: STRICT('function g() {}\nfunction f(t) { var g = t.cb; return g.call(t); }\nf(1);'),
    expect: E({ invoke: 1 }),
  },
  // Rule 1 is "one binding", not a scope analysis: a second DECLARATION of the
  // name is counted even where it would resolve to another private function.
  // This is the only fixture binds === 1 alone pins — a parameter or local
  // shadow is also refused by the not-a-function-declaration check.
  {
    name: 'second declaration of the name is counted',
    src: STRICT('function g() {}\nfunction f(t) { function g() {} return g.call(t); }\nf(1);'),
    expect: E({ invoke: 1 }),
  },
  {
    name: 'exported declaration is counted',
    src: STRICT('function g() {}\nmodule.exports = g;\nfunction f(t) { return g.call(t); }'),
    expect: E({ invoke: 1 }),
  },
  {
    name: 'constructed declaration is counted (instance.constructor leaks it)',
    src: STRICT('function g() {}\nvar o = new g();\nfunction f(t) { return g.call(t); }'),
    expect: E({ invoke: 1 }),
  },
  {
    name: 'sloppy declaration is counted (callee.caller leaks it)',
    src: WRAP('function g() {}\nfunction f(t) { return g.call(t); }\nf(1);'),
    expect: E({ invoke: 1 }),
  },
  {
    name: 'declaration out of the reference scope is counted',
    src: STRICT('(function () { function g() {} g(); })();\nfunction f(t) { return g.call(t); }'),
    expect: E({ invoke: 1 }),
  },
  {
    name: 'direct eval disqualifies every declaration',
    src: STRICT('function g() {}\nfunction f(t, s) { eval(s); return g.call(t); }'),
    expect: E({ invoke: 1 }),
  },
  // NOT exempt, deliberately: a captured INTRINSIC. The #485 lock stops
  // `Function.prototype.call = x` but not `Function.prototype.apply.call = x`,
  // which defines an own `call` on the very object `apply` captured; Lava then
  // runs it where node invokes the listener (probed: an emit printed the
  // attacker's marker). Same for every raw intrinsic the primordials table
  // re-exports (`ReflectApply`, `ObjectKeys`, …).
  {
    name: 'captured intrinsic receiver is counted',
    src: STRICT(
      'var apply = Function.prototype.apply;\nfunction f(cb, t, a) { return apply.call(cb, t, a); }',
    ),
    expect: E({ invoke: 1 }),
  },
  {
    name: 'destructured primordial receiver is counted',
    src: STRICT(
      "var { ReflectApply } = require('internal/primordials');\n" +
        'var P = require("internal/primordials");\nvar push = P.ArrayPrototypePush;\n' +
        'function f(t, a) { ReflectApply.call(null, t, a); return push.call(t, a); }',
    ),
    expect: E({ invoke: 2 }),
  },
];

function selfTest() {
  const failures = [];
  for (const t of SELF_TEST) {
    let got;
    try {
      got = countSource(t.src, t.name, { eager: !t.lazy });
    } catch (err) {
      failures.push(`${t.name}: ${err.message}`);
      continue;
    }
    const actual = E();
    for (const h of got.hits) actual[h.kind]++;
    for (const kind of KINDS) {
      if (actual[kind] !== t.expect[kind]) {
        failures.push(
          `${t.name}: expected ${t.expect[kind]} ${kind}, got ${actual[kind]}` +
            ` (all: ${KINDS.map((k) => `${k} ${actual[k]}`).join(', ')})`,
        );
      }
    }
    if (t.expectLine !== undefined && got.hits.length > 0 && got.hits[0].line !== t.expectLine) {
      failures.push(`${t.name}: expected the hit on line ${t.expectLine}, got ${got.hits[0].line}`);
    }
  }
  return failures;
}

export { E, WRAP, SELF_TEST, selfTest };
