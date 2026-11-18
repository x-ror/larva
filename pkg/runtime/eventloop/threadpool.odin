package eventloop

import "core:mem"
import "core:sync"
import "core:thread"

// Generic worker pool. Any blocking or CPU-bound operation (file I/O, a crypto KDF)
// runs OFF the loop thread on a fixed set of workers, then its completion is handed
// back to the loop thread through the same post_async path the async DNS resolver
// uses. This generalizes fetch_dns_pool: instead of one DNS-specific job type, a
// caller supplies a `work` proc (run off-loop) and a `done` proc (run on the loop).
//
// The pool is OWNED BY THE LOOP (Loop.pool), not a process global: each loop has its
// own workers, and destroy() tears down only that loop's pool. (A process-global pool
// would race across loops — notably the parallel test runner, where one loop's
// destroy would join another loop's still-running workers.)
//
// Memory: the pool's containers, its Pool_Job allocations and the workers' Thread
// structs all use loop.allocator (the same ownership contract the loop's queues follow
// — see loop.odin init), so a loop on the heap is entirely on the heap: the page runner
// relies on that to leave a closed page's loop to its workers (close_detach). Until
// teardown the loop thread is the only one that allocates or frees them (workers only
// pop and post); after close_detach, the last worker frees them.
//
// Lifetime / safety mirrors the DNS pool:
//   - Workers are lazily started on the first submit, so a loop that never offloads
//     work spawns no threads.
//   - pool_submit does async_begin(loop) so the loop stays alive and parked in poll
//     until the completion is posted; the matching decrement happens in drain_async
//     when the completion runs.
//   - A worker touches ONLY its job's user_data (never the loop or the JS engine);
//     the single cross-thread handoff is the post_async at the end. The lock/unlock
//     inside post_async publishes whatever the worker wrote into user_data.
//   - Teardown is split (loop.odin, close_begin / close_finish). close_begin stops
//     the pool without joining it — pool_stop — and settles every job on the loop
//     thread while the JS context lives; close_finish joins (pool_join) and only then
//     frees the async_queue and the wakeup pipe the workers may still write. So no
//     worker can post into a freed loop, and a worker blocked in `work` holds only its
//     own loop, never the thread that closed it.

// THREADPOOL_SIZE mirrors libuv's default UV_THREADPOOL_SIZE.
THREADPOOL_SIZE :: 4

// Pool_Work runs on a worker thread, off the loop. It must touch only its own
// user_data — no loop calls, no JS engine access — since it runs concurrently with
// the loop thread. Its result is carried back through user_data.
Pool_Work :: proc(user_data: rawptr)

// Pool_Done runs on the loop thread after the work finishes (delivered through
// post_async), so it may safely touch the loop and the JS engine.
Pool_Done :: proc(loop: ^Loop, user_data: rawptr)

// Pool_Dispose releases a job's user_data when its `done` will NOT run — i.e. the job
// was dropped at loop teardown (still queued, or its completion posted but discarded
// with the async_queue). Exactly one of {done, dispose} runs per job, so a caller can
// release a protected JS callback / buffer / path here without separately tracking
// in-flight requests. Optional.
//
// Where it runs depends on whether a worker had taken the job. Not taken: in
// close_begin, on the loop thread, with the JS context alive — it may unprotect. Taken:
// after the worker is gone — in close_finish, which may run after the caller has
// released its context, or on the detached loop's last worker thread — so by then
// `cancel` has released the engine half and dispose must free memory only.
Pool_Dispose :: proc(user_data: rawptr)

// Pool_Cancel releases the engine half of a job's user_data — a protected JS callback,
// say — while a worker may still be running `work` on it. Called on the loop thread by
// close_begin for a job a worker has already taken, so the JS context the caller is
// about to release is not touched again by the `dispose` that follows much later,
// possibly from another thread (close_finish run by a reaper, or by the last worker of
// a detached loop). It must not write anything `work` reads. Optional: a job with
// nothing to release before its memory goes needs none.
Pool_Cancel :: proc(user_data: rawptr)

