#+build linux, darwin
package main

import "core:testing"
import lava "lava:pkg/runtime"
import eventloop "lava:pkg/runtime/eventloop"

// Pins the shape of the error atob/btoa throw for a bad character, which is a
// deliberate deviation the node-compat oracle cannot express: Node throws a
// DOMException, Lava has no DOMException (the same gap structured_clone.js's
// DataCloneError documents), so it throws a plain Error carrying the
// DOMException's name, legacy numeric code and Node's exact message.
// tests/node-compat/cases/03-buffer.js compares name/code/message against node;
// this test pins the part node cannot oracle — that the value IS an Error and
// that there is no DOMException for it to be an instance of. When Lava grows a
// DOMException this test is what has to change, deliberately.
ATOB_INVALID_CHARACTER_SCRIPT :: `
'use strict';
function check(label, fn, message) {
  let e;
  try {
    fn();
  } catch (err) {
    e = err;
  }
  const got = e === undefined ? 'no throw' :
    'name=' + e.name + ' code=' + typeof e.code + ':' + e.code + ' message=' + e.message +
    ' isError=' + (e instanceof Error);
  const want = 'name=InvalidCharacterError code=number:5 message=' + message + ' isError=true';
  if (got !== want) throw new Error(label + ': got ' + got + ', want ' + want);
}
check('atob', () => atob('!'), 'Invalid character');
check('atob-length', () => atob('Z'), 'The string to be decoded is not correctly encoded.');
check('btoa', () => btoa('Ā'), 'Invalid character');
if (typeof DOMException !== 'undefined') throw new Error('DOMException now exists: revisit atob/btoa');
console.log('atob-invalid-character ok');
`

@(test)
atob_invalid_character_shape :: proc(t: ^testing.T) {
	loop := eventloop.init()
	// eval consumes (destroys) the loop on every path; do not destroy it here.
	result := lava.eval(ATOB_INVALID_CHARACTER_SCRIPT, "<atob-invalid-character-test>", &loop, false)
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
