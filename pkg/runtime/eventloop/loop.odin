package eventloop

import "core:mem"
import "core:sync"
import "core:time"

Callback :: proc(loop: ^Loop, user_data: rawptr)
// Dispose releases a handle's user_data when the loop drops it WITHOUT invoking
// its `callback` — i.e. it was cancelled before firing, or it was a repeating
// timer cancelled from within its own callback (so it fired but will not be
// re-armed). The firing path of a one-shot frees its own user_data, so for a
// given handle dispose and a normal one-shot fire are mutually exclusive; a
// repeating timer never frees on fire, so dispose is always its release path.
Dispose :: proc(user_data: rawptr)
Timer_ID :: u64

Backend :: enum {
	Unavailable,
	Native,
}

// Node.js event loop phases (in order):
// 1. next_tick  — process.nextTick queue (highest priority microtasks)
// 2. microtasks — Promise callbacks / queueMicrotask
// 3. timers     — setTimeout / setInterval
// 4. poll       — I/O events (blocks here if nothing pending)
// 5. check      — setImmediate
// 6. close      — close callbacks (socket.on('close', ...))
Phase :: enum {
	Next_Tick,
	Microtasks,
	Timers,
	Poll,
	Check,
	Close,
}

Task :: struct {
	id:        Timer_ID,
	callback:  Callback,
	user_data: rawptr,
	dispose:   Dispose, // released if the task is cancelled before its callback runs
	seq:       u64,
	cancelled: bool,
}

Timer :: struct {
	id:        Timer_ID,
	callback:  Callback,
	user_data: rawptr,
	dispose:   Dispose, // released when the timer is dropped without (re-)firing
	due_ms:    u64,
	repeat_ms: u64,
	repeating: bool,
	seq:       u64,
	cancelled: bool,
	unreffed:  bool, // if true, does not keep loop alive (like timer.unref() in Node)
}

Loop :: struct {
	backend:            Backend,
	now_ms:             u64,
	next_timer_id:      Timer_ID,
	next_sequence:      u64,
	next_ticks:         [dynamic]Task,
	microtasks:         [dynamic]Task,
	// Scratch buffers swapped with next_ticks/microtasks while draining, so a
	// drain reuses capacity instead of allocating a fresh queue every checkpoint
	// (same double-buffer trick as async_queue/async_scratch). Tasks appended by
	// callbacks during a drain land in the now-empty live queue.
	next_ticks_scratch: [dynamic]Task,
	microtasks_scratch: [dynamic]Task,
	immediates:         [dynamic]Task,
	io_callbacks:       [dynamic]Task, // poll-phase completions (e.g. fs.readFile); run before check
	close_callbacks:    [dynamic]Task,
	// timers is a binary min-heap keyed on (due_ms, seq): the root is the earliest
	// deadline, seq breaking ties to preserve Node's FIFO order for equal due_ms.
	// Push/pop are O(log n); cancelled entries are removed lazily (skipped/popped
	// when they reach the root) rather than compacted each tick.
	timers:             [dynamic]Timer,
	// timer_index maps a live heap timer's id to its slot in `timers`, so timer_cancel
	// (clearTimeout) is O(1) instead of an O(n) scan. With per-request HTTP header/idle
	// timeouts the heap holds O(connections) timers and an O(n) cancel made the server
	// O(n^2) under load — ~43% of CPU in clearTimeout (sampling profiler). Kept in sync by
	// every site that moves a timer within the heap (the timer_heap_* swaps).
	timer_index:        map[Timer_ID]int,
	// reffed_timer_count mirrors the number of heap timers that are ref'd and not
	// cancelled, so pending_count is O(1) instead of walking the heap every tick.
	// Maintained at every site a timer enters/leaves the heap or flips ref state.
	reffed_timer_count: int,
	cancelled_ids:      map[Timer_ID]bool,
	running_id:         Timer_ID,
	active_io_count:    int,
	io_events:          u64, // bumped by platform_poll each time a watcher callback fires
	iteration:          u64, // bumped once per run_once; a monotonic loop-tick counter
	// Set by platform_poll when the backend's blocking syscall fails fatally (any
	// error other than EINTR — e.g. EBADF on a closed epoll/kqueue fd). The run
	// drivers exit instead of busy-spinning on a syscall that can never make
	// progress; the flag stays set so an embedder can inspect it after run returns.
	backend_error:      bool,
	allocator:          mem.Allocator,
	platform:           Platform_Loop,
	// When set (the lava runtime), now_ms tracks the monotonic wall clock so
	// timer deadlines elapse in real time. When unset (deterministic Odin tests),
	// now_ms is a logical clock advanced explicitly via the run drivers.
	real_time:          bool,
	start_tick:         time.Tick, // monotonic origin for real_time mode
	// Cross-thread completion handoff (like libuv's uv_async). A background worker
	// (e.g. async DNS) runs off the loop, then post_async enqueues a completion
	// callback under async_mutex and wakes the loop; the loop drains async_queue on
	// its own thread. active_async (loop-thread only) counts in-flight off-loop ops
	// so the loop stays alive and blocks in poll until they complete.
	async_queue:        [dynamic]Task,
	async_scratch:      [dynamic]Task, // swapped with async_queue under the lock to drain
	async_mutex:        sync.Mutex,
	active_async:       int,
	// Per-loop worker pool for off-loop blocking/CPU-bound work (threadpool.odin).
	// Zero-valued until first use (lazily started); joined and freed by destroy.
	pool:               Thread_Pool,
	// Graceful-shutdown state machine (Slice 3a): Running (stop_requested false) -> Draining
	// (stop_requested true: stop accepting + let in-flight work finish) -> Forced (force_exit true:
	// run() returns and the deferred hard teardown reclaims the rest).
	//   - stop_requested is set CROSS-THREAD (the worker supervisor) so it is accessed atomically; the
	//     loop thread observes it once in run_once and invokes on_shutdown (close listeners / arm a
	//     drain timeout). force_exit and shutdown_observed are loop-thread-only.
	//   - shutdown_mutex + destroyed serialize request_shutdown's wakeup against destroy(): the
	//     supervisor must never write the wakeup pipe of a loop being torn down (use-after-free). Both
	//     request_shutdown and destroy take the mutex; destroy marks `destroyed` before freeing the
	//     platform fds, so a later request_shutdown sees it and no-ops.
	stop_requested:     bool,
	force_exit:         bool,
	shutdown_observed:  bool,
	on_shutdown:        Shutdown_Hook,
	on_shutdown_data:   rawptr,
	shutdown_mutex:     sync.Mutex,
	destroyed:          bool,
	// never_block makes every tick's poll phase non-blocking (timeout 0). Set by a
	// driver that multiplexes several loops on one thread (the page runner): one
	// loop must not sleep in its own poll while another loop's page has work. That
	// driver does the blocking itself, on every loop's backend_fd at once, bounded by
	// the smallest wait_hint_ms.
	never_block:        bool,
}

// Shutdown_Hook runs ONCE on the loop thread the first time run_once observes a stop request. The net
// layer registers it (set_shutdown_hook) to stop accepting and begin draining in-flight connections.
Shutdown_Hook :: proc(loop: ^Loop, user_data: rawptr)

Poll_Mode :: enum {
	Read,
	Write,
}

// fd is platform-agnostic here; cast to the right type in platform code
IO_Watcher :: struct {
	fd:        uintptr,
	mode:      Poll_Mode,
	callback:  Callback,
	user_data: rawptr,
	// watched tracks whether this watcher is currently in the loop's registered set.
	// It is the single source of truth for active_io_count accounting: the watch/
	// unwatch wrappers count off this flag, not the platform syscall result, so no
	// backend can desync the count (io_uring's logical-only unwatch, an EPOLL_CTL_DEL
	// that fails because the fd is already closed, a duplicate watch). Owned by the
	// wrappers; callers must zero-initialize the watcher (a fresh IO_Watcher literal).
	watched:   bool,
	// backend_slot is io_uring-only scratch: the index of this watcher's entry in
	// Platform_Loop.watch_slots while watched, so unwatch_fd reaches its slot in O(1)
	// instead of scanning the table. Set by platform_watch_fd, read by
	// platform_unwatch_fd; meaningful only while `watched`. Unused by the epoll/
	// kqueue/select backends, which recover the watcher pointer straight from the
	// kernel event. Owned by the platform layer; a zero-initialized watcher is fine.
	backend_slot: u32,
}

