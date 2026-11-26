#+build linux, darwin
package main

import "core:testing"
import lava "lava:pkg/runtime"
import eventloop "lava:pkg/runtime/eventloop"

// Function.prototype.toString's mask and the registry behind it (internal/native_shape,
// #114) are per realm: each page's context builds its own at its loader's eval, and
// nothing of them lives on the VM, the thread or the process. Two pages on one thread
// share the pooled VM; the first tampers with everything the mask reads — the property,
// WeakMap.prototype.get/set, and the toString of a built-in — and the second must still
// see Chrome's answers. A one-page oracle case cannot show this.
@(private = "file")
SHAPE_POLLUTER :: `
Function.prototype.toString = function () { return 'poisoned'; };
WeakMap.prototype.get = function () { return 'poisoned'; };
WeakMap.prototype.set = function () { return this; };
Object.defineProperty(atob, 'name', { value: 'renamed' });
if (String(atob) !== 'poisoned') throw new Error('page 1 did not poison its own realm');
`

@(private = "file")
SHAPE_CHECKER :: `
const ts = Function.prototype.toString;
const want = {
  atob: 'function atob() { [native code] }',
  self: 'function toString() { [native code] }',
  URL: 'function URL() { [native code] }',
  push: 'function push() { [native code] }',
  script: 'function f() { return 1; }',
};
const got = {
  atob: ts.call(atob),
  self: ts.call(ts),
  URL: String(URL),
  push: ts.call(Array.prototype.push),
  script: ts.call(function f() { return 1; }),
};
for (const k of Object.keys(want)) {
  if (got[k] !== want[k]) throw new Error(k + ': got ' + got[k] + ', want ' + want[k]);
}
`

@(test)
native_shape_mask_is_per_page :: proc(t: ^testing.T) {
	run_page :: proc(t: ^testing.T, source: string) {
		loop := eventloop.init()
		// eval consumes (destroys) the loop on every path; do not destroy it here.
		result := lava.eval(source, "<native-shape-test>", &loop, surface = .Web)
		defer lava.result_destroy(&result)
		testing.expectf(t, result.status == .Ok, "page failed: status=%v message=%q", result.status, result.message)
	}

	run_page(t, SHAPE_POLLUTER)
	_, created_before, _ := lava.vm_pool_stats(lava.thread_vm_pool())
	run_page(t, SHAPE_CHECKER)
	_, created_after, _ := lava.vm_pool_stats(lava.thread_vm_pool())
	// The second page ran in the VM the first one released, which is what makes this
	// an isolation test rather than two fresh starts.
	testing.expect_value(t, created_after, created_before)
}
