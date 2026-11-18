#+build linux, darwin
package main

import "base:runtime"
import "core:mem"
import "core:sync"
import "core:testing"
import lava "lava:pkg/runtime"
import eventloop "lava:pkg/runtime/eventloop"

// Guards the localized dns/fetch allocator fix (Dns_Lookup_Request.allocator). The
// hostname is cloned inside the native dns lookup callback (a `proc "c"` where context
// resets to runtime.default_context — the heap allocator) and the request struct is
// new()'d there too, but both are freed later in dns_request_free under the loop/
// teardown context. The runtime captures the request's allocator on the request and
// clones/frees through it, so the pair agrees even when eval runs under a custom
// allocator. Here that caller is a tracking allocator: an IP-literal lookup forces the
// clone+free without any network (the worker resolves "127.0.0.1" as a literal), so a
// mismatched free would land in bad_free_array. Scoped linux+darwin, where eval links JSC.
@(test)
eval_dns_lookup_uses_consistent_allocator :: proc(t: ^testing.T) {
	track: mem.Tracking_Allocator
	mem.tracking_allocator_init(&track, context.allocator)
	defer mem.tracking_allocator_destroy(&track)
	context.allocator = mem.tracking_allocator(&track)

	loop := eventloop.init()
	// An IP-literal lookup runs the full async path — native clone, worker resolve,
	// completion, dns_request_free — without touching the network. eval CONSUMES the
	// loop (it destroys it on every path; see the OWNERSHIP note in runtime.odin), so
	// there is no separate eventloop.destroy here.
	src := "require('node:dns').lookup('127.0.0.1', () => {}); 0"
	result := lava.eval(src, "<dns-alloc-test>", &loop, false)
	lava.result_destroy(&result)

	// A bad free here is the dns request allocator mismatch this fix targets; it would
	// also catch any other eval-time allocation freed with the wrong allocator.
	testing.expectf(
		t,
		len(track.bad_free_array) == 0,
		"eval of a dns lookup under a tracking allocator recorded %d bad free(s)",
		len(track.bad_free_array),
	)
}

// What a pool worker writes into must come from the heap, never from the allocator the
// runtime was handed (#34, ported from larva#49): the node:dns request and fetch's
// DNS_Job (with its host, which core:net re-reads for each address family). A worker
// blocked in a lookup can outlive its loop's owner — a detached loop's last worker
// frees them — and an embedder may free its allocator the moment the runtime returns.
// In Lava, eval joins its workers, so nothing fails yet when they come from the
// runtime allocator instead; the contract is pinned here, where it is observable:
// neither allocating proc may route a single allocation through eval's allocator.
//
// LAVA-ONLY: an allocator choice has no Node-visible effect. Neither lookup reads
// net.dns_configuration, which pool_cancel_hooks_test swaps process-wide: node:dns gets
// an IP literal (core:net returns it before any DNS), and fetch, which sends every
// non-literal host through fetch_dns_submit, gets one with an underscore —
// core:net's validate_hostname (core/net/dns.odin:603) rejects it before
// _get_dns_records_os loads resolv.conf (core/net/dns_unix.odin:37), so the fetch
// rejects without touching the network. The submit's allocations are all this test
// needs.

@(private = "file")
Watched_Allocator :: struct {
	backing: mem.Allocator,
	hits:    int, // atomic: allocations made from one of the watched procs
}

@(private = "file")
WATCHED_PROCS :: [?]string{"dns_lookup_cb", "fetch_dns_submit"}

@(private = "file")
watched_allocator_proc :: proc(
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
	w := cast(^Watched_Allocator)data
	if mode == .Alloc || mode == .Alloc_Non_Zeroed {
		for p in WATCHED_PROCS {
			if loc.procedure == p do sync.atomic_add(&w.hits, 1)
		}
	}
	return w.backing.procedure(w.backing.data, mode, size, alignment, old_memory, old_size, loc)
}

@(test)
eval_dns_workers_own_their_requests_on_the_heap :: proc(t: ^testing.T) {
	track: mem.Tracking_Allocator
	mem.tracking_allocator_init(&track, runtime.heap_allocator())
	defer mem.tracking_allocator_destroy(&track)
	watched := Watched_Allocator {
		backing = mem.tracking_allocator(&track),
	}
	context.allocator = mem.Allocator{watched_allocator_proc, &watched}

	loop := eventloop.init()
	src := `require('node:dns').lookup('127.0.0.1', () => {});
fetch('http://lava_heap.invalid:1/').then(() => {}, () => {});`
	result := lava.eval(src, "<dns-heap-test>", &loop, false)
	lava.result_destroy(&result)

	testing.expectf(
		t,
		sync.atomic_load(&watched.hits) == 0,
		"%d allocation(s) for a pool worker's DNS request came from eval's allocator, not the heap",
		sync.atomic_load(&watched.hits),
	)
	testing.expectf(t, len(track.bad_free_array) == 0, "recorded %d bad free(s)", len(track.bad_free_array))
}
