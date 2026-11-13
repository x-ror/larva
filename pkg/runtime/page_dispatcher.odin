#+build linux
package lava_runtime

import "base:runtime"
import "core:strings"
import "core:sync"
import "core:sys/linux"
import "core:thread"

// A page dispatcher spreads pages over N worker threads, each driving its own page
// runner (docs/LARVA.md decision 2: N worker threads ≈ cores, a dispatcher sends a
// new page to the least-loaded one). Only plain data crosses threads: a submitted
// page is its source text, name, limits and an opaque user_data; a finished page is
// its Result. JS values, VMs and loops never leave their worker.
//
// Threads, not Lava's process-based workers (workers.odin): those exist to share a
// listening socket between processes, with a supervisor that restarts or stops them
// as a group. Pages need none of that, and a process per worker would put the VM pools
// — whose whole point is reuse — behind an IPC hop. A supervisor process can still run
// one dispatcher per process if a crash must be contained to a fraction of the pages.

// Dispatch_Done_Proc receives each submitted page's Result exactly once and owns it
// (result_destroy). It runs on the WORKER thread that ran the page, concurrently with
// the other workers' calls, so it must be thread-safe.
Dispatch_Done_Proc :: proc(dispatcher: ^Page_Dispatcher, user_data: rawptr, result: Result)

@(private = "file")
Dispatch_Job :: struct {
	source:    string,
	name:      string,
	limits:    Page_Limits,
	user_data: rawptr,
}

@(private = "file")
Dispatch_Worker :: struct {
	dispatcher: ^Page_Dispatcher,
	thread:     ^thread.Thread,
	// Guards inbox and stopping; the worker swaps the inbox out under it.
	mutex:      sync.Mutex,
	inbox:      [dynamic]Dispatch_Job,
	stopping:   bool,
	// eventfd: written by submit and shutdown so a worker blocked in its runner's
	// epoll wakes for new work.
	wake_fd:    linux.Fd,
	// Pages submitted to this worker and not yet reported (queued + running). Read by
	// submit to pick the least-loaded worker; atomic, since workers decrement it.
	load:       int,
	capacity:   int,
	init_ok:    bool,
	ready:      sync.Sema,
}

Page_Dispatcher :: struct {
	workers:   []^Dispatch_Worker,
	on_done:   Dispatch_Done_Proc,
	// Owns the dispatcher's bookkeeping and the job copies. Shared by every worker, so
	// it must be thread-safe (the default heap allocator is).
	allocator: runtime.Allocator,
}

// page_dispatcher_init starts `threads` workers, each able to run `pages_per_thread`
// pages at once (one pooled VM per page slot).
//
// Returns:
//   false when a worker could not start (thread, eventfd, or its runner's epoll);
//   the workers that did start are shut down again.
page_dispatcher_init :: proc(
	d: ^Page_Dispatcher,
	threads: int,
	pages_per_thread: int,
	on_done: Dispatch_Done_Proc,
	allocator := context.allocator,
) -> bool {
	d^ = {}
	d.on_done = on_done
	d.allocator = allocator
	d.workers = make([]^Dispatch_Worker, max(threads, 1), allocator)
	ok := true
	for &w in d.workers {
		w = new(Dispatch_Worker, allocator)
		w.dispatcher = d
		w.capacity = max(pages_per_thread, 1)
		w.inbox = make([dynamic]Dispatch_Job, allocator)
		fd, err := linux.eventfd(0, {.CLOEXEC, .NONBLOCK})
		if err != .NONE {
			w.wake_fd = -1
			ok = false
			continue
		}
		w.wake_fd = fd
		w.thread = thread.create_and_start_with_poly_data(w, dispatch_worker_main)
		if w.thread == nil {
			ok = false
			continue
		}
		// Wait for the worker's runner, so a failed init is reported here, not as
		// pages that never run.
		sync.sema_wait(&w.ready)
		if !w.init_ok do ok = false
	}
	if !ok {
		page_dispatcher_shutdown(d)
		return false
	}
	return true
}

