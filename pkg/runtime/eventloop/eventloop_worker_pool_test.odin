// Linux-only: shared_pool_threads_bounded reads /proc/self/status.
#+build linux
package eventloop

import "base:runtime"
import "core:mem"
import "core:os"
import "core:strconv"
import "core:strings"
import "core:sync"
import "core:testing"
import "core:time"

// One worker pool shared by many loops (#36): the page runner's shape, driven here
// without JS. Each loop is a client of the pool; a job blocks on a semaphore the test
// posts, standing in for a lookup the resolver never answers or a read on a FIFO.
//
// Every test that leaves a job blocked releases it before it returns, so a red run
// fails on an assertion instead of leaving a worker parked for the rest of the binary.

@(private = "file")
TEST_THREADS :: #config(ODIN_TEST_THREADS, 0)

@(private = "file")
Gated_Job :: struct {
	gate:        sync.Sema,
	gated:       bool, // work blocks on `gate` until the test posts it
	started:     bool, // atomic: a worker is inside `work`
	seq:         int, // atomic: dispatch order, from the test's counter (0 = never ran)
	counter:     ^int, // shared dispatch counter; nil for none
	done:        int, // loop thread only
	cancel:      int, // atomic
	dispose:     int, // atomic
	cancel_tid:  int,
	dispose_tid: int,
	cancel_at:   int, // atomic: the shared sequence number at cancel
	dispose_at:  int, // atomic: the shared sequence number at dispose
	order:       ^int, // shared sequence for cancel/dispose ordering; nil for none
}

@(private = "file")
gated_work :: proc(user_data: rawptr) {
	job := cast(^Gated_Job)user_data

	if job.counter != nil {
		sync.atomic_store(&job.seq, sync.atomic_add(job.counter, 1) + 1)
	}

	sync.atomic_store(&job.started, true)

	if job.gated {
		sync.sema_wait(&job.gate)
	}
}

@(private = "file")
gated_done :: proc(loop: ^Loop, user_data: rawptr) {
	(cast(^Gated_Job)user_data).done += 1
}

@(private = "file")
gated_cancel :: proc(user_data: rawptr) {
	job := cast(^Gated_Job)user_data
	job.cancel_tid = sync.current_thread_id()

	if job.order != nil {
		sync.atomic_store(&job.cancel_at, sync.atomic_add(job.order, 1) + 1)
	}

	sync.atomic_add(&job.cancel, 1)
}

@(private = "file")
gated_dispose :: proc(user_data: rawptr) {
	job := cast(^Gated_Job)user_data
	job.dispose_tid = sync.current_thread_id()

	if job.order != nil {
		sync.atomic_store(&job.dispose_at, sync.atomic_add(job.order, 1) + 1)
	}

	sync.atomic_add(&job.dispose, 1)
}

@(private = "file")
submit_gated :: proc(t: ^testing.T, loop: ^Loop, job: ^Gated_Job, loc := #caller_location) {
	testing.expect(
		t,
		pool_submit(loop, gated_work, gated_done, job, gated_dispose, gated_cancel),
		"pool_submit",
		loc = loc,
	)
}

// client_loop is a page loop as the runner makes one: on the heap, never blocking in
// its own poll, a client of the shared pool.
@(private = "file")
client_loop :: proc(pool: ^Worker_Pool) -> ^Loop {
	loop := new(Loop, runtime.heap_allocator())
	loop^ = init(runtime.heap_allocator())
	loop.never_block = true
	pool_attach(loop, pool)
	return loop
}

@(private = "file")
close_loop :: proc(loop: ^Loop) {
	destroy(loop)
	free(loop, runtime.heap_allocator())
}

@(private = "file")
wait_until :: proc(flag: ^bool, limit: time.Duration) -> bool {
	deadline := time.tick_add(time.tick_now(), limit)
	for !sync.atomic_load(flag) {
		if time.tick_diff(time.tick_now(), deadline) <= 0 {
			return false
		}

		time.sleep(100 * time.Microsecond)
	}
	return true
}

