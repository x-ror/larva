// Prototype-pollution DETECTOR for the embedded runtime JS layer.
//
// The CLI that compares against the baseline is scripts/check-primordials.mjs;
// the fixtures that pin this detector are lib/primordials-fixtures.mjs.
//
// Internal modules under pkg/runtime/js run BEFORE and ALONGSIDE user code that
// can mutate shared prototypes (Array.prototype.push = …) or replace globals.
// A call like `arr.push(x)` or `s.charCodeAt(i)` resolves the method through the
// live (pollutable) prototype at call time, so a poisoned prototype silently
// corrupts a built-in. The fix is `require('primordials')` — captured, pristine
// methods invoked as `ArrayPrototypePush(arr, x)` (see primordials.js).
//
// FOUR classes are counted, each baselined separately (see KINDS):
//
//   method    `arr.push(x)`      — a pollutable prototype method, resolved live
//   invoke    `fn.call(t, a)`    — resolved through Function.prototype
//   accessor  `view.buffer`      — read through a configurable prototype getter
//   global    `String(x)`        — a replaceable global read live, not captured
//
// WHY AN AST. This was a regex scanner until it was measured. Three of the four
// classes are structural, not lexical, and the scanner got them wrong in both
// directions: 24% of its accessor hits were assignment TARGETS (a write counted
// as a read), every `global` hit in primordials.js was the capture table itself,
// every accessor hit in stream.js was the object's own `this.buffer` field — and
// `view['buffer']` was invisible, so rewriting `.buffer` to `['buffer']` LOWERED
// the count and the tool congratulated you for it. A ratchet that pays out for a
// rename is worse than none. It also could not see a brace inside a string
// inside a template hole, which desynchronised its shadowing and blanked the
// rest of the file — reporting a fully-blinded file as clean.
//
// acorn answers all of that exactly: parent links give callee-vs-read and
// write-vs-read, function nesting gives module-eval-vs-call-time with no
// heuristic, computed access with a literal key is just another property name,
// and `node.loc` gives line numbers that cannot drift. Reuse verdict (CLAUDE.md
// §2): acorn 8 + acorn-walk, MIT, pure JS with no transitive dependencies and no
// native binary, dev-only so `bin/lava` is unaffected, and `bun install` already
// runs in CI. `@oxlint/plugins` (then bundled by vite-plus) was the alternative — rejected
// because oxlint documents `jsPlugins` as alpha and not semver-bound, and the
// ratchet would have to map lint diagnostics back into per-class counts.
//
// This tool still does NOT resolve types, so it cannot tell `array.push` from
// `simpleQueue.push`. It is a RATCHET: it counts syntactic sites per file per
// class and fails when a file exceeds its recorded baseline for that class.
// Hardening a module lowers a count; the tool then prints the tighter baseline
// to commit. A genuine false positive (the receiver is a class instance, not a
// built-in) takes `// primordials-ok` on the same line — honoured only inside a
// real line comment, and only when every candidate on the line shares one
// class. On a mixed line, name it: `// primordials-ok: method`, or a
// comma-separated list. An unrecognized class name suppresses nothing, so a typo
// fails loud.
//
// Per-class baselines are what make "0" mean something: a file may be at 0
// globals because it captures them and still carry accessor reads, and mixing
// the two into one number would let a fixed site pay for a new one.
//
// NOT covered, and deliberately:
//   * a fully dynamic member read (`var k = 'buffer'; view[k]`) — the key is not
//     in the source. A literal key IS counted.
//   * an object literal indexed by a caller-supplied key needs `__proto__: null`
//     (CLAUDE.md §5, the "One vector is still on you" bullet). Deciding a literal
//     is a dynamic-key lookup table takes dataflow.
//   * the iterator and coercion protocols (`for…of`, spread, `Symbol.toPrimitive`)
//     — these read a well-known SYMBOL, not a named property, so there is no name
//     to count.
//   * `await` / `Promise.resolve` assimilation, which is a DIFFERENT gap and is
//     often described as the same one. `then` is an ordinary named property and
//     it IS in POLLUTABLE below, so `p.then(cb)` and `p['then'](cb)` each count 1
//     `method`. What is invisible is the IMPLICIT read: `await x` and
//     `Promise.resolve(x)` resolve `x.then` with no member expression in the
//     source, so there is no node to attribute. Only the implicit half is blind.
//     `Object.prototype.then` is also a plain data property reachable by an
//     ordinary merge gadget — no `defineProperty` needed — which makes it the
//     sharpest uncounted vector; recorded in ROADMAP rather than implied handled.
//
// Usage:
//   node scripts/check-primordials.mjs                  # check against baseline
//   node scripts/check-primordials.mjs --update         # lower the baseline
//   node scripts/check-primordials.mjs --update --allow-raise
//
// Exit 1 if any file exceeds its baseline, or if a count dropped (commit the
// tighter baseline), or if the detector's own self-test fails.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'acorn';
import * as walk from 'acorn-walk';

