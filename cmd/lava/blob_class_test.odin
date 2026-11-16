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
