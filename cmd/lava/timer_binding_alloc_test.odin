package main

import "core:mem"
import "core:testing"
import lava "lava:pkg/runtime"
import eventloop "lava:pkg/runtime/eventloop"

// A timer binding is created inside a `proc "c"` native (setTimeout), where context
// is runtime.default_context(), and freed later by the loop under the EMBEDDER'S
// context. Both sides must name the same allocator explicitly, or an embedder whose
// context.allocator is not the heap frees the binding into the wrong allocator
// (CLAUDE.md §4). A tracking allocator as the ambient allocator sees such a free as
// a bad free.
@(test)
timer_binding_frees_through_its_own_allocator :: proc(t: ^testing.T) {
	track: mem.Tracking_Allocator
	mem.tracking_allocator_init(&track, context.allocator)
	defer mem.tracking_allocator_destroy(&track)
	// Record bad frees instead of panicking, so the assertion below names the defect.
	track.bad_free_callback = mem.tracking_allocator_bad_free_callback_add_to_array
	context.allocator = mem.tracking_allocator(&track)

	loop := eventloop.init(real_time = true)
	result := lava.eval(
		"setTimeout((a, b) => {}, 0, 1, 2); setImmediate(() => {}); const i = setInterval(() => clearInterval(i), 0);",
		"<timer-alloc-test>",
		&loop,
		false,
	)
	defer lava.result_destroy(&result)
	testing.expect_value(t, result.status, lava.Status.Ok)
	testing.expectf(t, len(track.bad_free_array) == 0, "%d timer binding(s) freed into the wrong allocator", len(track.bad_free_array))
}
