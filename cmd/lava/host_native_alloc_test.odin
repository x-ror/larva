// Linux-only: host_function_create is stubbed off Linux, so nothing is ever
// registered and neither allocator rule below has anything to observe.
#+build linux
package main

import "core:mem"
import "core:strings"
import "core:testing"
import lava "lava:pkg/runtime"
import eventloop "lava:pkg/runtime/eventloop"

// Guards the two allocator rules in the host-native registry
// (pkg/runtime/host_natives.odin), neither of which the repeated-eval regression
// test can see — it runs under the runner's default context, where the ambient
// and the state allocator happen to be the same heap.
//
// Rule 1 (the cached NAMES): a name is cloned inside inject_native_function,
// which is reached both from eval-time setup AND from inside native_require_cb —
// a `proc "c"` where context resets to runtime.default_context(). The clone goes
// through the captured state.allocator so the sweep frees it through the same
// one. `require('node:fs')` is the specifier that drives that path: its bindings
// are injected lazily from inside the require callback, unlike node:events
// (served by require_builtin) or node:dns (registered at eval-time setup), which
// is why module_cache_alloc_test/dns_alloc_test do not cover this.
//
// Rule 2 (the map BACKING): both tables are thread-lived and bound explicitly to
// a process-lifetime allocator. Bound implicitly they would adopt this test's
// tracking allocator, which is torn down while the tables live on — a later eval
// then writes through reclaimed memory. That shows up here as a live-allocation
// count that grows with every eval instead of settling.
@(test)
eval_host_native_names_use_consistent_allocator :: proc(t: ^testing.T) {
	track: mem.Tracking_Allocator
	mem.tracking_allocator_init(&track, context.allocator)
	defer mem.tracking_allocator_destroy(&track)
	context.allocator = mem.tracking_allocator(&track)

	loop := eventloop.init()
	// eval CONSUMES the loop on every path; do not destroy it here.
	result := lava.eval("require('node:fs'); 0", "<host-native-alloc-test>", &loop, false)
	// Without this the allocator assertions below pass vacuously: a failed eval
	// registers no natives, so no name is ever cloned and nothing can mismatch.
	testing.expectf(
		t,
		result.status == .Ok && result.exit_code == 0,
		"eval did not reach the host-native path: status=%v exit=%d message=%q",
		result.status,
		result.exit_code,
		result.message,
	)
	lava.result_destroy(&result)

	testing.expectf(
		t,
		len(track.bad_free_array) == 0,
		"eval under a tracking allocator recorded %d bad free(s) — a host-native name was cloned and freed through different allocators",
		len(track.bad_free_array),
	)
}

// The map backings must not be CHARGED to a per-eval allocator. The sweep keeps
// the tables flat, so a wrong backing allocator does not show up as growth — it
// shows up as an allocation attributed to host_natives.odin that is still live
// under this allocator after eval returned, because the tables outlive it. That
// is the corruption precursor: the next caller to reuse this arena writes over
// a live table. Asserting on the recorded source location pins the binding
// itself rather than one of its symptoms.
@(test)
host_native_tables_are_not_charged_to_the_eval_allocator :: proc(t: ^testing.T) {
	track: mem.Tracking_Allocator
	mem.tracking_allocator_init(&track, context.allocator)
	defer mem.tracking_allocator_destroy(&track)
	context.allocator = mem.tracking_allocator(&track)

	loop := eventloop.init()
	result := lava.eval("require('node:fs'); 0", "<host-native-binding-test>", &loop, false)
	testing.expectf(
		t,
		result.status == .Ok && result.exit_code == 0,
		"eval did not reach the host-native path: status=%v exit=%d message=%q",
		result.status,
		result.exit_code,
		result.message,
	)
	lava.result_destroy(&result)

	stray := 0
	for _, entry in track.allocation_map {
		if strings.contains(entry.location.file_path, "host_natives.odin") {
			stray += 1
		}
	}
	testing.expectf(
		t,
		stray == 0,
		"%d live allocation(s) from host_natives.odin are charged to this eval's allocator — the thread-lived tables must be bound to a process-lifetime allocator",
		stray,
	)
	testing.expectf(
		t,
		len(track.bad_free_array) == 0,
		"repeated eval recorded %d bad free(s)",
		len(track.bad_free_array),
	)
}
