#+build linux
package lava_runtime

import "base:runtime"
import "core:sys/linux"
import eventloop "lava:pkg/runtime/eventloop"

// A page runner drives many pages concurrently on the calling thread (docs/LARVA.md
// decision 2: many VMs per thread). Each page has its own VM, from the runner's pool,
// and its own event loop (page.odin says why a loop per page). The runner gives
// every live page one tick per round; when a whole round makes no progress it blocks
// on all the pages' loop descriptors at once, bounded by the nearest timer. So no
// page's loop ever blocks on its own (never_block), and a page that is waiting costs
// nothing.
//
// What one page cannot do to the others on the thread: run past its CPU limits (a
// kill ends that page only — its loop is force-exited and closed, the rest keep
// ticking), or leave anything behind (closing a page destroys its loop and returns
// its VM). What it can do: delay them for up to its entry limit, since they share
// the thread's CPU. Threads are sized to cores.
//
// Thread-confined: a runner and its pages are only ever touched by the thread that
// called page_runner_init.

// Page_Done_Proc receives a finished page's Result, exactly once per page opened,
// and owns it (result_destroy). It is only ever called from page_runner_run or
// page_runner_destroy, never from inside page_runner_open, so a feed of pages that
// fail at open cannot recurse. It may open further pages: they join the running set
// — except once page_runner_destroy has begun, when they are reported .Cancelled
// without running.
Page_Done_Proc :: proc(runner: ^Page_Runner, user_data: rawptr, result: Result)

@(private = "file")
Done_Page :: struct {
	user_data: rawptr,
	result:    Result,
}

@(private = "file")
Runner_Page :: struct {
	page:      Page,
	loop:      eventloop.Loop,
	user_data: rawptr,
	fd:        linux.Fd,
}

Page_Runner :: struct {
	pages:     [dynamic]^Runner_Page,
	// The runner's own VMs, so the number of live VMs — and of permanent timerfds —
	// is bounded by the runner's capacity, not by how many pages it ever ran.
	pool:      VM_Pool,
	epfd:      linux.Fd,
	allocator: runtime.Allocator,
	on_done:   Page_Done_Proc,
	// Pages that finished without being ticked (at open, or cancelled), waiting for
	// their on_done call.
	done:      [dynamic]Done_Page,
	closing:   bool,
}

// page_runner_init prepares a runner that can hold up to `capacity` live pages (one
// VM each). `allocator` owns the runner's bookkeeping, every page's loop and runtime
// state, and the Results handed to on_done; it must outlive the runner (CLAUDE.md §4).
// The runner's entry points install it as context.allocator themselves, so pages are
// created and freed through it whatever context the caller runs them under.
//
// Returns:
//   false when the epoll instance cannot be created; the runner is then unusable.
page_runner_init :: proc(
	runner: ^Page_Runner,
	capacity: int,
	on_done: Page_Done_Proc,
	allocator: runtime.Allocator,
) -> bool {
	runner^ = {}
	runner.allocator = allocator
	runner.on_done = on_done
	runner.pages = make([dynamic]^Runner_Page, 0, max(capacity, 1), allocator)
	runner.done = make([dynamic]Done_Page, allocator)
	vm_pool_init(&runner.pool, capacity, allocator)
	epfd, err := linux.epoll_create1({.FDCLOEXEC})
	if err != .NONE {
		page_runner_destroy(runner)
		return false
	}
	runner.epfd = epfd
	return true
}

// page_runner_destroy cancels every page still live — each is torn down and reported
// .Cancelled, along with any page on_done opens meanwhile — then destroys the
// runner's VMs.
page_runner_destroy :: proc(runner: ^Page_Runner) {
	context.allocator = runner.allocator
	runner.closing = true
	for len(runner.pages) > 0 || len(runner.done) > 0 {
		for len(runner.pages) > 0 {
			page_cancel(&runner.pages[len(runner.pages) - 1].page)
			runner_finish(runner, len(runner.pages) - 1)
		}
		runner_report_done(runner)
	}
	delete(runner.pages)
	delete(runner.done)
	vm_pool_destroy(&runner.pool)
	if runner.epfd > 0 do linux.close(runner.epfd)
	runner^ = {}
}