@(private = "file")
wait_count :: proc(n: ^int, want: int, limit: time.Duration) -> bool {
	deadline := time.tick_add(time.tick_now(), limit)
	for sync.atomic_load(n) != want {
		if time.tick_diff(time.tick_now(), deadline) <= 0 {
			return false
		}

		time.sleep(100 * time.Microsecond)
	}
	return true
}

@(private = "file")
async_queued :: proc(loop: ^Loop) -> int {
	sync.lock(&loop.async_mutex)
	defer sync.unlock(&loop.async_mutex)
	return len(loop.async_queue)
}

// settle runs `loop` until every job's `done` has run, so none is still with a worker
// when the test's job memory goes out of scope; false at the deadline.
@(private = "file")
settle :: proc(loop: ^Loop, jobs: []Gated_Job, limit := 5 * time.Second) -> bool {
	deadline := time.tick_add(time.tick_now(), limit)
	for &j in jobs {
		for j.done == 0 {
			if time.tick_diff(time.tick_now(), deadline) <= 0 {
				return false
			}

			run_once(loop)
		}
	}
	return true
}

@(private = "file")
release_all :: proc(jobs: []Gated_Job) {
	for &j in jobs {
		if j.gated {
			sync.sema_post(&j.gate)
		}
	}
}

// A job still running when its client closes completes into nothing: no completion
// reaches the closed loop, nor the loop opened next on the same pool (which may reuse
// the closed one's address and descriptors), and the worker disposes the job once.
// The closed loop is kept allocated until the end, so a post into it is counted rather
// than written into freed memory.
@(test)
shared_pool_completion_never_reaches_a_closed_client :: proc(t: ^testing.T) {
	pool := pool_create(runtime.heap_allocator())
	defer pool_release(pool)
	a := client_loop(pool)
	job := Gated_Job {
		gated = true,
	}
	submit_gated(t, a, &job)

	if !wait_until(&job.started, 2 * time.Second) {
		sync.sema_post(&job.gate)
		testing.fail_now(t, "no worker took the job")
	}

	busy := close_begin(a)
	testing.expect(t, !busy, "close_begin on a shared-pool client reported a busy loop: the page would wait")
	b := client_loop(pool)
	sync.sema_post(&job.gate)
	disposed := wait_count(&job.dispose, 1, 2 * time.Second)

	testing.expect_value(t, async_queued(a), 0)
	testing.expect_value(t, async_queued(b), 0)
	testing.expect(t, disposed, "the worker never disposed the job of a closed client")
	testing.expect_value(t, sync.atomic_load(&job.cancel), 1)
	testing.expect_value(t, job.done, 0)
	close_finish(a)
	free(a, runtime.heap_allocator())
	close_loop(b)
	testing.expect_value(t, sync.atomic_load(&job.dispose), 1)
}

// Breakage 1 of #36: a page with every core worker blocked must not starve a sibling.
// A's four jobs hold the four core workers; B's one job must still finish within the
// stall threshold plus a margin, through an overflow worker that the runner's tick
// (pool_tick) spawns once the oldest running job is older than POOL_STALL_MS. Until
// then pool_wait_hint_ms bounds the runner's sleep by what is left of the threshold;
// with nothing starving it does not bound it at all.
@(test)
shared_pool_page_with_four_stalled_jobs_does_not_starve_a_sibling :: proc(t: ^testing.T) {
	pool := pool_create(runtime.heap_allocator())
	defer pool_release(pool)
	a := client_loop(pool)
	b := client_loop(pool)
	blocked: [THREADPOOL_SIZE]Gated_Job
	for &j in blocked {
		j.gated = true
		submit_gated(t, a, &j)
	}
	for &j in blocked {
		if !wait_until(&j.started, 2 * time.Second) {
			release_all(blocked[:])
			testing.fail_now(t, "the four core workers never all took a job")
		}
	}

	testing.expect_value(t, pool_wait_hint_ms(pool), -1)
	quick: Gated_Job
	start := time.tick_now()
	submit_gated(t, b, &quick)
	hint := pool_wait_hint_ms(pool)
	testing.expectf(t, hint >= 1 && hint <= POOL_STALL_MS, "wait hint %d with a client starving", hint)
	deadline := time.tick_add(start, 2 * time.Second)
	for quick.done == 0 && time.tick_diff(time.tick_now(), deadline) > 0 {
		run_once(b)
		pool_tick(pool)
		time.sleep(100 * time.Microsecond)
	}
	took := time.tick_since(start)
	release_all(blocked[:])

	testing.expectf(
		t,
		quick.done == 1 && took < (POOL_STALL_MS + 50) * time.Millisecond,
		"the sibling's job waited %v behind a page holding every core worker (done %d)",
		took,
		quick.done,
	)
	testing.expect(t, settle(a, blocked[:]), "A's released jobs never completed")
	close_loop(a)
	close_loop(b)
}

