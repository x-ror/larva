#+build linux, darwin
package main

import "base:runtime"
import "core:mem"
import "core:sync"
import "core:testing"
import lava "lava:pkg/runtime"
import eventloop "lava:pkg/runtime/eventloop"

// What a pool worker writes into must come from the heap, never from the allocator the
// runtime was handed (#34, ported from larva#49): fetch's DNS_Job, with its host, which
// core:net re-reads for each address family. A worker blocked in a lookup can outlive
// its loop's owner — a detached loop's last worker frees the job — and an embedder may
// free its allocator the moment the runtime returns. In Lava, eval joins its workers, so
// nothing fails yet when the job comes from the runtime allocator instead; the contract
// is pinned here, where it is observable: fetch_dns_submit may not route a single
// allocation through eval's allocator.
//
// This was the fetch half of dns_alloc_test.odin, which also watched node:dns's request;
// that half went with node:dns (Node-profile removal S3).
//
// LAVA-ONLY: an allocator choice has no Web-visible effect. fetch sends every non-literal
// host through fetch_dns_submit; this one carries an underscore, which core:net's
// validate_hostname (core/net/dns.odin:603) rejects before _get_dns_records_os loads
// resolv.conf (core/net/dns_unix.odin:37), so the fetch rejects without touching the
// network. The submit's allocations are all this test needs.

@(private = "file")
Watched_Allocator :: struct {
	backing: mem.Allocator,
	hits:    int, // atomic: allocations made from fetch_dns_submit
}

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

	if (mode == .Alloc || mode == .Alloc_Non_Zeroed) && loc.procedure == "fetch_dns_submit" {
		sync.atomic_add(&w.hits, 1)
	}

	return w.backing.procedure(w.backing.data, mode, size, alignment, old_memory, old_size, loc)
}

@(test)
eval_fetch_dns_jobs_live_on_the_heap :: proc(t: ^testing.T) {
	track: mem.Tracking_Allocator
	mem.tracking_allocator_init(&track, runtime.heap_allocator())
	defer mem.tracking_allocator_destroy(&track)
	watched := Watched_Allocator {
		backing = mem.tracking_allocator(&track),
	}
	context.allocator = mem.Allocator{watched_allocator_proc, &watched}

	loop := eventloop.init()
	src := `fetch('http://lava_heap.invalid:1/').then(() => {}, () => {});`
	result := lava.eval(src, "<fetch-dns-heap-test>", &loop, false)
	lava.result_destroy(&result)

	testing.expectf(
		t,
		sync.atomic_load(&watched.hits) == 0,
		"%d allocation(s) for a pool worker's DNS job came from eval's allocator, not the heap",
		sync.atomic_load(&watched.hits),
	)
	testing.expectf(t, len(track.bad_free_array) == 0, "recorded %d bad free(s)", len(track.bad_free_array))
}
