#+build linux
package lava_runtime

import "base:runtime"
import "core:container/queue"
import "core:strings"
import "core:sync"
import "core:sys/linux"
import "core:thread"

// A page dispatcher spreads pages over N worker threads, each driving its own page
// runner (page_runner.odin) with its own VM pool (docs/LARVA.md decision 2: many VMs
// per thread, a worker thread per core). The embedder submits from any thread; each
// page runs, start to end, on one worker, and its Result comes back through on_done
// on that worker. JSC adds a collector thread per VM, so the process runs about
// threads × pages_per_thread threads (decision 2 has the counts).
//
// Why threads in one process and not workers.odin's processes: a process per worker
// would put every VM pool behind IPC, and workers.odin's model — one script per
// worker sharing a listen socket — is a server's, not a page farm's. A supervisor that
// wants process isolation runs one dispatcher per process.
//
// Placement: a page goes to the worker with the fewest pages queued or running (ties
// rotate), and queues there when the worker's slots are full. It never moves: its VM,
// its loop and its JS values are confined to the worker's thread from the first line.
//
// Ownership and lifetimes:
//   - Everything the dispatcher owns — workers, inboxes, each page's copies of its
//     source and name, the worker threads themselves, every page's runtime state and
//     Result — is allocated and freed through Page_Dispatcher.allocator, on whichever
//     thread holds it at the time (submit allocates on the feeding thread, a worker
//     frees). Hence it must be thread-safe; the default is the heap.
//   - A worker thread owns its runner, its VMs and its thread-lived tables, and tears
//     all three down before it ends (worker_main).
//
// Concurrency, in one place, because it is the part that went wrong before (#28):
//   - d.gate (RW): submit holds it SHARED from its state check to its push and wake,
//     shutdown takes it EXCLUSIVELY to flip Open -> Closing and Closing -> Closed. So no
//     submit can reach a worker once shutdown has begun, every accepted page is in an
//     inbox before any worker can see the stop flag, and no submit, load or shutdown
//     reads d.workers after they are freed (they are freed only after Closed).
//   - A worker's inbox is guarded by its mutex; `load`, `posted`, `stop`, `cancel` and
//     `thread_id` are atomics.
//   - The wake protocol is worker_wake and the top of worker_loop; the ordering
//     argument is at worker_wake.

// Dispatch_Done_Proc receives an accepted page's Result.
//
// It runs exactly once per page that page_dispatcher_submit accepted, on the worker
// thread that ran the page — never on the submitter's thread — so it must be
// thread-safe with respect to the embedder's own state. It owns the Result: call
// result_destroy inside it, where context.allocator is the dispatcher's (the message
// was allocated there). It may submit further pages (accepted while the dispatcher is
// open, refused with false once shutdown has begun). It must not call
// page_dispatcher_shutdown — a worker cannot join itself; doing so panics.
Dispatch_Done_Proc :: proc(d: ^Page_Dispatcher, user_data: rawptr, result: Result)

// Dispatcher_State: a zero Page_Dispatcher is Closed, so one that was never
// initialised, or whose init failed, refuses every page.
Dispatcher_State :: enum {
	Closed,
	Open,
	Closing,
}

// One accepted page, from submit until its on_done. The worker hands the page runner
// the job itself as user_data and frees it in worker_page_done, after on_done: the
// clones must outlive the page, not only its open (page_runner_open's source must not
// be in the temp arena, and nothing promises the page drops source_name after open).
@(private = "file")
Dispatch_Job :: struct {
	worker:      ^Dispatch_Worker,
	source:      string,
	source_name: string,
	limits:      Page_Limits,
	user_data:   rawptr,
}

@(private = "file")
Dispatch_Worker :: struct {
	d:          ^Page_Dispatcher,
	thread:     ^thread.Thread,
	// sync.current_thread_id of the worker, for shutdown's self-join check.
	thread_id:  int,
	// Guards inbox. Held only for a push or a pop, never across a page.
	mutex:      sync.Mutex,
	// Accepted pages not yet opened, oldest first. The worker opens from it only while
	// a slot is free, so it is the one backlog: no second queue, no O(n) drain (#28).
	inbox:      queue.Queue(^Dispatch_Job),
	// Pages queued or running here: +1 when submit pushes, -1 when the page is
	// reported. What submit compares to pick a worker.
	load:       int,
	// Set by a submitter that wrote the wake pipe and not yet consumed by the worker.
	posted:     bool,
	stop:       bool,
	cancel:     bool,
	// The worker's wake pipe, in its runner's epoll set (page_runner_watch_fd).
	wake_read:  linux.Fd,
	wake_write: linux.Fd,
	// Posted once the worker has tried to start its runner; init_ok says how it went.
	ready:      sync.Sema,
	init_ok:    bool,
	runner:     Page_Runner,
}

