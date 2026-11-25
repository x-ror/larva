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
// ticking), leave its VM behind (closing a page returns it), hold the thread on
// blocking pool work, or starve its siblings of pool workers. The runner's pages share
// one worker pool (eventloop.Worker_Pool, #36): four core threads for the whole
// runner, not four per page, served round-robin across pages, with an overflow worker
// for a page left waiting behind jobs that stall (runner_round's pool_tick). A page
// whose job is still running when it closes — an fs read on a FIFO, a DNS lookup the
// resolver has not answered — closes at once all the same, loop included (#34): the
// job becomes an orphan its worker finishes and disposes on its own, and no completion
// can reach the closed loop. Orphans are bounded (orphan_limit): a page can still pin a
// thread for as long as its job blocks, but not the runner's thread, and not without
// bound.
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

// A live page. Its loop is on the heap, not the runner allocator: a pool worker grows
// the loop's async_queue through loop.allocator when it posts a completion, from its
// own thread, so that allocator must be thread-safe (eventloop.post_async), which the
// runner's — an arena, say — need not be.
@(private = "file")
Runner_Page :: struct {
	page:      Page,
	loop:      ^eventloop.Loop,
	user_data: rawptr,
	fd:        linux.Fd,
}

// RUNNER_ORPHAN_LIMIT is the default bound on a runner's orphans (Page_Runner.
// orphan_limit): jobs still running for pages that have closed. Each holds a pool
// worker for as long as the work it was given blocks — a page reading a FIFO nobody
// writes never releases its thread. Unbounded, they would turn the thread hang #34
// replaced into process-wide thread exhaustion; at the bound the runner refuses new
// pages instead (.Reaping_Full). 32 is chosen, not measured: it keeps the threads one
// runner can pin to what its reaping list allowed before #36 (8 loops x 4 workers).
RUNNER_ORPHAN_LIMIT :: 32

Page_Runner :: struct {
	pages:             [dynamic]^Runner_Page,
	// The runner thread's one worker pool, every page loop its client. On the heap: it
	// outlives the runner while orphans still run (page_runner_destroy).
	workers:           ^eventloop.Worker_Pool,
	// The bound on the pool's orphans; RUNNER_ORPHAN_LIMIT unless the embedder lowers
	// it after page_runner_init.
	orphan_limit:      int,
	// The runner's own VMs, so the number of live VMs — and of timerfds, kept for the
	// life of the runner's thread — is bounded by the runner's capacity, not by how
	// many pages it ever ran.
	pool:              VM_Pool,
	epfd:              linux.Fd,
	allocator:         runtime.Allocator,
	on_done:           Page_Done_Proc,
	// Pages that finished without being ticked (at open, or cancelled), waiting for
	// their on_done call.
	done:              [dynamic]Done_Page,
	closing:           bool,
	// Descriptors an embedder added to the runner's epoll set (page_runner_watch_fd),
	// so page_runner_step can block on them while no page is live.
	watched:           int,
	// Sample every Nth page's JS heap per VM into Result.heap_bytes; 0 (the default)
	// samples nothing. Set by the embedder after page_runner_init, like orphan_limit.
	// Sampled pages pay the heap walk outside their CPU budget (page_close says why).
	heap_sample_every: int,
}

