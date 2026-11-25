package eventloop

import "base:runtime"
import "core:mem"
import "core:sync"
import "core:thread"
import "core:time"

// Generic worker pool. Any blocking or CPU-bound operation (file I/O, a DNS lookup, a
// crypto KDF, a body decode) runs OFF the loop thread on a worker, and its completion
// is handed back to the loop thread through post_async. A caller supplies a `work`
// proc (run off-loop) and a `done` proc (run on the loop).
//
// One pool serves many loops (#36). Each loop that uses a pool is its CLIENT
// (Pool_Client): the client owns the loop's queue of jobs and is what a job points
// to, never the loop itself. Two owners exist:
//   - Larva's page runner creates one pool per runner thread (pool_create) and
//     attaches every page loop to it (pool_attach). Before, every page loop that
//     touched the pool started four threads of its own: 4 x N threads for N live
//     pages, +4.1 MB RSS a page in glibc's per-thread arenas (#36, measured).
//   - Any other loop (`lava run`, `lava eval`, the unit tests) gets a PRIVATE pool on
//     its first pool_submit, with itself as the only client, and tears it down with
//     the loop. Same code, one client: such a loop owns its thread, and destroy keeps
//     waiting for blocking work as it always has (Node joins its workers at exit
//     too, runtime.odin Result_Hook) — a process-wide pool would make `destroy`
//     either wait on other loops' work or stop waiting on its own.
//
// Isolation between clients, the reason the pool used to be per loop:
//   - A worker posts a completion only under the pool mutex and only while its
//     client is open. close_begin closes the client under that same mutex before
//     anything else, so a late completion never reaches a closed loop, nor whatever
//     loop later reuses its address or its wakeup pipe's descriptor numbers. The loop
//     can therefore close its pipe and be freed at once; nothing waits for a worker.
//   - Clients are served round-robin, at most POOL_PER_CLIENT_CAP jobs running each,
//     so one page's backlog does not delay a sibling's one job.
//   - A job still running when its client closes is an ORPHAN: its worker finishes
//     `work`, disposes the job (memory only — the loop already ran its cancel) and
//     goes back to the pool. Orphans do not count toward the core size, so the next
//     submit starts a replacement instead of queueing behind a job that may never end
//     (a read on a FIFO nobody writes).
//   - A page whose own jobs block every core worker does not starve its siblings: the
//     runner's tick (pool_tick) starts an overflow worker when a client with queued
//     work has nothing running, no worker is idle, and the oldest running job is older
//     than POOL_STALL_MS. Overflow workers exit after POOL_IDLE_EXIT idle.
//
// Memory: the pool, its clients, their rings and every Pool_Job come from the
// allocator the pool was created with (the heap for the runner's pool, loop.allocator
// for a private one). A worker frees through it from its own thread, so it must be
// thread-safe — the same requirement post_async already puts on loop.allocator. The
// workers' Thread structs always come from the heap: a worker cleans up after itself
// (Self_Cleanup), and core:thread frees its struct after the pool may already be gone.
//
// Lifetime:
//   - Workers start on demand, never more than one per job waiting, so a loop that
//     never offloads work spawns no threads and a page with one lookup starts one.
//   - pool_submit does async_begin(loop) so the loop stays alive and parked in poll
//     until the completion is posted; drain_async balances it when the completion runs.
//   - A worker touches ONLY its job's user_data while in `work` (never a loop or the JS
//     engine); the handoff is the post_async at the end, whose lock publishes what the
//     worker wrote.
//   - The pool is freed by whoever drops its last reference: the owner (pool_release),
//     the last client to close, or the last worker to exit — so pool_release never
//     waits for a blocked worker, and the runner allocator may be freed at once.

// THREADPOOL_SIZE is the core size K: the workers a pool keeps (idle ones included)
// for its open clients. 4 mirrors libuv's default UV_THREADPOOL_SIZE and is what each
// page had to itself before #36, so a single page's lookups and reads see the same
// parallelism as before.
THREADPOOL_SIZE :: 4

// POOL_PER_CLIENT_CAP bounds the jobs one client may have running at once, so a page
// with a deep backlog leaves workers for its siblings. Equal to THREADPOOL_SIZE: a page
// alone on its runner still gets all four, as before.
POOL_PER_CLIENT_CAP :: 4

