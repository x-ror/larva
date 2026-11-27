#+build linux, darwin
package main

import "core:testing"
import lava "lava:pkg/runtime"
import eventloop "lava:pkg/runtime/eventloop"

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
