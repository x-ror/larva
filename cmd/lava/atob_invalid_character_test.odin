#+build linux, darwin
package main

import "core:testing"
import lava "lava:pkg/runtime"
import eventloop "lava:pkg/runtime/eventloop"

// Pins the shape of the error atob/btoa throw for a bad character on the Node
// surface: an InvalidCharacterError DOMException, as node throws, with its legacy code
// a NUMBER answered by the prototype's getter (no own `code`) and node's text.
// tests/node-compat/cases/03-buffer.js compares name/code/message against node, but
// prints the code through console.log, where '5' and 5 look alike, and never asks
// what the value is an instance of — so those halves live here. The Window surface's
// shape and Chrome's text are tests/web/cases/base64-errors.js.
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
    ' DOMException=' + (e instanceof DOMException) + ' ownCode=' + Object.hasOwn(e, 'code');
  const want = 'name=InvalidCharacterError code=number:5 message=' + message +
    ' DOMException=true ownCode=false';
  if (got !== want) throw new Error(label + ': got ' + got + ', want ' + want);
}
check('atob', () => atob('!'), 'Invalid character');
check('atob-length', () => atob('Z'), 'The string to be decoded is not correctly encoded.');
check('btoa', () => btoa('Ā'), 'Invalid character');
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