Page_Dispatcher :: struct {
	workers:           []^Dispatch_Worker,
	gate:              sync.RW_Mutex,
	state:             Dispatcher_State,
	// Held for the whole of a shutdown, so a second, concurrent caller waits for the
	// first and then finds the dispatcher Closed.
	shutdown_mutex:    sync.Mutex,
	// Where submit's least-loaded scan starts, so ties rotate over the workers.
	rotor:             int,
	pages_per_thread:  int,
	heap_sample_every: int,
	on_done:           Dispatch_Done_Proc,
	allocator:         runtime.Allocator,
}

// page_dispatcher_init starts `threads` workers, each able to run `pages_per_thread`
// pages at once (one VM each), and returns once every worker is ready.
//
// Params:
//   heap_sample_every  Forwarded to every worker's runner (Page_Runner.
//                      heap_sample_every): sample every Nth page's heap per VM into
//                      Result.heap_bytes; 0 = never.
//   allocator          Owns everything the dispatcher allocates (see the file header);
//                      must be thread-safe and outlive the dispatcher. Zero (the
//                      default) = runtime.heap_allocator(). Not context.allocator: the
//                      ambient allocator of whoever calls init is rarely safe to use
//                      from N other threads.
// Returns:
//   false for threads < 1, pages_per_thread < 1 or a nil on_done, or when any worker
//   cannot start (its wake pipe, its thread or its runner's epoll set refused). A
//   failed init has stopped and joined every worker it started and freed everything;
//   `d` is left zero, which refuses pages.
page_dispatcher_init :: proc(
	d: ^Page_Dispatcher,
	threads, pages_per_thread: int,
	on_done: Dispatch_Done_Proc,
	heap_sample_every := 0,
	allocator: runtime.Allocator = {},
) -> bool {
	d^ = {}
	if threads < 1 || pages_per_thread < 1 || on_done == nil do return false
	alloc := allocator.procedure != nil ? allocator : runtime.heap_allocator()
	d.allocator = alloc
	d.on_done = on_done
	d.pages_per_thread = pages_per_thread
	d.heap_sample_every = heap_sample_every
	// core:thread allocates the Thread through context.allocator and frees it through
	// the same one (thread_unix.odin, creation_allocator), so this makes the threads
	// the dispatcher's too.
	context.allocator = alloc
	workers, err := make([]^Dispatch_Worker, threads, alloc)
	if err != nil {
		d^ = {}
		return false
	}
	d.workers = workers
	ok := true
	// One worker at a time, each waited for before the next starts: a refusal stops
	// the loop at the first failure, and the cost — an epoll_create1 per worker — is
	// not worth overlapping.
	for i in 0 ..< threads {
		w, werr := new(Dispatch_Worker, alloc)
		if werr != nil {
			ok = false
			break
		}
		d.workers[i] = w
		w.d = d
		w.wake_read = -1
		w.wake_write = -1
		if queue.init(&w.inbox, 16, alloc) != nil {
			ok = false
			break
		}
		// A pipe, as the event loop's own wakeup (loop_linux.odin, Platform_Loop.
		// wakeup_pipe): an eventfd would serve under epoll, but #74 found io_uring
		// POLL_ADD unreliable on one, and a pipe keeps a single wake shape in the tree.
		fds: [2]linux.Fd
		if linux.pipe2(&fds, {.CLOEXEC, .NONBLOCK}) != .NONE {
			ok = false
			break
		}
		w.wake_read = fds[0]
		w.wake_write = fds[1]
		w.thread = thread.create_and_start_with_data(w, worker_main)
		if w.thread == nil {
			ok = false
			break
		}
		sync.wait(&w.ready)
		if !w.init_ok {
			ok = false
			break
		}
	}
	if !ok {
		// No submit can have seen the dispatcher (state is still Closed), so this is a
		// plain stop: the started workers find their inboxes empty and exit.
		dispatcher_stop_and_free(d, cancel = true)
		d^ = {}
		return false
	}
	sync.lock(&d.gate)
	sync.atomic_store(&d.state, Dispatcher_State.Open)
	sync.unlock(&d.gate)
	return true
}

