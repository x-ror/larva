#+build linux, darwin
package main

import "core:testing"
import lava "lava:pkg/runtime"
import eventloop "lava:pkg/runtime/eventloop"

// Pins what internal/domexception.js deliberately leaves different from Chrome, which
// no tests/web case can print because the two engines answer differently by
// construction (CLAUDE.md §5): calling DOMException or QuotaExceededError without
// `new` throws the ENGINE's class-constructor TypeError. Chrome's text is Blink's
// "Failed to construct 'DOMException': Please use the 'new' operator, this DOM object
// constructor cannot be called as a function."; a JS class cannot run code before
// that check, so JSC's wording stands. If this message changes, JSC changed — or the
// interface stopped being a class (a host-native interface object, which would also
// give Blink's text and retire this pin, is the systemic fix for JS-implemented Web
// APIs and has its own issue).
DOMEXCEPTION_CLASS_SCRIPT :: `
'use strict';
function noNew(C) {
  try {
    C('m');
    return 'no throw';
  } catch (e) {
    return e.constructor.name + ': ' + e.message;
  }
}
const want = {
  domexception: 'TypeError: Cannot call a class constructor DOMException without |new|',
  quota: 'TypeError: Cannot call a class constructor QuotaExceededError without |new|',
};
const got = { domexception: noNew(DOMException), quota: noNew(QuotaExceededError) };
for (const k of Object.keys(want)) {
  if (got[k] !== want[k]) throw new Error(k + ': got ' + got[k] + ', want ' + want[k]);
}
console.log('domexception-class ok');
`

@(test)
domexception_class_engine_traits :: proc(t: ^testing.T) {
	loop := eventloop.init()
	// eval consumes (destroys) the loop on every path; do not destroy it here.
	result := lava.eval(DOMEXCEPTION_CLASS_SCRIPT, "<domexception-class-test>", &loop, false, surface = .Web)
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