// POOL_STALL_MS is how old the oldest running job must be before pool_tick starts an
// overflow worker for a client that has nothing running. Chosen, not tuned: about 70x
// the slowest quick job measured, so a burst of them drains through the core workers
// without spawning — core:net's net.resolve("localhost:80") took p50 59 us / p99 139 us
// and reading /proc/self/stat p50 9 us / p99 20 us (201 calls each in a loop on one
// thread, -o:speed, 16-core dev box) — and short enough that a sibling of a page whose
// lookups hang waits about one runner round, not the resolver's timeout. Pinned by
// shared_pool_page_with_four_stalled_jobs_does_not_starve_a_sibling.
POOL_STALL_MS :: 10

// POOL_MAX_WORKERS is the hard cap H on a pool's threads, overflow and orphan-held
// workers included. K (4) + the runner's orphan bound (RUNNER_ORPHAN_LIMIT, 32) + 28
// for live pages that stall at once: the worst case is about what one runner pinned
// before #36 with its reaping list full (8 loops x 4) plus a few live pages' pools,
// where the common case is now 4. At the cap a starving page waits for a worker to
// free up instead of getting a new one.
POOL_MAX_WORKERS :: 64

// POOL_IDLE_EXIT is how long a worker above the core size stays idle before it exits.
// Long enough that a page that stalls repeatedly does not create and join a thread per
// stall; short enough that a stall's extra threads are gone soon after it ends.
POOL_IDLE_EXIT :: time.Second

// Pool_Work runs on a worker thread, off the loop. It must touch only its own
// user_data — no loop calls, no JS engine access — since it runs concurrently with
// the loop thread. Its result is carried back through user_data.
Pool_Work :: proc(user_data: rawptr)

// Pool_Done runs on the loop thread after the work finishes (delivered through
// post_async), so it may safely touch the loop and the JS engine.
Pool_Done :: proc(loop: ^Loop, user_data: rawptr)

// Pool_Dispose releases a job's user_data when its `done` will NOT run — the job was
// dropped because its loop closed. Exactly one of {done, dispose} runs per job, so a
// caller can release a protected JS callback / buffer / path here without separately
// tracking in-flight requests. Optional.
//
// Where it runs depends on whether a worker had taken the job. Not taken (still
// queued, or finished with its completion not yet run): in close_begin, on the loop
// thread, with the JS context alive — it may unprotect. Taken: once the worker leaves
// `work`, on that worker's thread, possibly long after the caller released its context
// — so by then `cancel` has released the engine half and dispose must free memory only.
Pool_Dispose :: proc(user_data: rawptr)

// Pool_Cancel releases the engine half of a job's user_data — a protected JS callback,
// say — while a worker may still be running `work` on it. Called on the loop thread by
// close_begin for a job a worker has already taken, so the JS context the caller is
// about to release is not touched again by the `dispose` that follows later, from the
// worker's thread. Always runs before that dispose. It must not write anything `work`
// reads. Optional: a job with nothing to release before its memory goes needs none.
Pool_Cancel :: proc(user_data: rawptr)

// Pool_Job_State is where a job is, written under the pool mutex.
Pool_Job_State :: enum u8 {
	// In its client's ring; no worker has seen it.
	Queued,
	// A worker is inside `work`.
	Running,
	// `work` returned and the completion is in the loop's async_queue.
	Posted,
	// An orphan whose `work` returned before the loop ran its cancel: the loop thread
	// disposes it after the cancel (close_begin).
	Parked,
}

// Pool_Job pairs a unit of off-loop work with its on-loop completion. Allocated by
// pool_submit and freed by its completion (pool_complete), by close_begin for a job no
// worker holds, or by the worker of an orphan. user_data is owned by the caller, not
// the pool; the pool only ever frees the Pool_Job wrapper (and invokes `dispose` so
// the caller can free user_data on the dropped path).
//
// The release rule, which every caller's hooks rely on:
//   - exactly one of {done, dispose} frees user_data;
//   - the engine half (JSValueUnprotect) is released exactly once: in `done`; in
//     `dispose` for a job no worker held at close; or in `cancel` for a job a worker
//     was running, in which case the later `dispose` finds nothing left to release
//     and frees memory only.
// `done` never runs once close_begin has run.
Pool_Job :: struct {
	work:      Pool_Work,
	done:      Pool_Done,
	dispose:   Pool_Dispose,
	cancel:    Pool_Cancel,
	user_data: rawptr,
	client:    ^Pool_Client,
	// Index in client.outstanding, so a completion leaves it in O(1). Loop thread only.
	slot:      int,
	state:     Pool_Job_State,
	// Set under the mutex by close_begin once the job's cancel has run: from then on
	// the orphan's worker disposes it. Until then a worker that finishes parks it.
	cancelled: bool,
}

