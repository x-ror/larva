#+build !linux
package lava_runtime

import "base:runtime"

// The page runner blocks on every page loop's descriptor through epoll, which only
// the Linux backend exposes (eventloop.backend_fd). Linux-first: elsewhere the runner
// refuses to start rather than pretend, and eval still runs one page at a time.

Page_Done_Proc :: proc(runner: ^Page_Runner, user_data: rawptr, result: Result)

Page_Runner :: struct {
	on_done: Page_Done_Proc,
}

page_runner_init :: proc(runner: ^Page_Runner, capacity: int, on_done: Page_Done_Proc, allocator: runtime.Allocator) -> bool {
	runner^ = {}
	return false
}

page_runner_destroy :: proc(runner: ^Page_Runner) {}

// Reports the page as not run, so the exactly-once on_done contract still holds.
page_runner_open :: proc(runner: ^Page_Runner, source: string, source_name: string, limits: Page_Limits = {}, user_data: rawptr = nil) {
	if runner.on_done != nil {
		runner.on_done(runner, user_data, vm_pool_unavailable("page runner is not supported on this platform"))
	}
}

page_runner_live :: proc(runner: ^Page_Runner) -> int {return 0}

page_runner_run :: proc(runner: ^Page_Runner) {}
