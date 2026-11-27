#+build linux, darwin
package main

import "core:testing"
import lava "lava:pkg/runtime"
import eventloop "lava:pkg/runtime/eventloop"

// Pins the shape of the error atob/btoa throw for a bad character: an
// InvalidCharacterError DOMException with its legacy code a NUMBER answered by the
// prototype's getter (no own `code`) and Chrome's text. tests/web/cases/base64-errors.js
// compares name/code/message against Chrome, but prints the code, where '5' and 5 look
// alike, and never asks what the value is an instance of — so those halves live here.
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
const DECODE = "Failed to execute 'atob' on 'Window': The string to be decoded is not correctly encoded.";
check('atob', () => atob('!'), DECODE);
check('atob-length', () => atob('Z'), DECODE);
check('btoa', () => btoa('Ā'), "Failed to execute 'btoa' on 'Window': The string to be encoded contains characters outside of the Latin1 range.");
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