// Job_Ring is a client's queue: a growable circular buffer. Jobs are enqueued at the
// tail and dequeued from `head`, both O(1) — no front-shift, so a large fs backlog
// does not turn dequeue into O(n) under the pool mutex. The backing grows by doubling
// and is bounded by the peak queue depth (slots are reused via wraparound).
Job_Ring :: struct {
	buf:   []^Pool_Job,
	head:  int,
	count: int,
}

// Pool_Client is one loop's membership in a pool. Allocated from the pool's allocator
// and freed when its last reference goes: the loop holds one until close_begin, and
// each orphan holds one until its worker lets go of it. The loop itself is never
// reached through a closed client.
Pool_Client :: struct {
	pool:        ^Worker_Pool,
	loop:        ^Loop,
	// Every live job of this client: queued, running, or posted. Loop thread only.
	outstanding: [dynamic]^Pool_Job,
	// The fields below are guarded by pool.mutex.
	queue:       Job_Ring,
	running:     int,
	refs:        int,
	closed:      bool,
	listed:      bool, // in pool.ready
}

// Pool_Worker is one worker thread's record, so the tick can tell how long the oldest
// running job has run and whether it is an orphan. Guarded by pool.mutex.
@(private = "file")
Pool_Worker :: struct {
	pool:    ^Worker_Pool,
	job:     ^Pool_Job, // nil while idle
	started: time.Tick,
}

// Worker_Pool is the pool. Every field but `allocator` is guarded by `mutex`; the
// counters tests and the runner read (spawned, orphans) are also written atomically
// so they can be read without it.
Worker_Pool :: struct {
	mutex:     sync.Mutex,
	wake:      sync.Cond, // idle workers sleep here until a job arrives or the owner leaves
	drained:   sync.Cond, // signalled when the last worker exits (pool_close_private)
	allocator: mem.Allocator,
	// Clients with queued jobs, in round-robin order; `cursor` is where the next pick
	// starts.
	ready:     [dynamic]^Pool_Client,
	cursor:    int,
	workers:   [dynamic]^Pool_Worker,
	queued:    int, // jobs queued across all clients
	idle:      int, // workers waiting for a job
	live:      int, // worker threads started and not yet exited
	// Running jobs whose client has closed. Not counted toward THREADPOOL_SIZE.
	orphans:   int,
	// Threads ever started; for the thread-bound test and the bench.
	spawned:   int,
	// References: owners (pool_create's caller, pool_retain) and clients. The pool is
	// freed once both are zero and no worker is left.
	owners:    int,
	clients:   int,
	// Set while pool_close_private waits for the workers: it frees the pool itself.
	waiting:   bool,
}

// pool_create makes an empty pool: no thread starts until a client submits a job.
//
// Params:
//   allocator  Owns the pool, its clients and its jobs; captured for the pool's life.
//              Must be thread-safe and outlive every worker, since the last worker
//              may free the pool through it — the page runner passes the heap.
// Returns:
//   The pool, holding one owner reference that pool_release drops.
pool_create :: proc(allocator: mem.Allocator) -> ^Worker_Pool {
	pool := new(Worker_Pool, allocator)
	pool.allocator = allocator
	pool.ready = make([dynamic]^Pool_Client, allocator)
	pool.workers = make([dynamic]^Pool_Worker, allocator)
	pool.owners = 1
	return pool
}

// pool_retain adds an owner reference: the pool stays allocated, and its idle workers
// alive, until a matching pool_release. For an embedder (or a test) that must observe
// the pool past its owner's release.
pool_retain :: proc(pool: ^Worker_Pool) {
	sync.lock(&pool.mutex)
	pool.owners += 1
	sync.unlock(&pool.mutex)
}