// init creates a loop. Pass real_time=true (the lava runtime) to have timer
// deadlines elapse against the monotonic wall clock; leave it false (the default,
// used by deterministic tests) to drive a logical clock via run_next/advance_time.
init :: proc(allocator := context.allocator, real_time := false) -> Loop {
	loop := Loop {
		backend       = .Unavailable,
		next_timer_id = 1,
		allocator     = allocator,
		cancelled_ids = make(map[Timer_ID]bool, 16, allocator),
		real_time     = real_time,
	}

	// Bind every queue to loop.allocator up front. A [dynamic] otherwise adopts the
	// allocator of whatever context first appends to it — for async_queue that is a
	// worker thread calling post_async, which would bind the worker's context
	// allocator (a contract break, and a race against a custom loop allocator)
	// instead of the loop's. destroy deletes all of these.
	loop.next_ticks = make([dynamic]Task, allocator)
	loop.next_ticks_scratch = make([dynamic]Task, allocator)
	loop.microtasks = make([dynamic]Task, allocator)
	loop.microtasks_scratch = make([dynamic]Task, allocator)
	loop.immediates = make([dynamic]Task, allocator)
	loop.io_callbacks = make([dynamic]Task, allocator)
	loop.close_callbacks = make([dynamic]Task, allocator)
	loop.timers = make([dynamic]Timer, allocator)
	loop.timer_index = make(map[Timer_ID]int, 64, allocator)
	loop.async_queue = make([dynamic]Task, allocator)
	loop.async_scratch = make([dynamic]Task, allocator)
	// Bind the worker pool's containers to the loop allocator too (zero capacity —
	// no backing or threads until the first pool_submit). See threadpool.odin.
	pool_init(&loop.pool, allocator)

	if real_time {
		loop.start_tick = time.tick_now()
	}

	if platform_init(&loop) {
		loop.backend = .Native
	}

	return loop
}

// real_now_ms returns milliseconds elapsed on the monotonic clock since the loop
// started. Only meaningful in real_time mode.
real_now_ms :: proc(loop: ^Loop) -> u64 {
	elapsed := time.duration_milliseconds(time.tick_since(loop.start_tick))
	if elapsed < 0 do return 0
	return u64(elapsed)
}

// sync_real_clock advances now_ms to the monotonic wall clock in real_time mode.
// A no-op otherwise, so deterministic tests keep their explicit logical clock.
sync_real_clock :: proc(loop: ^Loop) {
	if loop.real_time {
		loop.now_ms = real_now_ms(loop)
	}
}

// destroy tears the loop down. Any handle still pending (the embedder is
// destroying a loop that has not run to idle) is released via its dispose hook
// first, so JS-protected callback bindings do not leak. dispose runs exactly once
// per live handle: cancelled handles already had theirs run and nulled by
// clear_timeout, and a fired one-shot freed its own binding, so neither is
// double-released here.
//
// PRECONDITION: every off-loop producer that may call post_async (e.g. fetch's DNS
// workers) must already be joined. destroy touches async_queue WITHOUT the mutex on
// the assumption it is the sole surviving accessor; a still-running worker would
// race the read here and could post into freed memory. The lava runtime enforces
// this by calling fetch_shutdown_active (which joins the workers) before destroy.
destroy :: proc(loop: ^Loop) {
	// Mark destroyed under the shutdown mutex BEFORE freeing any platform state, so a concurrent
	// request_shutdown (worker supervisor, another thread) either ran fully before this — having
	// already woken the still-live loop — or sees `destroyed` and no-ops. Without this the supervisor
	// could write a freed wakeup pipe fd. (Uncontended in the single-loop / test cases.)
	sync.lock(&loop.shutdown_mutex)
	loop.destroyed = true
	sync.unlock(&loop.shutdown_mutex)

	// Stop and join the worker pool first, so no off-loop worker can post into the
	// async_queue we are about to tear down (see threadpool.odin / the PRECONDITION
	// note below). A no-op when the pool was never started.
	pool_shutdown(loop)
	dispose_pending_tasks(&loop.next_ticks)
	dispose_pending_tasks(&loop.next_ticks_scratch)
	dispose_pending_tasks(&loop.microtasks)
	dispose_pending_tasks(&loop.microtasks_scratch)
	dispose_pending_tasks(&loop.immediates)
	dispose_pending_tasks(&loop.io_callbacks)
	dispose_pending_tasks(&loop.close_callbacks)
	dispose_pending_tasks(&loop.async_queue)
	dispose_pending_tasks(&loop.async_scratch)
	for &timer in loop.timers {
		if !timer.cancelled {
			run_dispose(timer.dispose, timer.user_data)
		}
	}

	platform_destroy(loop)
	delete(loop.next_ticks)
	delete(loop.next_ticks_scratch)
	delete(loop.microtasks)
	delete(loop.microtasks_scratch)
	delete(loop.immediates)
	delete(loop.io_callbacks)
	delete(loop.close_callbacks)
	delete(loop.timers)
	delete(loop.timer_index)
	delete(loop.cancelled_ids)
	delete(loop.async_queue)
	delete(loop.async_scratch)
	pool_destroy(&loop.pool, loop.allocator) // frees the pool backings (workers already joined above)
	// NOT `loop^ = Loop{}`: that bulk-zero would race a cross-thread request_shutdown (the worker
	// supervisor) on the shutdown_mutex/destroyed/wakeup_pipe words. `destroyed` was set true under the
	// mutex at the top of destroy and must STAY true so a late request_shutdown sees it and no-ops; the
	// explicit deletes above already released every owned allocation, so the remaining stale scalar
	// fields are harmless (the loop is on the owner's stack / the process is exiting). LOOP-THREAD ONLY
	// otherwise; the only legitimate concurrent access after this point is request_shutdown, handled.
}

// dispose_pending_tasks releases the user_data of every not-yet-fired, not-cancelled
// task in a queue via its dispose hook. Used only on teardown (see destroy).
dispose_pending_tasks :: proc(queue: ^[dynamic]Task) {
	for &task in queue^ {
		if !task.cancelled {
			run_dispose(task.dispose, task.user_data)
		}
	}
}

// --- Cross-thread async completion handoff ---
//
// async_begin marks one off-loop operation in flight. Called on the loop thread
// before dispatching a background worker, it keeps the loop alive and makes the
// poll phase block until the worker completes.
async_begin :: proc(loop: ^Loop) {
	loop.active_async += 1
}

// async_cancel undoes an async_begin when the off-loop op could not be dispatched
// (e.g. a worker thread failed to spawn), so the loop is not kept alive forever
// waiting for a completion that will never arrive. Loop-thread only; must not be
// called once post_async has been (or may be) invoked for that op.
async_cancel :: proc(loop: ^Loop) {
	loop.active_async = max(0, loop.active_async - 1)
}

// post_async delivers a completion callback from ANY thread: it enqueues the
// callback under async_mutex and wakes the loop, which runs it on the loop thread
// in the next tick (see drain_async) and decrements the in-flight count there. The
// worker must finish writing any result the callback reads before calling this —
// the lock/unlock publishes those writes.
//
// The append may grow async_queue, which allocates via the queue's bound allocator
// off the loop thread while the loop thread allocates concurrently. loop.allocator
// (passed to init) must therefore be thread-safe — the default heap allocator is.
// Do not back a loop with a non-thread-safe arena if any worker calls post_async.
post_async :: proc(loop: ^Loop, callback: Callback, user_data: rawptr = nil) {
	if callback == nil do return
	sync.lock(&loop.async_mutex)
	append(&loop.async_queue, Task{callback = callback, user_data = user_data})
	sync.unlock(&loop.async_mutex)
	wakeup(loop)
}

