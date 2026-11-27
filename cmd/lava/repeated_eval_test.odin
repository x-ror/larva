// Linux-only by mechanism, not by convenience: the private-ABI host-call path is
// compiled only for Linux (pkg/jsc/host_function.odin), so off Linux the registry
// this pins is permanently empty and the defect cannot occur.
#+build linux
package main

import "core:testing"
import jsc "lava:pkg/jsc"
import lava "lava:pkg/runtime"
import eventloop "lava:pkg/runtime/eventloop"

// Proves that a process can run many lava.eval calls in a row. This is a
// Lava-only test, not a node-compat oracle case: it is about our own JSC context
// lifetime, which Node has no equivalent of.
//
// The defect it pins: pkg/runtime/host_natives.odin caches host-registered
// function objects in a thread-local map keyed by {context pointer, callback,
// name}. Nothing used to drop those entries when a context was destroyed, and JSC
// hands the same address to a later JSGlobalContextCreate — so the key collided
// with a dead context's entry and the cache returned a JSObjectRef into freed
// memory. From the 3rd-4th eval onward this surfaced as the `allocUninit` binding
// resolving to an unrelated function of the new VM ("TypeError: Map operation
// called on non-Map object" out of buffer.js createPool), and under the test
// runner escalated to a segfault or a tracking-allocator bad free. Each eval below
// must therefore report a clean status and a zero exit code (the loader failure
// itself goes to stderr, not into Result.message, so the script below is what
// turns it into an observable failure); the script itself calls through cached host
// natives (the codecs behind TextDecoder, atob and URL's host parse).
REPEATED_EVAL_SOURCE :: `
'use strict';
const s = new TextDecoder().decode(new Uint8Array([0x41, 0x42]));
if (atob('YWFh') !== 'aaa') throw new Error('codec');
if (s !== 'AB') throw new Error('decode');
if (new URL('http://%C3%BCber.example/').hostname !== 'xn--ber-goa.example')
  throw new Error('url');
`

@(test)
repeated_eval_stays_correct :: proc(t: ^testing.T) {
	// The registry only holds entries when the private-ABI host-call path resolved.
	// If the probe ever misses (a JSC upgrade renaming the mangled symbol it
	// dlsyms), nothing is cached, nothing can go stale, and this whole test passes
	// on unfixed code. Assert the precondition so a green run means something.
	{
		gctx := jsc.JSGlobalContextCreate(nil)
		defer if gctx != nil {
			jsc.JSGlobalContextRelease(gctx)
		}
		testing.expect(
			t,
			gctx != nil && jsc.host_calls_active(jsc.JSContextRef(gctx)),
			"private-ABI host-call path inactive — nothing is cached, so this test cannot observe the defect it pins",
		)
	}
	// 12 is comfortably past the 3rd-4th eval where address reuse first bit.
	for i in 0 ..< 12 {
		loop := eventloop.init()
		// eval consumes (destroys) the loop on every path; do not destroy it here.
		result := lava.eval(REPEATED_EVAL_SOURCE, "<repeated-eval-test>", &loop, false)
		defer lava.result_destroy(&result)

		testing.expectf(
			t,
			result.status == .Ok,
			"eval #%d did not complete cleanly: status=%v message=%q",
			i,
			result.status,
			result.message,
		)
		testing.expectf(t, result.exit_code == 0, "eval #%d exit code=%d (want 0)", i, result.exit_code)
	}
}
