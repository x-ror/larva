#+build linux
package lava_runtime

import "core:sys/linux"
import "core:testing"
import eventloop "lava:pkg/runtime/eventloop"

// Direct-invocation tests for the SEND_ZC two-axis state machine (Slice 3b, net_send_zc_complete).
// A real kernel two-CQE pinned sequence is unobservable in CI (loopback always copies; AF_UNIX has no
// send-zerocopy), so — per the design — the state machine is driven by calling net_send_zc_complete
// with crafted (res, more) tuples on a hand-built connection. This reaches the error/copied/fallback
// cells the large-body integration test cannot. `inflight` is held high so net_maybe_free never fires
// mid-test (the test owns the conn's lifetime); read_done is set so the drain's recv re-arm no-ops; the
// JS callbacks are nil so net_emit is a no-op (no JSC context needed). The fd is a real (unconnected)
// socket so net_close_conn's shutdown()/close() are clean rather than EBADF on a literal.

@(private = "file")
zc_conn :: proc(loop: ^eventloop.Loop, body_len: int) -> ^Net_Connection {
	conn := new(Net_Connection)
	conn.loop = loop
	fd, _ := linux.socket(.INET, .STREAM, {}, .TCP) // real fd: shutdown()/close() on the close path are clean
	conn.fd = uintptr(fd)
	conn.io_mode = .Proactor
	conn.read_done = true // drain's net_maybe_arm_recv returns early — no recv setup needed
	conn.inflight = 1000 // sentinel: maybe_free's (closing && inflight==0) never fires during the test
	conn.send_op = eventloop.Op_ID(0xABCD) // a non-INVALID placeholder; the terminal clears it
	conn.active_send = make([dynamic]byte)
	resize(&conn.active_send, body_len)
	return conn
}

@(private = "file")
zc_free :: proc(conn: ^Net_Connection) {
	linux.close(linux.Fd(conn.fd)) // net_maybe_free never ran (inflight sentinel), so close the real fd here
	delete(conn.active_send)
	delete(conn.pending_writes)
	free(conn)
}

// (a) RESULT CQE (more=true), res>=0: INV-1 records ONLY off (no clear/finish/submit/close).
@(test)
zc_result_records_off_only :: proc(t: ^testing.T) {
	loop := eventloop.init()

	if !eventloop.proactor_available(&loop) {
		eventloop.destroy(&loop)
		return
	}

	conn := zc_conn(&loop, 100)
	defer zc_free(conn) // runs LAST
	defer eventloop.destroy(&loop) // registered 2nd -> runs FIRST: dispose ops while conn is still live, then free

	net_send_zc_complete(&loop, conn, 60, true) // partial result: 60 of 100 bytes
	testing.expect_value(t, conn.active_send_off, 60)
	testing.expect(t, conn.saw_result, "saw_result set by the result CQE")
	testing.expect(t, conn.send_op != eventloop.OP_ID_INVALID, "INV-1: result must NOT clear send_op")
	testing.expect(t, !conn.closing, "INV-1: result must NOT close")
}

// (b) RESULT CQE (more=true), res<0: errored-but-pinned — record zc_err, leave off untouched (INV-4),
//     surface nothing yet (INV-1). The owed terminal handles it.
@(test)
zc_result_errored_pinned_records_err :: proc(t: ^testing.T) {
	loop := eventloop.init()

	if !eventloop.proactor_available(&loop) {
		eventloop.destroy(&loop)
		return
	}

	conn := zc_conn(&loop, 100)
	defer zc_free(conn) // runs LAST
	defer eventloop.destroy(&loop) // registered 2nd -> runs FIRST: dispose ops while conn is still live, then free

	net_send_zc_complete(&loop, conn, -i32(linux.Errno.EPIPE), true)
	testing.expect_value(t, conn.zc_err, -i32(linux.Errno.EPIPE))
	testing.expect_value(t, conn.active_send_off, 0) // INV-4: off untouched on a negative result
	testing.expect(t, !conn.closing, "INV-1: no close on a more=true CQE even when errored")
}