// pool_release drops an owner reference without waiting for anything. Once no owner is
// left, idle workers exit, and a worker still inside an orphan's `work` exits when it
// returns; the pool is freed by whichever of them, or of the clients still open, goes
// last — at once if none is left.
//
// After the last owner's release no new client may attach: the runner closes all its
// pages first.
pool_release :: proc(pool: ^Worker_Pool) {
	sync.lock(&pool.mutex)
	pool.owners -= 1
	sync.cond_broadcast(&pool.wake)
	last := pool_unreferenced(pool)
	sync.unlock(&pool.mutex)

	if last {
		pool_free(pool)
	}
}

// pool_attach makes `loop` a client of `pool`. Call it right after init, before
// anything submits; a loop that is never attached gets a private pool on its first
// pool_submit. The client is released by close_begin.
pool_attach :: proc(loop: ^Loop, pool: ^Worker_Pool) {
	loop.pool = pool
	loop.owns_pool = false
	loop.pool_client = pool_client_create(pool, loop)
}

// pool_orphans is the number of jobs still running whose loop has closed. Lock-free
// read; the page runner bounds it (RUNNER_ORPHAN_LIMIT).
pool_orphans :: proc(pool: ^Worker_Pool) -> int {
	return sync.atomic_load(&pool.orphans)
}

// pool_tick starts an overflow worker when some client is starving: it has queued
// work and nothing running, no worker is idle, and the oldest running (non-orphan) job
// has run for POOL_STALL_MS or more. One worker per call, never past POOL_MAX_WORKERS.
// The page runner calls it once a round, after the pages' ticks; nothing else does,
// so a loop alone on its pool never overflows (it cannot starve itself: a client with
// a job running is not starving).
pool_tick :: proc(pool: ^Worker_Pool) {
	sync.lock(&pool.mutex)
	defer sync.unlock(&pool.mutex)

	if age, starving := pool_stall_age(pool); starving && age >= POOL_STALL_MS * time.Millisecond {
		pool_spawn(pool)
	}
}

// pool_wait_hint_ms is how long a driver may block before pool_tick has work to do:
// -1 when nothing is starving (a completion wakes the client's loop by itself), the
// milliseconds until the oldest running job reaches POOL_STALL_MS otherwise, at least 1
// so a driver whose spawn just failed does not spin.
pool_wait_hint_ms :: proc(pool: ^Worker_Pool) -> int {
	sync.lock(&pool.mutex)
	defer sync.unlock(&pool.mutex)
	age, starving := pool_stall_age(pool)

	if !starving {
		return -1
	}

	left := POOL_STALL_MS - int(time.duration_milliseconds(age))
	return max(left, 1)
}

// pool_submit hands a unit of work to the loop's pool. `work` runs off-loop; `done`
// runs on the loop thread once it finishes; `dispose` (optional) releases user_data if
// the job is dropped at close before `done` runs; `cancel` (optional) releases its
// engine half if a worker holds it at close. Returns false only if no worker exists
// and none could be started (or on a nil loop/work, or a loop already closing), in
// which case nothing is scheduled. Loop-thread only.
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

	if loop.pool_client == nil {
		loop.pool = pool_create(loop.allocator)
		loop.owns_pool = true
		loop.pool_client = pool_client_create(loop.pool, loop)
	}

	c := loop.pool_client
	pool := c.pool

	if c.closed {
		return false
	}

	sync.lock(&pool.mutex)

	// Start a worker when no idle one is left for this job and the core is not full —
	// orphans aside. With a worker started for every job waiting (and at most K), a
	// burst starts K threads, and a page with one lookup starts one.
	if pool.queued + 1 > pool.idle && pool.live - pool.orphans < THREADPOOL_SIZE {
		pool_spawn(pool)
	}

	if pool.live == 0 {
		sync.unlock(&pool.mutex)
		return false
	}

	job := new(Pool_Job, pool.allocator)
	job.work = work
	job.done = done
	job.dispose = dispose
	job.cancel = cancel
	job.user_data = user_data
	job.client = c
	job_ring_push(&c.queue, job, pool.allocator)
	pool.queued += 1

	if !c.listed {
		append(&pool.ready, c)
		c.listed = true
	}

	sync.cond_signal(&pool.wake)
	sync.unlock(&pool.mutex)

	// outstanding is the loop thread's alone, so it needs no lock. Keep the loop alive
	// (and blocking in poll) until the completion is posted.
	job.slot = len(c.outstanding)
	append(&c.outstanding, job)
	async_begin(loop)
	return true
}