// page_dispatcher_submit hands a page to the least-loaded worker. Safe from any
// thread, including from inside on_done.
//
// Params:
//   source, source_name  Copied through the dispatcher's allocator; the caller's
//                        strings may go away as soon as this returns.
//   limits               As page_runner_open's: a page without a CPU budget is still
//                        accepted, and reported .Invalid_Input through on_done — one
//                        path for every per-page failure.
// Returns:
//   true when the page was accepted: on_done will run for it exactly once. false when
//   it was not — the dispatcher is not open (never initialised, failed, shutting down
//   or shut down) or the copy could not be allocated; nothing was kept and on_done
//   will not run for it.
page_dispatcher_submit :: proc(
	d: ^Page_Dispatcher,
	source, source_name: string,
	limits: Page_Limits,
	user_data: rawptr = nil,
) -> bool {
	// A zero dispatcher has no allocator to copy through; it is Closed anyway.
	if d.allocator.procedure == nil do return false
	// Early refusal without the gate, so a late submit after shutdown allocates
	// nothing. Only a hint: the state can still change before the gate is taken, and
	// the check under it below is the one that decides.
	if !dispatcher_accepts(d) do return false
	// Copies outside the gate: a shutdown waiting on it should not wait on a memcpy.
	job, jerr := new(Dispatch_Job, d.allocator)
	if jerr != nil do return false
	src, serr := strings.clone(source, d.allocator)
	name, nerr := strings.clone(source_name, d.allocator)
	job^ = {
		source      = src,
		source_name = name,
		limits      = limits,
		user_data   = user_data,
	}
	if serr != nil || nerr != nil {
		job_free(d, job)
		return false
	}

	sync.shared_lock(&d.gate)
	defer sync.shared_unlock(&d.gate)
	// The deciding check. It only differs from the early one above for a submit that
	// races the flip, which no deterministic test can schedule, so deleting it alone
	// survives every test and has no mutation entry — it is not redundant: without it
	// a job could land in a worker's inbox after that worker decided to exit.
	if !dispatcher_accepts(d) {
		job_free(d, job)
		return false
	}
	w := dispatcher_pick(d)
	job.worker = w
	sync.atomic_add(&w.load, 1)
	sync.lock(&w.mutex)
	_, perr := queue.push_back(&w.inbox, job)
	sync.unlock(&w.mutex)
	if perr != nil {
		sync.atomic_sub(&w.load, 1)
		job_free(d, job)
		return false
	}
	// Under the gate: once it is released a shutdown may join this worker and close
	// the pipe, and a write after that could land on a reused descriptor number.
	worker_wake(w)
	return true
}

// page_dispatcher_shutdown stops the dispatcher and joins its workers. Once it
// returns no worker runs, every accepted page has been reported exactly once, and
// every page submitted from now on is refused; `d` stays valid until the caller
// frees it. A second call, or one concurrent with the first, returns once the first
// has finished. Not callable from on_done (it panics there: a worker cannot join
// itself).
//
// Params:
//   cancel  false: every accepted page — running or still queued — runs to its end.
//           true: queued pages are reported .Cancelled without running, and running
//           pages are cancelled at their worker's next round (status .Execution_Error,
//           Result.kill .Cancelled, as page_runner_destroy reports them).
//
// The cancel is observed between ticks, so a page inside one synchronous entry ends
// at its entry limit or its CPU budget, whichever comes first — bounded, since every
// page carries a budget. Ending it sooner from this thread would take
// TerminateExecution under the VM lock (private_terminate.odin), which the busy worker
// holds; not attempted. Without cancel, shutdown waits for every page to end, and
// that is NOT bounded: the budget counts CPU, so a page that waits — a re-arming
// setInterval, a socket nobody writes to — holds a draining shutdown forever. cancel
// is the bounded path.
page_dispatcher_shutdown :: proc(d: ^Page_Dispatcher, cancel := false) {
	self := sync.current_thread_id()
	sync.shared_lock(&d.gate)
	if d.state != .Closed {
		for w in d.workers {
			if sync.atomic_load(&w.thread_id) == self {
				sync.shared_unlock(&d.gate)
				panic("page_dispatcher_shutdown called from on_done: a worker cannot join itself")
			}
		}
	}
	sync.shared_unlock(&d.gate)

	sync.lock(&d.shutdown_mutex)
	defer sync.unlock(&d.shutdown_mutex)
	sync.lock(&d.gate)
	if d.state != .Open {
		sync.unlock(&d.gate)
		return
	}
	sync.atomic_store(&d.state, Dispatcher_State.Closing)
	sync.unlock(&d.gate)
	dispatcher_stop_and_free(d, cancel)
}

