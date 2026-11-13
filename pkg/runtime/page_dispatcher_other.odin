#+build !linux
package lava_runtime

import "base:runtime"

// The page dispatcher's workers drive page runners, which are Linux-only
// (page_runner_other.odin). Elsewhere it refuses to start, honestly, rather than
// pretend; nothing is ever submitted, so on_done is never called.

Dispatch_Done_Proc :: proc(dispatcher: ^Page_Dispatcher, user_data: rawptr, result: Result)

Page_Dispatcher :: struct {
	on_done: Dispatch_Done_Proc,
}

page_dispatcher_init :: proc(
	d: ^Page_Dispatcher,
	threads: int,
	pages_per_thread: int,
	on_done: Dispatch_Done_Proc,
	heap_sample_every := 0,
	allocator: runtime.Allocator = {},
) -> bool {
	d^ = {}
	return false
}

page_dispatcher_submit :: proc(
	d: ^Page_Dispatcher,
	source: string,
	source_name: string,
	limits: Page_Limits = {},
	user_data: rawptr = nil,
) -> bool {
	return false
}

page_dispatcher_load :: proc(d: ^Page_Dispatcher, out: []int) {}

page_dispatcher_shutdown :: proc(d: ^Page_Dispatcher, cancel := false) {}
