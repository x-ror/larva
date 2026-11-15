package main

// Lava-only: pins the two places where Buffer's util.inspect hook deliberately
// renders LESS than node 24 (issue #391), per CLAUDE.md §1.
//
// Why this is not an oracle case. Both behaviours differ from node by design, so a
// node-vs-Lava diff would only ever be red:
//
//   1. The string-key scan is capped at INSPECT_EXTRAS_MAX_LENGTH (1024) bytes
//      (pkg/runtime/js/internal/buffer.js). JS cannot list a typed array's named own
//      properties without first materialising one string per index, so an uncapped
//      scan made `console.log(chunk)` O(length) — 13.8 ms for a 64 KiB Buffer and 11 s
//      for 1e7 bytes, measured on bin/lava. Past the cap, string-keyed extras are
//      omitted; symbol-keyed ones still show (Object.getOwnPropertySymbols lists no
//      indices). Node shows both at any length.
//   2. Extras render only when the hook is handed an inspect function, which
//      util.inspect and console.log always do. A bare `buf.inspect()` therefore shows
//      the bytes only — which matches node for the no-argument call this pins; node
//      would also render extras for `buf.inspect(0, {})`, which Lava does not.
//
// The 1024/1025 pair sits exactly on the cap, so moving the constant or dropping the
// length check turns this red. The script throws on the first mismatch, so the
// message in the failed expectation names it.

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
const atCap = Buffer.alloc(1024);
atCap.tag = 1;
check('1024 shows string key', util.inspect(atCap).endsWith(', tag: 1>'), true);

// One past the cap: the string key is omitted, the symbol key still shows.
const pastCap = Buffer.alloc(1025);
pastCap.tag = 1;
pastCap[sym] = 2;
const past = util.inspect(pastCap);
check('1025 omits string key', past.includes('tag: 1'), false);
check('1025 shows symbol key', past.endsWith(' more bytes, Symbol(s): 2>'), true);

// A bare call receives no inspect function and renders the bytes only.
const small = Buffer.from([1, 2, 3]);
small.tag = 1;
check('bare inspect()', small.inspect(), '<Buffer 01 02 03>');
// ...while util.inspect of the same Buffer does render the extra (so the line above
// is not passing merely because extras never render).
check('util.inspect same buffer', util.inspect(small), "<Buffer 01 02 03, tag: 1>");
console.log('buffer-inspect-extras ok');
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
