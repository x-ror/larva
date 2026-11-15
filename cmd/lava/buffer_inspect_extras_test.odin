package main

// Lava-only: pins where Buffer's util.inspect hook deliberately renders LESS than node 24
// (issue #391), per CLAUDE.md §1, and one pollution property node cannot oracle.
//
// Why these are not oracle cases.
//
//   1. The string-key scan is capped at INSPECT_EXTRAS_MAX_LENGTH (64) bytes
//      (pkg/runtime/js/internal/buffer.js, where the measurements and their method are
//      recorded). JS cannot list a typed array's named own properties without first
//      materialising one string per index, so the scan is O(length) on every inspect.
//      Past the cap, string-keyed extras are omitted; symbol-keyed ones still show
//      (Object.getOwnPropertySymbols lists no indices). Node shows both at any length,
//      so a node-vs-Lava diff here would only ever be red. The 64/65 pair sits exactly
//      on the cap, so moving the constant or dropping the length check turns this red.
//      The bare `buf.inspect()` assertion is node's own behaviour, kept beside it so a
//      change that renders extras without a context is caught too.
//   2. The hook reads `showHidden`/`depth` as OWN properties of the options object.
//      Polluting Object.prototype in an oracle case would leak into every other line
//      it prints, so the property is pinned here instead.
//
//   3. Cycles, where node has no stable output to compare against. A Buffer reaching itself
//      by two or more keys made Lava's per-hook overflow catch do work like k^depth
//      (c5fd268: `b.k0 = b; b.k1 = b; console.log(b)` ran past 60 s). node's outcome there
//      depends on whether a lazily compiled regex has been compiled yet (see case 70), so
//      the property pinned here is Lava's own: it ends, by a throw, in bounded wall-clock
//      time. A user hook that inspects its own ancestor must not throw out of console.log
//      (Lava's console.log text cannot be captured by an oracle case: it writes natively),
//      and with two ways back it must end in bounded time too.
//   4. console.log hands a hook an inspect that reads `depth` as an OWN option only.
//
// Each script throws on the first mismatch, so the failed expectation names it.

import "core:testing"
import "core:time"
import "lava:pkg/runtime/eventloop"
import lava "lava:pkg/runtime"

BUFFER_INSPECT_EXTRAS_SCRIPT :: `
const util = require('node:util');
const sym = Symbol('s');
function check(label, got, want) {
  if (got !== want) throw new Error(label + ': want ' + want + ' got ' + got);
}

// At the cap: the string-keyed property is scanned and shown.
const atCap = Buffer.alloc(64);
atCap.tag = 1;
check('64 shows string key', util.inspect(atCap).endsWith(', tag: 1>'), true);

// One past the cap: the string key is omitted, the symbol key still shows.
const pastCap = Buffer.alloc(65);
pastCap.tag = 1;
pastCap[sym] = 2;
const past = util.inspect(pastCap);
check('65 omits string key', past.includes('tag: 1'), false);
check('65 shows symbol key', past.endsWith(' more bytes, Symbol(s): 2>'), true);

// A bare call has no context and renders the bytes only (node does the same)...
const small = Buffer.from([1, 2, 3]);
small.tag = 1;
check('bare inspect()', small.inspect(), '<Buffer 01 02 03>');
// ...while util.inspect of the same Buffer does render the extra (so the line above
// is not passing merely because extras never render).
check('util.inspect same buffer', util.inspect(small), "<Buffer 01 02 03, tag: 1>");
console.log('buffer-inspect-extras ok');
`

BUFFER_INSPECT_POLLUTION_SCRIPT :: `
const util = require('node:util');
function check(label, got, want) {
  if (got !== want) throw new Error(label + ': want ' + want + ' got ' + got);
}
const b = Buffer.from([1]);
Object.defineProperty(b, 'hid', { value: 1, enumerable: false });
b.o = { a: { b: { c: { d: 1 } } } };
Object.prototype.showHidden = true;
Object.prototype.depth = null;
let plain, shown;
try {
  plain = util.inspect(b, {});
  shown = util.inspect(b, { showHidden: true });
} finally {
  delete Object.prototype.showHidden;
  delete Object.prototype.depth;
}
// An inherited showHidden must not list the non-enumerable property...
check('inherited showHidden', plain.includes('hid'), false);
// ...an inherited depth: null must not lift the depth bound for the extras...
check('inherited depth', plain.includes('[Object]'), true);
// ...and an OWN showHidden still works, so the first check is not vacuous.
check('own showHidden', shown.includes('hid: 1'), true);
// console.log's hook inspect must not take depth from Object.prototype either (M).
let viaConsole;
const deep = { a: { b: { c: { d: { e: 1 } } } } };
const hooked = {
  [util.inspect.custom](d, o, inspect) {
    viaConsole = inspect(deep, {});
    return 'hooked';
  },
};
Object.prototype.depth = null;
try {
  console.log(hooked);
} finally {
  delete Object.prototype.depth;
}
check('console hook inherited depth', viaConsole, '{ a: { b: { c: [Object] } } }');
console.log('buffer-inspect-pollution ok');
`

@(test)
buffer_inspect_extras_cap :: proc(t: ^testing.T) {
	loop := eventloop.init()
	// eval consumes (destroys) the loop on every path; do not destroy it here.
	result := lava.eval(BUFFER_INSPECT_EXTRAS_SCRIPT, "<buffer-inspect-extras-test>", &loop, false)
	defer lava.result_destroy(&result)

	testing.expectf(
		t,
		result.status == .Ok,
		"eval did not complete cleanly: status=%v message=%q",
		result.status,
		result.message,
	)
	testing.expectf(t, result.exit_code == 0, "eval exit code=%d (want 0)", result.exit_code)
}