// (c) TERMINAL after a successful full transmission (saw=true, off==len): clear send_op, drain.
@(test)
zc_terminal_drained :: proc(t: ^testing.T) {
	loop := eventloop.init()

	if !eventloop.proactor_available(&loop) {
		eventloop.destroy(&loop)
		return
	}

	conn := zc_conn(&loop, 100)
	defer zc_free(conn) // runs LAST
	defer eventloop.destroy(&loop) // registered 2nd -> runs FIRST: dispose ops while conn is still live, then free
	conn.saw_result = true
	conn.active_send_off = 100 // the result CQE already advanced off to len

	net_send_zc_complete(&loop, conn, 0, false) // notif: res ignored (INV-3)
	testing.expect_value(t, conn.send_op, eventloop.OP_ID_INVALID) // cleared first
	testing.expect_value(t, len(conn.active_send), 0) // fully drained → backing cleared
	testing.expect(t, !conn.closing, "a clean drain must not close")
}

// (d) Single-CQE COPIED success (saw=false, more=false, res>0): the kernel declined zerocopy — advance
//     off like a plain success, do NOT close (Codex#3 — the cell that used to hit the fatal branch).
@(test)
zc_terminal_copied_success_not_close :: proc(t: ^testing.T) {
	loop := eventloop.init()

	if !eventloop.proactor_available(&loop) {
		eventloop.destroy(&loop)
		return
	}

	conn := zc_conn(&loop, 50)
	defer zc_free(conn) // runs LAST
	defer eventloop.destroy(&loop) // registered 2nd -> runs FIRST: dispose ops while conn is still live, then free
	// saw_result stays false (no prior more=true result): a single F_MORE-clear res>0 CQE.

	net_send_zc_complete(&loop, conn, 50, false)
	testing.expect(t, !conn.closing, "a copied (single-CQE) success must NOT close the connection")
	testing.expect_value(t, len(conn.active_send), 0) // off advanced to len → drained
}

// (e) Single-CQE zero-byte stall (saw=false, res==0): close (plain-path parity).
@(test)
zc_terminal_stall_closes :: proc(t: ^testing.T) {
	loop := eventloop.init()

	if !eventloop.proactor_available(&loop) {
		eventloop.destroy(&loop)
		return
	}

	conn := zc_conn(&loop, 100)
	defer zc_free(conn) // runs LAST
	defer eventloop.destroy(&loop) // registered 2nd -> runs FIRST: dispose ops while conn is still live, then free

	net_send_zc_complete(&loop, conn, 0, false)
	testing.expect(t, conn.closing, "a zero-byte stall must close")
	testing.expect(t, conn.had_error, "stall close is an error close")
}

// (f) Single-CQE -EINVAL on a ZC op (saw=false, send_was_zc): capability fallback — latch zc_ok off
//     loop-wide, re-submit PLAIN (send_op re-set), NOT fatal.
@(test)
zc_terminal_einval_falls_back_plain :: proc(t: ^testing.T) {
	loop := eventloop.init()

	if !eventloop.proactor_available(&loop) {
		eventloop.destroy(&loop)
		return
	}

	conn := zc_conn(&loop, 100)
	defer zc_free(conn) // runs LAST
	defer eventloop.destroy(&loop) // registered 2nd -> runs FIRST: dispose ops while conn is still live, then free
	conn.send_was_zc = true

	net_send_zc_complete(&loop, conn, -i32(linux.Errno.EINVAL), false)
	testing.expect(t, !eventloop.send_zc_ok(&loop), "EINVAL on a ZC op latches zc_ok off")
	testing.expect(t, !conn.closing, "EINVAL capability fallback must NOT close")
	testing.expect(t, conn.send_op != eventloop.OP_ID_INVALID, "fallback re-submitted (plain) — send_op re-set")
	testing.expect(t, !conn.send_was_zc, "the fallback re-submit chose plain")
}

// (g) Single-CQE -ENOBUFS (optmem pressure): transient copy-send fallback — re-submit, NOT fatal, zc NOT latched.
@(test)
zc_terminal_enobufs_not_fatal :: proc(t: ^testing.T) {
	loop := eventloop.init()

	if !eventloop.proactor_available(&loop) {
		eventloop.destroy(&loop)
		return
	}

	conn := zc_conn(&loop, 100)
	defer zc_free(conn) // runs LAST
	defer eventloop.destroy(&loop) // registered 2nd -> runs FIRST: dispose ops while conn is still live, then free
	conn.send_was_zc = true

	net_send_zc_complete(&loop, conn, -i32(linux.Errno.ENOBUFS), false)
	testing.expect(t, !conn.closing, "ENOBUFS (optmem) must be transient, NOT a fatal close")
	testing.expect(t, conn.send_op != eventloop.OP_ID_INVALID, "ENOBUFS re-submitted the tail")
}

