// Linux-only: net's native socket path exists only there.
#+build linux
package main

import "core:mem"
import "core:strings"
import "core:testing"
import lava "lava:pkg/runtime"
import eventloop "lava:pkg/runtime/eventloop"

// A loopback round trip: the server echoes what the client writes, so both ends
// receive bytes through net's read path, each chunk copied into a NoCopy
// Uint8Array. Dropped at the end, they are reclaimed by JSC (GC or context
// release) through jsc_buffer_deallocator, which frees into the heap.
@(private = "file")
NOCOPY_NET_SRC :: `
const net = require('net');
const srv = net.createServer((s) => {
  s.on('data', (d) => s.write(d));
  s.on('end', () => s.end());
});
srv.listen(0, '127.0.0.1', () => {
  const c = net.connect(srv.address().port, '127.0.0.1', () => c.write('hello nocopy bytes'));
  let got = 0;
  c.on('data', (d) => { got += d.length; if (got >= 18) c.end(); });
  c.on('close', () => srv.close());
});
`

// live_net_allocations counts what is still live in the tracker from net.odin.
@(private = "file")
live_net_allocations :: proc(track: ^mem.Tracking_Allocator) -> int {
	n := 0
	for _, entry in track.allocation_map {
		if strings.has_suffix(entry.location.file_path, "net.odin") do n += 1
	}
	return n
}

// net's read callbacks run on the loop, under eval's (the embedder's) context,
// not runtime.default_context(). The bytes they hand to JSC as a NoCopy
// Uint8Array are freed by jsc_buffer_deallocator, which can only free into the
// heap: it is a `proc "c"` with no Odin context of its own. So the copy must be
// made from runtime.heap_allocator(), never the ambient allocator.
//
// With a tracking allocator as eval's ambient allocator, an ambient copy is
// owned by the tracker but freed by JSC straight into the heap: the run dies
// with a signal (verified: SIGSEGV, reverting conn_read_cb's copy alone), and
// short of a crash it would stay live in the tracker as a net.odin allocation.
// The fixed code never routes these bytes through the tracker.
@(test)
nocopy_net_bytes_never_use_the_ambient_allocator :: proc(t: ^testing.T) {
	track: mem.Tracking_Allocator
	mem.tracking_allocator_init(&track, context.allocator)
	defer mem.tracking_allocator_destroy(&track)
	// Bad frees are recorded, not asserted: Net_Server is made under a `proc "c"`
	// native (heap) and freed on the loop (ambient), a separate pairing defect that
	// this script's listener trips. This test pins only the read-path copies.
	track.bad_free_callback = mem.tracking_allocator_bad_free_callback_add_to_array
	context.allocator = mem.tracking_allocator(&track)

	// conn_read_cb, the readiness backend's read path, is the one that runs under
	// the loop's (eval's) context; the io_uring completions reset to the heap.
	eventloop.force_readiness_backend = true
	defer eventloop.force_readiness_backend = false
	loop := eventloop.init(real_time = true)
	result := lava.eval(NOCOPY_NET_SRC, "<nocopy-bytes-alloc-test>", &loop, false)
	defer lava.result_destroy(&result)
	testing.expect_value(t, result.status, lava.Status.Ok)

	leaked := live_net_allocations(&track)
	testing.expectf(t, leaked == 0, "%d net.odin allocation(s) handed to JSC from the ambient allocator", leaked)
}