// drain_async runs queued completions on the loop thread, decrementing the
// in-flight count per completion. Returns true if any ran.
drain_async :: proc(loop: ^Loop) -> bool {
	sync.lock(&loop.async_mutex)
	if len(loop.async_queue) == 0 {
		sync.unlock(&loop.async_mutex)
		return false
	}
	// Swap producer queue with the scratch buffer (O(1)) so callbacks — which may
	// post more async work — run without holding the lock.
	loop.async_queue, loop.async_scratch = loop.async_scratch, loop.async_queue
	sync.unlock(&loop.async_mutex)

	for task in loop.async_scratch {
		loop.active_async = max(0, loop.active_async - 1)
		task.callback(loop, task.user_data)
	}
	clear(&loop.async_scratch)
	return true
}

backend_name :: proc(loop: ^Loop) -> string {
	switch loop.backend {
	case .Native:
		return platform_name(loop)
	case .Unavailable:
		return "unavailable"
	}
	return "unavailable"
}

now :: proc(loop: ^Loop) -> u64 {
	return loop.now_ms
}

// iteration_count returns the monotonic loop-tick counter (bumped once per
// run_once). A general-purpose tick clock for embedders that need to age out or
// order resources across loop iterations. The fetch transport uses it to hold a
// just-settled request a couple of iterations before reclaim, so a stale readiness
// event still pending in an in-flight platform_poll batch (epoll/kqueue/select
// dispatch via the raw watcher pointer) cannot land on freed memory. (io_uring no
// longer needs this — its poll is truly cancelled and its token invalidated, see
// #183 / loop_linux.odin — but the guard is cheap and uniform across backends.)
iteration_count :: proc(loop: ^Loop) -> u64 {
	return loop.iteration
}

// Returns the number of items keeping the loop alive.
// Unreffed timers are excluded (matching Node.js timer.unref() semantics).
pending_count :: proc(loop: ^Loop) -> int {
	return(
		len(loop.next_ticks) +
		len(loop.microtasks) +
		active_immediate_count(loop) +
		active_io_callback_count(loop) +
		active_close_count(loop) +
		active_timer_count(loop) +
		loop.active_io_count +
		loop.active_async \
	)
}

active_io_callback_count :: proc(loop: ^Loop) -> int {
	count := 0
	for &task in loop.io_callbacks {
		if !task.cancelled && !is_cancel_requested(loop, task.id) {
			count += 1
		}
	}
	return count
}

active_timer_count :: proc(loop: ^Loop) -> int {
	return loop.reffed_timer_count
}

active_immediate_count :: proc(loop: ^Loop) -> int {
	count := 0
	for &immediate in loop.immediates {
		if !immediate.cancelled && !is_cancel_requested(loop, immediate.id) {
			count += 1
		}
	}
	return count
}

active_close_count :: proc(loop: ^Loop) -> int {
	count := 0
	for &cb in loop.close_callbacks {
		if !cb.cancelled {
			count += 1
		}
	}
	return count
}

has_pending_work :: proc(loop: ^Loop) -> bool {
	return pending_count(loop) > 0
}

// --- Scheduling APIs ---

queue_next_tick :: proc(loop: ^Loop, callback: Callback, user_data: rawptr = nil) {
	if callback == nil {
		return
	}
	append(
		&loop.next_ticks,
		Task{callback = callback, user_data = user_data, seq = next_sequence(loop)},
	)
}

queue_microtask :: proc(loop: ^Loop, callback: Callback, user_data: rawptr = nil) {
	if callback == nil {
		return
	}
	append(
		&loop.microtasks,
		Task{callback = callback, user_data = user_data, seq = next_sequence(loop)},
	)
}

set_timeout :: proc(
	loop: ^Loop,
	callback: Callback,
	delay_ms: u64,
	user_data: rawptr = nil,
	dispose: Dispose = nil,
) -> Timer_ID {
	return set_timer(loop, callback, delay_ms, 0, false, user_data, dispose)
}

set_interval :: proc(
	loop: ^Loop,
	callback: Callback,
	interval_ms: u64,
	user_data: rawptr = nil,
	dispose: Dispose = nil,
) -> Timer_ID {
	return set_timer(loop, callback, interval_ms, interval_ms, true, user_data, dispose)
}

set_immediate :: proc(
	loop: ^Loop,
	callback: Callback,
	user_data: rawptr = nil,
	dispose: Dispose = nil,
) -> Timer_ID {
	if callback == nil {
		return 0
	}
	id := next_handle_id(loop)
	append(
		&loop.immediates,
		Task {
			id = id,
			callback = callback,
			user_data = user_data,
			dispose = dispose,
			seq = next_sequence(loop),
		},
	)
	return id
}

// queue_io_callback registers a poll-phase completion callback (e.g. an async
// fs.readFile whose result is ready). It runs in the poll phase — after timers,
// before check (setImmediate) — matching Node's I/O-callback ordering.
queue_io_callback :: proc(
	loop: ^Loop,
	callback: Callback,
	user_data: rawptr = nil,
	dispose: Dispose = nil,
) -> Timer_ID {
	if callback == nil {
		return 0
	}
	id := next_handle_id(loop)
	append(
		&loop.io_callbacks,
		Task {
			id = id,
			callback = callback,
			user_data = user_data,
			dispose = dispose,
			seq = next_sequence(loop),
		},
	)
	return id
}

// queue_close_callback registers a close-phase callback (e.g. socket.on('close',...)).
// These run at the end of each loop iteration, after check phase.
queue_close_callback :: proc(loop: ^Loop, callback: Callback, user_data: rawptr = nil) {
	if callback == nil {
		return
	}
	id := next_handle_id(loop)
	append(
		&loop.close_callbacks,
		Task{id = id, callback = callback, user_data = user_data, seq = next_sequence(loop)},
	)
}

// timer_ref marks a timer as ref'd (default). Ref'd timers keep the loop alive. O(1) via
// timer_index; only heap-resident timers are ref-adjustable (a running handle is not in
// the heap), matching the prior scan's reachability.
timer_ref :: proc(loop: ^Loop, id: Timer_ID) {
	if idx, ok := loop.timer_index[id]; ok {
		if loop.timers[idx].unreffed && !loop.timers[idx].cancelled {
			loop.reffed_timer_count += 1
		}
		loop.timers[idx].unreffed = false
	}
}

// timer_unref marks a timer so it no longer keeps the loop alive (Node's timer.unref()).
timer_unref :: proc(loop: ^Loop, id: Timer_ID) {
	if idx, ok := loop.timer_index[id]; ok {
		if !loop.timers[idx].unreffed && !loop.timers[idx].cancelled {
			loop.reffed_timer_count -= 1
		}
		loop.timers[idx].unreffed = true
	}
}

set_timer :: proc(
	loop: ^Loop,
	callback: Callback,
	delay_ms, repeat_ms: u64,
	repeating: bool,
	user_data: rawptr = nil,
	dispose: Dispose = nil,
) -> Timer_ID {
	if callback == nil {
		return 0
	}

	// Anchor the deadline to the real clock in real_time mode so the delay is
	// measured from when the timer is scheduled, not from the loop's last tick.
	sync_real_clock(loop)

	timer := Timer {
		id        = next_handle_id(loop),
		callback  = callback,
		user_data = user_data,
		dispose   = dispose,
		due_ms    = loop.now_ms + delay_ms,
		repeat_ms = repeat_ms,
		repeating = repeating,
		seq       = next_sequence(loop),
	}

	// New timers start ref'd; account for it before the heap push.
	loop.reffed_timer_count += 1
	timer_heap_push(loop, timer)
	return timer.id
}

