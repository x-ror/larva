package lava_runtime

import "core:os"
import "core:strconv"
import "core:sync"
import "core:thread"
import eventloop "lava:pkg/runtime/eventloop"

// Multi-core workers (Slice 3a). JSC contexts can't share a heap and a shared VM serializes, so "use N
// cores" means N independent shared-nothing workers — each its own { event loop + JSC context +
// Runtime_State } running the app, with the kernel load-balancing connections via SO_REUSEPORT (commit
// 5). This file is the supervisor + the startup barrier; shutdown (signalfd / stop state machine) and
// listener sharing land in later commits.

// LAVA_WORKERS_MAX bounds the worker count so a typo/overflow can't spawn thousands of threads.
LAVA_WORKERS_MAX :: 256

// lava_resolve_worker_count reads LAVA_WORKERS and resolves how many workers to run. Thin wrapper over
// the pure lava_parse_worker_count (env + CPU count injected) so the parsing/validation is unit-testable.
lava_resolve_worker_count :: proc() -> (count: int, ok: bool, msg: string) {
	raw, has := os.lookup_env("LAVA_WORKERS", context.temp_allocator)
	return lava_parse_worker_count(raw, has, os.get_processor_core_count())
}

// lava_parse_worker_count is the pure resolver (no env / no syscalls — cpu_count is passed in). Unset
// / "1" -> 1 (the single inline path, unchanged). "auto" -> cpu_count. An explicit base-10 integer in
// [1, LAVA_WORKERS_MAX] -> that. Anything else fails fast (ok=false + a message), never a silent
// degrade: malformed / partial (e.g. "0x10", "1_0", trailing junk) / 0 / negative / oversized, or
// LAVA_WORKERS>1 on a non-Linux platform (multi-worker needs SO_REUSEPORT/signalfd/io_uring — Linux only).
lava_parse_worker_count :: proc(raw: string, has_env: bool, cpu_count: int) -> (count: int, ok: bool, msg: string) {
	if !has_env || raw == "" || raw == "1" do return 1, true, ""

	n: int
	if raw == "auto" {
		n = cpu_count
		if n < 1 do n = 1
	} else {
		// Base 10 explicitly + require the WHOLE string consumed, so "0x10" is not reinterpreted as hex
		// and trailing junk ("10abc") is rejected rather than partially parsed. (parse_int still accepts
		// an underscore separator, so "1_0" -> 10 — benign, still bounded by [1,256].)
		consumed: int
		parsed, pok := strconv.parse_int(raw, 10, &consumed)
		if !pok || consumed != len(raw) do return 0, false, "LAVA_WORKERS must be a positive integer or 'auto'"
		n = parsed
	}
	if n < 1 do return 0, false, "LAVA_WORKERS must be >= 1"
	if n > LAVA_WORKERS_MAX do return 0, false, "LAVA_WORKERS exceeds the maximum of 256"
	when ODIN_OS != .Linux {
		if n > 1 do return 0, false, "multi-worker (LAVA_WORKERS > 1) is supported only on Linux"
	}
	return n, true, ""
}

// g_multi_worker is read by net_listen_cb (commit 5) to decide whether to set SO_REUSEPORT. The
// supervisor sets it true ONCE before spawning any worker; workers only read it, and the thread
// spawn is the happens-before edge, so a plain bool needs no atomics.
g_multi_worker: bool

// Cross-thread shutdown signalling between the supervisor and the workers (all atomic):
//   - g_shutdown: the supervisor is shutting everyone down. The worker pre-run hook checks it so a
//     worker that publishes its loop AFTER the supervisor's signal sweep still aborts (startup-vs-
//     signal race) instead of starting to serve.
//   - g_worker_crashed: a worker's loop died abnormally (backend_failed); the supervisor stops the rest.
//   - g_worker_exits: incremented by each worker as it exits, so the supervisor knows when all are done
//     (non-server scripts) without treating a clean finish as a crash.
g_shutdown:        bool
g_worker_crashed:  bool
g_worker_exits:    int
// Set by net_startup_failed when a listener fails to bind / set SO_REUSEPORT during startup, or
// listen(0) is rejected under multi-worker. A worker checks it in its pre-run hook and aborts startup
// (M7: all listeners bind or the whole startup aborts — no running with partial/partitioned capacity).
g_listen_failed:   bool