// Breakage 2 of #36: one page's backlog does not delay a sibling's single job. A holds
// every core worker with four gated jobs, queues 996 more, and B queues one; once the
// gates open, B's job is among the first 2*K dispatches, not behind A's backlog. No
// pool_tick here, so no overflow worker joins.
@(test)
shared_pool_round_robins_clients :: proc(t: ^testing.T) {
	pool := pool_create(runtime.heap_allocator())
	defer pool_release(pool)
	a := client_loop(pool)
	b := client_loop(pool)
	gates: [THREADPOOL_SIZE]Gated_Job
	for &j in gates {
		j.gated = true
		submit_gated(t, a, &j)
	}
	for &j in gates {
		if !wait_until(&j.started, 2 * time.Second) {
			release_all(gates[:])
			testing.fail_now(t, "the four core workers never all took a job")
		}
	}

	counter := 0
	backlog := make([]Gated_Job, 996)
	defer delete(backlog)
	for &j in backlog {
		j.counter = &counter
		submit_gated(t, a, &j)
	}
	single := Gated_Job {
		counter = &counter,
	}
	submit_gated(t, b, &single)
	release_all(gates[:])

	deadline := time.tick_add(time.tick_now(), 5 * time.Second)
	for single.done == 0 && time.tick_diff(time.tick_now(), deadline) > 0 {
		run_once(a)
		run_once(b)
	}
	seq := sync.atomic_load(&single.seq)
	testing.expectf(
		t,
		seq > 0 && seq <= 2 * THREADPOOL_SIZE,
		"B's one job was dispatch #%d behind A's backlog, want within the first %d",
		seq,
		2 * THREADPOOL_SIZE,
	)
	testing.expect(t, settle(a, gates[:]) && settle(a, backlog), "A's jobs never completed")
	close_loop(a)
	close_loop(b)
}

// Breakage 5 of #36: a closed page's job that never finishes must not take a core
// worker with it. Four clients close with a job blocked each — four orphans holding
// every thread the pool had — and a new client's job still runs at once, without the
// runner's stall tick: orphans do not count toward the core size, so the submit itself
// starts a replacement.
@(test)
shared_pool_orphan_does_not_count_toward_core :: proc(t: ^testing.T) {
	pool := pool_create(runtime.heap_allocator())
	defer pool_release(pool)
	loops: [THREADPOOL_SIZE]^Loop
	orphans: [THREADPOOL_SIZE]Gated_Job
	for &l, i in loops {
		l = client_loop(pool)
		orphans[i].gated = true
		submit_gated(t, l, &orphans[i])
	}
	for &j in orphans {
		if !wait_until(&j.started, 2 * time.Second) {
			release_all(orphans[:])
			testing.fail_now(t, "the four core workers never all took a job")
		}
	}
	for l in loops {
		close_loop(l)
	}
	testing.expect_value(t, pool_orphans(pool), THREADPOOL_SIZE)

	n := client_loop(pool)
	fresh: Gated_Job
	submit_gated(t, n, &fresh)
	deadline := time.tick_add(time.tick_now(), time.Second)
	for fresh.done == 0 && time.tick_diff(time.tick_now(), deadline) > 0 {
		run_once(n)
		time.sleep(100 * time.Microsecond)
	}
	release_all(orphans[:])

	testing.expect(t, fresh.done == 1, "a new client's job never ran while four orphans held the old workers")
	for &j in orphans {
		testing.expect(t, wait_count(&j.dispose, 1, 2 * time.Second), "an orphan was never disposed")
	}
	testing.expect(t, wait_count(&pool.orphans, 0, 2 * time.Second), "the orphan count never drained")
	close_loop(n)
}