const ROOT = join(import.meta.dirname, '..', '..');
// The PARENT of internal/: console.js sits directly in pkg/runtime/js, is
// #load-embedded by globals.odin, and runs before user code exactly like the
// internal modules — it was outside the scan while the baseline's "console.js"
// entry described the 7-line internal re-export, so the report read as "console
// is hardened". check-orphan-js.mjs already walks this directory.
const JS_DIR = join(ROOT, 'pkg', 'runtime', 'js');
const BASELINE = join(ROOT, 'tests', 'node-compat', 'pollution-baseline.json');

// The detector classes, in report order. Each is counted and baselined
// SEPARATELY — see the note at the counting loop.
const KINDS = ['method', 'invoke', 'accessor', 'global'];

// Pollutable prototype methods. Array/String mutators plus the prototypes a
// poisoned method on which has a demonstrated consequence in this codebase:
//   RegExp  `test`/`exec` — writable DATA properties, no defineProperty needed.
//           A poisoned `test` makes fetch.js's VALID_HEADER_NAME accept a name
//           containing CRLF (header injection, reproduced on the wire) and makes
//           http.js read Content-Length as NaN (request smuggling desync).
//   Promise `then`/`catch` — every internal await and .then chain.
//   Function `bind`, TypedArray `subarray`, Object `toString`/`valueOf`/
//           `hasOwnProperty` — all writable, all with a primordial available.
// `.at` and `.normalize` carry the two worst known URL vectors (IPv4
// normalization bypass, host substitution).
const POLLUTABLE = new Set([
  // Array.prototype
  'push',
  'pop',
  'shift',
  'unshift',
  'splice',
  'slice',
  'concat',
  'join',
  'reverse',
  'sort',
  'map',
  'filter',
  'forEach',
  'reduce',
  'reduceRight',
  'indexOf',
  'lastIndexOf',
  'includes',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'some',
  'every',
  'flat',
  'flatMap',
  'fill',
  'copyWithin',
  'entries',
  'keys',
  'values',
  'at',
  // String.prototype
  'charCodeAt',
  'codePointAt',
  'charAt',
  'replace',
  'replaceAll',
  'split',
  'toLowerCase',
  'toUpperCase',
  'trim',
  'trimStart',
  'trimEnd',
  'startsWith',
  'endsWith',
  'padStart',
  'padEnd',
  'repeat',
  'normalize',
  'localeCompare',
  'match',
  'matchAll',
  'search',
  'substr',
  'substring',
  // RegExp.prototype
  'test',
  'exec',
  // Promise.prototype
  'then',
  'catch',
  // Function.prototype / %TypedArray%.prototype / Object.prototype
  'bind',
  'subarray',
  'toString',
  'valueOf',
  'hasOwnProperty',
]);

// Dynamic invocation: resolved through Function.prototype at call time.
const INVOKE = new Set(['call', 'apply']);

