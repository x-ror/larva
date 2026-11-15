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
// Each script throws on the first mismatch, so the failed expectation names it.

import "core:testing"
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