// close_begin settles its client's jobs on the loop thread, while the caller's JS
// context still lives: each queued job is disposed there, before close_begin returns,
// and never cancelled; each running job gets its cancel there, and its dispose only
// later, from the worker, after the cancel. Other clients' queued jobs are untouched.
@(test)
shared_pool_close_disposes_queued_jobs_on_the_loop_thread :: proc(t: ^testing.T) {
	pool := pool_create(runtime.heap_allocator())
	defer pool_release(pool)
	a := client_loop(pool)
	order := 0
	running: [THREADPOOL_SIZE]Gated_Job
	queued: [3]Gated_Job
	for &j in running {
		j.gated = true
		j.order = &order
		submit_gated(t, a, &j)
	}
	for &j in running {
		if !wait_until(&j.started, 2 * time.Second) {
			release_all(running[:])
			testing.fail_now(t, "the four core workers never all took a job")
		}
	}
	for &j in queued {
		j.order = &order
		submit_gated(t, a, &j)
	}

	me := sync.current_thread_id()
	close_begin(a)
	for &j in queued {
		testing.expect_value(t, sync.atomic_load(&j.dispose), 1)
		testing.expect_value(t, j.dispose_tid, me)
		testing.expect_value(t, sync.atomic_load(&j.cancel), 0)
		testing.expect(t, !j.started, "a queued job ran after its client closed")
	}
	for &j in running {
		testing.expect_value(t, sync.atomic_load(&j.cancel), 1)
		testing.expect_value(t, j.cancel_tid, me)
		testing.expect_value(t, sync.atomic_load(&j.dispose), 0)
	}

	release_all(running[:])
	for &j in running {
		testing.expect(t, wait_count(&j.dispose, 1, 2 * time.Second), "a running job was never disposed")
		testing.expectf(
			t,
			sync.atomic_load(&j.cancel_at) < sync.atomic_load(&j.dispose_at),
			"a running job was disposed (#%d) before its cancel (#%d)",
			j.dispose_at,
			j.cancel_at,
		)
		testing.expect_value(t, j.done, 0)
	}
	close_finish(a)
	free(a, runtime.heap_allocator())
}

// The point of #36: a hundred pages that each make one quick lookup share the core
// workers instead of starting four threads each (400 before). The jobs arrive as one
// burst — each holds its worker until all hundred are submitted — so every submit
// finds no idle worker, and only the core bound keeps the pool at K threads. The
// pool's own count of threads it started is the signal under the parallel runner; on
// one runner thread (make test-eventloop-odin) the process's thread count is checked
// too.
@(test)
shared_pool_threads_bounded :: proc(t: ^testing.T) {
	N :: 100
	SLACK :: 2
	base := task_count()
	pool := pool_create(runtime.heap_allocator())
	defer pool_release(pool)
	loops: [N]^Loop
	jobs: [N]Gated_Job
	for &l, i in loops {
		l = client_loop(pool)
		jobs[i].gated = true
		submit_gated(t, l, &jobs[i])
	}
	peak := task_count()
	release_all(jobs[:])
	deadline := time.tick_add(time.tick_now(), 5 * time.Second)
	for {
		all := true
		for l, i in loops {
			if jobs[i].done == 0 {
				run_once(l)
				all = false
			}
		}

		if all || time.tick_diff(time.tick_now(), deadline) <= 0 {
			break
		}

		peak = max(peak, task_count())
	}
	for l in loops {
		close_loop(l)
	}

	for &j in jobs {
		testing.expect_value(t, j.done, 1)
	}
	testing.expectf(
		t,
		sync.atomic_load(&pool.spawned) <= THREADPOOL_SIZE,
		"the pool started %d threads for %d one-job clients, want at most %d",
		pool.spawned,
		N,
		THREADPOOL_SIZE,
	)
	when TEST_THREADS == 1 {
		testing.expectf(
			t,
			base > 0 && peak - base <= THREADPOOL_SIZE + SLACK,
			"the process went from %d to %d threads for %d one-job clients",
			base,
			peak,
			N,
		)
	}
}

