#+build linux
package lava_runtime

import "core:sync"
import "core:sys/linux"
import eventloop "lava:pkg/runtime/eventloop"

// Supervisor signal handling (Slice 3a, Linux). SIGINT/SIGTERM are blocked process-wide before the
// workers spawn (so they inherit the block) and received synchronously by the supervisor via
// rt_sigtimedwait — the sigwait approach the design chose (no async-signal handler, and core:sys/linux
// has no signalfd binding). The short timeout doubles as the poll interval for the worker-exit state.

// SUPERVISOR_TICK_MS bounds how often supervisor_wait re-checks the worker-exit state between signal
// waits — prompt crash/finish detection without a busy loop.
@(private = "file")
SUPERVISOR_TICK_MS :: 200

@(private = "file")
shutdown_sigset :: proc() -> linux.Sig_Set {
	set: linux.Sig_Set
	// Sig_Set is a bitmask; signal n is bit (n-1). SIGINT(2) and SIGTERM(15) both fall in word 0.
	set[0] = (uint(1) << (uint(linux.Signal.SIGINT) - 1)) | (uint(1) << (uint(linux.Signal.SIGTERM) - 1))
	return set
}

// supervisor_block_signals blocks SIGINT/SIGTERM on the calling (supervisor) thread BEFORE any worker
// is spawned, so workers inherit the block and the supervisor is the only thread that receives them.
supervisor_block_signals :: proc() {
	set := shutdown_sigset()
	linux.rt_sigprocmask(.SIG_BLOCK, &set, nil)
}

// supervisor_wait blocks until SIGINT/SIGTERM, a worker crash, or all workers finishing on their own,
// then sets g_shutdown and requests graceful shutdown on every still-live worker loop.
supervisor_wait :: proc(workers: []Worker) {
	set := shutdown_sigset()
	n := len(workers)
	for {
		ts := linux.Time_Spec {
			time_nsec = SUPERVISOR_TICK_MS * 1_000_000,
		}
		_, err := linux.rt_sigtimedwait(&set, nil, &ts)

		if err == .NONE {break} 	// SIGINT/SIGTERM received -> graceful shutdown

		// EAGAIN (timeout) / EINTR: poll the worker-exit state.
		if sync.atomic_load(&g_worker_crashed) {break} 	// a worker died -> stop the rest

		if sync.atomic_load(&g_worker_exits) >= n {return} 	// all finished cleanly -> nothing to signal
	}

	// Signal every worker. g_shutdown first closes the startup-vs-signal race (a worker that publishes
	// its loop after this sweep sees g_shutdown in its pre-run hook and aborts). Then request_shutdown
	// each published loop UNDER the worker's sig_mutex: holding it across the read + the call keeps that
	// worker's stack-allocated loop alive for the duration (the worker can't clear+return meanwhile), so
	// there is no use-after-return; request_shutdown is itself destroy-safe for a mid-teardown loop.
	sync.atomic_store(&g_shutdown, true)
	for &w in workers {
		sync.lock(&w.sig_mutex)

		if w.loop != nil {
			eventloop.request_shutdown(w.loop)
		}

		sync.unlock(&w.sig_mutex)
	}
}