// job_ring_push appends a job at the ring's tail, growing (doubling) when full. Under
// the pool mutex. (Package-visible for the ring unit test.)
job_ring_push :: proc(ring: ^Job_Ring, job: ^Pool_Job, allocator: mem.Allocator) {
	if ring.count == len(ring.buf) {
		new_cap := max(8, len(ring.buf) * 2)
		ns := make([]^Pool_Job, new_cap, allocator)
		// Copy the live entries into the front of the new backing, unwrapping the ring.
		for i in 0 ..< ring.count {
			ns[i] = ring.buf[(ring.head + i) % len(ring.buf)]
		}

		if ring.buf != nil {
			delete(ring.buf, allocator)
		}

		ring.buf = ns
		ring.head = 0
	}

	tail := (ring.head + ring.count) % len(ring.buf)
	ring.buf[tail] = job
	ring.count += 1
}

// job_ring_pop removes and returns the head job. Caller guarantees the ring is
// non-empty. Under the pool mutex. (Package-visible for the ring unit test.)
job_ring_pop :: proc(ring: ^Job_Ring) -> ^Pool_Job {
	job := ring.buf[ring.head]
	ring.head = (ring.head + 1) % len(ring.buf)
	ring.count -= 1
	return job
}

// pool_close_client closes the loop's client, for close_begin. Under the mutex it marks
// the client closed — no worker posts to the loop after this — takes the client's
// queued jobs out of the round-robin, and counts its running jobs as orphans. Then, on
// the loop thread with the JS context alive, it disposes and frees every job no worker
// holds (queued, or finished with its completion not yet run) and runs `cancel` for
// each running one, which its worker disposes once `work` returns.
//
// Returns:
//   busy  true when the loop owns its pool and a worker is still inside one of its
//         jobs: close_finish will wait for it. Always false for a shared pool's
//         client — nothing of the loop is left for the worker to reach.
@(private)
pool_close_client :: proc(loop: ^Loop) -> (busy: bool) {
	c := loop.pool_client

	if c == nil {
		return false
	}

	pool := c.pool
	sync.lock(&pool.mutex)
	c.closed = true
	pool_unlist(pool, c)
	pool.queued -= c.queue.count
	c.queue.count = 0
	c.queue.head = 0
	// Running jobs go to the front of outstanding; the rest are settled below.
	orphans := 0
	for job, i in c.outstanding {
		if job.state == .Running {
			c.outstanding[i], c.outstanding[orphans] = c.outstanding[orphans], job
			orphans += 1
		}
	}
	sync.atomic_add(&pool.orphans, orphans)
	c.refs += orphans

	// Orphans no longer count toward the core size: another client's queued job may
	// need a replacement now.
	if pool.queued > pool.idle && pool.live - pool.orphans < THREADPOOL_SIZE {
		pool_spawn(pool)
	}

	sync.unlock(&pool.mutex)

	for job in c.outstanding[orphans:] {
		if job.dispose != nil {
			job.dispose(job.user_data)
		}

		free(job, pool.allocator)
	}

	for job in c.outstanding[:orphans] {
		if job.cancel != nil {
			job.cancel(job.user_data)
		}
	}

	// From here an orphan's worker disposes it; one that finished during the cancels
	// above was parked for this thread to dispose instead.
	parked := 0
	sync.lock(&pool.mutex)
	for job in c.outstanding[:orphans] {
		if job.state == .Parked {
			c.outstanding[parked] = job
			parked += 1
		} else {
			job.cancelled = true
		}
	}
	sync.unlock(&pool.mutex)

	for job in c.outstanding[:parked] {
		if job.dispose != nil {
			job.dispose(job.user_data)
		}

		free(job, pool.allocator)
	}

	delete(c.outstanding)
	c.outstanding = nil
	sync.lock(&pool.mutex)
	// The parked jobs' references and the loop's own.
	c.refs -= parked + 1
	freed := pool_client_unref(pool, c)
	sync.unlock(&pool.mutex)

	if freed {
		pool_client_free(pool, c)
	}

	loop.pool_client = nil
	return loop.owns_pool && orphans > parked
}