// task_count is the process's thread count (the Threads: line of /proc/self/status),
// -1 when it cannot be read.
@(private = "file")
task_count :: proc() -> int {
	data, err := os.read_entire_file("/proc/self/status", context.temp_allocator)

	if err != nil {
		return -1
	}

	text := string(data)
	for line in strings.split_lines_iterator(&text) {
		if strings.has_prefix(line, "Threads:") {
			n, ok := strconv.parse_int(strings.trim_space(line[len("Threads:"):]))
			return ok ? n : -1
		}
	}
	return -1
}

@(private = "file")
Closing_Submit :: struct {
	loop:     ^Loop,
	tried:    bool,
	accepted: bool,
}

@(private = "file")
noop_work :: proc(user_data: rawptr) {}

// closing_submit is a timer's dispose, which close_begin runs after it has closed the
// loop's pool client: a teardown hook that submits.
@(private = "file")
closing_submit :: proc(user_data: rawptr) {
	cs := cast(^Closing_Submit)user_data
	cs.tried = true
	cs.accepted = pool_submit(cs.loop, noop_work, nil)
}

@(private = "file")
never_fires :: proc(loop: ^Loop, user_data: rawptr) {}

// A loop whose close has begun takes no more pool work, whether a teardown hook submits
// during close_begin or a caller after it — for a runner page's loop and for one with a
// private pool alike. Accepted, the job would start a fresh private pool on the closing
// loop that close_finish then waits for (and trips its assert on). An accepted submit
// leaves the loop unfinished here, so the failure is an assertion, not that abort.
@(test)
pool_submit_refuses_a_loop_that_is_closing :: proc(t: ^testing.T) {
	pool := pool_create(runtime.heap_allocator())
	defer pool_release(pool)
	shared := client_loop(pool)
	private := new(Loop, runtime.heap_allocator())
	private^ = init(runtime.heap_allocator())
	private.never_block = true
	first: [1]Gated_Job
	submit_gated(t, private, &first[0])

	if !settle(private, first[:]) {
		testing.fail_now(t, "the private pool's first job never completed")
	}

	for loop, i in ([2]^Loop{shared, private}) {
		cs := Closing_Submit {
			loop = loop,
		}
		set_timeout(loop, never_fires, 100_000, &cs, closing_submit)
		close_begin(loop)
		after := pool_submit(loop, noop_work, nil)
		testing.expectf(t, cs.tried, "loop %d: close_begin did not dispose the timer", i)
		testing.expectf(t, !cs.accepted, "loop %d: a teardown hook's pool_submit was accepted", i)
		testing.expectf(t, !after, "loop %d: pool_submit after close_begin was accepted", i)

		if cs.accepted || after {
			continue // leave it: close_finish would wait on, then assert about, the new pool
		}

		close_finish(loop)
		free(loop, runtime.heap_allocator())
	}
}

// Orphans never take the threads open clients run on (POOL_MAX_WORKERS' invariant):
// with as many orphans blocked as the cap allows workers, a new client's job still
// starts at once, through the core rule, without the runner's tick.
@(test)
shared_pool_orphans_never_take_the_threads_of_live_clients :: proc(t: ^testing.T) {
	ROUNDS :: POOL_MAX_WORKERS / THREADPOOL_SIZE
	pool := pool_create(runtime.heap_allocator())
	defer pool_release(pool)
	orphans: [ROUNDS * THREADPOOL_SIZE]Gated_Job
	for r in 0 ..< ROUNDS {
		l := client_loop(pool)
		jobs := orphans[r * THREADPOOL_SIZE:][:THREADPOOL_SIZE]
		for &j in jobs {
			j.gated = true
			submit_gated(t, l, &j)
		}
		for &j in jobs {
			if !wait_until(&j.started, 2 * time.Second) {
				close_loop(l)
				release_all(orphans[:])
				testing.fail_now(t, "a fresh client's jobs never all started")
			}
		}
		close_loop(l)
	}
	testing.expect_value(t, pool_orphans(pool), POOL_MAX_WORKERS)

	n := client_loop(pool)
	fresh: Gated_Job
	submit_gated(t, n, &fresh)
	deadline := time.tick_add(time.tick_now(), time.Second)
	for fresh.done == 0 && time.tick_diff(time.tick_now(), deadline) > 0 {
		run_once(n)
		time.sleep(100 * time.Microsecond)
	}
	release_all(orphans[:])

	testing.expectf(
		t,
		fresh.done == 1,
		"a live client's job never ran while %d orphans held their workers",
		POOL_MAX_WORKERS,
	)
	testing.expect(t, wait_count(&pool.orphans, 0, 5 * time.Second), "the orphans never drained")
	close_loop(n)
}

