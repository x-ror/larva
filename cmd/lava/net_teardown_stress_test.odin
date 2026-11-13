// Linux-only: net's native connect path (linux.socket) exists only there, and
// the fd census below reads /proc.
#+build linux
package main

import "core:log"
import "core:testing"
import eventloop "lava:pkg/runtime/eventloop"
import lava "lava:pkg/runtime"

// eval_fd_delta runs one eval and reports how many file descriptors it left
// behind. `src` is expected to throw at top level; ok=false means it did not,
// which would make the number meaningless.
@(private = "file")
eval_fd_delta :: proc(src: string) -> (delta: int, ok: bool) {
	before := fd_census()
	if before < 0 do return 0, false
	loop := eventloop.init()
	// eval CONSUMES the loop — it destroys it on every path, including this
	// top-level-throw one (see the OWNERSHIP note in runtime.odin).
	result := lava.eval(src, "<net-teardown-stress-test>", &loop, false)
	defer lava.result_destroy(&result)
	after := fd_census()
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
//   * an ABSOLUTE fd count is confounded: the FIRST eval on a thread pays
//     one-time costs that have nothing to do with net — measured at +5 fds on a
//     cold runner thread, among them JavaScriptCore's per-VM
//     `anon_inode:[timerfd]`, which survives even the VM's destruction (see
//     create_eval_context in runtime.odin). eval reuses a pooled VM per thread,
//     so every later eval costs +0.
// So the test first runs one throwaway eval to pay those costs, then a baseline
// eval of the same script minus the connects, which absorbs anything per-eval
// that remains; what is left beyond it is attributable to the three sockets.
// Without the warm-up the baseline absorbed the cold start: run alone, with the
// sweep mutated to skip every connection, it measured baseline=5 withconns=3 and
// PASSED — it only went red when an earlier test happened to warm the thread.
//
// SERIAL ONLY. /proc/self/fd is process-wide, so with the runner's default
// thread-per-core every other test's sockets and files land in the census: the
// first parallel run measured a baseline of -18 against +20. This test is
// therefore a member of the `make test-odin-serial` gate (CI runs it) and skips
// itself elsewhere rather than reporting noise as a leak.
@(test)
eval_teardown_with_live_net_connections :: proc(t: ^testing.T) {
	when RUNNER_THREADS != 1 {
		log.info(
			"skipped: the /proc/self/fd census needs -define:ODIN_TEST_THREADS=1 (make test-odin-serial)",
		)
		return
	}

	// Warm-up: pays the thread's one-time costs (see above). Its delta is not used.
	// Same script as the baseline, so whatever loading node:net costs once is paid here too.
	_, warm_ok := eval_fd_delta("const net = require('node:net'); throw new Error('warm-up');")
	testing.expect(t, warm_ok, "the warm-up script was supposed to throw at top level")
	if !warm_ok do return

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