// Pool_Job pairs a unit of off-loop work with its on-loop completion. Allocated by
// pool_submit and freed by its completion (pool_complete) — or by the teardown
// (close_begin / close_finish) for a job whose completion is dropped. user_data is
// owned by the caller, not the pool; the pool only ever frees the Pool_Job wrapper
// (and invokes `dispose` so the caller can free user_data on the dropped path).
//
// The release rule, which every caller's hooks rely on:
//   - exactly one of {done, dispose} frees user_data;
//   - the engine half (JSValueUnprotect) is released exactly once: in `done`; in
//     `dispose` for a job no worker took; or in `cancel` for a job a worker took
//     before the teardown, in which case the later `dispose` finds nothing left to
//     release and frees memory only.
// `done` never runs once close_begin has run.
Pool_Job :: struct {
	work:      Pool_Work,
	done:      Pool_Done,
	dispose:   Pool_Dispose,
	cancel:    Pool_Cancel,
	user_data: rawptr,
	loop:      ^Loop,
	// Set under pool.mutex by the worker that pops the job. From then on the worker
	// may be inside `work`, or have posted the completion and still be reading
	// job.loop, so the teardown must neither free the job nor hand user_data to a
	// `dispose` that can run concurrently with `work` until that worker is joined.
	running:   bool,
}

// Thread_Pool is embedded in Loop. Its containers use loop.allocator; nothing is
// allocated and no thread is started until the first pool_submit.
//
// `pending` is a growable circular buffer (ring): jobs are enqueued at the tail and
// dequeued from `pending_head`, both O(1) under the mutex — no front-shift, so a large
// fs/crypto backlog does not turn dequeue into O(n) (and does not hold the mutex while
// memmoving). The backing grows by doubling and is bounded by the peak queue depth
// (slots are reused via wraparound), not by the total number of jobs ever submitted.
Thread_Pool :: struct {
	mutex:         sync.Mutex,
	wake:          sync.Cond, // workers sleep here until a job arrives or stop is requested
	pending:       []^Pool_Job, // ring backing (cap = len(pending)); mutex-guarded
	pending_head:  int, // index of the next job to dequeue
	pending_count: int, // number of live jobs in the ring
	threads:       [dynamic]^thread.Thread,
	outstanding:   [dynamic]^Pool_Job, // every live job (loop-thread-only; for teardown dispose/free)
	started:       bool,
	stopping:      bool,
	// Workers that have left their job loop for good. Bumped under the mutex as a
	// worker's last decision about the loop; read without it by close_ready.
	exited:        int,
	// Set under the mutex by close_detach: the last worker to exit finishes the loop.
	detached:      bool,
}

// pool_init binds the pool's dynamic containers to the loop allocator at zero
// capacity. Called once from the loop's init(); the ring backing stays nil and no
// thread is started until the first pool_submit.
pool_init :: proc(pool: ^Thread_Pool, allocator: mem.Allocator) {
	pool.threads = make([dynamic]^thread.Thread, allocator)
	pool.outstanding = make([dynamic]^Pool_Job, allocator)
}

// pool_destroy frees the pool's container backings. The workers must already be
// gone (pool_join, or the last worker of a detached loop) — close_release calls them
// in that order.
pool_destroy :: proc(pool: ^Thread_Pool, allocator: mem.Allocator) {
	delete(pool.threads)
	delete(pool.outstanding)

	if pool.pending != nil {
		delete(pool.pending, allocator)
	}
}

// pool_ring_push appends a job at the ring's tail, growing (doubling) when full.
// Mutex-held, loop thread. (Package-visible — not file-private — so the ring's
// FIFO/grow/wrap behavior can be unit-tested directly without spinning up workers.)
pool_ring_push :: proc(pool: ^Thread_Pool, job: ^Pool_Job, allocator: mem.Allocator) {
	if pool.pending_count == len(pool.pending) {
		new_cap := max(8, len(pool.pending) * 2)
		ns := make([]^Pool_Job, new_cap, allocator)
		// Copy the live entries into the front of the new backing, unwrapping the ring.
		for i in 0 ..< pool.pending_count {
			ns[i] = pool.pending[(pool.pending_head + i) % len(pool.pending)]
		}

		if pool.pending != nil {
			delete(pool.pending, allocator)
		}

		pool.pending = ns
		pool.pending_head = 0
	}

	tail := (pool.pending_head + pool.pending_count) % len(pool.pending)
	pool.pending[tail] = job
	pool.pending_count += 1
}

// pool_ring_pop removes and returns the head job. Caller guarantees the ring is
// non-empty. Mutex-held, worker thread. (Package-visible for the ring unit test.)
pool_ring_pop :: proc(pool: ^Thread_Pool) -> ^Pool_Job {
	job := pool.pending[pool.pending_head]
	pool.pending_head = (pool.pending_head + 1) % len(pool.pending)
	pool.pending_count -= 1
	return job
}

