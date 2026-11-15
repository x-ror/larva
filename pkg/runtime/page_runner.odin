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
// page's loop ever blocks on its own (never_block), and a waiting page costs no CPU —
// except one whose loop has no descriptor to wait on, which is polled every 1 ms
// (runner_wait).
//
// What one page cannot do to the others on the thread: run past its CPU budget (a
// kill ends that page only — its loop is force-exited and closed, the rest keep
// ticking), leave its VM behind (closing a page returns it), or hold the thread on
// blocking pool work. A page whose loop still has a pool worker inside a job when it
// closes — an fs read on a FIFO, a DNS lookup the resolver has not answered — closes
// at once all the same: page_close releases its JS side, and its loop goes to the
// reaping list, where the runner waits for the worker through the loop's wakeup pipe
// and finishes the loop once it exits (#34). The list is bounded (reap_limit): a page
// can still pin a few threads and descriptors for as long as its job blocks, but not
// the runner's thread, and not without bound.
//
// What it can do, all listed in docs/LARVA.md decision 2 as open work:
//   - delay its siblings by up to its budget, not its entry limit: one page_tick
//     fires every timer already due, and the thread's CPU is shared;
//   - under the Node profile, reach the process-wide fd table (leak to EMFILE, close
//     a sibling's descriptor). The runner is not a security boundary there.
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

// A live page. Its loop is on the heap, not the runner allocator: workers hold a
// pointer to it, so its address must not move, and if the page closes with a worker
// still busy the loop outlives the page — and, after page_runner_destroy, the runner.
@(private = "file")
Runner_Page :: struct {
	page:      Page,
	loop:      ^eventloop.Loop,
	user_data: rawptr,
	fd:        linux.Fd,
}

// RUNNER_REAP_LIMIT is the default bound on a runner's reaping list (Page_Runner.
// reap_limit). Each entry holds a loop's wakeup pipe (2 fds) and up to
// THREADPOOL_SIZE threads, some of them blocked for as long as the work they were
// given: a page reading a FIFO nobody writes never releases its entry. Unbounded,
// the list would turn the thread hang it replaced into process-wide thread and fd
// exhaustion; at the bound the runner refuses new pages instead (.Reaping_Full).
RUNNER_REAP_LIMIT :: 8

// Reaping_Loop is a closed page's loop that close_begin left with a busy pool worker.
// The page's JS side is gone; what remains is the loop's memory, its pool threads and
// its wakeup pipe, all on the heap, never on the runner allocator, so that
// page_runner_destroy can leave them to the workers.
Reaping_Loop :: struct {
	loop: ^eventloop.Loop,
	// The loop's wakeup-pipe read end while it sits in the runner's epoll set, else
	// -1 (then the runner polls the entry every millisecond instead of sleeping).
	fd:   linux.Fd,
}

Page_Runner :: struct {
	pages:      [dynamic]^Runner_Page,
	// Closed pages' loops still waiting on a worker, reaped by the runner as their
	// workers exit (runner_reap). Backed by the runner allocator, bound at init.
	reaping:    [dynamic]Reaping_Loop,
	// The bound on `reaping`; RUNNER_REAP_LIMIT unless the embedder lowers it after
	// page_runner_init.
	reap_limit: int,
	// The runner's own VMs, so the number of live VMs — and of permanent timerfds —
	// is bounded by the runner's capacity, not by how many pages it ever ran.
	pool:       VM_Pool,
	epfd:       linux.Fd,
	allocator:  runtime.Allocator,
	on_done:    Page_Done_Proc,
	// Pages that finished without being ticked (at open, or cancelled), waiting for
	// their on_done call.
	done:       [dynamic]Done_Page,
	closing:    bool,
}

// page_runner_init prepares a runner that can hold up to `capacity` live pages (one
// VM each). `allocator` owns the runner's bookkeeping, every page's runtime state and
// the Results handed to on_done; it must outlive the runner (CLAUDE.md §4). Page loops
// are the exception: they are on the heap (Runner_Page says why).
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
	runner.reaping = make([dynamic]Reaping_Loop, allocator)
	runner.reap_limit = RUNNER_REAP_LIMIT
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
//
// It does not wait for blocking pool work: a reaping loop whose worker is still inside
// its job is detached (eventloop.close_detach) and finished by that worker's own last
// exit — its pool, its pipe and the loop itself are on the heap, so the runner
// allocator may be freed the moment this returns. Pinned by
// runner_destroy_detaches_loops_whose_workers_are_blocked.
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
	runner_reap(runner)
	for e in runner.reaping {
		if e.fd >= 0 do linux.epoll_ctl(runner.epfd, .DEL, e.fd, nil)
		if !eventloop.close_detach(e.loop) do free(e.loop, runtime.heap_allocator())
	}
	delete(runner.reaping)
	delete(runner.pages)
	delete(runner.done)
	vm_pool_destroy(&runner.pool)
	if runner.epfd > 0 do linux.close(runner.epfd)
	runner^ = {}
}