// page_runner_init prepares a runner that can hold up to `capacity` live pages (one
// VM each). `allocator` owns the runner's bookkeeping, every page's runtime state and
// the Results handed to on_done; it must outlive the runner (CLAUDE.md §4). Page loops
// and the worker pool are the exception: they are on the heap (Runner_Page and
// Page_Runner.workers say why).
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
	runner.workers = eventloop.pool_create(runtime.heap_allocator())
	runner.orphan_limit = RUNNER_ORPHAN_LIMIT
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
// It does not wait for blocking pool work: the worker pool is released
// (eventloop.pool_release), its idle workers exit, and one still inside an orphan's job
// exits when that job returns — the last of them frees the pool. The pool and every
// orphan's job are on the heap, so the runner allocator may be freed the moment this
// returns. Pinned by runner_destroy_does_not_wait_for_blocked_workers.
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

	if runner.workers != nil {
		eventloop.pool_release(runner.workers)
	}

	delete(runner.pages)
	delete(runner.done)
	vm_pool_destroy(&runner.pool)

	if runner.epfd > 0 {
		linux.close(runner.epfd)
	}

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
// takes a loop or a VM, while orphan_limit jobs of closed pages are still running.
// Pinned by runner_refuses_pages_at_its_orphan_bound.
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
//   surface The global names the page can reach (Global_Surface, runtime.odin).
//           `.Node` by default; `.Web` hides process, require, Buffer and the rest
//           (#5). Each page gets a fresh global in its pooled VM, so pages of both
//           surfaces can take turns in one VM. Pinned by
//           runner_web_page_sees_no_node_names_in_a_reused_vm.
page_runner_open :: proc(
	runner: ^Page_Runner,
	source: string,
	source_name: string,
	limits: Page_Limits,
	user_data: rawptr = nil,
	surface: Global_Surface = .Node,
) {
	context.allocator = runner.allocator
	defer free_all(context.temp_allocator)

	if runner.closing {
		append(&runner.done, Done_Page{user_data, page_killed_result(.Cancelled)})
		return
	}

	// `!(x > 0)`, not `x <= 0`: NaN compares false both ways.
	if !(limits.cpu_budget > 0) {
		append(
			&runner.done,
			Done_Page {
				user_data,
				Result {
					status = .Invalid_Input,
					exit_code = 2,
					message = "page runner: a page needs a CPU budget (Page_Limits.cpu_budget > 0)",
				},
			},
		)
		return
	}

	if page_runner_orphans(runner) >= runner.orphan_limit {
		append(&runner.done, Done_Page{user_data, page_killed_result(.Reaping_Full)})
		return
	}

	rp := new(Runner_Page, runner.allocator)
	rp.user_data = user_data
	rp.fd = -1
	rp.loop = new(eventloop.Loop, runtime.heap_allocator())
	rp.loop^ = eventloop.init(runtime.heap_allocator(), real_time = true)
	rp.loop.never_block = true

	// Always set on a runner init made usable; a loop left unattached would still run,
	// on a private pool of its own.
	if runner.workers != nil {
		eventloop.pool_attach(rp.loop, runner.workers)
	}

	append(&runner.pages, rp)
	index := len(runner.pages) - 1

	if !page_open(
		&rp.page,
		source,
		source_name,
		rp.loop,
		false,
		nil,
		limits,
		&runner.pool,
		runner_page = true,
		surface = surface,
	) {
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

		if linux.epoll_ctl(runner.epfd, .ADD, linux.Fd(fd), &ev) == .NONE {
			rp.fd = linux.Fd(fd)
		}
	}

	// A loop the runner cannot wait on is still ticked every round; it only loses the
	// ability to wake a blocked runner, so runner_wait never blocks while one is live.
}

// page_runner_orphans is the number of jobs still running for pages that have closed
// (eventloop.pool_orphans). Never blocks; at orphan_limit page_runner_open refuses.
page_runner_orphans :: proc(runner: ^Page_Runner) -> int {
	// nil after page_runner_destroy, or after an init that failed.
	if runner.workers == nil {
		return 0
	}

	return eventloop.pool_orphans(runner.workers)
}

// page_runner_live is the number of pages still running.
page_runner_live :: proc(runner: ^Page_Runner) -> int {
	return len(runner.pages)
}

// page_runner_watch_fd adds `fd` to the runner's epoll set, level-triggered, so that
// page_runner_step wakes when it becomes readable — the page dispatcher's wake pipe.
// The runner never reads or closes it: the caller drains it, and removes nothing —
// the descriptor must stay open until page_runner_destroy, which closes the epoll set.
//
// Returns:
//   false when epoll refuses the descriptor; nothing was registered.
page_runner_watch_fd :: proc(runner: ^Page_Runner, fd: i32) -> bool {
	ev := linux.EPoll_Event {
		events = {.IN},
	}

	if linux.epoll_ctl(runner.epfd, .ADD, linux.Fd(fd), &ev) != .NONE {
		return false
	}

	runner.watched += 1
	return true
}

