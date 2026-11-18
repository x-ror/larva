package lava_runtime

import "core:log"
import "core:sync"
import "core:testing"
import "core:thread"
import eventloop "lava:pkg/runtime/eventloop"

// Unit tests for the multi-worker primitives (Slice 3a): the pure LAVA_WORKERS parser and the
// abortable startup barrier. Deterministic and JSC-free (they touch no event loop or context).

// --- lava_parse_worker_count (pure: env + cpu count injected) ----------------------------------------
@(test)
worker_count_parsing :: proc(t: ^testing.T) {
	expect_ok :: proc(t: ^testing.T, raw: string, has: bool, cpu: int, want: int) {
		n, ok, _ := lava_parse_worker_count(raw, has, cpu)
		testing.expectf(
			t,
			ok && n == want,
			"parse(%q,%v,cpu=%d): got (n=%d ok=%v), want n=%d ok",
			raw,
			has,
			cpu,
			n,
			ok,
			want,
		)
	}
	expect_fail :: proc(t: ^testing.T, raw: string, has: bool, cpu: int) {
		_, ok, msg := lava_parse_worker_count(raw, has, cpu)
		testing.expectf(t, !ok && len(msg) > 0, "parse(%q): expected failure with a message, got ok=%v", raw, ok)
	}

	// Unset / "1" / "" -> single inline path.
	expect_ok(t, "", false, 8, 1)
	expect_ok(t, "", true, 8, 1)
	expect_ok(t, "1", true, 8, 1)
	// auto -> cpu count (clamped to >=1).
	expect_ok(t, "auto", true, 8, 8)
	expect_ok(t, "auto", true, 0, 1)
	// explicit valid counts + the [1,256] boundary.
	expect_ok(t, "4", true, 8, 4)
	expect_ok(t, "256", true, 8, 256)
	// invalid: zero / negative / oversized / non-numeric / partial-or-reinterpreted.
	expect_fail(t, "0", true, 8)
	expect_fail(t, "-1", true, 8)
	expect_fail(t, "257", true, 8)
	expect_fail(t, "abc", true, 8)
	expect_fail(t, "0x10", true, 8) // base-10 + full-consume: NOT reinterpreted as hex 16
	expect_fail(t, "10abc", true, 8) // trailing junk rejected
	expect_fail(t, "4.5", true, 8)
	// parse_int accepts an underscore digit separator in any base, so "1_0" -> 10. Harmless (still
	// bounded by [1,256]); the dangerous reinterpretations (hex/trailing-junk) are what we reject.
	expect_ok(t, "1_0", true, 8, 10)
}

// --- startup barrier (real N-thread, deterministic) --------------------------------------------------
@(private = "file")
Barrier_Probe :: struct {
	barrier:  ^Worker_Barrier,
	fail:     bool, // this probe reports a startup failure instead of ready
	released: bool, // result of barrier_ready_wait (meaningful when !fail)
	done:     bool,
}

@(private = "file")
barrier_probe_run :: proc(data: rawptr) {
	p := cast(^Barrier_Probe)data

	if p.fail {
		barrier_settle(p.barrier, true)
	} else {
		p.released = barrier_ready_wait(p.barrier)
	}

	sync.atomic_store(&p.done, true)
}

@(private = "file")
run_barrier :: proc(t: ^testing.T, n_ready, n_fail: int) -> (released_all: bool, any_failed: bool) {
	total := n_ready + n_fail
	b := Worker_Barrier {
		total = total,
	}
	probes := make([]Barrier_Probe, total, context.allocator)
	defer delete(probes, context.allocator)
	threads := make([dynamic]^thread.Thread, 0, total, context.allocator)
	defer delete(threads)
	for i in 0 ..< total {
		probes[i] = Barrier_Probe {
			barrier = &b,
			fail    = i >= n_ready, // first n_ready report ready, the rest fail
		}
		th := thread.create_and_start_with_data(&probes[i], barrier_probe_run, nil, .Normal, false)
		testing.expect(t, th != nil, "probe thread spawned")

		if th != nil {
			append(&threads, th)
		}
	}
	// join — this completes only if the barrier is deadlock-free (every reporter unblocked).
	for th in threads {
		thread.join(th)
		thread.destroy(th)
	}
	released_all = true
	for i in 0 ..< n_ready {
		if !probes[i].released {
			released_all = false
		}
	}
	return released_all, b.any_failed
}

