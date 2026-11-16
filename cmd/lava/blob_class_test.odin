#+build linux, darwin
package main

import "core:testing"
import lava "lava:pkg/runtime"
import eventloop "lava:pkg/runtime/eventloop"

// Pins what the Blob/File class conversion deliberately leaves different from node,
// which the oracle case (tests/node-compat/cases/77-blob-file-module.js) cannot express
// because the two runtimes answer differently by construction:
//
//   - Calling either without `new` throws the ENGINE's class-constructor TypeError.
//     JSC: `Cannot call a class constructor Blob without |new|`; node (V8):
//     `Class constructor Blob cannot be invoked without 'new'`. A class constructor
//     cannot customise it, so the text is an engine trait; the oracle case compares
//     only the error's class. If this message changes, JSC changed — or Blob stopped
//     being a class, which is the regression this guards.
//   - Blob.prototype's methods stay ENUMERABLE, as they were while Blob was a function
//     with an assigned prototype. Class methods are not, so internal/blob.js re-marks
//     them; node's enumerable set differs (size/type/textStream in, toString out).
BLOB_CLASS_SCRIPT :: `
'use strict';
const { Blob, File } = require('node:buffer');
function noNew(C) {
  try {
    C([], 'f');
    return 'no throw';
  } catch (e) {
    return e.name + ': ' + e.message;
  }
}
const want = {
  blob: 'TypeError: Cannot call a class constructor Blob without |new|',
  file: 'TypeError: Cannot call a class constructor File without |new|',
  keys: 'arrayBuffer,bytes,stream,text,slice,toString',
};
const got = {
  blob: noNew(Blob),
  file: noNew(File),
  keys: Object.keys(Blob.prototype).join(','),
};
for (const k of Object.keys(want)) {
  if (got[k] !== want[k]) throw new Error(k + ': got ' + got[k] + ', want ' + want[k]);
}
console.log('blob-class ok');
`

@(test)
blob_class_engine_traits :: proc(t: ^testing.T) {
	loop := eventloop.init()
	// eval consumes (destroys) the loop on every path; do not destroy it here.
	result := lava.eval(BLOB_CLASS_SCRIPT, "<blob-class-test>", &loop, false)
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

// A view part's window must come from the engine's slots, not the configurable
// %TypedArray% / DataView accessors. Read live, a forged byteOffset/byteLength selects
// any window of the backing store — across a shared allocUnsafe pool, a neighbouring
// Buffer's bytes (the gadget internal/encoding.js's toBytes already closed). Lava-only:
// node's own Blob reads these accessors off every view part (node 26.13.0, verified with
// spy getters), so node lands on the forged window and an oracle would diverge by
// construction. Deviates from node in Lava's favour; documented at blobPartToChunks.
BLOB_VIEW_WINDOW_SCRIPT :: `
'use strict';
const TA = Object.getPrototypeOf(Uint8Array.prototype);
const saved = [];
function forge(owner, key, value) {
  saved.push([owner, key, Object.getOwnPropertyDescriptor(owner, key)]);
  Object.defineProperty(owner, key, { configurable: true, get() { return value; } });
}
const backing = new Uint8Array([0x53, 0x45, 0x43, 0x52, 0x45, 0x54, 0x61, 0x62]); // SECRETab
const view = backing.subarray(6, 8); // "ab"
const dv = new DataView(backing.buffer, 6, 2); // "ab"
forge(TA, 'byteOffset', 0);
forge(TA, 'byteLength', 6);
forge(DataView.prototype, 'byteOffset', 0);
forge(DataView.prototype, 'byteLength', 6);
const b = new Blob([view, dv]);
for (const [o, k, d] of saved) Object.defineProperty(o, k, d);
b.text().then(function (s) {
  if (s !== 'abab') throw new Error('view window came from forged accessors: ' + JSON.stringify(s));
  console.log('blob-view-window ok');
});
`

@(test)
blob_view_window_ignores_forged_accessors :: proc(t: ^testing.T) {
	loop := eventloop.init()
	// eval consumes (destroys) the loop on every path; do not destroy it here.
	result := lava.eval(BLOB_VIEW_WINDOW_SCRIPT, "<blob-view-window-test>", &loop, false)
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