// Prototype ACCESSORS worth counting. Deliberately a short list of names that
// are (a) reachable through a configurable prototype getter and (b) rare enough
// as ordinary property names that the false-positive rate stays low.
//
// `length` is NOT here, and that was traced rather than assumed: a poisoned
// %TypedArray%.prototype.length getter cannot widen a view, because every
// native re-derives the real byte length from the engine's internal slots
// (typed_array_view, pkg/runtime/typed_array.odin), so the outcome is
// truncation rather than an over-read. The disclosure axis is byteOffset and
// byteLength, which ARE counted. Counting `length` would fire on every
// `arr.length` and make the ratchet unusable, which is its own failure mode.
const ACCESSOR = new Set(['buffer', 'byteOffset', 'byteLength', 'constructor', '__proto__']);

// Globals a script can replace outright. Captured at module-eval, these are
// safe; read live inside a function body they are the `global` class.
const GLOBALS = new Set([
  'String',
  'Number',
  'Boolean',
  'Object',
  'Array',
  'Symbol',
  'Promise',
  'Reflect',
  'JSON',
  'Math',
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'Buffer',
  'ArrayBuffer',
  'SharedArrayBuffer',
  'DataView',
  'Uint8Array',
  'Uint16Array',
  'Uint32Array',
  'Int8Array',
  'Int16Array',
  'Int32Array',
  'Float32Array',
  'Float64Array',
  'BigInt',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'RegExp',
  'Date',
  'Proxy',
]);

// A class instance-field initialiser is not a Function node, but it RUNS at
// construction time — after user code has had every chance to replace a global.
// Counting it as module-eval let `class C { x = String(); }` score 0.
const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'PropertyDefinition',
]);

// The property name a member expression reads, or null when the key is not in
// the source. `view.buffer` and `view['buffer']` are the same read and both
// return 'buffer'; `view[k]` returns null (see the header's NOT-covered list).
function propName(node) {
  if (!node.computed) return node.property.type === 'Identifier' ? node.property.name : null;
  const key = node.property;
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
  // A template with no interpolation is a literal key wearing a different hat.
  // Leaving it out meant `view[`buffer`]` counted 0 while `view['buffer']` counted
  // 1 — a third spelling of the rename this detector exists to refuse to pay for.
  if (key.type === 'TemplateLiteral' && key.expressions.length === 0 && key.quasis.length === 1) {
    return key.quasis[0].value.cooked;
  }
  return null;
}

// How many function bodies enclose this node. The module wrapper every internal
// file is written inside counts as 1, so depth <= 1 is module-eval — code the
// loader runs before any user code — and anything deeper runs at call time.
function functionDepth(ancestors) {
  let n = 0;
  for (const a of ancestors) if (FUNCTION_TYPES.has(a.type)) n++;
  return n;
}

// A global read AT MODULE-EVAL is not a finding at all — the loader evaluates
// module bodies before any user code runs, so the binding it reads is still
// pristine. That is what makes a capture the fix, and it generalises: the shape
// of the statement does not matter, only when it runs. `var S = String;`,
// `module.exports = { Object: Object }` and even `var b = Buffer.from(x)` are all
// safe at depth <= 1, and all three are live reads at depth >= 2.
//
// This replaced a line-shaped "is it a capture?" regex, which had to guess and
// guessed wrong in both directions: it exempted a capture inside a function body
// (a call-time read) and counted primordials.js's own export table, where every
// module-level mention IS the capture.
function runsAtModuleEval(ancestors) {
  return functionDepth(ancestors) <= 1;
}

// Does an enclosing function bind this name as a parameter? `function f(String)`
// shadows the global, so the body's `String` is a local, not a live global read.
function shadowedByParam(name, ancestors) {
  for (const a of ancestors) {
    // FUNCTION_TYPES includes PropertyDefinition, which is a call-time context for
    // the depth rule but has no parameter list — hence the guard rather than a
    // narrower set, so the two uses cannot drift apart.
    if (!FUNCTION_TYPES.has(a.type) || !Array.isArray(a.params)) continue;
    for (const p of a.params) {
      if (p.type === 'Identifier' && p.name === name) return true;
    }
  }
  return false;
}

