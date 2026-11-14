package main

import "core:mem"
import "core:testing"
import lava "lava:pkg/runtime"
import eventloop "lava:pkg/runtime/eventloop"

// Both free paths: the loop firing/dropping a binding under the embedder's context,
// and clearTimeout/clearImmediate from JS, which dispose inside a `proc "c"` native
// whose ambient allocator is the heap. Only the second can tell an ambient free from
// a cb.allocator one here (eval captures the state allocator from the same tracking
// context the loop later runs under), so it is the one the mutations rely on.
TIMER_ALLOC_SRC :: "setTimeout((a, b) => {}, 0, 1, 2); setImmediate(() => {}); const i = setInterval(() => clearInterval(i), 0); clearTimeout(setTimeout(() => {}, 1000, 3)); clearImmediate(setImmediate(() => {}, 4));"

// A timer binding is created inside a `proc "c"` native (setTimeout), where context
// is runtime.default_context(), and freed later by the loop under the EMBEDDER'S
// context. The binding therefore carries the owning Runtime_State allocator and both
// sides use it (CLAUDE.md §4). With a tracking allocator as the ambient allocator,
// a free through the wrong allocator shows up as a bad free, and — because the
// binding now goes through the tracked allocator at all — a binding that is never
// freed shows up as a live entry.
//
// What this cannot see: an AMBIENT free in free_js_callback. Every free today runs
// under eval's context — clear_timer_cb only marks the id cancelled and the loop
// disposes it later — and eval captures the state allocator from that same context,
// so an ambient free is the correct allocator by coincidence (verified: the mutation
// survives). cb.allocator is what keeps that true for a future synchronous-dispose
// or foreign-context loop driver; the manifest pins the allocation side instead.
@(test)
timer_binding_frees_through_its_own_allocator :: proc(t: ^testing.T) {
	track: mem.Tracking_Allocator
	mem.tracking_allocator_init(&track, context.allocator)
	defer mem.tracking_allocator_destroy(&track)
	// Record bad frees instead of panicking, so the assertion below names the defect.
	track.bad_free_callback = mem.tracking_allocator_bad_free_callback_add_to_array
	context.allocator = mem.tracking_allocator(&track)

	run :: proc(t: ^testing.T, src: string) {
		loop := eventloop.init(real_time = true)
		result := lava.eval(src, "<timer-alloc-test>", &loop, false)
		defer lava.result_destroy(&result)
		testing.expect_value(t, result.status, lava.Status.Ok)
	}

	// Warm-up: the first eval on this thread builds the pooled VM and thread-lived
	// tables under the tracking allocator; those legitimately outlive the eval. A
	// second eval of the SAME source settles anything that is lazily cached on first
	// use, so the third run's delta is the timer bindings alone.
	run(t, TIMER_ALLOC_SRC)
	run(t, TIMER_ALLOC_SRC)
	live_before := len(track.allocation_map)
	run(t, TIMER_ALLOC_SRC)

	testing.expectf(t, len(track.bad_free_array) == 0, "%d timer binding(s) freed into the wrong allocator", len(track.bad_free_array))
	testing.expectf(
		t,
		len(track.allocation_map) == live_before,
		"timer bindings leaked: %d live allocation(s) after eval, %d before",
		len(track.allocation_map),
		live_before,
	)
}