// page_runner_step runs one round — every queued Result reported, every live page
// ticked once — and then, if no page made progress, blocks until one can or a watched
// descriptor becomes readable. Unlike page_runner_run it blocks with no page live, so
// a driver that feeds the runner from another thread (the dispatcher) sleeps on its
// wake descriptor instead of spinning. It never blocks when there is nothing at all to
// wait on (no page, no watched descriptor).
//
// Returns:
//   Whether the round ticked a page that did work or finished one.
page_runner_step :: proc(runner: ^Page_Runner) -> bool {
	context.allocator = runner.allocator
	return runner_round(runner, idle_wait = true)
}

// page_runner_run ticks the live pages until none is left, including pages that
// on_done opens along the way. It does not wait for orphans: it returns once no page
// is live, whatever closed pages' jobs are still running (page_runner_orphans).
page_runner_run :: proc(runner: ^Page_Runner) {
	context.allocator = runner.allocator
	for len(runner.pages) > 0 || len(runner.done) > 0 {
		runner_round(runner, idle_wait = false)
	}
}

// runner_round is one round of run and step: report queued Results, tick every live
// page once, let the worker pool start an overflow worker for a page starving behind
// stalled jobs (pool_tick — after the ticks, which is where pages submit), and wait
// when no page progressed and one is live. `idle_wait` lets
// it wait with none live too — only for page_runner_step, whose driver has a watched
// descriptor to be woken through; run's contract is to return once no page is left,
// and a run that waited there would sleep on a descriptor it does not own (#28's
// idle-step defect).
@(private = "file")
runner_round :: proc(runner: ^Page_Runner, idle_wait: bool) -> bool {
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

		if did_work {
			progressed = true
		}

		i += 1
	}
	eventloop.pool_tick(runner.workers)

	if progressed {
		return true
	}

	// Results delivered above are not progress: a run whose only page failed at open
	// reaches here with nothing live, which is exactly where it must not wait.
	if len(runner.pages) > 0 || (idle_wait && runner.watched > 0) {
		runner_wait(runner)
	}

	return false
}

// runner_wait blocks until some page can make progress: an fd of any page's loop
// becomes ready, the nearest timer across all pages comes due, or a page starving for a
// pool worker has waited long enough for pool_tick to start one (pool_wait_hint_ms) —
// a stall wakes nothing by itself.
@(private = "file")
runner_wait :: proc(runner: ^Page_Runner) {
	timeout := eventloop.pool_wait_hint_ms(runner.workers)
	for rp in runner.pages {
		// A page the runner cannot wait on is polled every millisecond instead: not
		// slept through, and not spun on either, since every spin tick would be charged
		// to some page's CPU budget.
		if rp.fd < 0 && (timeout < 0 || timeout > 1) {
			timeout = 1
		}

		hint := eventloop.wait_hint_ms(rp.loop)

		if hint == 0 {
			return
		}

		if hint > 0 && (timeout < 0 || hint < timeout) {
			timeout = hint
		}
	}
	events: [16]linux.EPoll_Event
	// EINTR or a spurious wake only costs one more round.
	linux.epoll_wait(runner.epfd, raw_data(events[:]), i32(len(events)), i32(timeout))
}

// runner_finish closes page `index`, removes it, and reports its Result — now, or,
// with `deliver` false (inside page_runner_open), from the run loop. The page's loop
// descriptor leaves the runner's epoll set before the loop closes it. page_close
// closes the loop whatever its pool jobs are doing — a client of the shared pool is
// never handed back busy — so only its struct is left to free.
@(private = "file")
runner_finish :: proc(runner: ^Page_Runner, index: int, deliver := true) {
	rp := runner.pages[index]
	unordered_remove(&runner.pages, index)

	if rp.fd >= 0 {
		linux.epoll_ctl(runner.epfd, .DEL, rp.fd, nil)
	}

	result, busy_loop := page_close(&rp.page, runner.heap_sample_every)
	assert(busy_loop == nil, "a page loop attached to the runner's pool was handed back busy")
	free(rp.loop, runtime.heap_allocator())

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