// page_runner_open starts a page: its runtime install and top-level script run now,
// and its loop joins the runner. A page that finishes during the open — a throw, a
// kill, a full pool, a refusal — is reported to on_done from the next
// page_runner_run; one with nothing scheduled is reported on its first tick. The temp
// arena does not survive this call — the page's require() calls reset it
// (native_require_cb), and the open resets it once more at the end so a chain of
// opens cannot grow it — so `source` and anything else the caller still needs must
// not live in it.
//
// A page is refused with Kill_Reason.Reaping_Full (status .Execution_Error), before it
// takes a loop or a VM, while the reaping list holds reap_limit loops after a reap
// pass. Pinned by runner_refuses_pages_while_its_reaping_list_is_full.
//
// Params:
//   limits  Must carry a CPU budget (cpu_budget > 0); there is no default, so a
//           caller that forgets the argument does not compile. A page without one is
//           refused with .Invalid_Input before it takes a loop or a VM. The budget,
//           not the entry limit, is what bounds a page's whole life — an endless
//           chain of short callbacks never trips an entry limit — and so what makes
//           "a page that spins is killed alone" hold for every caller. Negative and
//           NaN read as "no budget" to vm_set_cpu_budget, and are refused alike.
//           Pinned by runner_refuses_a_page_without_a_cpu_budget.
page_runner_open :: proc(
	runner: ^Page_Runner,
	source: string,
	source_name: string,
	limits: Page_Limits,
	user_data: rawptr = nil,
) {
	context.allocator = runner.allocator
	defer free_all(context.temp_allocator)
	if runner.closing {
		append(&runner.done, Done_Page{user_data, page_killed_result(.Cancelled)})
		return
	}
	// `!(x > 0)`, not `x <= 0`: NaN compares false both ways.
	if !(limits.cpu_budget > 0) {
		append(&runner.done, Done_Page{user_data, Result{status = .Invalid_Input, exit_code = 2, message = "page runner: a page needs a CPU budget (Page_Limits.cpu_budget > 0)"}})
		return
	}
	// Reap first, so the bound counts only loops whose workers are still busy.
	if runner_reap(runner) >= runner.reap_limit {
		append(&runner.done, Done_Page{user_data, page_killed_result(.Reaping_Full)})
		return
	}
	rp := new(Runner_Page, runner.allocator)
	rp.user_data = user_data
	rp.fd = -1
	rp.loop = new(eventloop.Loop, runtime.heap_allocator())
	rp.loop^ = eventloop.init(runtime.heap_allocator(), real_time = true)
	rp.loop.never_block = true
	append(&runner.pages, rp)
	index := len(runner.pages) - 1

	if !page_open(&rp.page, source, source_name, rp.loop, false, nil, limits, &runner.pool, runner_page = true) {
		runner_finish(runner, index, deliver = false)
		return
	}
	// Edge-triggered: a CQE or watched fd the page's own tick is not going to reap
	// (an I/O-free page waiting on a timer, say) must not keep the runner's wait
	// returning at once; a new arrival still wakes it.
	if fd, ok := eventloop.backend_fd(rp.loop); ok {
		ev := linux.EPoll_Event {
			events = {.IN, .ET},
		}
		if linux.epoll_ctl(runner.epfd, .ADD, linux.Fd(fd), &ev) == .NONE do rp.fd = linux.Fd(fd)
	}
	// A loop the runner cannot wait on is still ticked every round; it only loses the
	// ability to wake a blocked runner, so runner_wait never blocks while one is live.
}

// page_runner_reaping is the number of closed pages whose loops still wait on a pool
// worker (see Reaping_Loop).
page_runner_reaping :: proc(runner: ^Page_Runner) -> int {
	return len(runner.reaping)
}

// page_runner_reap finishes every reaping loop whose workers have exited, without
// waiting on the others, and returns how many remain. page_runner_run and
// page_runner_open reap on their own; this is for an embedder between runs.
page_runner_reap :: proc(runner: ^Page_Runner) -> int {
	context.allocator = runner.allocator
	return runner_reap(runner)
}