// page_dispatcher_submit queues a page on the least-loaded worker. The source and name
// are copied, so the caller may free them at once. Thread-safe against the workers;
// submit itself is meant for one feeding thread.
page_dispatcher_submit :: proc(
	d: ^Page_Dispatcher,
	source: string,
	source_name: string,
	limits: Page_Limits = {},
	user_data: rawptr = nil,
) {
	best := d.workers[0]
	best_load := sync.atomic_load(&best.load)
	for w in d.workers[1:] {
		if l := sync.atomic_load(&w.load); l < best_load {
			best, best_load = w, l
		}
	}
	job := Dispatch_Job {
		source    = strings.clone(source, d.allocator),
		name      = strings.clone(source_name, d.allocator),
		limits    = limits,
		user_data = user_data,
	}
	sync.atomic_add(&best.load, 1)
	sync.mutex_lock(&best.mutex)
	append(&best.inbox, job)
	sync.mutex_unlock(&best.mutex)
	dispatch_wake(best)
}

// page_dispatcher_load reports how many pages each worker holds (queued + running).
// A snapshot: workers keep changing it.
page_dispatcher_load :: proc(d: ^Page_Dispatcher, out: []int) {
	for w, i in d.workers do if i < len(out) do out[i] = sync.atomic_load(&w.load)
}

// page_dispatcher_shutdown lets every submitted page finish, then stops and joins the
// workers and frees the dispatcher. No submit may race it.
page_dispatcher_shutdown :: proc(d: ^Page_Dispatcher) {
	for w in d.workers {
		if w == nil do continue
		sync.mutex_lock(&w.mutex)
		w.stopping = true
		sync.mutex_unlock(&w.mutex)
		dispatch_wake(w)
	}
	for w in d.workers {
		if w == nil do continue
		if w.thread != nil {
			thread.join(w.thread)
			thread.destroy(w.thread)
		}
		if w.wake_fd >= 0 do linux.close(w.wake_fd)
		delete(w.inbox)
		free(w, d.allocator)
	}
	delete(d.workers, d.allocator)
	d^ = {}
}

@(private = "file")
dispatch_wake :: proc(w: ^Dispatch_Worker) {
	one := u64(1)
	linux.write(w.wake_fd, ([^]u8)(&one)[:8])
}

@(private = "file")
dispatch_page_done :: proc(runner: ^Page_Runner, user_data: rawptr, result: Result) {
	// Runs on the worker's thread, under the context dispatch_worker_main set up.
	w := cast(^Dispatch_Worker)context.user_ptr
	sync.atomic_sub(&w.load, 1)
	result := result
	if w.dispatcher.on_done != nil {
		w.dispatcher.on_done(w.dispatcher, user_data, result)
	} else {
		result_destroy(&result)
	}
}

// dispatch_worker_main owns one runner for the life of the thread. Each turn it moves
// queued jobs into free page slots, then steps the runner, which blocks on its pages
// and on the wake eventfd. It exits once stopping is set and every page is reported.
@(private = "file")
dispatch_worker_main :: proc(w: ^Dispatch_Worker) {
	context.user_ptr = w
	runner: Page_Runner
	w.init_ok = page_runner_init(&runner, w.capacity, dispatch_page_done, runtime.heap_allocator()) &&
		page_runner_watch_fd(&runner, w.wake_fd)
	sync.sema_post(&w.ready)
	if !w.init_ok {
		if runner.epfd > 0 do page_runner_destroy(&runner)
		return
	}

	pending: [dynamic]Dispatch_Job
	pending.allocator = runtime.heap_allocator()
	defer delete(pending)
	for {
		// Drain the eventfd before reading the inbox, so a submit that lands after the
		// read below still leaves the fd readable for the next wait.
		counter: u64
		linux.read(w.wake_fd, ([^]u8)(&counter)[:8])

		sync.mutex_lock(&w.mutex)
		stopping := w.stopping
		for job in w.inbox do append(&pending, job)
		clear(&w.inbox)
		sync.mutex_unlock(&w.mutex)

		// Jobs wait here, not in the runner, while every page slot is busy: opening
		// past capacity would fail the page for want of a VM.
		for len(pending) > 0 && page_runner_live(&runner) < w.capacity {
			job := pop_front(&pending)
			page_runner_open(&runner, job.source, job.name, job.limits, job.user_data)
			delete(job.source, w.dispatcher.allocator)
			delete(job.name, w.dispatcher.allocator)
		}

		// Checked before stepping: with nothing left, a step would block on an eventfd
		// this turn has already drained.
		if stopping && len(pending) == 0 && page_runner_live(&runner) == 0 && len(runner.done) == 0 do break
		page_runner_step(&runner)
	}
	page_runner_destroy(&runner)
	// The runner's pool held this thread's VMs; the implicit pool may hold more if
	// anything on this thread called eval.
	thread_vm_pool_destroy()
}
