// Linux-only: uses the shared JSC-context helpers from
// host_native_registry_test.odin, which are compiled for Linux only (the
// private-ABI host path they gate on does not exist elsewhere).
#+build linux
package main

import "core:mem"
import "core:testing"
import jsc "lava:pkg/jsc"
import lava "lava:pkg/runtime"

// Pins module_cache_insert_new's rollback (globals.odin): when the map grow
// fails, the cloned key is freed and the JSValueProtect undone.
//
// The leak assertion is THE test. `!hit` below passes with or without the
// rollback — a failed map_insert stores nothing either way — so it pins the
// insert's failure handling, not the cleanup. The runner's own per-test
// tracking allocator does not close the gap: ODIN_TEST_FAIL_ON_BAD_MEMORY
// defaults to false (core/testing/runner.odin:40), so it logs the orphaned
// clone as a WARN and still reports the test successful. Verified by mutation:
// with the rollback deleted the runner printed `<14B/462B> (1/2)` — 14 bytes is
// exactly "rollback-probe" — and finished "All tests were successful". Hence
// the explicit before/after count through an allocator this test owns.
//
// What it does NOT pin: the JSValueUnprotect. A GC root has no allocator to
// observe it from, and the two live in the same branch, so the clone stands in
// for both. Deleting only the unprotect line would survive this test.
//
// The injection swaps the MAP, not state.allocator: a map captures its backing
// allocator at make time, so a zero-valued map with `allocator` pre-set is the
// one shape whose very first insert must grow through the failing allocator.
// The key clone still goes through state.allocator, which is what makes the
// orphan visible.
@(test)
module_cache_insert_rolls_back_on_grow_failure :: proc(t: ^testing.T) {
	c, ok := make_context()
	testing.expect(t, ok, "could not create a JSC global context")

	if !ok {
		return
	}

	defer destroy_context(c)

	track: mem.Tracking_Allocator
	mem.tracking_allocator_init(&track, context.allocator)
	defer mem.tracking_allocator_destroy(&track)
	context.allocator = mem.tracking_allocator(&track)

	// new_runtime_state captures context.allocator into state.allocator, so the
	// key clone under test is allocated through `track`.
	state := lava.new_runtime_state(nil)
	defer lava.destroy_runtime_state(c.ctx, state)

	saved := state.module_cache
	state.module_cache = {}
	state.module_cache.allocator = failing_allocator()
	// Restored before teardown (defers are LIFO): destroy_runtime_state walks and
	// deletes the map, and it must be the one the real allocator owns.
	defer state.module_cache = saved

	value := jsc.JSValueMakeNumber(c.ctx, 1)
	before := len(track.allocation_map)
	lava.module_cache_put(c.ctx, state, "rollback-probe", value)
	after := len(track.allocation_map)

	_, hit := lava.module_cache_get(state, "rollback-probe")
	testing.expect(t, !hit, "an entry landed in a map whose grow failed")
	testing.expectf(
		t,
		after == before,
		"the failed insert left %d allocation(s) live — the rollback did not free the cloned key",
		after - before,
	)
}