// page_dispatcher_load copies each worker's load — pages queued or running there — into
// `out` (as many as fit) and returns the number of workers; 0 once the dispatcher is
// closed. A snapshot, for tests and operators: it is stale as soon as it returns.
page_dispatcher_load :: proc(d: ^Page_Dispatcher, out: []int) -> int {
	sync.shared_lock(&d.gate)
	defer sync.shared_unlock(&d.gate)
	if d.state == .Closed do return 0
	for w, i in d.workers {
		if i < len(out) do out[i] = sync.atomic_load(&w.load)
	}
	return len(d.workers)
}

// dispatcher_accepts is the one test of whether submit may accept a page: only while
// Open, never once shutdown has begun (Closing) — a page accepted then could land in
// the inbox of a worker that has already decided to exit. Both submit's early refusal
// and its authoritative check under the gate go through it.
@(private = "file")
dispatcher_accepts :: proc(d: ^Page_Dispatcher) -> bool {
	return sync.atomic_load(&d.state) == .Open
}

// dispatcher_pick returns the worker with the lowest load, scanning from a rotating
// start so equal loads take turns. Caller holds the gate (shared), so the workers
// exist. Two submitters racing may pick the same worker; the next pick sees both.
@(private = "file")
dispatcher_pick :: proc(d: ^Page_Dispatcher) -> ^Dispatch_Worker {
	n := len(d.workers)
	start := sync.atomic_add(&d.rotor, 1) % n
	best := start
	best_load := sync.atomic_load(&d.workers[start].load)
	for k in 1 ..< n {
		i := (start + k) % n
		l := sync.atomic_load(&d.workers[i].load)
		if l < best_load {
			best = i
			best_load = l
		}
	}
	return d.workers[best]
}

// dispatcher_stop_and_free stops every worker, joins them all, and only then frees
// them: a worker still running may be inside on_done, submitting, and that submit must
// find live workers behind the gate — or, once Closed is set here, none at all (#28
// freed each worker as it joined it). Shared by shutdown and a failed init.
@(private = "file")
dispatcher_stop_and_free :: proc(d: ^Page_Dispatcher, cancel: bool) {
	context.allocator = d.allocator
	for w in d.workers {
		if w == nil do continue
		sync.atomic_store(&w.cancel, cancel)
		sync.atomic_store(&w.stop, true)
		worker_wake(w)
	}
	for w in d.workers {
		if w != nil && w.thread != nil do thread.join(w.thread)
	}
	sync.lock(&d.gate)
	sync.atomic_store(&d.state, Dispatcher_State.Closed)
	sync.unlock(&d.gate)
	for w in d.workers {
		if w == nil do continue
		if w.thread != nil do thread.destroy(w.thread)
		if w.wake_read >= 0 do linux.close(w.wake_read)
		if w.wake_write >= 0 do linux.close(w.wake_write)
		// Empty after a worker that ran (it drains or cancels its inbox before it
		// exits); jobs can only be left by a worker that never started, before any
		// submit could reach it — kept as a belt for that path.
		for queue.len(w.inbox) > 0 do job_free(d, queue.pop_front(&w.inbox))
		queue.destroy(&w.inbox)
		free(w, d.allocator)
	}
	delete(d.workers, d.allocator)
	d.workers = nil
}

// worker_wake makes sure the worker will look at its inbox and flags after this call.
//
// Ordering — submitter: push under the worker's mutex, then exchange(posted, true),
// and write a byte only if it was false. Worker (worker_loop), on a round that drains:
// drain the pipe, then exchange(posted, false), then read flags and inbox. If our
// exchange saw false, our byte keeps the pipe readable — so the worker's step cannot
// sleep through it — until a drain, and every drain precedes an inbox read. If it saw
// true, it is ordered before the worker's reset (else it would have seen false), so
// the worker's inbox read after that reset sees our push — and the byte of whoever set
// `posted` is either still in the pipe or already led to such a read.
//
// The worker drains only on a round that follows a wake: `posted` seen set, or a step
// that returned without progress (it woke on something). A round that skips the drain
// cannot lose a push: a push it misses was followed by a write, which leaves the pipe
// readable for the next step. The no-progress case is what consumes a byte written
// after a reset — exchange(true) seen false, the worker resets and reads, then the
// write lands — which would otherwise keep the level-triggered pipe readable with
// `posted` clear, and the worker spinning. So: one write per wake cycle, not one per
// submit, and a drain per wake, not per round (#28 paid a syscall and a lock on every
// round).
@(private = "file")
worker_wake :: proc(w: ^Dispatch_Worker) {
	if w.wake_write < 0 do return
	if !sync.atomic_exchange(&w.posted, true) {
		b := [1]u8{1}
		// EAGAIN means the pipe is full, so already readable: nothing lost.
		linux.write(w.wake_write, b[:])
	}
}