// (h) ERRORED-BUT-PINNED TERMINAL (two-CQE): a more=true result carries res<0, then the more=false
//     terminal surfaces conn.zc_err (NOT the notif's own res — INV-3) and drives the fatal close. This is
//     the saw=true carried-error arm that the single-CQE cells (e–g) never reach, and exactly the
//     "even a failed request may notify" sequence loopback/AF_UNIX CI cannot produce.
@(test)
zc_errored_pinned_terminal_closes :: proc(t: ^testing.T) {
	loop := eventloop.init()

	if !eventloop.proactor_available(&loop) {
		eventloop.destroy(&loop)
		return
	}

	conn := zc_conn(&loop, 100)
	defer zc_free(conn) // runs LAST
	defer eventloop.destroy(&loop) // registered 2nd -> runs FIRST: dispose ops while conn is still live, then free
	conn.send_was_zc = true

	net_send_zc_complete(&loop, conn, -i32(linux.Errno.EPIPE), true) // errored-but-pinned result
	net_send_zc_complete(&loop, conn, 0, false) // notif (res ignored): the carried EPIPE drives the close
	testing.expect(t, conn.closing, "carried EPIPE at the terminal closes (INV-3: notif res ignored)")
	testing.expect(t, conn.had_error, "an EPIPE close is an error close")
}

// (i) CARRIED -EINVAL → loop-wide fallback (two-CQE): the errored-but-pinned arm whose carried error is a
//     capability signal — latch zc_ok off loop-wide and re-submit PLAIN, NOT fatal. Distinct from (f),
//     which reaches the ladder via the single-CQE (saw=false) arm.
@(test)
zc_carried_einval_falls_back_loopwide :: proc(t: ^testing.T) {
	loop := eventloop.init()

	if !eventloop.proactor_available(&loop) {
		eventloop.destroy(&loop)
		return
	}

	conn := zc_conn(&loop, 100)
	defer zc_free(conn) // runs LAST
	defer eventloop.destroy(&loop) // registered 2nd -> runs FIRST: dispose ops while conn is still live, then free
	conn.send_was_zc = true

	net_send_zc_complete(&loop, conn, -i32(linux.Errno.EINVAL), true) // errored-pinned, carries EINVAL
	net_send_zc_complete(&loop, conn, 0, false) // terminal: carried EINVAL → disable_zc + re-submit plain
	testing.expect(t, !eventloop.send_zc_ok(&loop), "carried EINVAL latches zc_ok off loop-wide")
	testing.expect(t, !conn.closing, "EINVAL capability fallback (via the carried error) must NOT close")
	testing.expect(t, conn.send_op != eventloop.OP_ID_INVALID, "fallback re-submitted (plain)")
	testing.expect(t, !conn.send_was_zc, "the re-submit chose plain")
}

// (j) -EOPNOTSUPP is PER-CONN, not loop-wide (the EINVAL/EOPNOTSUPP split): a per-socket/protocol denial
//     sets conn.zc_unsupported and re-submits plain, but leaves loop-wide zc_ok intact so sibling conns
//     keep using ZC.
@(test)
zc_eopnotsupp_is_per_conn :: proc(t: ^testing.T) {
	loop := eventloop.init()

	if !eventloop.proactor_available(&loop) {
		eventloop.destroy(&loop)
		return
	}

	conn := zc_conn(&loop, 100)
	defer zc_free(conn) // runs LAST
	defer eventloop.destroy(&loop) // registered 2nd -> runs FIRST: dispose ops while conn is still live, then free
	conn.send_was_zc = true

	net_send_zc_complete(&loop, conn, -i32(linux.Errno.EOPNOTSUPP), false)
	testing.expect(t, conn.zc_unsupported, "EOPNOTSUPP denies ZC for THIS conn")
	testing.expect(t, eventloop.send_zc_ok(&loop), "EOPNOTSUPP is per-socket — loop-wide zc_ok stays intact")
	testing.expect(t, !conn.closing, "EOPNOTSUPP fallback must NOT close")
	testing.expect(t, conn.send_op != eventloop.OP_ID_INVALID, "re-submitted (plain)")
	testing.expect(t, !conn.send_was_zc, "the re-submit chose plain (the zc_unsupported gate)")
}

