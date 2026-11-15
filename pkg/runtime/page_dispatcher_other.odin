#+build !linux
package lava_runtime

import "base:runtime"

// The dispatcher's workers are page runners, which exist only on Linux
// (page_runner_other.odin). Linux-first: elsewhere the dispatcher refuses to start —
// init returns false and starts no thread — rather than pretend; every page it is then
// handed is refused by submit (false: not accepted, on_done never runs).

Dispatch_Done_Proc :: proc(d: ^Page_Dispatcher, user_data: rawptr, result: Result)

Page_Dispatcher :: struct {
	on_done: Dispatch_Done_Proc,
}

page_dispatcher_init :: proc(
	d: ^Page_Dispatcher,
	threads, pages_per_thread: int,
	on_done: Dispatch_Done_Proc,
	heap_sample_every := 0,
	allocator: runtime.Allocator = {},
) -> bool {
	d^ = {}
	return false
}

page_dispatcher_submit :: proc(
	d: ^Page_Dispatcher,
	source, source_name: string,
	limits: Page_Limits,
	user_data: rawptr = nil,
) -> bool {
	return false
}

page_dispatcher_shutdown :: proc(d: ^Page_Dispatcher, cancel := false) {}

page_dispatcher_load :: proc(d: ^Page_Dispatcher, out: []int) -> int {return 0}
