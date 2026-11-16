// A lazy builtin must not read a REPLACED global while it evaluates.
//
// CLAUDE.md §5: a module-eval capture is pristine only in a module the loader instantiates
// before user code. Every module required below is LAZY — its factory runs on the user's
// first require(), so `Object.create(...)`, `Symbol('x')`, `new Map()` at its top level
// read whatever user code has left on globalThis by then (issue #426). Node's builtins
// take these from primordials and are immune; measured on node 26.13.0, every log below
// is empty. Before the fix, Lava's were not:
//
//   util (+ internal/mime)  Symbol(), Symbol.for, Symbol.iterator, new RegExp,
//                           String.fromCharCode, Object.defineProperties, Object.prototype
//   assert                  Object.prototype
//   diagnostics_channel     new Map, Object.defineProperty
//   dns                     Object.keys
//   os                      new Uint8Array, new Uint16Array
//   querystring, util/types Object.prototype
//   sqlite                  Symbol.dispose, Symbol(), and a WRITE of Symbol.dispose — the
//                           JSC polyfill went onto whatever object held the name
//   tty                     Object.create
//   http, https, net        Object.create / Object.defineProperty / new Uint8Array
//                           (Linux; on darwin the missing-bindings `new Error` is reached
//                           instead, which node never has)
//
// A spy that forwards everything is enough to see the read: what the builtin does with
// the value is up to whoever installed the replacement. punycode is deliberately absent —
// node's own punycode reads Math.floor and String.fromCharCode live too.
const NAMES = ['Symbol', 'RegExp', 'String', 'Object', 'Map', 'Error', 'Uint8Array', 'Uint16Array'];
const RA = Reflect.apply;
const RC = Reflect.construct;
const RG = Reflect.get;
const RS = Reflect.set;
const reals = {};
let log = [];
let armed = false;

// NOTHING under test may be required above this line: a module loaded before the swap
// captures the real globals whichever way it resolves them, and the check below passes
// with the fix reverted (the trap 65-lazy-buffer-capture.js documents).
for (const G of NAMES) {
  const real = globalThis[G];
  reals[G] = real;
  globalThis[G] = new Proxy(real, {
    get(t, k) {
      if (armed) log.push(G + '.' + (typeof k === 'symbol' ? '@@' + k.description : k));
      return RG(t, k);
    },
    set(t, k, v) {
      if (armed) log.push(G + '.' + (typeof k === 'symbol' ? '@@' + k.description : k) + '=');
      return RS(t, k, v);
    },
    apply(t, self, args) {
      if (armed) log.push(G + '()');
      return RA(t, self, args);
    },
    construct(t, args, nt) {
      if (armed) log.push('new ' + G);
      return RC(t, args, nt);
    },
  });
}

function loadUnderSpies(specifier) {
  log = [];
  armed = true;
  let threw = null;
  try {
    require(specifier);
  } catch (err) {
    threw = err;
  }
  armed = false;
  return { log, threw };
}

// Prove the recorder can fire BEFORE trusting an empty log — an empty-list check is worthless
// if nothing could ever append to it.
armed = true;
globalThis.Object.keys({});
armed = false;
console.log('recorder live:', log.length === 1 && log[0] === 'Object.keys');

const results = [];
// Leaves first: util requires util/types and internal/mime, assert requires util, http
// requires net — a module already loaded by a dependency logs nothing of its own.
for (const m of [
  'util/types',
  'util',
  'assert',
  'diagnostics_channel',
  'dns',
  'os',
  'querystring',
  'node:sqlite',
  'tty',
  'net',
  'http',
  'https',
]) {
  results.push([m, loadUnderSpies(m)]);
}

for (const G of NAMES) globalThis[G] = reals[G];

for (const [m, r] of results) {
  console.log(m + ':', r.threw ? 'THREW ' + r.threw.message : 'ok', JSON.stringify(r.log));
}