// All-ready -> the barrier RELEASES (every ready worker proceeds) and no deadlock.
@(test)
barrier_all_ready_releases :: proc(t: ^testing.T) {
	released, any_failed := run_barrier(t, 4, 0)
	testing.expect(t, released, "all-ready barrier must release every worker")
	testing.expect(t, !any_failed, "no failure recorded")
}

// Any failure -> the barrier ABORTS (ready workers get released=false) and still no deadlock — the
// failing report wakes the blocked ready workers. This is the abort path a partial startup relies on.
@(test)
barrier_one_failure_aborts :: proc(t: ^testing.T) {
	released, any_failed := run_barrier(t, 3, 1)
	testing.expect(t, !released, "a failed startup must abort the ready workers (released=false)")
	testing.expect(t, any_failed, "failure recorded")
}

// --- worker thread exit gives back its host-native tables ---------------------------------------------
// Each worker thread binds the thread_local host-native tables (host_natives.odin) the first time eval
// injects a native. They are heap-backed and nothing but host_native_thread_teardown deletes them, so a
// worker_main that does not call it leaks both backings per worker per lifetime (an in-process respawn
// would leak per restart). Runs the REAL thread body, worker_main, on three threads through the real
// barrier — not eval plus a hand-placed teardown — so deleting the call in worker_main turns this red
// (recorded in tests/mutation-manifest.json). Calling lava_run_workers instead would set g_multi_worker
// and block SIGINT/SIGTERM on the test-runner thread for every later test.
//
// Tables bind only when the private host-call path is up (bind_host_tables runs after
// jsc.host_function_create succeeds); under LAVA_HOSTFN_DISABLE=1 or a failed probe nothing binds, the
// count never moves, and a worker_main without the teardown would still pass. So the same eval shape
// worker_main uses is first run once on this thread and must move the count by exactly one; when it
// does not, the leak this pins cannot occur here and the test skips (loudly) rather than pass vacuously.
@(test)
workers_give_back_their_host_tables :: proc(t: ^testing.T) {
	N :: 3
	baseline := host_native_tables_live()

	{
		probe_loop := eventloop.init(real_time = true)
		res := eval("globalThis.__ran = typeof Buffer", "workers_host_tables_probe.js", &probe_loop, false, nil)
		probe_exit := res.exit_code
		result_destroy(&res)
		bound := host_native_tables_live() == baseline + 1
		// eval destroyed its context on every path, which is the teardown's precondition; harmless when
		// nothing bound. Leaving the runner thread's tables bound would offset every later count.
		host_native_thread_teardown()

		if !testing.expectf(t, probe_exit == 0, "probe eval exit code %d", probe_exit) {
			return
		}

		if !bound {
			log.warnf(
				"SKIP workers_give_back_their_host_tables: an eval bound no host-native tables on this thread " +
				"(host-call path unavailable, e.g. LAVA_HOSTFN_DISABLE=1) — the leak it pins cannot occur here",
			)
			return
		}

		if !testing.expectf(
			t,
			host_native_tables_live() == baseline,
			"probe teardown left %d tables live, want baseline %d",
			host_native_tables_live(),
			baseline,
		) {return}
	}

	barrier := Worker_Barrier {
		total = N,
	}
	workers: [N]Worker
	threads: [N]^thread.Thread
	for i in 0 ..< N {
		workers[i] = Worker {
			source      = "globalThis.__ran = typeof Buffer",
			source_name = "workers_host_tables.js",
			barrier     = &barrier,
		}
		threads[i] = thread.create_and_start_with_data(&workers[i], worker_main, nil, .Normal, false)

		if !testing.expect(t, threads[i] != nil, "thread create failed") {
			return
		}
	}
	for th in threads {
		thread.join(th)
		thread.destroy(th)
	}
	// worker_main bumps the supervisor's exit tally; no supervisor ran, so hand it back.
	sync.atomic_sub(&g_worker_exits, N)

	for i in 0 ..< N {
		// Every worker reached the ready barrier and exited cleanly, i.e. really ran the eval the probe
		// above proved binds tables on this build — a startup failure would make the count below vacuous.
		testing.expectf(t, workers[i].reported && !barrier.any_failed, "worker %d did not reach the ready barrier", i)
		testing.expectf(t, workers[i].result.exit_code == 0, "worker %d exit code %d", i, workers[i].result.exit_code)
		result_destroy(&workers[i].result)
	}
	testing.expectf(
		t,
		host_native_tables_live() == baseline,
		"host-native tables live after workers exited: %d, want baseline %d",
		host_native_tables_live(),
		baseline,
	)
}