// net_startup_failed records a fatal startup listener failure (called from net.odin, Linux). Aborting
// is process-wide: every worker runs the same script, so a bind failure on one means the deployment
// can't come up, and the others must not serve degraded.
net_startup_failed :: proc() {
	sync.atomic_store(&g_listen_failed, true)
}

// --- startup barrier (abortable two-phase) -------------------------------------------------------
//
// Each worker, after its top-level eval succeeds, reports "ready" and blocks until ALL expected
// workers have reported. All ready -> RELEASE (workers run their loops); any FAILED (eval errored
// before its hook, or a thread never started) -> ABORT (ready workers skip run() and tear down). A
// server must not start serving on some cores while another core failed to come up (#293 §6.2).
// Self-deciding: the last reporter computes the outcome, so no separate supervisor broadcast is
// needed. The mutex is the happens-before edge that publishes the outcome to the blocked workers.
Worker_Barrier :: struct {
	mutex:      sync.Mutex,
	cond:       sync.Cond,
	total:      int, // workers expected to report
	reported:   int, // ready + failed
	any_failed: bool, // a worker failed, or a thread never started
	decided:    bool,
	released:   bool, // outcome (valid once decided): true = run, false = abort
}

// barrier_maybe_decide: once all expected workers have reported, latch the outcome (release iff none
// failed). Mutex held by the caller; idempotent via the decided latch.
barrier_maybe_decide :: proc(b: ^Worker_Barrier) {
	if b.reported >= b.total && !b.decided {
		b.decided = true
		b.released = !b.any_failed
	}
}

// barrier_settle records one report and wakes everyone, deciding if it was the last. failed=true marks
// a startup failure (so the barrier aborts). Non-blocking — the failure/abort path.
barrier_settle :: proc(b: ^Worker_Barrier, failed: bool) {
	sync.lock(&b.mutex)
	defer sync.unlock(&b.mutex)
	if failed do b.any_failed = true
	b.reported += 1
	barrier_maybe_decide(b)
	sync.cond_broadcast(&b.cond)
}

// barrier_ready_wait is the success path: report ready, then block until the barrier decides. Returns
// whether to proceed (released) or abort.
barrier_ready_wait :: proc(b: ^Worker_Barrier) -> bool {
	sync.lock(&b.mutex)
	defer sync.unlock(&b.mutex)
	b.reported += 1
	barrier_maybe_decide(b)
	sync.cond_broadcast(&b.cond)
	for !b.decided do sync.cond_wait(&b.cond, &b.mutex)
	return b.released
}

// Worker is one shared-nothing instance: it runs eval() on its own thread with its own loop + JSC
// context. The input fields are read-only after spawn; reported/result are written only by this
// worker's thread (read by the supervisor after join).
Worker :: struct {
	source:      string,
	source_name: string,
	script_args: []string,
	barrier:     ^Worker_Barrier,
	reported:    bool, // did the ready hook run? (else the wrapper reports a startup failure)
	// The worker's loop, published once init() returns so the supervisor can request_shutdown it, and
	// cleared before the worker exits — both UNDER sig_mutex, which the supervisor also holds across its
	// read+request_shutdown. That keeps the worker's stack-allocated loop alive for the duration of the
	// supervisor's call (the worker can't clear -> can't return -> stack stays valid), closing the
	// use-after-return window. sig_mutex lives in this Worker (the supervisor-owned array), so it
	// outlives the loop. request_shutdown is additionally destroy-safe (the loop's own shutdown mutex +
	// platform_wakeup's invalidated-fd guard) for the case where the loop is mid/post-destroy.
	sig_mutex:   sync.Mutex,
	loop:        ^eventloop.Loop,
	result:      Result,
}

@(private = "file")
worker_pre_run :: proc(user_data: rawptr) -> bool {
	w := cast(^Worker)user_data
	w.reported = true
	// A listener that failed to bind during startup aborts the whole startup (M7): report a failure so
	// the barrier releases everyone to abort, rather than reporting ready and serving partial capacity.
	if sync.atomic_load(&g_listen_failed) {
		barrier_settle(w.barrier, true)
		return false
	}
	// Block at the barrier until all workers are ready (or one failed -> abort). Then proceed to run
	// UNLESS a shutdown was already requested — a signal during startup must not start serving.
	if !barrier_ready_wait(w.barrier) do return false
	return !sync.atomic_load(&g_shutdown)
}