// pool_submit hands a unit of work to the loop's pool. `work` runs off-loop; `done`
// runs on the loop thread once it finishes; `dispose` (optional) releases user_data if
// the job is dropped at teardown before `done` runs. Returns false only if no worker
// thread could be started (or on a nil loop/work), in which case nothing is scheduled.
// Loop-thread only.
pool_submit :: proc(
	loop: ^Loop,
	work: Pool_Work,
	done: Pool_Done,
	user_data: rawptr = nil,
	dispose: Pool_Dispose = nil,
	cancel: Pool_Cancel = nil,
) -> bool {
	if loop == nil || work == nil {
		return false
	}

	pool := &loop.pool

	// Keep the loop alive (and blocking in poll) until the completion is posted.
	// Undone if the pool can't be started, so the loop is not pinned forever.
	async_begin(loop)

	if !pool_ensure_started(loop) {
		async_cancel(loop)
		return false
	}

	job := new(Pool_Job, loop.allocator)
	job.work = work
	job.done = done
	job.dispose = dispose
	job.cancel = cancel
	job.user_data = user_data
	job.loop = loop

	// outstanding is mutated only on the loop thread (submit, complete, shutdown), so
	// it needs no lock; the pending ring is shared with the workers.
	append(&pool.outstanding, job)
	sync.lock(&pool.mutex)
	pool_ring_push(pool, job, loop.allocator)
	sync.cond_signal(&pool.wake)
	sync.unlock(&pool.mutex)
	return true
}

// pool_ensure_started starts the workers on the first submit. Each Thread struct comes
// from loop.allocator (core:thread allocates it from context.allocator), so a detached
// loop's workers can free it with the rest of the loop.
@(private = "file")
pool_ensure_started :: proc(loop: ^Loop) -> bool {
	pool := &loop.pool

	if pool.started {
		return true
	}

	pool.stopping = false
	pool.exited = 0
	// Workers receive the loop pointer and reach the pool through loop.pool; the loop
	// outlives them (close_finish joins every worker before the loop is freed, and a
	// detached loop is freed by its last worker).
	context.allocator = loop.allocator
	for _ in 0 ..< THREADPOOL_SIZE {
		th := thread.create(pool_worker)

		if th == nil {
			continue
		}

		th.data = loop
		thread.start(th)
		append(&pool.threads, th)
	}

	// As long as one worker started, the pool can make progress.
	if len(pool.threads) == 0 {
		return false
	}

	pool.started = true
	return true
}

@(private = "file")
pool_worker :: proc(self: ^thread.Thread) {
	loop := cast(^Loop)self.data
	pool := &loop.pool
	for {
		sync.lock(&pool.mutex)
		for pool.pending_count == 0 && !pool.stopping {
			sync.cond_wait(&pool.wake, &pool.mutex)
		}

		if pool.stopping && pool.pending_count == 0 {
			// Count out under the mutex, so close_detach and the last worker agree on
			// who finishes a detached loop: whichever of them sees the other's write.
			exited := sync.atomic_add(&pool.exited, 1) + 1
			last_of_detached := pool.detached && exited == len(pool.threads)
			sync.unlock(&pool.mutex)

			if last_of_detached {
				pool_release_detached(loop, self)
				return
			}

			// Wake a driver waiting to reap this loop (close_ready moved). Safe after
			// the unlock: the pipe closes only after this thread is joined.
			wakeup(loop)
			return
		}

		job := pool_ring_pop(pool) // FIFO from the ring head, O(1)
		job.running = true
		sync.unlock(&pool.mutex)

		if job.work != nil {
			job.work(job.user_data)
		}

		// Release any per-job scratch the work left on this worker's temp arena.
		free_all(context.temp_allocator)
		// Hand back to the loop thread. After this the worker must not touch the job —
		// the completion (or teardown) owns it now.
		post_async(job.loop, pool_complete, job)
	}
}