clear_timeout :: proc(loop: ^Loop, id: Timer_ID) -> bool {
	if id == 0 {
		return false
	}

	// Heap-resident timer: remove it eagerly (O(log n)) — release its binding, drop its
	// ref, and take it out of the heap and timer_index now. It is not the running handle
	// (that one was popped from the heap before its callback ran), so freeing its user_data
	// here is safe. Eager removal (vs leaving a cancelled tombstone until it reaches the
	// root) keeps the heap and timer_index bounded under timer churn — e.g. per-request
	// HTTP timeouts armed then cancelled on completion, whose due times are far in the
	// future.
	if idx, ok := loop.timer_index[id]; ok {
		if !loop.timers[idx].unreffed {
			loop.reffed_timer_count -= 1
		}
		run_dispose(loop.timers[idx].dispose, loop.timers[idx].user_data)
		timer_heap_remove_at(loop, idx)
		return true
	}

	// Cancelling the currently-running callback (e.g. clearInterval(self)): it was popped
	// from the heap before its callback ran, so it is not in timer_index. Its binding
	// cannot be freed mid-call — run_once's re-arm branch releases a repeating timer once
	// it decides not to re-arm, and a one-shot frees itself when its callback returns.
	// Checked before the immediates scan so self-cancellation stays O(1).
	if loop.running_id == id {
		append_cancel_request(loop, id)
		return true
	}

	for i in 0 ..< len(loop.immediates) {
		if loop.immediates[i].id == id && !loop.immediates[i].cancelled {
			loop.immediates[i].cancelled = true
			run_dispose(loop.immediates[i].dispose, loop.immediates[i].user_data)
			loop.immediates[i].dispose = nil
			append_cancel_request(loop, id)
			return true
		}
	}

	return false
}

clear_interval :: proc(loop: ^Loop, id: Timer_ID) -> bool {
	return clear_timeout(loop, id)
}

clear_immediate :: proc(loop: ^Loop, id: Timer_ID) -> bool {
	return clear_timeout(loop, id)
}

advance_time :: proc(loop: ^Loop, delta_ms: u64) {
	loop.now_ms += delta_ms
}

// --- Microtask checkpoint ---
// Node.js: after every timer/immediate callback, drain next_tick first, then
// microtasks. Newly queued next_ticks are processed before existing microtasks.
drain_microtasks :: proc(loop: ^Loop) {
	for {
		// Always drain all next_ticks before touching microtasks
		for len(loop.next_ticks) > 0 {
			drain_task_queue(loop, &loop.next_ticks, &loop.next_ticks_scratch)
		}
		if len(loop.microtasks) == 0 {
			break
		}
		drain_task_queue(loop, &loop.microtasks, &loop.microtasks_scratch)
	}
}

// drain_io_callbacks runs ready poll-phase I/O completions (those registered via
// queue_io_callback, e.g. async fs.readFile/writeFile) whose seq is below `limit`, so
// callbacks queued *during* the drain defer to a later pass. Returns whether any ran.
// Shared by run_once's Phase 4a and the post-poll re-drain that keeps a pool completion
// landing during the poll wait ahead of check.
drain_io_callbacks :: proc(loop: ^Loop, limit: u64) -> (did_work: bool) {
	for {
		index := next_io_callback_index(loop, limit)
		if index < 0 {
			break
		}
		task := loop.io_callbacks[index]
		ordered_remove(&loop.io_callbacks, index)
		if task.cancelled || is_cancel_requested(loop, task.id) {
			continue
		}
		did_work = true
		loop.running_id = task.id
		task.callback(loop, task.user_data)
		drain_microtasks(loop)
		loop.running_id = 0
	}
	return
}

