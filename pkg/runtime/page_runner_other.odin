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

// page_runner_init returned false, so the runner is unusable: a page opened on it is
// neither run nor reported (on_done was never kept). Linux-first, as above.
page_runner_open :: proc(runner: ^Page_Runner, source: string, source_name: string, limits: Page_Limits, user_data: rawptr = nil) {}

page_runner_live :: proc(runner: ^Page_Runner) -> int {return 0}

page_runner_run :: proc(runner: ^Page_Runner) {}

page_runner_reaping :: proc(runner: ^Page_Runner) -> int {return 0}

page_runner_reap :: proc(runner: ^Page_Runner) -> int {return 0}