// countSource parses `src` and reports every pollutable site, per class, with the
// line each sits on. Throws when the source does not parse — a scanner that
// silently reports 0 sites on a file it failed to read is the failure mode this
// tool exists to prevent.
function countSource(src, label = '<fixture>') {
  const lineComments = new Map();
  let ast;
  try {
    ast = parse(src, {
      // 'latest', not a pinned year: a pinned version turns valid new syntax into
      // a hard parse failure, and this gate runs on every `make check-js`, so the
      // failure mode is "CI blocks on correct code with a confusing acorn error"
      // rather than anything safer. Nothing here is version-sensitive — the
      // visitors match node TYPES, which do not change for existing syntax. Note
      // that newer symbol-keyed protocols (`using` reads `Symbol.dispose`) join
      // the uncounted-by-construction list above rather than becoming countable.
      ecmaVersion: 'latest',
      sourceType: 'script',
      locations: true,
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      onComment: (isBlock, text, _s, _e, locStart) => {
        // Only a LINE comment carries a suppression marker, and only a real
        // comment does: the previous implementation matched the marker text
        // anywhere on the raw line, so `var s = "// primordials-ok";` silenced
        // the line.
        if (!isBlock) lineComments.set(locStart.line, text);
      },
    });
  } catch (err) {
    throw new Error(`${label}: parse failed at line ${err.loc?.line ?? '?'}: ${err.message}`);
  }

  const hits = [];
  const at = (node, kind, name) => hits.push({ line: node.loc.start.line, kind, name });

  walk.ancestor(ast, {
    MemberExpression(node, _state, ancestors) {
      const name = propName(node);
      if (name === null) return;
      const parent = ancestors[ancestors.length - 2];
      // ONLY a plain `=` skips the getter. The spec evaluates a simple assignment
      // as PutValue with no preceding GetValue, so `o.constructor = X` really does
      // not resolve the accessor — `Stream.prototype.constructor = Stream` was 24%
      // of the old accessor count and is correctly exempt.
      //
      // Every OTHER form in the family reads first: compound (`+=`), logical
      // (`||= &&= ??=`) and update (`++ --`) all run GetValue -> op -> PutValue.
      // Exempting them was a rename the ratchet would have paid for, which is the
      // one thing this tool exists to refuse: `if (o.constructor === undefined)
      // o.constructor = X` counted 1 accessor and `o.constructor ??= X` counted 0
      // for the same live read, and lowering is the always-allowed direction
      // through `--update`. Narrowing changed no per-file per-class count across
      // the tree — there is no such site in it today — so this is a floor raised
      // before anything stood on it.
      const isPlainWrite =
        parent &&
        parent.type === 'AssignmentExpression' &&
        parent.left === node &&
        parent.operator === '=';
      if (isPlainWrite) return;

      // `globalThis.String(x)` reaches the same replaceable binding the long way
      // round. Handled HERE rather than in the Identifier visitor because
      // acorn-walk only descends into `property` when the access is computed, so
      // a non-computed property identifier is never visited on its own.
      if (
        node.object.type === 'Identifier' &&
        node.object.name === 'globalThis' &&
        GLOBALS.has(name)
      ) {
        if (!runsAtModuleEval(ancestors)) at(node, 'global', `globalThis.${name}`);
        return;
      }

      const isCallee =
        parent &&
        (parent.type === 'CallExpression' || parent.type === 'NewExpression') &&
        parent.callee === node;

      if (isCallee) {
        if (POLLUTABLE.has(name)) at(node, 'method', `.${name}()`);
        else if (INVOKE.has(name)) at(node, 'invoke', `.${name}()`);
      }
      if (!ACCESSOR.has(name)) return;
      // A static call on a global constructor (`Buffer.byteLength(s)`) reads the
      // constructor's own property, not a view's prototype getter.
      if (node.object.type === 'Identifier' && GLOBALS.has(node.object.name)) return;
      // `this.buffer` is the object's own field — every accessor hit in
      // stream.js was this shape.
      if (node.object.type === 'ThisExpression') return;
      // A callee position is still a READ of the accessor: `new v.constructor(…)`
      // reaches the prototype chain and then invokes whatever it found. The old
      // trailing-`(` rule skipped it, which hid a reproduced vector in
      // structured_clone.js.
      at(node, 'accessor', `.${name}`);
    },

    // `const { buffer } = view` resolves the same getter as `view.buffer`, and so
    // does `const { 'buffer': b } = view` — both were a way to lower a count.
    ObjectPattern(node) {
      for (const p of node.properties) {
        if (p.type !== 'Property') continue;
        let key = null;
        if (!p.computed && p.key.type === 'Identifier') key = p.key.name;
        else if (p.key.type === 'Literal' && typeof p.key.value === 'string') key = p.key.value;
        if (key && ACCESSOR.has(key)) at(p, 'accessor', `{ ${key} } =`);
      }
    },

    Identifier(node, _state, ancestors) {
      const parent = ancestors[ancestors.length - 2];
      if (!parent) return;
      if (!GLOBALS.has(node.name)) return;
      // Property, key, label and binding positions are not reads of the global.
      // `!computed` matters: `o[String]` READS the global as a key, where
      // `o.String` only names a property. Without it the largest class still paid
      // out for a rename.
      if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) {
        return;
      }
      if (parent.type === 'Property' && parent.key === node && !parent.computed) return;
      if (parent.type === 'VariableDeclarator' && parent.id === node) return;
      // `Array.isArray(parent.params)` for the same reason `shadowedByParam` has
      // it: FUNCTION_TYPES includes PropertyDefinition, which is a call-time
      // context for the depth rule but carries no parameter list. Unguarded, a
      // class field holding a bare global — `class C { x = String; }`, the
      // class-field spelling of this codebase's own capture idiom — made `parent`
      // the PropertyDefinition and threw
      // `Cannot read properties of undefined (reading 'includes')`, crashing the
      // whole scan on valid syntax. The call form `x = String()` parents to a
      // CallExpression and never hit it, which is why the fixtures missed this.
      if (
        FUNCTION_TYPES.has(parent.type) &&
        (parent.id === node || (Array.isArray(parent.params) && parent.params.includes(node)))
      ) {
        return;
      }
      if (parent.type === 'ClassDeclaration' && parent.id === node) return;
      if (shadowedByParam(node.name, ancestors)) return;
      if (runsAtModuleEval(ancestors)) return;
      at(node, 'global', node.name);
    },
  });

  hits.sort((a, b) => a.line - b.line);
  return applySuppression(hits, lineComments);
}