// --- Main loop tick ---
//
// Every tick ends with a free_all(context.temp_allocator): callbacks allocate
// per-tick scratch on the loop thread's temp arena (fetch response parsing,
// fs paths, JS string clones), and nothing temp-backed may outlive the tick
// that allocated it — without the reset the arena grows for the life of the
// process, linearly with e.g. fetch count. The defer here is the single choke
// point every driver (run, run_next, run_until_idle, embedders) funnels
// through, so the reset cannot be bypassed. Callers that need temp data to
// survive across ticks must copy it to a longer-lived allocator first.
run_once :: proc(loop: ^Loop) -> bool {
	defer free_all(context.temp_allocator)
	loop.iteration += 1
	did_work := false

	// Graceful-shutdown observe point: the first run_once after a stop request runs the drain-start
	// hook (stop accepting, arm the drain timeout) on the loop thread. Subsequent ticks skip it; the
	// drain driver flips force_exit when in-flight work finishes or the timeout fires, and run()'s
	// condition then returns.
	if !loop.shutdown_observed && sync.atomic_load(&loop.stop_requested) {
		loop.shutdown_observed = true
		if loop.on_shutdown != nil do loop.on_shutdown(loop, loop.on_shutdown_data)
	}
	// Forced: skip this tick's blocking poll and return at once so run()'s condition can exit. Covers
	// both a hook that drained immediately (force_exit set just above) and a prior tick's drain driver.
	if loop.force_exit do return false

	// Sample the real clock first so the timer phase fires every timer whose
	// deadline has actually elapsed (no-op in virtual-clock mode).
	sync_real_clock(loop)

	// Cross-thread completions (e.g. async DNS) posted by worker threads run first
	// so the work they unblock proceeds this tick.
	if drain_async(loop) {
		did_work = true
	}

	// Phase 1 & 2: next_tick + microtasks (before anything else)
	if len(loop.next_ticks) > 0 || len(loop.microtasks) > 0 {
		did_work = true
	}
	drain_microtasks(loop)

	// Phase 3: timers
	// sequence_limit ensures timers scheduled *during* this phase run next iteration.
	// The heap root is the earliest (due_ms, seq); a timer with seq >= the limit was
	// scheduled this phase and (since its due_ms >= now_ms, delays being >= 0) sorts
	// no earlier than every already-due seq < limit timer — so stopping at the first
	// such root cannot starve an earlier-scheduled due timer.
	timer_phase_sequence_limit := loop.next_sequence
	for len(loop.timers) > 0 {
		// Lazily drop a cancelled root: its binding was already disposed and its
		// count already adjusted at cancel time, so just discard it.
		if loop.timers[0].cancelled || is_cancel_requested(loop, loop.timers[0].id) {
			timer_heap_pop_min(loop)
			continue
		}

		root := loop.timers[0]
		if root.seq >= timer_phase_sequence_limit do break
		if root.due_ms > loop.now_ms do break

		timer := timer_heap_pop_min(loop)
		did_work = true
		// A one-shot cannot re-arm, so it leaves the active set the instant it is
		// popped — drop its ref now, before the callback, not after. This keeps
		// has_pending_work honest *while the callback runs* (a running task is not
		// "pending"), matching how immediates/I-O/close are uncounted before firing.
		// Without it the firing one-shot still counts itself, so an in-callback
		// has_pending_work check (e.g. the Windows post-fire root-release decision)
		// can't tell a final one-shot from one with real work queued behind it. A
		// repeating timer's ref is left until the re-arm decision below, since it
		// stays active across the fire.
		if !timer.repeating && !timer.unreffed {
			loop.reffed_timer_count -= 1
		}
		loop.running_id = timer.id
		timer.callback(loop, timer.user_data)
		// Drain microtasks while running_id still names this timer: a task the
		// callback queued (next_tick/microtask) that clears this very timer must
		// reach clear_timeout's running-handle branch and record the cancel, or the
		// re-arm check below misses it and re-arms a cancelled repeating timer.
		drain_microtasks(loop)
		loop.running_id = 0

		if timer.repeating && !is_cancel_requested(loop, timer.id) {
			// Re-armed: stays active, so reffed_timer_count is unchanged.
			timer.due_ms = loop.now_ms + timer.repeat_ms
			timer.seq = next_sequence(loop)
			timer_heap_push(loop, timer)
		} else if timer.repeating {
			// Repeating, not re-armed (cancelled from within its own callback): it
			// already fired, so its callback did NOT free the binding — release it
			// here — and drop the ref it kept across the fire. A one-shot freed its
			// binding when it fired and dropped its ref above, so neither applies.
			run_dispose(timer.dispose, timer.user_data)
			if !timer.unreffed {
				loop.reffed_timer_count -= 1
			}
		}
	}

	// Phase 4a: deliver ready I/O completion callbacks (e.g. async fs.readFile)
	// queued before this tick. They run after timers and before check, matching
	// Node's poll-before-check order. The sequence limit defers callbacks queued
	// *during* this phase to the next iteration.
	if drain_io_callbacks(loop, loop.next_sequence) {
		did_work = true
	}

	// Phase 4b: poll — block for I/O only when there is nothing else to do
	// (no immediates, no close callbacks, no pending microtasks)
	has_nothing_to_do :=
		!did_work &&
		active_immediate_count(loop) == 0 &&
		active_close_count(loop) == 0 &&
		len(loop.next_ticks) == 0 &&
		len(loop.microtasks) == 0

	if !has_nothing_to_do && (loop.active_io_count > 0 || loop.active_async > 0) {
		// Other phases still have work this iteration (e.g. a self-rescheduling
		// setImmediate chain that keeps an immediate perpetually pending), but I/O is
		// in flight. Block-free poll (timeout 0) so ready socket completions are
		// drained every iteration and cannot be starved until the chain ends —
		// matching Node, which runs the poll phase with timeout 0 when other work is
		// queued. The blocking wait below is only for when there is nothing else to do.
		io_before := loop.io_events
		platform_poll(loop, 0)
		if loop.io_events != io_before {
			did_work = true
		}
	}

	if has_nothing_to_do {
		timeout_ms := get_next_timer_timeout(loop)
		if loop.never_block do timeout_ms = 0
		// With no timers but pending I/O, block indefinitely until an fd is ready
		// rather than spinning (get_next_timer_timeout returns -1 in that case).
		if timeout_ms != 0 || loop.active_io_count > 0 || loop.active_async > 0 {
			io_before := loop.io_events
			platform_poll(loop, timeout_ms)
			if loop.io_events != io_before {
				// A fired I/O callback counts as progress so the run-until-idle
				// driver does not treat an I/O-only tick as "nothing happened".
				did_work = true
			} else if timeout_ms > 0 {
				// Woke on the timer deadline with no fd ready: the now-due timer
				// fires on the next tick. In real_time mode the next run_once
				// re-samples the monotonic clock; in virtual mode we advance the
				// logical clock by the slept interval so the timer is not dropped
				// (a timer co-pending with in-flight I/O would otherwise be lost
				// and the loop would exit early). timeout_ms < 0 is a pure-I/O wait.
				if !loop.real_time {
					advance_time(loop, u64(timeout_ms))
				}
				did_work = true
			}
		}
	}

	// A worker completion (async DNS) may have arrived during the poll block and
	// woken us via the wakeup pipe; drain it now so the work it unblocks (and any
	// immediate/close it schedules) runs this tick rather than idling out.
	if drain_async(loop) {
		did_work = true
	}

	// A pool completion drained just above (e.g. an async fs.readFile/writeFile that
	// finished during the poll wait) re-queues its callback onto io_callbacks via
	// fs_*_pool_done → queue_io_callback. Phase 4a has already run this tick, so drain
	// these freshly-ready I/O callbacks now — before check — so a poll-ready fs
	// completion still beats a pending setImmediate, matching Node's poll-before-check.
	// (Only fs uses io_callbacks; DNS/fetch completions drive watchers, not this queue.
	// The in-callback ordering in 08-io-before-immediate is unaffected.)
	if drain_io_callbacks(loop, loop.next_sequence) {
		did_work = true
	}

	// Phase 5: check — setImmediate
	immediate_phase_sequence_limit := loop.next_sequence
	for {
		index := next_immediate_index(loop, immediate_phase_sequence_limit)
		if index < 0 {
			break
		}

		immediate := loop.immediates[index]
		ordered_remove(&loop.immediates, index)
		if immediate.cancelled || is_cancel_requested(loop, immediate.id) {
			continue
		}

		did_work = true
		loop.running_id = immediate.id
		immediate.callback(loop, immediate.user_data)
		drain_microtasks(loop)
		loop.running_id = 0
	}

	// Phase 6: close callbacks
	close_phase_sequence_limit := loop.next_sequence
	for {
		index := next_close_index(loop, close_phase_sequence_limit)
		if index < 0 {
			break
		}

		cb := loop.close_callbacks[index]
		ordered_remove(&loop.close_callbacks, index)
		if cb.cancelled {
			continue
		}

		did_work = true
		cb.callback(loop, cb.user_data)
		drain_microtasks(loop)
	}

	// Cancelled timers are dropped lazily from the heap root (see the timer phase),
	// so there is no per-tick compaction pass for them — only the array-backed
	// immediates still need one.
	discard_cancelled_immediates(loop)
	clear(&loop.cancelled_ids)
	return did_work
}

// run_next advances time to the next due timer if there is no immediate work,
// then calls run_once. Used for test/simulation drivers.
run_next :: proc(loop: ^Loop) -> bool {
	if len(loop.next_ticks) > 0 ||
	   len(loop.microtasks) > 0 ||
	   has_due_timer(loop) ||
	   active_immediate_count(loop) > 0 ||
	   active_io_callback_count(loop) > 0 ||
	   active_close_count(loop) > 0 {
		return run_once(loop)
	}

	// Pending I/O — or an in-flight off-loop op (async DNS) — with nothing else
	// ready: run a tick so the poll phase blocks on the fd(s)/wakeup. Without this
	// the loop would exit before the socket or worker completion is driven.
	if loop.active_io_count > 0 || loop.active_async > 0 {
		return run_once(loop)
	}

	next_due, ok := next_timer_due(loop)
	if !ok {
		return false
	}

	// Real_time mode: don't fast-forward. run_once samples the monotonic clock
	// and, if the deadline is still in the future, blocks in the poll phase until
	// it elapses — so the timer fires in real wall-clock time.
	if loop.real_time {
		return run_once(loop)
	}

	loop.now_ms = next_due
	return run_once(loop)
}

run_until_idle :: proc(loop: ^Loop, max_iterations := 1024) -> bool {
	did_work := false

	for i in 0 ..< max_iterations {
		// force_exit for the same reason run() carries it: the Forced shutdown state
		// must end the drive even while work is pending, and without it this loop
		// would burn all max_iterations tickless (run_once returns immediately once
		// force_exit is set). Bounded rather than hung, but still wrong.
		if !has_pending_work(loop) || loop.backend_error || loop.force_exit {
			return did_work
		}

		if !run_next(loop) {
			// A no-progress tick is NOT idleness while off-loop work is in flight —
			// the same invariant run() states above, which #113 (ba12bd3) fixed there
			// and only there: the parenthetical "(run_until_idle keeps its bounded
			// form for deterministic tests)" kept the ceiling AND, by accident, this
			// early return.
			//
			// The tick that reports no progress is real and routine. post_async
			// appends the completion under async_mutex and writes the wakeup byte
			// after unlocking, while the poll drains the pipe and drain_async drains
			// the queue at different instants — and drain_async takes the WHOLE queue
			// per pass. So one byte can carry two completions and leave a surplus
			// byte, which pops the next blocking poll with nothing to drain. Draining
			// a wakeup deliberately does not bump io_events (loop_linux.odin), so that
			// tick returns false. Returning here ended the drive with active_async
			// still nonzero, and returned the `did_work` an EARLIER tick had latched —
			// which is how it read as success.
			//
			// Reproduced deterministically without any threadpool at all: async_begin
			// plus a set_immediate that calls wakeup() makes run_until_idle return
			// true in ~9us with active_async == 1. Under CI's oversubscription the
			// threadpool version hit roughly 1-2% per run, which is why 40 solo runs
			// and 25 whole-suite runs on a 16-core box all came back clean.
			//
			// Exiting only when BOTH counters are zero keeps the bounded, deterministic
			// behavior every existing caller relies on: has_pending_work can be true
			// for a not-yet-due timer with nothing off-loop, and that must still return.
			if loop.active_io_count == 0 && loop.active_async == 0 {
				return did_work
			}
			continue
		}
		did_work = true
	}

	return did_work
}