// page_runner_open starts a page: its runtime install and top-level script run now,
// and its loop joins the runner. A page that finishes during the open — a throw, a
// kill, a full pool — is reported to on_done from the next page_runner_run; one with
// nothing scheduled is reported on its first tick. The temp arena is reset after the
// open, like eval's: nothing a caller keeps across this call may live in it.
page_runner_open :: proc(
	runner: ^Page_Runner,
	source: string,
	source_name: string,
	limits: Page_Limits = {},
	user_data: rawptr = nil,
) {
	context.allocator = runner.allocator
	defer free_all(context.temp_allocator)
	if runner.closing {
		append(&runner.done, Done_Page{user_data, page_killed_result(.Cancelled)})
		return
	}
	rp := new(Runner_Page, runner.allocator)
	rp.user_data = user_data
	rp.fd = -1
	rp.loop = eventloop.init(runner.allocator, real_time = true)
	rp.loop.never_block = true
	append(&runner.pages, rp)
	index := len(runner.pages) - 1

	if !page_open(&rp.page, source, source_name, &rp.loop, false, nil, limits, &runner.pool, runner_page = true) {
		runner_finish(runner, index, deliver = false)
		return
	}
	// Edge-triggered: a CQE or watched fd the page's own tick is not going to reap
	// (an I/O-free page waiting on a timer, say) must not keep the runner's wait
	// returning at once; a new arrival still wakes it.
	if fd, ok := eventloop.backend_fd(&rp.loop); ok {
		ev := linux.EPoll_Event {
			events = {.IN, .ET},
		}
		if linux.epoll_ctl(runner.epfd, .ADD, linux.Fd(fd), &ev) == .NONE do rp.fd = linux.Fd(fd)
	}
	// A loop the runner cannot wait on is still ticked every round; it only loses the
	// ability to wake a blocked runner, so runner_wait never blocks while one is live.
}

// page_runner_live is the number of pages still running.
page_runner_live :: proc(runner: ^Page_Runner) -> int {
	return len(runner.pages)
}

// page_runner_run ticks the live pages until none is left, including pages that
// on_done opens along the way.
page_runner_run :: proc(runner: ^Page_Runner) {
	context.allocator = runner.allocator
	for len(runner.pages) > 0 || len(runner.done) > 0 {
		runner_report_done(runner)
		progressed := false
		i := 0
		for i < len(runner.pages) {
			alive, did_work := page_tick(&runner.pages[i].page)
			if !alive {
				// Swap-removes index i, so the page moved into it is ticked next.
				runner_finish(runner, i)
				progressed = true
				continue
			}
			if did_work do progressed = true
			i += 1
		}
		if !progressed && len(runner.pages) > 0 do runner_wait(runner)
	}
}

// runner_wait blocks until some page can make progress: an fd of any page's loop
// becomes ready, or the nearest timer across all pages comes due.
@(private = "file")
runner_wait :: proc(runner: ^Page_Runner) {
	timeout := -1
	for rp in runner.pages {
		// A page the runner cannot wait on is polled every millisecond instead: not
		// slept through, and not spun on either, since every spin tick would be charged
		// to some page's CPU budget.
		if rp.fd < 0 && (timeout < 0 || timeout > 1) do timeout = 1
		hint := eventloop.wait_hint_ms(&rp.loop)
		if hint == 0 do return
		if hint > 0 && (timeout < 0 || hint < timeout) do timeout = hint
	}
	events: [16]linux.EPoll_Event
	// EINTR or a spurious wake only costs one more round.
	linux.epoll_wait(runner.epfd, raw_data(events[:]), i32(len(events)), i32(timeout))
}

// runner_finish closes page `index`, removes it, and reports its Result — now, or,
// with `deliver` false (inside page_runner_open), from the run loop. The page's loop
// descriptor leaves the runner's epoll set before the loop closes it.
@(private = "file")
runner_finish :: proc(runner: ^Page_Runner, index: int, deliver := true) {
	rp := runner.pages[index]
	unordered_remove(&runner.pages, index)
	if rp.fd >= 0 do linux.epoll_ctl(runner.epfd, .DEL, rp.fd, nil)
	result := page_close(&rp.page)
	user_data := rp.user_data
	free(rp, runner.allocator)
	if !deliver {
		append(&runner.done, Done_Page{user_data, result})
		return
	}
	runner_deliver(runner, user_data, result)
}

// runner_report_done hands every queued Result to on_done. on_done may queue more
// (a page it opens that fails at open); they are reported in the same pass.
@(private = "file")
runner_report_done :: proc(runner: ^Page_Runner) {
	for len(runner.done) > 0 {
		d := pop_front(&runner.done)
		runner_deliver(runner, d.user_data, d.result)
	}
}

@(private = "file")
runner_deliver :: proc(runner: ^Page_Runner, user_data: rawptr, result: Result) {
	result := result
	if runner.on_done != nil {
		runner.on_done(runner, user_data, result)
	} else {
		result_destroy(&result)
	}
}