@(test)
buffer_inspect_extras_pollution :: proc(t: ^testing.T) {
	loop := eventloop.init()
	// eval consumes (destroys) the loop on every path; do not destroy it here.
	result := lava.eval(BUFFER_INSPECT_POLLUTION_SCRIPT, "<buffer-inspect-pollution-test>", &loop, false)
	defer lava.result_destroy(&result)

	testing.expectf(
		t,
		result.status == .Ok,
		"eval did not complete cleanly: status=%v message=%q",
		result.status,
		result.message,
	)
	testing.expectf(t, result.exit_code == 0, "eval exit code=%d (want 0)", result.exit_code)
}

BUFFER_INSPECT_CYCLE_SCRIPT :: `
const util = require('node:util');
function check(label, got, want) {
  if (got !== want) throw new Error(label + ': want ' + want + ' got ' + got);
}
// k self-references: must END, and by a throw (node's fresh-process outcome), well inside
// the bound. Before the overflow latch, k = 2 already ran past 60 s.
for (const refs of [2, 3, 8]) {
  const b = Buffer.from([1]);
  for (let i = 0; i < refs; i++) b['k' + i] = b;
  for (const how of ['inspect', 'log']) {
    const t0 = Date.now();
    let out = 'returned';
    try {
      if (how === 'inspect') util.inspect(b);
      else console.log(b);
    } catch (e) {
      out = 'threw';
    }
    const ms = Date.now() - t0;
    check(refs + ' refs ' + how + ' outcome', out, 'threw');
    if (ms > 5000) throw new Error(refs + ' refs ' + how + ' took ' + ms + 'ms (bound 5000)');
  }
}
// One way back still RETURNS, with node's interrupted marker, and the latch is reset for
// the next top-level call: inspecting it again returns again (a latch left set would
// make the second call throw at its first extra). Where the cut lands varies with stack
// state, so the two strings are not compared.
const one = Buffer.from([1]);
one.self = one;
check('1 ref marker', util.inspect(one).includes('Inspection interrupted prematurely'), true);
check('1 ref repeat', util.inspect(one).includes('Inspection interrupted prematurely'), true);
check('plain after cycle', util.inspect(Object.assign(Buffer.from([2]), { t: 1 })), '<Buffer 02, t: 1>');
console.log('buffer-inspect-cycle ok');
`

BUFFER_INSPECT_HOOK_ANCESTOR_SCRIPT :: `
const util = require('node:util');
function check(label, got, want) {
  if (got !== want) throw new Error(label + ': want ' + want + ' got ' + got);
}
const outer = { n: 1 };
class H {
  [util.inspect.custom](d, o, inspect) {
    return inspect(outer);
  }
}
outer.h = new H();
// util.inspect returns node's interrupted marker rather than throwing...
check('util.inspect', util.inspect(outer).includes('Inspection interrupted prematurely'), true);
// ...and so does console.log (c5fd268 threw RangeError out of it), in bounded time.
const t0 = Date.now();
console.log(outer);
if (Date.now() - t0 > 5000) throw new Error('console.log took ' + (Date.now() - t0) + 'ms');
// Two ways back to the ancestor: bounded, by a throw (the latch), never a hang.
const outer2 = { n: 2 };
class H2 {
  [util.inspect.custom](d, o, inspect) {
    return inspect(outer2);
  }
}
outer2.a = new H2();
outer2.b = new H2();
for (const how of ['inspect', 'log']) {
  const t1 = Date.now();
  try {
    if (how === 'inspect') util.inspect(outer2);
    else console.log(outer2);
  } catch {}
  if (Date.now() - t1 > 5000) throw new Error('2 ways back ' + how + ' took ' + (Date.now() - t1) + 'ms');
}
console.log('buffer-inspect-hook-ancestor ok');
`

@(test)
buffer_inspect_cycle_bounded :: proc(t: ^testing.T) {
	// The exponential path never returns, so the script's own 5 s check would never run:
	// the runner's timeout is what turns a regression into a failure instead of a CI hang.
	testing.set_fail_timeout(t, 30 * time.Second)
	loop := eventloop.init()
	// eval consumes (destroys) the loop on every path; do not destroy it here.
	result := lava.eval(BUFFER_INSPECT_CYCLE_SCRIPT, "<buffer-inspect-cycle-test>", &loop, false)
	defer lava.result_destroy(&result)

	testing.expectf(
		t,
		result.status == .Ok,
		"eval did not complete cleanly: status=%v message=%q",
		result.status,
		result.message,
	)
	testing.expectf(t, result.exit_code == 0, "eval exit code=%d (want 0)", result.exit_code)
}

@(test)
buffer_inspect_hook_ancestor_cycle :: proc(t: ^testing.T) {
	testing.set_fail_timeout(t, 30 * time.Second)
	loop := eventloop.init()
	// eval consumes (destroys) the loop on every path; do not destroy it here.
	result := lava.eval(BUFFER_INSPECT_HOOK_ANCESTOR_SCRIPT, "<buffer-inspect-hook-ancestor-test>", &loop, false)
	defer lava.result_destroy(&result)

	testing.expectf(
		t,
		result.status == .Ok,
		"eval did not complete cleanly: status=%v message=%q",
		result.status,
		result.message,
	)
	testing.expectf(t, result.exit_code == 0, "eval exit code=%d (want 0)", result.exit_code)
}