// page_runner_live is the number of pages still running.
page_runner_live :: proc(runner: ^Page_Runner) -> int {
	return len(runner.pages)
}

// page_runner_run ticks the live pages until none is left, including pages that
// on_done opens along the way. Reaping loops are finished as their workers exit — a
// worker's exit writes its loop's wakeup pipe, which wakes a blocked runner — but the
// run does not wait for them: it returns once no page is live, whatever is still on
// the reaping list (page_runner_reap, page_runner_destroy).
page_runner_run :: proc(runner: ^Page_Runner) {
	context.allocator = runner.allocator
	for len(runner.pages) > 0 || len(runner.done) > 0 {
		runner_report_done(runner)
		runner_reap(runner)
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
// becomes ready, or the nearest timer across all pages comes due. A reaping loop's
// wakeup pipe wakes it too, so a loop is reaped soon after its worker exits.
@(private = "file")
runner_wait :: proc(runner: ^Page_Runner) {
	timeout := -1
	for e in runner.reaping {
		if e.fd < 0 do timeout = 1
	}
	for rp in runner.pages {
		// A page the runner cannot wait on is polled every millisecond instead: not
		// slept through, and not spun on either, since every spin tick would be charged
		// to some page's CPU budget.
		if rp.fd < 0 && (timeout < 0 || timeout > 1) do timeout = 1
		hint := eventloop.wait_hint_ms(rp.loop)
		if hint == 0 do return
		if hint > 0 && (timeout < 0 || hint < timeout) do timeout = hint
	}
	events: [16]linux.EPoll_Event
	// EINTR or a spurious wake only costs one more round.
	linux.epoll_wait(runner.epfd, raw_data(events[:]), i32(len(events)), i32(timeout))
}

// runner_finish closes page `index`, removes it, and reports its Result — now, or,
// with `deliver` false (inside page_runner_open), from the run loop. The page's loop
// descriptor leaves the runner's epoll set before the loop closes it. A loop that
// page_close hands back with a busy worker goes to the reaping list; any other is
// closed by now, and only its struct is left to free.
@(private = "file")
runner_finish :: proc(runner: ^Page_Runner, index: int, deliver := true) {
	rp := runner.pages[index]
	unordered_remove(&runner.pages, index)
	if rp.fd >= 0 do linux.epoll_ctl(runner.epfd, .DEL, rp.fd, nil)
	result, busy_loop := page_close(&rp.page)
	if busy_loop != nil {
		runner_reap_add(runner, busy_loop)
	} else {
		free(rp.loop, runtime.heap_allocator())
	}
	user_data := rp.user_data
	free(rp, runner.allocator)
	if !deliver {
		append(&runner.done, Done_Page{user_data, result})
		return
	}
	runner_deliver(runner, user_data, result)
}

// runner_reap_add puts a closed page's loop on the reaping list, waiting on its wakeup
// pipe's read end. Edge-triggered, like a live page's descriptor; runner_reap drains
// the pipe before it checks the loop, so a wakeup written after the check raises a
// new edge rather than being consumed unseen. A pipe the epoll set will not take
// leaves the entry polled every millisecond (runner_wait), never stranded.
@(private = "file")
runner_reap_add :: proc(runner: ^Page_Runner, loop: ^eventloop.Loop) {
	e := Reaping_Loop {
		loop = loop,
		fd   = -1,
	}
	if fd, ok := eventloop.wakeup_fd(loop); ok {
		ev := linux.EPoll_Event {
			events = {.IN, .ET},
		}
		if linux.epoll_ctl(runner.epfd, .ADD, fd, &ev) == .NONE do e.fd = fd
	}
	append(&runner.reaping, e)
}

// runner_reap finishes every reaping loop whose workers have all exited and returns how
// many are left. It never waits: close_finish runs only once close_ready, when the
// join has nothing left to wait for but the threads' exit epilogues. The loop leaves
// the epoll set before close_finish closes its pipe.
@(private = "file")
runner_reap :: proc(runner: ^Page_Runner) -> int {
	i := 0
	for i < len(runner.reaping) {
		e := runner.reaping[i]
		if e.fd >= 0 do eventloop.drain_wakeup(e.loop)
		if !eventloop.close_ready(e.loop) {
			i += 1
			continue
		}
		if e.fd >= 0 do linux.epoll_ctl(runner.epfd, .DEL, e.fd, nil)
		eventloop.close_finish(e.loop)
		free(e.loop, runtime.heap_allocator())
		unordered_remove(&runner.reaping, i)
	}
	return len(runner.reaping)
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