// Closing a page that held every core worker replaces all of them for a sibling with
// jobs waiting, not one: the sibling's four queued jobs all start without the runner's
// tick.
@(test)
shared_pool_close_replaces_every_orphan_a_sibling_waits_for :: proc(t: ^testing.T) {
	pool := pool_create(runtime.heap_allocator())
	defer pool_release(pool)
	a := client_loop(pool)
	b := client_loop(pool)
	held: [THREADPOOL_SIZE]Gated_Job
	waiting: [THREADPOOL_SIZE]Gated_Job
	for &j in held {
		j.gated = true
		submit_gated(t, a, &j)
	}
	for &j in held {
		if !wait_until(&j.started, 2 * time.Second) {
			release_all(held[:])
			testing.fail_now(t, "the four core workers never all took a job")
		}
	}
	for &j in waiting {
		j.gated = true
		submit_gated(t, b, &j)
	}
	close_loop(a)

	started := 0
	for &j in waiting {
		if wait_until(&j.started, time.Second) {
			started += 1
		}
	}
	release_all(waiting[:])
	release_all(held[:])

	testing.expectf(t, started == THREADPOOL_SIZE, "%d of the sibling's %d queued jobs started", started, THREADPOOL_SIZE)
	testing.expect(t, settle(b, waiting[:]), "the sibling's jobs never completed")
	testing.expect(t, wait_count(&pool.orphans, 0, 2 * time.Second), "the orphans never drained")
	close_loop(b)
}

// After its owner releases it, the shared pool is freed by its last worker — the only
// free path once page_runner_destroy has returned with an orphan still running. The
// pool runs on a tracking allocator (thread-safe: it locks), which must end empty.
@(test)
shared_pool_last_worker_frees_the_pool :: proc(t: ^testing.T) {
	track: mem.Tracking_Allocator
	mem.tracking_allocator_init(&track, runtime.heap_allocator())
	defer mem.tracking_allocator_destroy(&track)
	pool := pool_create(mem.tracking_allocator(&track))
	l := client_loop(pool)
	job := Gated_Job {
		gated = true,
	}
	submit_gated(t, l, &job)

	if !wait_until(&job.started, 2 * time.Second) {
		sync.sema_post(&job.gate)
		testing.fail_now(t, "no worker took the job")
	}

	close_loop(l)
	pool_release(pool)
	testing.expect(t, tracked_bytes(&track) > 0, "the pool was freed while its orphan still ran")
	sync.sema_post(&job.gate)
	deadline := time.tick_add(time.tick_now(), 2 * time.Second)
	for tracked_bytes(&track) > 0 && time.tick_diff(time.tick_now(), deadline) > 0 {
		time.sleep(time.Millisecond)
	}
	testing.expectf(t, tracked_bytes(&track) == 0, "%d bytes of the pool were never freed", tracked_bytes(&track))
	testing.expect_value(t, sync.atomic_load(&job.dispose), 1)
}

@(private = "file")
tracked_bytes :: proc(track: ^mem.Tracking_Allocator) -> i64 {
	sync.lock(&track.mutex)
	defer sync.unlock(&track.mutex)
	return track.current_memory_allocated
}