// pool_release_detached finishes a detached loop from its last worker: joins the
// other workers (each has counted out, so the join waits only for its thread
// epilogue), frees their Thread structs, and releases the loop (close_release) and the
// Loop struct itself. Its own Thread struct cannot be freed here — core:thread writes
// `Done` into it after this proc returns — so it is flagged Self_Cleanup, which makes
// core:thread detach the pthread and free the struct through its creation allocator
// (loop.allocator) once it is done with it. Set by the thread on itself, so it cannot
// race core:thread's own read of the flag.
@(private = "file")
pool_release_detached :: proc(loop: ^Loop, self: ^thread.Thread) {
	pool := &loop.pool
	for th in pool.threads {
		if th != self {
			thread.destroy(th)
		}
	}
	clear(&pool.threads)
	sync.atomic_or(&self.flags, {.Self_Cleanup})
	pool.started = false
	close_release(loop)
	free(loop, loop.allocator)
}

// pool_complete runs on the loop thread once a job's work finishes: it frees the job
// wrapper, then invokes the caller's `done` with (loop, user_data). The job is
// released before `done` runs so a `done` that submits more work cannot observe a
// half-freed wrapper. `dispose` is NOT called on this path — `done` owns user_data on
// success. The async_begin from submit is balanced by drain_async's decrement around
// this call.
@(private = "file")
pool_complete :: proc(loop: ^Loop, user_data: rawptr) {
	job := cast(^Pool_Job)user_data
	done := job.done
	ud := job.user_data
	pool_release_job(loop, job)

	if done != nil {
		done(loop, ud)
	}
}

@(private = "file")
pool_release_job :: proc(loop: ^Loop, job: ^Pool_Job) {
	pool := &loop.pool
	for i in 0 ..< len(pool.outstanding) {
		if pool.outstanding[i] == job {
			unordered_remove(&pool.outstanding, i)
			break
		}
	}
	free(job, loop.allocator)
}

// pool_stop stops the loop's pool without waiting for it, and settles every job, for
// close_begin. Queued-but-unstarted jobs are dropped from the ring under the lock and
// the workers woken, so no worker takes another job; then, on the loop thread with
// the JS context alive, each job no worker took is disposed and freed at once, and
// each job a worker did take gets its `cancel` and stays outstanding — the worker may
// still be in `work` on its user_data, or about to read job.loop to post — until
// pool_join or the detached loop's last worker disposes it.
//
// Returns:
//   busy  true when some worker had taken a job: joining the pool may then wait for as
//         long as that job's `work` blocks.
//
// CONTRACT: teardown-only. This is NOT a quiesce/restart primitive — it does not
// balance the per-job async_begin counts and leaves posted completions in async_queue
// (their jobs are freed by close_release, and the tasks are never invoked). Loop-thread
// only; a no-op when the pool never started.
pool_stop :: proc(loop: ^Loop) -> (busy: bool) {
	pool := &loop.pool

	if !pool.started {
		return false
	}

	sync.lock(&pool.mutex)
	pool.stopping = true
	// Drop the queued backlog (the jobs stay in `outstanding`, settled below).
	pool.pending_count = 0
	pool.pending_head = 0
	sync.cond_broadcast(&pool.wake)
	// `running` is set under this mutex by the worker that pops a job, and nothing pops
	// once the ring is empty, so the flags read after this unlock are final.
	sync.unlock(&pool.mutex)
	i := 0
	for i < len(pool.outstanding) {
		job := pool.outstanding[i]

		if job.running {
			if job.cancel != nil {
				job.cancel(job.user_data)
			}

			busy = true
			i += 1
			continue
		}

		unordered_remove(&pool.outstanding, i)

		if job.dispose != nil {
			job.dispose(job.user_data)
		}

		free(job, loop.allocator)
	}
	return
}

// pool_join waits for every worker to exit and frees their Thread structs. Blocks for
// as long as a job's `work` does; close_ready says when it will not. close_finish only.
pool_join :: proc(loop: ^Loop) {
	pool := &loop.pool

	if !pool.started {
		return
	}

	for th in pool.threads {thread.destroy(th)} 	// joins, then frees through loop.allocator
	clear(&pool.threads)
	pool.started = false
}

// pool_dispose_outstanding disposes and frees the jobs pool_stop left: every one a
// worker had taken. Their `cancel` already ran, so `dispose` frees memory only — this
// may run after the caller's JS context is gone, or on a worker thread. Once every
// worker has exited.
pool_dispose_outstanding :: proc(loop: ^Loop) {
	pool := &loop.pool
	for job in pool.outstanding {
		if job.dispose != nil {
			job.dispose(job.user_data)
		}

		free(job, loop.allocator)
	}
	clear(&pool.outstanding)
}
