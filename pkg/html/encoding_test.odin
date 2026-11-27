#+build linux
package larva_html

import "core:mem"
import "core:strings"
import "core:testing"

// What tests/dom's charset cases cannot see: which allocator the decoded text lives in,
// and the output growing past the shim's fixed buffers. The cases themselves are the
// oracle for what a byte decodes to.

// 0x80 is U+20AC in windows-1252: one byte in, three out, so 5000 of them cross the
// shim's 1024-codepoint buffer several times and grow the sink past the reservation
// decode_document makes (the input's length). All of it must come from the allocator
// passed in, and go back to it with one delete.
@(test)
decode_document_grows_through_the_callers_allocator :: proc(t: ^testing.T) {
	track: mem.Tracking_Allocator
	mem.tracking_allocator_init(&track, context.allocator)
	defer mem.tracking_allocator_destroy(&track)
	alloc := mem.tracking_allocator(&track)

	input := make([]byte, 5000, context.temp_allocator)
	for &b in input {
		b = 0x80
	}

	text, enc, ok := decode_document(input, "", alloc)
	testing.expect(t, ok, "decode failed")
	testing.expectf(t, enc.name == "windows-1252" && enc.source == .Default, "sniffed %v", enc)
	testing.expectf(t, len(text) == 15000, "want 15000 bytes of U+20AC, got %d", len(text))
	testing.expect(t, string(text) == strings.repeat("€", 5000, context.temp_allocator), "wrong text")
	testing.expect(t, track.total_allocation_count > 1, "the sink never grew through the caller's allocator")

	delete(text, alloc)
	testing.expectf(t, len(track.allocation_map) == 0, "%d allocations left after delete", len(track.allocation_map))
	testing.expectf(t, len(track.bad_free_array) == 0, "%d bad frees", len(track.bad_free_array))
}