// (k) PARTIAL result → TERMINAL → resubmit the unsent tail: a result advances off short of len, then the
//     terminal re-submits active_send[off:] (the choke point re-picks ZC vs plain). off is unchanged
//     because the new submit is for the remaining tail.
@(test)
zc_partial_then_tail_resubmit :: proc(t: ^testing.T) {
	loop := eventloop.init()

	if !eventloop.proactor_available(&loop) {
		eventloop.destroy(&loop)
		return
	}

	conn := zc_conn(&loop, 100)
	defer zc_free(conn) // runs LAST
	defer eventloop.destroy(&loop) // registered 2nd -> runs FIRST: dispose ops while conn is still live, then free

	net_send_zc_complete(&loop, conn, 60, true) // partial result: off → 60
	testing.expect_value(t, conn.active_send_off, 60)
	net_send_zc_complete(&loop, conn, 0, false) // terminal (saw, zc_err==0): off(60) < len(100) → re-submit tail
	testing.expect(t, conn.send_op != eventloop.OP_ID_INVALID, "the unsent 40-byte tail was re-submitted")
	testing.expect_value(t, conn.active_send_off, 60) // the re-submit is for [60:]; off is unchanged
	testing.expect(t, !conn.closing, "a partial-then-tail continuation must not close")
}

// (l) The teardown-pin predicate (M1/M2): the leak decision net_maybe_free uses. A live ZC send (send_op
//     not yet cleared by its notif) is pinned → LEAK, don't free; once the terminal clears send_op, or for
//     a plain send, the backing is safe to free. (The leak itself can't be asserted — Odin's leak tracker
//     would flag the intentional leak — so the pure predicate carries the coverage.)
@(test)
zc_pinned_at_teardown_predicate :: proc(t: ^testing.T) {
	conn := new(Net_Connection)
	defer free(conn)

	conn.send_was_zc = true
	conn.send_op = eventloop.Op_ID(0xABCD) // a ZC send whose notification has not fired
	testing.expect(t, net_zc_pinned_at_teardown(conn), "a live ZC send is pinned at teardown — leak, don't free")

	conn.send_op = eventloop.OP_ID_INVALID // the more=false terminal cleared it → pages released
	testing.expect(t, !net_zc_pinned_at_teardown(conn), "after the terminal, the backing is safe to free")

	conn.send_op = eventloop.Op_ID(0xABCD)
	conn.send_was_zc = false // a plain (copy) send never pins user pages
	testing.expect(t, !net_zc_pinned_at_teardown(conn), "a plain send's backing is never pinned")
}

// (m) The §7 read-pause tightening: with a 'drain' owed (want_drain), reads do NOT re-arm — even on a
//     PARTIAL drain (buffered < HWM), which 2a/1b used to resume on. Regression guard so a future change
//     can't silently revert to resuming reads before 'drain'. (Drives only the gate — no submit.)
@(test)
zc_want_drain_keeps_reads_paused :: proc(t: ^testing.T) {
	loop := eventloop.init()

	if !eventloop.proactor_available(&loop) {
		eventloop.destroy(&loop)
		return
	}

	conn := zc_conn(&loop, 0) // empty body → net_proactor_buffered == 0 (< HWM): a "partial drain" state
	defer zc_free(conn) // runs LAST
	defer eventloop.destroy(&loop) // registered 2nd -> runs FIRST

	conn.read_done = false // eligible to read…
	conn.recv_op = eventloop.OP_ID_INVALID // …and nothing in flight
	conn.want_drain = true // …but a 'drain' is owed
	testing.expect(t, !net_maybe_arm_recv(conn), "want_drain keeps reads paused (no re-arm on a partial drain)")
	testing.expect_value(t, conn.recv_op, eventloop.OP_ID_INVALID) // nothing was armed
}