// run drives the loop to completion with no iteration ceiling — the runtime's
// entry point. It runs until the loop is genuinely idle (no pending work).
// Exit is solely on !has_pending_work: a no-progress tick (e.g. a stale wakeup
// pipe byte waking platform_poll with no fd ready) must not terminate the loop
// while active_io_count or active_async are nonzero. (run_until_idle keeps its
// bounded form for deterministic tests.)
run :: proc(loop: ^Loop) {
	// A fatal backend-poll error (see Loop.backend_error) stops the loop: the poll
	// syscall can no longer make progress, so continuing would busy-spin while
	// active_io_count/active_async keep has_pending_work true forever.
	// force_exit (the Forced shutdown state) exits even while work is pending: a listening server keeps
	// active_io_count > 0 forever, so without it a stop request could never end run().
	// lava_runtime.page_tick copies this condition for pages; keep the two in step.
	for has_pending_work(loop) && !loop.backend_error && !loop.force_exit {
		run_next(loop)
	}
}

// backend_fd returns a descriptor that becomes readable when this loop has I/O or a
// cross-thread wakeup to process: the epoll fd, or the io_uring ring fd (readable
// while its completion queue is non-empty). For a driver that waits on many loops at
// once. ok is false on backends that have no such descriptor (darwin, windows: they
// are stubs for this use) and when the backend failed to initialize.
backend_fd :: proc(loop: ^Loop) -> (fd: uintptr, ok: bool) {
	if loop.backend != .Native do return 0, false
	return platform_backend_fd(loop)
}

// wait_hint_ms is how long a multi-loop driver may block before this loop needs
// another tick: 0 when work is runnable now, the time to the next timer, or -1 when
// only I/O (seen through backend_fd) or nothing can wake it. Samples the real clock
// first, so a timer that came due while another loop ran reports 0.
wait_hint_ms :: proc(loop: ^Loop) -> int {
	sync_real_clock(loop)
	if len(loop.next_ticks) > 0 ||
	   len(loop.microtasks) > 0 ||
	   active_immediate_count(loop) > 0 ||
	   active_io_callback_count(loop) > 0 ||
	   active_close_count(loop) > 0 {
		return 0
	}
	return get_next_timer_timeout(loop)
}

// get_next_timer_timeout returns milliseconds until the next timer fires.
// Returns 0 if a timer is already due, -1 if there are no timers.
get_next_timer_timeout :: proc(loop: ^Loop) -> int {
	next_due, ok := next_timer_due(loop)
	if !ok {
		return -1
	}
	if next_due <= loop.now_ms {
		return 0
	}
	return int(next_due - loop.now_ms)
}

// --- Internal helpers ---

drain_task_queue :: proc(loop: ^Loop, queue: ^[dynamic]Task, scratch: ^[dynamic]Task) {
	if len(queue^) == 0 {
		return
	}

	// Swap the live queue with its scratch buffer (O(1)): callbacks run from the
	// scratch copy while anything they newly enqueue accumulates in the now-empty
	// live queue. clear() keeps the scratch capacity for the next drain so we do
	// not reallocate per checkpoint.
	queue^, scratch^ = scratch^, queue^

	for task in scratch^ {
		if task.cancelled || (task.id != 0 && is_cancel_requested(loop, task.id)) {
			continue
		}
		task.callback(loop, task.user_data)
	}
	clear(scratch)
}

next_handle_id :: proc(loop: ^Loop) -> Timer_ID {
	id := loop.next_timer_id
	loop.next_timer_id += 1
	return id
}

next_sequence :: proc(loop: ^Loop) -> u64 {
	seq := loop.next_sequence
	loop.next_sequence += 1
	return seq
}

append_cancel_request :: proc(loop: ^Loop, id: Timer_ID) {
	loop.cancelled_ids[id] = true
}

is_cancel_requested :: proc(loop: ^Loop, id: Timer_ID) -> bool {
	if id == 0 {
		return false
	}
	return loop.cancelled_ids[id]
}

// --- Timer min-heap (keyed on due_ms, then seq) ---

// timer_less orders the heap: earliest due_ms first, seq breaking ties so equal
// deadlines fire in scheduling (FIFO) order, matching Node. Takes pointers (the
// elements are already in loop.timers) to avoid copying a whole Timer per compare —
// this runs O(log n) times per push/pop in the heap sift loops. Read-only.
timer_less :: proc(a, b: ^Timer) -> bool {
	return a.due_ms < b.due_ms || (a.due_ms == b.due_ms && a.seq < b.seq)
}

// timer_heap_swap exchanges two heap slots and updates timer_index so each timer's id
// keeps mapping to its current slot. Every in-heap move must go through here (or set the
// index directly) to keep timer_cancel's O(1) lookup correct.
@(private = "file")
timer_heap_swap :: proc(loop: ^Loop, i, j: int) {
	loop.timers[i], loop.timers[j] = loop.timers[j], loop.timers[i]
	loop.timer_index[loop.timers[i].id] = i
	loop.timer_index[loop.timers[j].id] = j
}

timer_heap_push :: proc(loop: ^Loop, timer: Timer) {
	append(&loop.timers, timer)
	i := len(loop.timers) - 1
	loop.timer_index[timer.id] = i
	timer_heap_sift_up(loop, i)
}

@(private = "file")
timer_heap_sift_up :: proc(loop: ^Loop, start: int) {
	i := start
	for i > 0 {
		parent := (i - 1) / 2
		if !timer_less(&loop.timers[i], &loop.timers[parent]) {
			break
		}
		timer_heap_swap(loop, i, parent)
		i = parent
	}
}

// timer_heap_remove_at removes the timer at slot `idx` (not necessarily the root) in
// O(log n), keeping timer_index consistent. Used by timer_cancel to drop a cancelled timer
// eagerly instead of leaving a tombstone in the heap (and its id in timer_index) until it
// reaches the root — which, with per-request HTTP timeouts armed-then-cancelled, would let
// cancelled entries pile up behind a not-yet-due live timer and inflate RSS.
timer_heap_remove_at :: proc(loop: ^Loop, idx: int) {
	delete_key(&loop.timer_index, loop.timers[idx].id)
	last := len(loop.timers) - 1
	if idx == last {
		ordered_remove(&loop.timers, last) // removing the tail: nothing to re-heap
		return
	}
	moved := loop.timers[last]
	ordered_remove(&loop.timers, last)
	loop.timers[idx] = moved
	loop.timer_index[moved.id] = idx
	// The moved tail can violate the heap upward or downward, never both: sift the
	// direction it needs.
	if idx > 0 && timer_less(&loop.timers[idx], &loop.timers[(idx - 1) / 2]) {
		timer_heap_sift_up(loop, idx)
	} else {
		timer_heap_sift_down(loop, idx)
	}
}

// timer_heap_pop_min removes and returns the earliest timer. Callers guarantee the
// heap is non-empty.
timer_heap_pop_min :: proc(loop: ^Loop) -> Timer {
	n := len(loop.timers)
	root := loop.timers[0]
	delete_key(&loop.timer_index, root.id)
	last := loop.timers[n - 1]
	ordered_remove(&loop.timers, n - 1) // pop the tail (O(1) on the last element)
	if n - 1 > 0 {
		loop.timers[0] = last
		loop.timer_index[last.id] = 0
		timer_heap_sift_down(loop, 0)
	}
	return root
}