@(private = "file")
worker_main :: proc(data: rawptr) {
	w := cast(^Worker)data
	loop := eventloop.init(real_time = true)
	// Publish under sig_mutex so the supervisor's read+request_shutdown is serialized against this
	// publish and the clear below (see the Worker.sig_mutex note).
	sync.lock(&w.sig_mutex)
	w.loop = &loop
	sync.unlock(&w.sig_mutex)
	// eval consumes the loop (destroys it on every path); the pre-run hook is the barrier rendezvous.
	w.result = eval(w.source, w.source_name, &loop, false, w.script_args, worker_pre_run, w)
	// This thread is about to end and runs no more evals: destroy its VM pool so the
	// pooled VM's heap is reclaimed now instead of outliving the thread (Odin has no
	// thread-exit hook to do it for us). eval has released its context by here.
	thread_vm_pool_destroy()
	// Clear the published loop (under sig_mutex) before this stack frame unwinds, so the supervisor's
	// sweep never dereferences a pointer to a returned stack — and before flagging a crash, so a
	// crash-driven sweep can't pick up this loop.
	sync.lock(&w.sig_mutex)
	w.loop = nil
	sync.unlock(&w.sig_mutex)
	if !w.reported do barrier_settle(w.barrier, true) // eval failed before the ready hook
	if w.result.backend_failed do sync.atomic_store(&g_worker_crashed, true)
	sync.atomic_add(&g_worker_exits, 1)
}

// lava_run_workers is the multi-worker supervisor: read the entry once, spawn `count` workers each
// running it on its own loop + context, and join them. Returns the process exit code. (Graceful
// shutdown via signalfd and SO_REUSEPORT listener sharing arrive in later commits; this commit is
// spawn + the startup barrier + join, exercisable with a non-server script.)
lava_run_workers :: proc(path: string, count: int, script_args: []string) -> int {
	data, err := os.read_entire_file(path, context.allocator)
	if err != os.ERROR_NONE {
		process_write(os.stderr, "lava: could not read ", path, "\n")
		return 1
	}
	defer delete(data, context.allocator)
	source := string(data)

	g_multi_worker = true

	// Block SIGINT/SIGTERM on the supervisor BEFORE spawning, so the workers inherit the block and the
	// supervisor is the only thread that receives them (via supervisor_wait's sigwait). No-op off Linux.
	supervisor_block_signals()

	barrier := Worker_Barrier {
		total = count,
	}
	workers := make([]Worker, count, context.allocator)
	defer delete(workers, context.allocator)
	threads := make([dynamic]^thread.Thread, 0, count, context.allocator)
	defer delete(threads)

	for i in 0 ..< count {
		workers[i] = Worker {
			source      = source,
			source_name = path,
			script_args = script_args,
			barrier     = &barrier,
		}
		t := thread.create_and_start_with_data(&workers[i], worker_main, nil, .Normal, false)
		if t != nil {
			append(&threads, t)
		} else {
			// A thread that never started can't report or ever run worker_main — settle a failure on
			// its behalf so the BARRIER reaches `total` (started peers abort), AND bump g_worker_exits
			// so the SUPERVISOR's exits>=n tally can still complete: worker_main is the only other
			// g_worker_exits increment, so without this an unspawned slot would hang supervisor_wait
			// forever (no signal, not a crash) after the started workers abort.
			barrier_settle(&barrier, true)
			sync.atomic_add(&g_worker_exits, 1)
		}
	}

	// Block until SIGINT/SIGTERM, a worker crash, or all workers finishing on their own — then signal
	// every live worker to begin graceful shutdown (request_shutdown each, after setting g_shutdown).
	supervisor_wait(workers)

	for t in threads {
		thread.join(t)
		thread.destroy(t)
	}

	// Exit code: a startup abort or a worker crash takes PRECEDENCE (code 1) — "the deployment did not
	// come up" must not be masked by a worker that happened to set process.exitCode. Otherwise the
	// first non-zero worker exit code wins. (Destroy every Result regardless.)
	code := 0
	if barrier.any_failed || sync.atomic_load(&g_worker_crashed) {
		code = 1
	} else {
		for i in 0 ..< count {
			if workers[i].result.exit_code != 0 {
				code = workers[i].result.exit_code
				break
			}
		}
	}
	for i in 0 ..< count do result_destroy(&workers[i].result)
	return code
}
