// Linux-only: net's native connect path (linux.socket) exists only there, and
// the fd census below reads /proc.
#+build linux
package main

import "core:log"
import "core:os"
import "core:testing"
import lava "lava:pkg/runtime"
import eventloop "lava:pkg/runtime/eventloop"

// The same define core:testing's runner reads for its thread count
// (runner.odin:34). Re-declared here because `testing.TEST_THREADS` is not
// exported; #config resolves the identical -define at compile time, so this
// tracks the runner exactly. 0 is its default, meaning one thread per core.
@(private = "file")
RUNNER_THREADS :: #config(ODIN_TEST_THREADS, 0)

@(private = "file")
open_fd_count :: proc() -> int {
	handle, err := os.open("/proc/self/fd")
	if err != nil do return -1
	defer os.close(handle)
	infos, read_err := os.read_directory(handle, -1, context.temp_allocator)
	if read_err != nil do return -1
	return len(infos)
}

// eval_fd_delta runs one eval and reports how many file descriptors it left
// behind. `src` is expected to throw at top level; ok=false means it did not,
// which would make the number meaningless.
@(private = "file")
eval_fd_delta :: proc(src: string) -> (delta: int, ok: bool) {
	before := open_fd_count()
	if before < 0 do return 0, false
	loop := eventloop.init()
	// eval CONSUMES the loop — it destroys it on every path, including this
	// top-level-throw one (see the OWNERSHIP note in runtime.odin).
	result := lava.eval(src, "<net-teardown-stress-test>", &loop, false)
	defer lava.result_destroy(&result)
	after := open_fd_count()
	if after < 0 do return 0, false
	return after - before, result.status != .Ok
}

// net_shutdown_active iterates state.net_conns directly while net_maybe_free
// delete_keys entries under it. Every clean script closes its sockets, so the
// sweep normally runs over an empty map and the delete-during-iteration shape
// goes unexercised — the smokes only reach it on timing luck. This drives it
// deterministically: net.connect inserts the connection at INITIATION
// (net.odin, state.net_conns[conn.id] = conn), and a top-level throw returns
// from eval before the loop ever runs, so teardown sweeps a map holding three
// live in-flight connections. No listener and no port bind: the connects target
// a loopback port nothing answers, and their failure could only arrive through
// the loop, which never runs.
//
// The assertion is a DIFFERENTIAL fd census, and every simpler option was ruled
// out by mutation rather than by reasoning:
//   * a tracking allocator sees nothing. Connections are allocated and freed
//     under runtime.default_context() on purpose (net_connect_cb,
//     net_maybe_free), so they never touch the caller's allocator. Verified:
//     with the sweep mutated to skip a connection, and again with it mutated to
//     INSERT during the range (the one operation the loop's comment calls
//     unsafe), an allocator-based version of this test passed both times.
//   * an ABSOLUTE fd count is confounded: every eval leaves one
//     `anon_inode:[timerfd]` behind whether or not it touches net. That one is
//     JavaScriptCore's, not ours — measured at one per JSGlobalContext, with a
//     bare create/release pair leaking it just as a full eval does, and neither
//     a forced JSGarbageCollect nor dropping our JSClass reclaims it (see
//     release_global_context_after_eval in runtime.odin). Unconditional, and
//     nothing this sweep can influence.
// So the baseline eval below is the same script minus the connects: it absorbs
// the per-eval cost, and what remains is attributable to the three sockets.
//
// SERIAL ONLY. /proc/self/fd is process-wide, so with the runner's default
// thread-per-core every other test's sockets and files land in the census: the
// first parallel run measured a baseline of -18 against +20. This test is
// therefore a member of the `make test-odin-serial` gate (CI runs it) and skips
// itself elsewhere rather than reporting noise as a leak.
@(test)
eval_teardown_with_live_net_connections :: proc(t: ^testing.T) {
	when RUNNER_THREADS != 1 {
		log.info("skipped: the /proc/self/fd census needs -define:ODIN_TEST_THREADS=1 (make test-odin-serial)")
		return
	}

	baseline, base_ok := eval_fd_delta("const net = require('node:net'); throw new Error('x');")
	testing.expect(t, base_ok, "the baseline script was supposed to throw at top level")
	if !base_ok do return

	withconns, conn_ok := eval_fd_delta(
		`
		const net = require('node:net');
		net.connect(1, '127.0.0.1');
		net.connect(1, '127.0.0.1');
		net.connect(1, '127.0.0.1');
		throw new Error('teardown with live connections');
	`,
	)
	testing.expect(t, conn_ok, "the connect script was supposed to throw at top level")
	if !conn_ok do return

	testing.expectf(
		t,
		withconns <= baseline,
		"teardown left %d file descriptor(s) beyond the %d an equivalent eval leaks — a connection's socket was never closed",
		withconns - baseline,
		baseline,
	)
}