timer_heap_sift_down :: proc(loop: ^Loop, start: int) {
	n := len(loop.timers)
	i := start
	for {
		left := 2 * i + 1
		right := 2 * i + 2
		smallest := i
		if left < n && timer_less(&loop.timers[left], &loop.timers[smallest]) {
			smallest = left
		}
		if right < n && timer_less(&loop.timers[right], &loop.timers[smallest]) {
			smallest = right
		}
		if smallest == i {
			break
		}
		timer_heap_swap(loop, i, smallest)
		i = smallest
	}
}

// timer_heap_clean_root pops cancelled timers off the root so a peek sees a live
// timer. Cancelled timers were already disposed and uncounted at cancel time, so
// no further bookkeeping is needed here.
timer_heap_clean_root :: proc(loop: ^Loop) {
	for len(loop.timers) > 0 &&
	    (loop.timers[0].cancelled || is_cancel_requested(loop, loop.timers[0].id)) {
		timer_heap_pop_min(loop)
	}
}

has_due_timer :: proc(loop: ^Loop) -> bool {
	timer_heap_clean_root(loop)
	return len(loop.timers) > 0 && loop.timers[0].due_ms <= loop.now_ms
}

next_immediate_index :: proc(loop: ^Loop, sequence_limit: u64) -> int {
	for i in 0 ..< len(loop.immediates) {
		immediate := loop.immediates[i]
		if immediate.cancelled || is_cancel_requested(loop, immediate.id) {
			continue
		}
		if immediate.seq >= sequence_limit {
			continue
		}
		return i
	}
	return -1
}

next_io_callback_index :: proc(loop: ^Loop, sequence_limit: u64) -> int {
	for i in 0 ..< len(loop.io_callbacks) {
		task := loop.io_callbacks[i]
		if task.cancelled || is_cancel_requested(loop, task.id) {
			continue
		}
		if task.seq >= sequence_limit {
			continue
		}
		return i
	}
	return -1
}

next_close_index :: proc(loop: ^Loop, sequence_limit: u64) -> int {
	for i in 0 ..< len(loop.close_callbacks) {
		cb := loop.close_callbacks[i]
		if cb.cancelled {
			continue
		}
		if cb.seq >= sequence_limit {
			continue
		}
		return i
	}
	return -1
}

// next_timer_due returns the earliest live deadline (the heap root after pruning
// any cancelled timers off it), or false if no timer is pending.
next_timer_due :: proc(loop: ^Loop) -> (u64, bool) {
	timer_heap_clean_root(loop)
	if len(loop.timers) == 0 {
		return 0, false
	}
	return loop.timers[0].due_ms, true
}

// run_dispose invokes a handle's dispose hook (if any) to release its user_data.
// A timer/immediate only reaches here when it is dropped without firing (or, for
// a repeating timer, after firing but without re-arming), so dispose runs at most
// once per handle and never alongside the callback's own one-shot cleanup.
run_dispose :: proc(dispose: Dispose, user_data: rawptr) {
	if dispose != nil {
		dispose(user_data)
	}
}

discard_cancelled_immediates :: proc(loop: ^Loop) {
	i := 0
	for i < len(loop.immediates) {
		if loop.immediates[i].cancelled || is_cancel_requested(loop, loop.immediates[i].id) {
			ordered_remove(&loop.immediates, i)
			continue
		}
		i += 1
	}
}

// poll_remaining_ms returns the time left until an absolute poll deadline, so a
// platform_poll re-entering after EINTR waits the REMAINING interval rather than
// restarting it: a storm of signals can neither restart the full timeout nor
// extend it unboundedly. A non-positive timeout (0 = non-blocking, <0 = block
// forever) has no deadline to track and is returned unchanged; a finite timeout
// returns max(0, timeout_ms - elapsed). Shared by the epoll and kqueue backends.
poll_remaining_ms :: proc(start: time.Tick, timeout_ms: int) -> int {
	if timeout_ms <= 0 do return timeout_ms
	elapsed := int(time.duration_milliseconds(time.tick_since(start)))
	return max(0, timeout_ms - elapsed)
}

// --- I/O watcher API ---

// watch_fd registers watcher with the backend and returns whether it is now the
// caller's freshly-registered watch. RETURN CONTRACT: true means this call moved
// the watcher into the registered set (and bumped active_io_count). false means
// "not newly registered" and covers THREE distinct cases the caller cannot tell
// apart: a nil/callback-less watcher, an already-watched watcher (a benign re-arm,
// not an error), or a real backend failure. A caller that must react to a genuine
// registration failure should therefore drive watch_fd off a freshly zeroed
// watcher (watched == false), so a false return can only mean the backend failed.
// fetch_set_watch_mode relies on this: it unwatch_fd's first, clearing the flag.
watch_fd :: proc(loop: ^Loop, watcher: ^IO_Watcher) -> bool {
	if watcher == nil || watcher.callback == nil do return false
	// Already in the registered set: a re-arm, not a new watcher. Do not call the
	// backend again (io_uring would over-count by arming a duplicate poll) or bump
	// active_io_count a second time.
	if watcher.watched do return false
	if platform_watch_fd(loop, watcher) {
		watcher.watched = true
		loop.active_io_count += 1
		return true
	}
	return false
}

unwatch_fd :: proc(loop: ^Loop, watcher: ^IO_Watcher) -> bool {
	if watcher == nil do return false
	// Only a watcher that is actually registered may decrement the count. A no-op
	// unwatch (never watched, or already unwatched) must not drift active_io_count
	// down — a spurious decrement can let the loop exit with I/O still pending.
	if !watcher.watched do return false
	// The platform op is best-effort: a failed EPOLL_CTL_DEL (fd already closed →
	// the kernel auto-removed it) or io_uring's logical-only unwatch must still drop
	// the count, or has_pending_work stays true forever and the loop parks. The
	// logical `watched` flag — not the syscall result — drives the accounting.
	platform_unwatch_fd(loop, watcher)
	watcher.watched = false
	loop.active_io_count = max(0, loop.active_io_count - 1)
	return true
}

// --- Completion-mode (proactor) socket I/O (io_uring only) ---------------------
//
// Unlike watch_fd (readiness: the loop tells you the fd is ready and you do the recv/send),
// submit_recv/submit_send hand the transfer itself to the kernel and deliver its result via
// Op_Completion. This is the io_uring proactor path (see docs/lava/io-uring-proactor.md); it is
// available only on the Linux io_uring backend with kernel RECV/SEND opcode support (probed at
// init) — proactor_available reports false on other backends AND on io_uring kernels predating
// those ops, and callers fall back to watch_fd. An in-flight op counts as pending work
// (active_io_count) so the loop stays alive until its completion.

// Op_ID identifies a submitted op so the caller can cancel_op it. Returned by submit_recv/
// submit_send; OP_ID_INVALID (0) means the submission did not happen (proactor unavailable,
// nil callback, or the SQE could not be obtained). It is the op's io_uring token, opaque to
// callers.
Op_ID :: distinct u64
OP_ID_INVALID :: Op_ID(0)

// Op_Completion fires exactly once for an op that REACHES a terminal completion, on the loop
// thread. `res` is the kernel result: bytes transferred (>= 0), or a negative -errno
// (including -ECANCELED for a cancel_op'd op). The buffer passed to submit_* is the CALLER's
// and must stay valid until either this OR the op's Op_Dispose fires.
Op_Completion :: proc(loop: ^Loop, user_data: rawptr, res: i32)

// Op_Dispose fires exactly once for an op that is DROPPED without a terminal completion —
// today only at loop destruction with the op still in flight (the ring is torn down, so no
// CQE will ever be drained). It is the op's "your buffer/user_data is now safe to reclaim"
// signal, mirroring a timer/task dispose. For any one op, exactly one of {Op_Completion,
// Op_Dispose} runs. May be nil if the caller has nothing to release.
Op_Dispose :: proc(user_data: rawptr)