// pool_close_private drops the loop's private pool and waits for its workers to
// exit, for close_finish: as long as a job's `work` blocks. A no-op for a shared pool's
// client, which waits for nothing.
@(private)
pool_close_private :: proc(loop: ^Loop) {
	if !loop.owns_pool || loop.pool == nil {
		return
	}

	pool := loop.pool
	loop.pool = nil
	loop.owns_pool = false
	sync.lock(&pool.mutex)
	pool.owners -= 1
	pool.waiting = true
	sync.cond_broadcast(&pool.wake)
	for pool.live > 0 {
		sync.cond_wait(&pool.drained, &pool.mutex)
	}
	sync.unlock(&pool.mutex)
	// The loop's client went in close_begin, and its orphans with their workers.
	assert(pool.clients == 0 && pool.owners == 0, "a private pool outlived its loop's client")
	pool_free(pool)
}

@(private = "file")
pool_client_create :: proc(pool: ^Worker_Pool, loop: ^Loop) -> ^Pool_Client {
	c := new(Pool_Client, pool.allocator)
	c.pool = pool
	c.loop = loop
	c.outstanding = make([dynamic]^Pool_Job, pool.allocator)
	c.refs = 1
	sync.lock(&pool.mutex)
	pool.clients += 1
	sync.unlock(&pool.mutex)
	return c
}

// pool_client_unref reports whether the client lost its last reference; the caller
// frees it (pool_client_free) after the unlock. Under the mutex.
@(private = "file")
pool_client_unref :: proc(pool: ^Worker_Pool, c: ^Pool_Client) -> bool {
	if c.refs > 0 {
		return false
	}

	pool.clients -= 1
	return true
}

// pool_client_free frees a client nothing references any more, and the pool with it
// when that was the pool's last reference and no worker is left.
@(private = "file")
pool_client_free :: proc(pool: ^Worker_Pool, c: ^Pool_Client) {
	if c.queue.buf != nil {
		delete(c.queue.buf, pool.allocator)
	}

	free(c, pool.allocator)
	sync.lock(&pool.mutex)
	last := pool_unreferenced(pool)
	sync.unlock(&pool.mutex)

	if last {
		pool_free(pool)
	}
}

// pool_unreferenced reports whether nothing holds the pool any more and nobody else
// will free it. Under the mutex.
@(private = "file")
pool_unreferenced :: proc(pool: ^Worker_Pool) -> bool {
	return pool.owners == 0 && pool.clients == 0 && pool.live == 0 && !pool.waiting
}

@(private = "file")
pool_free :: proc(pool: ^Worker_Pool) {
	allocator := pool.allocator
	delete(pool.ready)
	delete(pool.workers)
	free(pool, allocator)
}

// pool_unlist takes a client out of the round-robin, keeping the order of the rest.
// Under the mutex.
@(private = "file")
pool_unlist :: proc(pool: ^Worker_Pool, c: ^Pool_Client) {
	if !c.listed {
		return
	}

	for r, i in pool.ready {
		if r == c {
			ordered_remove(&pool.ready, i)

			if i < pool.cursor {
				pool.cursor -= 1
			}

			break
		}
	}
	c.listed = false
}

// pool_pick takes the next job round-robin: the first ready client from the cursor
// with fewer than POOL_PER_CLIENT_CAP jobs running, its oldest job, and the cursor
// moves past it. nil when every ready client is at its cap. Under the mutex.
@(private = "file")
pool_pick :: proc(pool: ^Worker_Pool) -> ^Pool_Job {
	for _ in 0 ..< len(pool.ready) {
		idx := pool.cursor % len(pool.ready)
		c := pool.ready[idx]
		pool.cursor = idx + 1

		if c.running >= POOL_PER_CLIENT_CAP {
			continue
		}

		job := job_ring_pop(&c.queue)
		pool.queued -= 1

		if c.queue.count == 0 {
			ordered_remove(&pool.ready, idx)
			c.listed = false
			pool.cursor = idx
		}

		return job
	}
	return nil
}

