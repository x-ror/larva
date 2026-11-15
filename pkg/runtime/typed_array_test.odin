package lava_runtime

import "core:mem"
import "core:testing"
import jsc "lava:pkg/jsc"

@(test)
make_uint8_array_uninit_uses_heap_allocator :: proc(t: ^testing.T) {
	track: mem.Tracking_Allocator
	mem.tracking_allocator_init(&track, context.allocator)
	defer mem.tracking_allocator_destroy(&track)
	context.allocator = mem.tracking_allocator(&track)

	ctx := jsc.JSGlobalContextCreate(nil)
	defer jsc.JSGlobalContextRelease(ctx)

	val, ok := make_uint8_array_uninit(ctx, 64)
	testing.expect(t, ok, "make_uint8_array_uninit(64) should succeed")
	testing.expect(t, val != nil, "make_uint8_array_uninit(64) should return non-nil value")
	testing.expectf(
		t,
		len(track.allocation_map) == 0,
		"make_uint8_array_uninit allocated %d block(s) on ambient allocator instead of heap_allocator",
		len(track.allocation_map),
	)
}