// worker_main is a worker thread's body: start the runner on THIS thread (a runner is
// thread-confined), report to init, run, and tear down everything thread-lived on
// every path, including a failed start.
@(private = "file")
worker_main :: proc(data: rawptr) {
	w := cast(^Dispatch_Worker)data
	d := w.d
	context.allocator = d.allocator
	sync.atomic_store(&w.thread_id, sync.current_thread_id())
	ok := page_runner_init(&w.runner, d.pages_per_thread, worker_page_done, d.allocator)
	if ok {
		w.runner.heap_sample_every = d.heap_sample_every
		ok = page_runner_watch_fd(&w.runner, i32(w.wake_read))
	}
	w.init_ok = ok
	sync.post(&w.ready)
	if ok do worker_loop(w)
	// Running pages are reported .Cancelled here (cancel); after a drain none is left.
	page_runner_destroy(&w.runner)
	// Thread-lived state no exit hook frees: the implicit VM pool (unused by runner
	// pages, but a page's require() path may have reached it) and the host-native
	// tables (host_native_thread_teardown says why).
	thread_vm_pool_destroy()
	host_native_thread_teardown()
}

// worker_loop runs pages until shutdown says stop. Each turn: consume a wake if there
// was one (worker_wake says when), read the flags, open queued pages into free slots,
// then one runner step, which blocks when nothing progressed — on the pages'
// descriptors and the wake pipe.
@(private = "file")
worker_loop :: proc(w: ^Dispatch_Worker) {
	d := w.d
	woke := true
	for {
		// `woke` covers a byte that landed after the last reset with `posted` already
		// clear, which would otherwise keep the level-triggered pipe readable and spin.
		// That needs a submit in the nanoseconds between reset and drain, so it has no
		// mutation entry (deleting `woke ||` survives every test); keep it.
		if woke || sync.atomic_load(&w.posted) {
			worker_drain_wake(w)
			sync.atomic_exchange(&w.posted, false)
		}
		stop := sync.atomic_load(&w.stop)
		if stop && sync.atomic_load(&w.cancel) {
			worker_cancel_queued(w)
			return
		}
		// Only while a slot is free: a page opened past capacity would be refused for
		// want of a VM, so the rest wait in the inbox instead of failing.
		for page_runner_live(&w.runner) < d.pages_per_thread {
			job := worker_pop(w)
			if job == nil do break
			page_runner_open(&w.runner, job.source, job.source_name, job.limits, job)
		}
		// Done once nothing is live. That also means the inbox is empty — the open loop
		// above stops only at a full runner or an empty inbox — and it stays empty:
		// `stop` was read after the reset, and every accepted push happened before the
		// flip that preceded the stop (the gate). Pages that failed at open sit in the
		// runner's done list, which page_runner_destroy still reports.
		if stop && page_runner_live(&w.runner) == 0 do return
		woke = !page_runner_step(&w.runner)
	}
}

// worker_page_done is the runner's on_done: the page's job goes back with its Result.
@(private = "file")
worker_page_done :: proc(runner: ^Page_Runner, user_data: rawptr, result: Result) {
	job := cast(^Dispatch_Job)user_data
	w := job.worker
	d := w.d
	// Before on_done, so a follow-up it submits sees this worker's slot as free.
	sync.atomic_sub(&w.load, 1)
	d.on_done(d, job.user_data, result)
	job_free(d, job)
}

// worker_cancel_queued reports every page still in the inbox .Cancelled, unopened.
@(private = "file")
worker_cancel_queued :: proc(w: ^Dispatch_Worker) {
	d := w.d
	for {
		job := worker_pop(w)
		if job == nil do return
		sync.atomic_sub(&w.load, 1)
		d.on_done(d, job.user_data, page_killed_result(.Cancelled))
		job_free(d, job)
	}
}

@(private = "file")
worker_pop :: proc(w: ^Dispatch_Worker) -> ^Dispatch_Job {
	sync.lock(&w.mutex)
	defer sync.unlock(&w.mutex)
	job, _ := queue.pop_front_safe(&w.inbox)
	return job
}

@(private = "file")
worker_drain_wake :: proc(w: ^Dispatch_Worker) {
	buf: [64]u8
	for {
		n, err := linux.read(w.wake_read, buf[:])
		if err != .NONE || n <= 0 do return
	}
}

@(private = "file")
job_free :: proc(d: ^Page_Dispatcher, job: ^Dispatch_Job) {
	delete(job.source, d.allocator)
	delete(job.source_name, d.allocator)
	free(job, d.allocator)
}
