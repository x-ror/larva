package main

import "core:mem"
import "core:testing"
import lava "lava:pkg/runtime"
import eventloop "lava:pkg/runtime/eventloop"

// Every free path for a timer binding (JS_Callback + its forwarded args), each under
// a different ambient context:
//   - the loop fires a one-shot, or drops a self-cleared interval — eval's context;
//   - clearTimeout/clearImmediate dispose synchronously inside clear_timer_cb, a
//     `proc "c"` native — runtime.default_context()'s heap;
//   - eventloop.destroy disposes bindings still pending at teardown — eval's context
//     (TIMER_PENDING_SRC: eval exits on the throw with both still queued).
// One binding per call, five in TIMER_ALLOC_SRC: two setTimeout, two setImmediate,
// one setInterval.
TIMER_ALLOC_SRC :: "setTimeout((a, b) => {}, 0, 1, 2); setImmediate(() => {}); const i = setInterval(() => clearInterval(i), 0); clearTimeout(setTimeout(() => {}, 1000, 3)); clearImmediate(setImmediate(() => {}, 4));"
TIMER_PENDING_SRC :: "setTimeout(() => {}, 1e6, 1); setImmediate(() => {}, 2); throw new Error('exit with timers pending');"
TIMER_CONTROL_SRC :: "const i = 0;"
TIMER_BINDINGS :: 5

// Binding_Counter counts allocations of exactly size_of(JS_Callback) on their way to
// the tracking allocator, so the test can tell that bindings went through the
// embedder's allocator at all — the property a heap-allocating runtime would also
// pass every pairing check with.
Binding_Counter :: struct {
	backing: mem.Allocator,
	hits:    int,
}

binding_counter_proc :: proc(
	data: rawptr,
	mode: mem.Allocator_Mode,
	size, alignment: int,
	old_memory: rawptr,
	old_size: int,
	loc := #caller_location,
) -> (
	[]byte,
	mem.Allocator_Error,
) {
	c := cast(^Binding_Counter)data
	if (mode == .Alloc || mode == .Alloc_Non_Zeroed) && size == size_of(lava.JS_Callback) {
		c.hits += 1
	}
	return c.backing.procedure(c.backing.data, mode, size, alignment, old_memory, old_size, loc)
}

// A tracking allocator as eval's ambient allocator pins three things the runtime
// owes it (CLAUDE.md §4):
//   - pairing: a binding made or freed through any other allocator is a bad free —
//     or, when the stray free lands in the heap with a tracked pointer, a libc abort
//     ("free(): invalid pointer"), which kills the test just as dead;
//   - routing: bindings are made through the state allocator (counted per binding),
//     not a hard-coded heap the tracker never sees;
//   - release: every binding is freed — on fire, on clear, and at teardown.
@(test)
timer_binding_frees_through_its_own_allocator :: proc(t: ^testing.T) {
	track: mem.Tracking_Allocator
	mem.tracking_allocator_init(&track, context.allocator)
	defer mem.tracking_allocator_destroy(&track)
	// Record bad frees instead of panicking, so the assertion below names the defect.
	track.bad_free_callback = mem.tracking_allocator_bad_free_callback_add_to_array
	counter := Binding_Counter {
		backing = mem.tracking_allocator(&track),
	}
	context.allocator = mem.Allocator{binding_counter_proc, &counter}

	run :: proc(t: ^testing.T, src: string, want: lava.Status) {
		loop := eventloop.init(real_time = true)
		result := lava.eval(src, "<timer-alloc-test>", &loop, false)
		defer lava.result_destroy(&result)
		testing.expect_value(t, result.status, want)
	}

	// Warm-up: lazily cached allocations made through the state or ambient allocator
	// on the first evals of these sources must not read as leaks or as bindings.
	run(t, TIMER_ALLOC_SRC, .Ok)
	run(t, TIMER_PENDING_SRC, .Execution_Error)
	run(t, TIMER_CONTROL_SRC, .Ok)

	// Control: whatever else this eval shape allocates at size_of(JS_Callback).
	before := counter.hits
	run(t, TIMER_CONTROL_SRC, .Ok)
	baseline := counter.hits - before

	live_before := len(track.allocation_map)
	before = counter.hits
	run(t, TIMER_ALLOC_SRC, .Ok)
	bindings := counter.hits - before - baseline
	run(t, TIMER_PENDING_SRC, .Execution_Error)

	testing.expectf(t, len(track.bad_free_array) == 0, "%d timer binding(s) freed into the wrong allocator", len(track.bad_free_array))
	testing.expectf(
		t,
		bindings == TIMER_BINDINGS,
		"%d timer binding(s) made through the state allocator, want %d",
		bindings,
		TIMER_BINDINGS,
	)
	testing.expectf(
		t,
		len(track.allocation_map) == live_before,
		"timer bindings leaked: %d live allocation(s) after eval, %d before",
		len(track.allocation_map),
		live_before,
	)
}