// `// primordials-ok` silences a line. Bare, it silences the line ONLY when
// every candidate on it belongs to a single class — otherwise a marker added for
// a known-safe `queue.push(x)` would also hide an unrelated live global read the
// author never looked at. A mixed line must name its class:
// `// primordials-ok: method` (or a comma-separated list). An unrecognized name
// suppresses nothing, so a typo fails loud rather than quiet.
function applySuppression(hits, lineComments) {
  const byLine = new Map();
  for (const h of hits) {
    if (!byLine.has(h.line)) byLine.set(h.line, []);
    byLine.get(h.line).push(h);
  }
  const kept = [];
  for (const [line, lineHits] of byLine) {
    const comment = lineComments.get(line);
    const marker = comment ? /^\s*primordials-ok(?::\s*([\w,\s]+))?\s*$/.exec(comment) : null;
    if (!marker) {
      kept.push(...lineHits);
      continue;
    }
    if (marker[1]) {
      const named = marker[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      kept.push(...lineHits.filter((h) => !named.includes(h.kind)));
      continue;
    }
    const classes = new Set(lineHits.map((h) => h.kind));
    kept.push(...(classes.size === 1 ? [] : lineHits));
  }
  kept.sort((a, b) => a.line - b.line);
  return { count: kept.length, hits: kept };
}

function walkDir(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkDir(full, out);
    else if (full.endsWith('.js')) out.push(full);
  }
  return out;
}

function countFile(file) {
  return countSource(readFileSync(file, 'utf8'), relative(ROOT, file));
}

export { KINDS, countSource, countFile, walkDir, JS_DIR, BASELINE, ROOT };