// pool_stall_age reports whether a client is starving behind running work — it has
// queued jobs and nothing running, no worker is idle to take them, and some job that is
// not an orphan is running — and, if so, how long the oldest such job has run. Orphans
// are left out: the core rule in pool_submit and pool_close_client replaces them, not
// the stall. Under the mutex.
@(private = "file")
pool_stall_age :: proc(pool: ^Worker_Pool) -> (age: time.Duration, starving: bool) {
	if pool.idle > 0 || pool.live >= POOL_MAX_WORKERS {
		return 0, false
	}

	waiting := false
	for c in pool.ready {
		if c.running == 0 {
			waiting = true
			break
		}
	}

	if !waiting {
		return 0, false
	}

	now := time.tick_now()
	for w in pool.workers {
		if w.job != nil && !w.job.client.closed {
			age = max(age, time.tick_diff(w.started, now))
			starving = true
		}
	}
	return
}

// pool_spawn starts one worker thread. The thread cleans up after itself
// (Self_Cleanup), so nothing joins it; its struct comes from the heap because
// core:thread frees it after the proc returns, when the pool — and a private pool's
// allocator — may already be gone. Under the mutex: the new worker blocks on it until
// the caller unlocks.
@(private = "file")
pool_spawn :: proc(pool: ^Worker_Pool) -> bool {
	if pool.live >= POOL_MAX_WORKERS {
		return false
	}

	w := new(Pool_Worker, pool.allocator)
	w.pool = pool
	context.allocator = runtime.heap_allocator()
	th := thread.create_and_start_with_poly_data(w, pool_worker_main, self_cleanup = true)

	if th == nil {
		free(w, pool.allocator)
		return false
	}

	append(&pool.workers, w)
	pool.live += 1
	sync.atomic_add(&pool.spawned, 1)
	return true
}

@(private = "file")
pool_worker_main :: proc(w: ^Pool_Worker) {
	pool := w.pool
	sync.lock(&pool.mutex)
	for {
		job := pool_pick(pool)

		if job == nil {
			if pool.owners == 0 {
				break
			}

			pool.idle += 1
			woken := sync.cond_wait_with_timeout(&pool.wake, &pool.mutex, POOL_IDLE_EXIT)
			pool.idle -= 1

			// Above the core size (orphans aside), an idle worker leaves.
			if !woken && pool.queued == 0 && pool.live - pool.orphans > THREADPOOL_SIZE {
				break
			}

			continue
		}

		c := job.client
		job.state = .Running
		c.running += 1
		w.job = job
		w.started = time.tick_now()
		sync.unlock(&pool.mutex)

		job.work(job.user_data)
		// Release any per-job scratch the work left on this worker's temp arena.
		free_all(context.temp_allocator)

		sync.lock(&pool.mutex)
		w.job = nil
		c.running -= 1

		// Posted under the mutex, and only to an open client: close_begin closes it
		// under the same mutex, so no completion can reach a closed loop. After the
		// post the job is the loop's.
		if !c.closed {
			job.state = .Posted
			post_async(c.loop, pool_complete, job)
			continue
		}

		sync.atomic_sub(&pool.orphans, 1)

		if !job.cancelled {
			// close_begin has not run its cancel yet; it disposes the job after it.
			job.state = .Parked
			continue
		}

		c.refs -= 1
		freed := pool_client_unref(pool, c)
		sync.unlock(&pool.mutex)

		if job.dispose != nil {
			job.dispose(job.user_data)
		}

		free(job, pool.allocator)

		// Never the pool's last reference: this worker is still live.
		if freed {
			pool_client_free(pool, c)
		}

		sync.lock(&pool.mutex)
	}

	for x, i in pool.workers {
		if x == w {
			unordered_remove(&pool.workers, i)
			break
		}
	}
	free(w, pool.allocator)
	pool.live -= 1

	if pool.live == 0 {
		sync.cond_broadcast(&pool.drained)
	}

	last := pool_unreferenced(pool)
	sync.unlock(&pool.mutex)

	// Nothing of the pool is touched after the unlock unless this worker frees it.
	if last {
		pool_free(pool)
	}
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
	c := job.client
	done := job.done
	ud := job.user_data
	last := c.outstanding[len(c.outstanding) - 1]
	c.outstanding[job.slot] = last
	last.slot = job.slot
	pop(&c.outstanding)
	free(job, c.pool.allocator)

	if done != nil {
		done(loop, ud)
	}
}