// Op_Recv_Completion fires for a provided-buffer-ring RECV (Slice 2a/2b). It reports the
// kernel-selected buffer (`has_buf` = whether one was picked, `bid` = its id) and `more` = whether
// the submission stays armed (multishot, 2b): true on an INTERMEDIATE completion (the op is still
// live — do NOT re-arm or treat as finished), false on the TERMINAL completion (single-shot always,
// or a multishot that ended/errored/was cancelled — re-arm then). The callback MUST copy what it
// needs from `recv_ring_buf(loop, bid, res)` and then call `recv_ring_recycle(loop, bid)` — copy
// BEFORE recycle (recycling republishes the buffer; the kernel may immediately overwrite it), and
// recycle UNCONDITIONALLY for any CQE that carried a buffer (even a terminal one, even when
// discarding the data), or the shared ring leaks a buffer. Loop thread.
Op_Recv_Completion :: proc(loop: ^Loop, user_data: rawptr, res: i32, bid: u16, has_buf: bool, more: bool)

proactor_available :: proc(loop: ^Loop) -> bool {
	return platform_proactor_available(loop)
}

// bufring_available reports whether the shared provided-buffer ring is registered (Slice 2a). When
// false, callers use the 1b per-conn-buffer path (submit_recv).
bufring_available :: proc(loop: ^Loop) -> bool {
	return platform_bufring_ok(loop)
}

// submit_recv_ring queues a RECV that draws its destination from the shared buffer ring (no per-conn
// buffer). When multishot is available (recv_ring_multishot) it submits a MULTISHOT recv — one
// submission yields many completions (cb fires repeatedly with more=true), removing the per-request
// re-arm; otherwise a single-shot recv (cb fires once, more=false). cb fires with (res, bid, has_buf,
// more). Returns OP_ID_INVALID if cb is nil, the ring is unavailable, or no SQE could be obtained
// (caller falls back to submit_recv). LOOP-THREAD ONLY.
submit_recv_ring :: proc(
	loop: ^Loop,
	fd: uintptr,
	cb: Op_Recv_Completion,
	dispose: Op_Dispose,
	user_data: rawptr,
) -> Op_ID {
	if cb == nil do return OP_ID_INVALID
	token := platform_submit_recv_ring(loop, fd, cb, dispose, user_data)
	if token != 0 do loop.active_io_count += 1
	return Op_ID(token)
}

// recv_ring_multishot reports whether ring recvs are submitted in multishot mode (2b). False on a
// kernel without RECV_MULTISHOT (or after disable_multishot fell back); then each ring recv is
// single-shot and the caller re-arms per completion.
recv_ring_multishot :: proc(loop: ^Loop) -> bool {
	return platform_recv_ring_multishot(loop)
}

// disable_multishot turns multishot off for all future ring recvs on this loop — called once when a
// multishot recv completes with -EINVAL (the kernel lacks RECV_MULTISHOT but has buffer rings, so
// the gate let it through); the caller re-arms the connection in single-shot mode. LOOP-THREAD ONLY.
disable_multishot :: proc(loop: ^Loop) {
	platform_disable_multishot(loop)
}

// recv_ring_buf returns the kernel-selected bytes for a completed ring RECV (copy, do not retain).
recv_ring_buf :: proc(loop: ^Loop, bid: u16, n: int) -> []byte {
	return platform_buf_ring_buf(loop, bid, n)
}

// recv_ring_recycle returns buffer `bid` to the shared ring (after the caller copied what it needs).
recv_ring_recycle :: proc(loop: ^Loop, bid: u16) {
	platform_buf_ring_recycle(loop, bid)
}

// submit_recv queues a RECV of up to len(buf) bytes from fd into buf; cb fires with the byte
// count (or -errno) on completion. Returns OP_ID_INVALID if cb is nil, the proactor is
// unavailable, or the SQE could not be obtained (caller falls back to the readiness path).
// LOOP-THREAD ONLY: this mutates the io_uring SQ and the op-slot tables non-atomically;
// off-loop callers must hand work in via post_async. The op counts as pending work until its
// completion (or dispose), keeping the loop alive.
submit_recv :: proc(
	loop: ^Loop,
	fd: uintptr,
	buf: []byte,
	cb: Op_Completion,
	dispose: Op_Dispose,
	user_data: rawptr,
) -> Op_ID {
	if cb == nil do return OP_ID_INVALID // exactly-once completion has no observer; refuse
	token := platform_submit_recv(loop, fd, buf, cb, dispose, user_data)
	if token != 0 do loop.active_io_count += 1
	return Op_ID(token)
}

// submit_send queues a SEND of buf to fd; cb fires with the bytes sent (or -errno). SEND may
// complete with res < len(buf) (partial), exactly like send(2): the caller re-submits the
// unsent tail and keeps buf alive until the whole buffer is acknowledged. LOOP-THREAD ONLY
// (see submit_recv).
submit_send :: proc(
	loop: ^Loop,
	fd: uintptr,
	buf: []byte,
	cb: Op_Completion,
	dispose: Op_Dispose,
	user_data: rawptr,
) -> Op_ID {
	if cb == nil do return OP_ID_INVALID
	token := platform_submit_send(loop, fd, buf, cb, dispose, user_data)
	if token != 0 do loop.active_io_count += 1
	return Op_ID(token)
}

// cancel_op asks the kernel to cancel an in-flight op (e.g. a RECV pending on a socket being
// closed — io_uring holds its own file reference, so closing the fd alone does NOT tear the
// op down). Best-effort: the op still produces a terminal CQE (its own -ECANCELED, or a real
// result that beat the cancel), which fires Op_Completion and reclaims the slot. The buffer
// must stay valid until that terminal completion — the cancel CQE alone is not it. LOOP-THREAD
// ONLY. Returns whether a cancel SQE was actually queued (false = OP_ID_INVALID, proactor
// unavailable, the slot already completed, or the SQ was momentarily full), so a caller
// suppressing duplicate cancels can distinguish a real cancel from a no-op.
cancel_op :: proc(loop: ^Loop, id: Op_ID) -> bool {
	if id == OP_ID_INVALID do return false
	return platform_cancel_op(loop, u64(id))
}

// wakeup allows background worker threads to instantly kick the loop out of sleep.
wakeup :: proc(loop: ^Loop) {
	platform_wakeup(loop)
}

// set_shutdown_hook registers the loop-thread drain-start callback (the net layer's "stop accepting +
// drain"). Loop-thread only, before run().
set_shutdown_hook :: proc(loop: ^Loop, hook: Shutdown_Hook, user_data: rawptr) {
	loop.on_shutdown = hook
	loop.on_shutdown_data = user_data
}

// request_shutdown asks a (possibly other-thread) loop to begin graceful shutdown: set stop_requested
// and wake the loop so run_once observes it. CROSS-THREAD SAFE against destroy() — the shutdown_mutex
// serializes with destroy's `destroyed` mark, so this never writes the wakeup pipe of a torn-down loop.
// Idempotent. Called by the worker supervisor.
request_shutdown :: proc(loop: ^Loop) {
	sync.lock(&loop.shutdown_mutex)
	defer sync.unlock(&loop.shutdown_mutex)
	if loop.destroyed do return
	sync.atomic_store(&loop.stop_requested, true)
	platform_wakeup(loop)
}

// shutdown_requested reports whether a stop has been requested (atomic load — may be set by another
// thread). Used by the worker pre-run hook to abort startup if a signal arrived before run().
shutdown_requested :: proc(loop: ^Loop) -> bool {
	return sync.atomic_load(&loop.stop_requested)
}

// begin_force_exit transitions Draining -> Forced so run() returns. LOOP-THREAD ONLY (the net drain
// driver calls it when the last connection closes or the drain timeout fires).
begin_force_exit :: proc(loop: ^Loop) {
	loop.force_exit = true
}
