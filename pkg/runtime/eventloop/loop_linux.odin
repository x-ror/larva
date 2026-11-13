#+build linux
package eventloop

import "core:sync"
import "core:sys/linux"
import "core:sys/linux/uring"
import "core:time"

// Reserved io_uring user_data sentinels. These are matched exactly in
// drain_uring_completions before any watcher decode, so a watcher token must
// never collide with them. Watcher tokens always carry a non-zero generation in
// their high 32 bits (see uring_encode_token), so they are always >= 1<<32 and
// cannot equal these small constants.
URING_WAKEUP_USER_DATA :: u64(1) // re-armed POLL_ADD on the wakeup pipe's read end
URING_CANCEL_USER_DATA :: u64(2) // ASYNC_CANCEL ops issued by unwatch (completion ignored)
// Sentinel stored in the epoll event-data union for the wakeup-pipe registration.
// The wakeup is told apart from a watcher by an exact value match, NOT by reading
// the union's `fd` field and comparing it to the pipe fd: watchers store a `ptr`
// in the same union, and a watcher pointer whose low 32 bits happen to equal the
// pipe fd would be misclassified. All-ones is never a valid (canonical) pointer.
EPOLL_WAKEUP_TOKEN :: ~u64(0)

// Uring_Watch_Slot is one entry in the io_uring watcher table — the indirection
// that makes stale poll completions memory-safe. A submitted POLL_ADD carries a
// token (slot index + generation) as its user_data, NOT the raw watcher pointer.
// A completion is mapped back to its watcher through this table; if the slot has
// since been released (generation bumped by unwatch_fd) the completion is dropped
// WITHOUT dereferencing the — possibly freed — watcher. See drain_uring_completions.
Uring_Watch_Slot :: struct {
	watcher:    ^IO_Watcher,
	generation: u32, // bumped on release so a later completion for this slot is recognized stale
	in_use:     bool,
}

// Uring_Op_Slot is the proactor analogue of Uring_Watch_Slot: it holds the completion
// callback for an in-flight RECV/SEND. The op's user_data token carries (slot index,
// generation) like a watcher token, but with the op-domain bit set so completions are
// dispatched to the op path, never the poll-watcher path. The slot is released on the op's
// own (terminal) CQE.
Uring_Op_Slot :: struct {
	callback:   Op_Completion,
	recv_cb:    Op_Recv_Completion, // set instead of callback for a provided-buffer-ring RECV (Slice 2a)
	send_cb:    Op_Send_Completion, // set instead of callback for a SEND_ZC (Slice 3b); carries `more`
	dispose:    Op_Dispose, // fires instead of callback/recv_cb/send_cb if the op is dropped at loop destroy
	user_data:  rawptr,
	generation: u32,
	in_use:     bool,
}

// Max bytes per RECV/SEND SQE. The SQE length is a u32, but Buffer.MAX_LENGTH is 4 GiB and a
// straight u32(len) would wrap a 4 GiB buffer to 0 (a zero-length recv reads as EOF; a
// zero-length send spins). Cap each op at max(i32) and let the caller continue from cqe.res
// (it already handles short reads / partial sends).
URING_MAX_RW :: int(max(i32))

// Token domains: bit 63 of an io_uring user_data distinguishes a completion-op token (set)
// from a poll-watcher token (clear). Watcher generations are capped to 31 bits (see
// uring_release_slot) so a watcher token never sets bit 63, and the small sentinels
// (wakeup=1, cancel=2) have it clear too — they are matched by exact value first.
URING_OP_DOMAIN :: u64(1) << 63

Platform_Loop :: struct {
	use_uring:    bool,
	// Whether the proactor (RECV/SEND completion ops) is usable on this kernel. io_uring_setup
	// can succeed on kernels predating the single-shot RECV/SEND opcodes (added in 5.6), where
	// submitting one yields a -EINVAL CQE rather than a synchronous failure. We probe for opcode
	// support at init (uring_probe_proactor) and gate proactor_available / submit_* on this, so
	// callers fall back to watch_fd instead of mistaking a healthy socket for a failed one (#286).
	// Implies use_uring (we only probe when the ring initialized); the readiness/poll path on the
	// same ring stays available on older kernels regardless.
	proactor_ok:  bool,
	ring:         uring.Ring,
	cqes:         [32]linux.IO_Uring_CQE,
	epoll_fd:     linux.Fd,
	// Self-pipe used by wakeup() to kick the loop out of poll from another thread.
	// A pipe (not an eventfd): io_uring POLL_ADD reliably completes on a pipe fd
	// but not on an eventfd in our kernels (#74). [0] = read end, [1] = write end.
	wakeup_pipe:  [2]linux.Fd,
	// Watcher table backing the generation-token scheme (io_uring only). Slots are
	// reused across watchers; the array only grows to the high-water mark of
	// concurrently watched fds, so retention stays bounded to the in-flight set.
	watch_slots:  [dynamic]Uring_Watch_Slot,
	// Free-list of released watch_slots indices, so alloc/release are O(1) (no scan
	// for a vacant slot). Holds exactly the indices whose slot is currently !in_use.
	free_slots:   [dynamic]u32,
	// Completion-op slot table + free-list (proactor RECV/SEND), same generation-token
	// scheme as watch_slots but in the op token domain. Sized to the high-water mark of
	// concurrently in-flight ops.
	op_slots:     [dynamic]Uring_Op_Slot,
	op_free:      [dynamic]u32,
	// Provided-buffer ring (Slice 2a; the memory moat). A shared pool of N×M buffers the kernel
	// picks from for BUFFER_SELECT RECVs, so an idle connection holds no per-conn read buffer.
	// bufring_ok gates the ring-recv path (else callers use the 1b per-conn buffer). `bufring` is a
	// page-aligned mmap of N Uring_Buf entries (the kernel overlays the producer `tail` on bufs[0]);
	// `bufring_tail` is our running producer index. The -ENOBUFS refill budget is tracked at the net
	// layer (a recycle-driven credit), NOT here — a userspace ring-occupancy count can't see the
	// kernel's consumer head and so can't be a reliable credit. See docs/lava/io-uring-proactor.md (Slice 2).
	bufring_ok:    bool,
	multishot_ok:  bool, // submit ring recvs as MULTISHOT (2b); cleared on a -EINVAL (kernel lacks it)
	zc_ok:         bool, // large sends may use SEND_ZC (3b); set by the init-time .SEND_ZC opcode probe, cleared on a -EINVAL/-EOPNOTSUPP
	bufring_tried: bool, // buf_ring_init attempted (lazy: on the first ring-recv check, not loop init)
	bufring:       rawptr,
	bufring_size:  uint,
	bufring_pool:  []byte,
	bufring_tail:  u16,
}

platform_name :: proc(loop: ^Loop) -> string {
	if loop.platform.use_uring {
		return "linux-io_uring"
	}
	return "linux-epoll"
}

platform_init :: proc(loop: ^Loop) -> bool {
	loop.platform.epoll_fd = -1
	loop.platform.wakeup_pipe = {-1, -1}

	if pipe_err := linux.pipe2(&loop.platform.wakeup_pipe, {.CLOEXEC, .NONBLOCK});
	   pipe_err != nil {
		return false
	}

	params := uring.DEFAULT_PARAMS
	uring_err := uring.init(&loop.platform.ring, &params, 256)
	if uring_err == nil {
		loop.platform.use_uring = true
		// Gate the proactor on an actual RECV/SEND opcode probe (see proactor_ok): a successful
		// ring setup does not imply these ops exist on this kernel. ALSO require FAST_POLL: without
		// it a RECV on a nonblocking socket with no data completes immediately with -EAGAIN, and
		// net.odin's transient-retry would busy-spin. With FAST_POLL the kernel arms its own
		// internal poll past the initial EAGAIN — the assumption the retry path relies on. Lacking
		// either, fall back to the readiness path.
		proactor_supported, zc_supported := uring_probe_proactor(loop.platform.ring.fd)
		fast_poll := .FAST_POLL in loop.platform.ring.features
		loop.platform.proactor_ok = proactor_supported && fast_poll
		// zc_ok gates SEND_ZC for large sends (3b). It needs the proactor usable (it rides the same op
		// path, hence FAST_POLL too); the runtime -EINVAL/-EOPNOTSUPP fallback covers per-socket gaps the
		// probe can't see. Initialized HERE (not at Odin's false default) so use_zc can ever be true.
		loop.platform.zc_ok = zc_supported && fast_poll
		// Bind the watcher table to the loop allocator (set before platform_init), so
		// it does not adopt the allocator of whatever first appends to it.
		loop.platform.watch_slots = make([dynamic]Uring_Watch_Slot, loop.allocator)
		loop.platform.free_slots = make([dynamic]u32, loop.allocator)
		loop.platform.op_slots = make([dynamic]Uring_Op_Slot, loop.allocator)
		loop.platform.op_free = make([dynamic]u32, loop.allocator)

		// The provided-buffer ring (Slice 2a) is initialized LAZILY on the first ring-recv check
		// (platform_bufring_ok), not here — so a CLI/eval workload that never opens a node:net
		// connection never allocates the multi-MiB pool.

		arm_uring_poll(loop, u64(loop.platform.wakeup_pipe[0]), URING_WAKEUP_USER_DATA, {.IN})
		return true
	}

	fd, err := linux.epoll_create1({.FDCLOEXEC})
	if err != nil {
		linux.close(loop.platform.wakeup_pipe[0])
		linux.close(loop.platform.wakeup_pipe[1])
		// Reset, not just close. init returns the Loop even when this fails
		// (loop.odin: backend stays .Unavailable) and destroy calls
		// platform_destroy unconditionally, closing every wakeup_pipe entry >= 0
		// — so a stale number here is closed a SECOND time. epoll_create1 fails
		// on EMFILE, i.e. exactly when the kernel is recycling numbers, so that
		// second close lands on an unrelated descriptor rather than being
		// harmless. Same convention as loop_darwin.odin. Pinned by
		// failed_platform_init_does_not_double_close.
		loop.platform.wakeup_pipe = {-1, -1}
		return false
	}
	loop.platform.epoll_fd = fd

	ev: linux.EPoll_Event
	ev.events = {.IN}
	ev.data.u64 = EPOLL_WAKEUP_TOKEN
	linux.epoll_ctl(loop.platform.epoll_fd, .ADD, loop.platform.wakeup_pipe[0], &ev)

	return true
}

platform_destroy :: proc(loop: ^Loop) {
	if loop.platform.use_uring {
		// Tear the ring down FIRST: closing the io_uring fd cancels every in-flight op in the
		// kernel and guarantees it will not touch the op buffers again. Only then is it safe
		// to tell callers (via Op_Dispose) that the buffers of any op still in flight — which
		// therefore never got a drained completion — are reclaimable. Exactly one of
		// {callback, dispose} runs per op; here it is dispose.
		uring.destroy(&loop.platform.ring)
		for &slot in loop.platform.op_slots {
			if !slot.in_use do continue
			loop.active_io_count = max(0, loop.active_io_count - 1)
			if slot.dispose != nil do slot.dispose(slot.user_data)
			slot.in_use = false
		}
		// The io_uring fd is now closed (uring.destroy), which implicitly deregistered the buf_ring
		// — the kernel can no longer touch the ring/pool, so free them now (teardown model: close
		// fd = implicit dereg, THEN unmap/free; never an explicit unregister after the fd is closed).
		buf_ring_destroy(loop)
		delete(loop.platform.watch_slots)
		loop.platform.watch_slots = nil
		delete(loop.platform.free_slots)
		loop.platform.free_slots = nil
		delete(loop.platform.op_slots)
		loop.platform.op_slots = nil
		delete(loop.platform.op_free)
		loop.platform.op_free = nil
		loop.platform.use_uring = false
		loop.platform.proactor_ok = false
	}

	if loop.platform.epoll_fd >= 0 {
		linux.close(loop.platform.epoll_fd)
		loop.platform.epoll_fd = -1
	}

	if loop.platform.wakeup_pipe[0] >= 0 {
		linux.close(loop.platform.wakeup_pipe[0])
		loop.platform.wakeup_pipe[0] = -1
	}
	if loop.platform.wakeup_pipe[1] >= 0 {
		linux.close(loop.platform.wakeup_pipe[1])
		loop.platform.wakeup_pipe[1] = -1
	}
}

platform_wakeup :: proc(loop: ^Loop) {
	// One byte is enough to make the read end readable; coalesced wakeups are
	// drained together. Called from any thread (write() is async-signal-safe and
	// thread-safe); EAGAIN on a full pipe is fine — a wakeup is already pending.
	// Skip an invalidated write end (-1 after platform_destroy, 0 after destroy's
	// `loop^ = Loop{}`): a cross-thread request_shutdown that races teardown past the
	// shutdown-mutex guard must never write a closed/zeroed fd. The real pipe fd is
	// always > 2 (stdin/out/err precede it), so this never skips a live wakeup.
	if loop.platform.wakeup_pipe[1] <= 0 do return
	b := [1]u8{1}
	linux.write(loop.platform.wakeup_pipe[1], b[:])
}

// drain_wakeup empties the wakeup pipe's read end so it is not perpetually
// readable (which would busy-spin the poll). The bytes carry no information.
drain_wakeup :: proc(loop: ^Loop) {
	buf: [64]u8
	for {
		n, err := linux.read(loop.platform.wakeup_pipe[0], buf[:])
		if err != nil || n <= 0 do break
	}
}

platform_watch_fd :: proc(loop: ^Loop, watcher: ^IO_Watcher) -> bool {
	fd := linux.Fd(watcher.fd)
	if loop.platform.use_uring {
		events: linux.Fd_Poll_Events = {.IN} if watcher.mode == .Read else {.OUT}
		// Allocate a fresh table slot and arm the poll under its generation token
		// rather than the raw watcher pointer: a completion is now mapped back through
		// the table, so a stale one (after unwatch_fd bumped the generation) is dropped
		// without ever dereferencing the watcher. The loop-level watch_fd wrapper only
		// reaches here for a NOT-yet-watched watcher, so each call is one new slot.
		token := uring_alloc_slot(loop, watcher)
		if arm_uring_poll(loop, u64(watcher.fd), token, events) {
			// Record the slot on the watcher so unwatch_fd reaches it in O(1) without
			// scanning the table.
			watcher.backend_slot = uring_token_index(token)
			return true
		}
		// Arm failed even after arm_uring_poll's submit-and-retry (the SQ ring is still
		// full): release the slot so it is not stranded in_use.
		uring_release_slot(loop, uring_token_index(token))
		return false
	}

	ev: linux.EPoll_Event
	ev.events = {.IN} if watcher.mode == .Read else {.OUT}
	ev.data.ptr = watcher

	err := linux.epoll_ctl(loop.platform.epoll_fd, .ADD, fd, &ev)
	return err == nil
}

platform_unwatch_fd :: proc(loop: ^Loop, watcher: ^IO_Watcher) -> bool {
	if loop.platform.use_uring {
		// Real cancellation (#183), two layers, both required:
		//   1. ASYNC_CANCEL the outstanding POLL_ADD by its token so the kernel tears
		//      the poll down promptly — nothing lingers armed on a live or about-to-be-
		//      closed fd, and no spurious POLLNVAL completion fires after fd close.
		//   2. Release the table slot, bumping its generation. This is the memory-safe
		//      backstop: ANY completion that still races through (the cancelled poll's
		//      own -ECANCELED, or one already on the CQ before the cancel landed) now
		//      carries a stale token and is dropped in drain_uring_completions WITHOUT
		//      touching the watcher. As far as io_uring is concerned the watcher (and
		//      its owning request) may be freed the instant unwatch_fd returns — this
		//      backend needs no deferred reclaim. (The pointer-based backends still hold
		//      a settled request a couple of loop ticks for their in-flight poll batch,
		//      which dispatches via the raw watcher pointer; see fetch_reclaim_pending.)
		// Returns true unconditionally: the logical `watched` flag in the loop wrapper,
		// not the kernel result, drives active_io_count, and a best-effort cancel that
		// could not get an SQE is still covered by the generation check.
		index := watcher.backend_slot
		if int(index) < len(loop.platform.watch_slots) {
			slot := loop.platform.watch_slots[index]
			// Guard the O(1) lookup against a stale backend_slot: act only if the slot
			// still holds THIS watcher (it always does while watched, but this keeps a
			// desync from cancelling/releasing an unrelated slot).
			if slot.in_use && slot.watcher == watcher {
				uring_cancel_poll(loop, uring_encode_token(index, slot.generation))
				uring_release_slot(loop, index)
			}
		}
		return true
	}

	fd := linux.Fd(watcher.fd)
	err := linux.epoll_ctl(loop.platform.epoll_fd, .DEL, fd, nil)
	return err == nil
}

// platform_backend_fd: the ring fd under io_uring (pollable, readable while CQEs are
// pending — the wakeup pipe completes through the ring too), else the epoll fd (the
// wakeup pipe is in its set).
platform_backend_fd :: proc(loop: ^Loop) -> (uintptr, bool) {
	if loop.platform.use_uring do return uintptr(loop.platform.ring.fd), loop.platform.ring.fd >= 0
	return uintptr(loop.platform.epoll_fd), loop.platform.epoll_fd >= 0
}

platform_poll :: proc(loop: ^Loop, timeout_ms: int) {
	if loop.platform.use_uring {
		platform_poll_uring(loop, timeout_ms)
		return
	}

	if loop.platform.epoll_fd < 0 do return

	events: [32]linux.EPoll_Event
	n: int

	// Re-enter on EINTR rather than returning a spurious idle wake: a signal that
	// interrupts the wait must not be mistaken for "nothing to do". For a finite
	// timeout the retry waits the REMAINING time (an absolute deadline), so a storm
	// of signals can neither restart the full interval nor extend it unboundedly.
	poll_start := time.tick_now()
	for {
		res: i32
		errno: linux.Errno
		if timeout_ms < 0 {
			res, errno = linux.epoll_wait(
				loop.platform.epoll_fd,
				raw_data(events[:]),
				i32(len(events)),
				-1,
			)
		} else {
			remaining := poll_remaining_ms(poll_start, timeout_ms)
			ts := linux.Time_Spec {
				time_sec  = uint(remaining / 1000),
				time_nsec = uint((remaining % 1000) * 1_000_000),
			}
			res, errno = linux.epoll_pwait2(
				loop.platform.epoll_fd,
				raw_data(events[:]),
				i32(len(events)),
				&ts,
				nil,
			)
		}

		if errno == .EINTR {
			continue
		}
		// Any other error is fatal (e.g. EBADF on a closed epoll fd): flag it so the
		// run drivers stop instead of busy-spinning on a syscall that can never make
		// progress.
		if errno != nil {
			loop.backend_error = true
			return
		}
		n = int(res)
		break
	}

	if n <= 0 do return

	for i in 0 ..< n {
		ev := events[i]

		if ev.data.u64 == EPOLL_WAKEUP_TOKEN {
			drain_wakeup(loop)
			continue
		}

		// A registered socket / file-descriptor event.
		watcher := cast(^IO_Watcher)ev.data.ptr
		if watcher != nil && watcher.callback != nil {
			loop.io_events += 1
			watcher.callback(loop, watcher.user_data)
		}
	}
}

platform_poll_uring :: proc(loop: ^Loop, timeout_ms: int) {
	if timeout_ms == 0 {
		// Non-blocking tick: flush SQEs staged by uring_arm_rw before reaping. This ring is NOT
		// SQPOLL, so uring.submit would io_uring_enter even with nothing staged (sq_ring_needs_enter
		// returns true unconditionally without SQPOLL) — gate on sq_ready so a tick that staged no
		// socket op pays no extra syscall. (copy_cqes reads the CQ ring directly; it needs no
		// submit to observe completions.) The timeout>0 path flushes via its waiting submit(1, ts).
		if uring.sq_ready(&loop.platform.ring) > 0 {
			uring.submit(&loop.platform.ring, 0, nil)
		}
		drain_uring_completions(loop)
		return
	}

	// Bound the wait with the timer deadline via io_uring_enter's EXT_ARG timeout
	// (the same path submit already takes) rather than submitting a separate
	// IORING_OP_TIMEOUT SQE. The kernel arms and tears the timeout down internally,
	// so there is no standalone timeout op left pending after an early wake (a
	// socket completing first) to fire spuriously on a later wait — previously one
	// of the spurious-wake sources behind the premature-exit class (#72).
	ts: linux.Time_Spec
	ts_ptr: ^linux.Time_Spec = nil
	if timeout_ms > 0 {
		ts = linux.Time_Spec {
			time_sec  = uint(timeout_ms / 1000),
			time_nsec = uint((timeout_ms % 1000) * 1_000_000),
		}
		ts_ptr = &ts
	}

	// Wait for at least one completion (timeout_ms < 0 → ts_ptr nil → block until
	// one arrives). A timed-out wait returns -ETIME and an interrupted one -EINTR;
	// both are benign — we just reap whatever completed and let the driver re-enter.
	uring.submit(&loop.platform.ring, 1, ts_ptr)
	drain_uring_completions(loop)
}

// URING_DRAIN_CAP bounds how many completions a single drain processes. A multishot RECV on a
// continuously-readable peer replenishes the CQ as fast as we drain it (each completion recycles a
// ring buffer that feeds the next), so an uncapped drain could never return and would starve
// timers/immediates/other sockets/shutdown. The cap is generous — far above the per-tick load of a
// busy server, which drains to empty long before reaching it — so normal throughput is unthrottled;
// it bites only under true monopolization, where we yield to the rest of run_once and the remaining
// CQEs wait for the next tick (NODROP defers any CQ overflow — no loss).
URING_DRAIN_CAP :: 1024

drain_uring_completions :: proc(loop: ^Loop) {
	// Drain to empty (NOT just the entry snapshot): a closed-loop client's next request and our own
	// send-completions land mid-drain, so picking them up here instead of deferring avoids an extra
	// poll syscall per generation. URING_DRAIN_CAP keeps a hot multishot socket from looping forever.
	processed := 0
	for processed < URING_DRAIN_CAP {
		n, err := uring.copy_cqes(&loop.platform.ring, loop.platform.cqes[:], 0)
		if err != nil || n == 0 do return
		processed += int(n)

		for i in 0 ..< int(n) {
			cqe := loop.platform.cqes[i]

			if cqe.user_data == URING_WAKEUP_USER_DATA {
				drain_wakeup(loop)
				// Re-arm the one-shot poll on the wakeup pipe for the next wakeup.
				// arm_uring_poll retries once if the SQ ring is momentarily full rather
				// than silently dropping the re-arm — otherwise this loop could never be
				// woken across threads again (post_async could not break a parked poll).
				arm_uring_poll(
					loop,
					u64(loop.platform.wakeup_pipe[0]),
					URING_WAKEUP_USER_DATA,
					{.IN},
				)
				continue
			}

			// An ASYNC_CANCEL completion issued by unwatch_fd. It carries no watcher
			// work (its target's -ECANCELED is handled as a stale token below); just
			// reap it. -ENOENT/-EALREADY here mean the poll already completed or was
			// already gone — both benign.
			if cqe.user_data == URING_CANCEL_USER_DATA {
				continue
			}

			// A completion-op (proactor RECV/SEND) token: bit 63 set. Map it back through
			// the op-slot table, drop the in-flight count, release the slot, and fire the
			// completion with the kernel result (bytes, or -errno). The slot is copied before
			// release so the callback may immediately submit_* into the freed slot. A stale
			// token (generation mismatch) is dropped without calling back.
			if cqe.user_data & URING_OP_DOMAIN != 0 {
				index := uring_op_token_index(cqe.user_data)
				gen := uring_op_token_generation(cqe.user_data)
				if uring_op_slot_live(loop, index, gen) {
					slot := loop.platform.op_slots[index]
					loop.io_events += 1
					// A multishot RECV (2b) stays armed across many CQEs: IORING_CQE_F_MORE set means
					// this is an INTERMEDIATE completion (the op is still live under the same token) —
					// fire the callback but keep the slot in_use and active_io_count unchanged. Only
					// the TERMINAL CQE (F_MORE clear — single-shot always, or a multishot that ended/
					// errored/was cancelled) releases the slot and drops the in-flight count, exactly
					// once per op. F_MORE is set by a multishot RECV's intermediate CQEs (2b) AND by a
					// SEND_ZC's result CQE, whose notification (F_MORE clear) is the terminal (3b) — so
					// the count/slot lifetime is driven by F_MORE alone, uniformly, for both.
					more := .MORE in cqe.flags
					if !more {
						loop.active_io_count = max(0, loop.active_io_count - 1)
						uring_op_release_slot(loop, index)
					}
					// Dispatch by callback KIND (mutually exclusive: a slot carries exactly one of
					// recv_cb/send_cb/callback). Order recv → send → plain; a SEND_ZC CQE never reaches
					// the recv arm (no recv_cb), so its high flag bits are never misread as a buffer id.
					if slot.recv_cb != nil {
						// Decode the kernel-selected buffer id from the CQE flags (a bit_set —
						// transmute to u32 before the >>16). The callback copies the bytes then recycles.
						has_buf := .BUFFER in cqe.flags
						bid := u16(transmute(u32)cqe.flags >> 16)
						slot.recv_cb(loop, slot.user_data, cqe.res, bid, has_buf, more)
					} else if slot.send_cb != nil {
						slot.send_cb(loop, slot.user_data, cqe.res, more)
					} else if slot.callback != nil {
						slot.callback(loop, slot.user_data, cqe.res)
					}
				}
				continue
			}

			// A completion from a registered async socket watcher. Map the token back
			// through the table; a stale token (slot released or its generation bumped
			// by unwatch_fd) is dropped WITHOUT dereferencing the watcher, which may
			// already be freed — this is the core stale-poll safety guarantee.
			index := uring_token_index(cqe.user_data)
			gen := uring_token_generation(cqe.user_data)
			if !uring_slot_live(loop, index, gen) do continue

			watcher := loop.platform.watch_slots[index].watcher
			if watcher == nil || watcher.callback == nil do continue

			loop.io_events += 1
			watcher.callback(loop, watcher.user_data)

			// POLL_ADD is one-shot; re-arm only if the slot is STILL the same live
			// watcher after the callback. The callback may have unwatched (releasing
			// the slot), or unwatched then re-watched (a different slot now owns a
			// fresh poll) — re-validating index+generation catches both, so we never
			// re-arm a freed or reassigned slot. A re-watch is left to its own poll.
			if !uring_slot_live(loop, index, gen) do continue
			watcher = loop.platform.watch_slots[index].watcher
			if watcher == nil || watcher.callback == nil do continue

			events: linux.Fd_Poll_Events = {.IN} if watcher.mode == .Read else {.OUT}
			// arm_uring_poll retries once if the SQ ring is momentarily full rather than
			// silently dropping the re-arm (which would strand the fd with no kernel poll).
			arm_uring_poll(loop, u64(watcher.fd), cqe.user_data, events)
		}
	}
}

arm_uring_poll :: proc(
	loop: ^Loop,
	fd: u64,
	user_data: u64,
	events: linux.Fd_Poll_Events,
) -> bool {
	sqe, ok := uring.get_sqe(&loop.platform.ring)
	if !ok {
		// SQ ring momentarily full: submit to flush staged entries to the kernel
		// (which frees SQEs), then retry once. Every caller — the fresh watch in
		// platform_watch_fd, the wakeup re-arm, and the watcher re-arm — relies on
		// this so a transient full ring never strands an fd with no kernel poll.
		uring.submit(&loop.platform.ring, 0, nil)
		sqe, ok = uring.get_sqe(&loop.platform.ring)
		if !ok do return false
	}

	// Defensive zero: do not depend on get_sqe clearing the recycled ring entry.
	sqe^ = {}
	sqe.opcode = .POLL_ADD
	sqe.fd = cast(linux.Fd)fd // explicit cast to the distinct linux.Fd type
	sqe.user_data = user_data
	// POLL_ADD reads the interest mask from poll_events; writing it to addr (the
	// previous behavior) left poll_events zero, so the poll never completed.
	sqe.poll_events = events
	// Flush the SQE into the kernel now (non-blocking, wait_nr=0). Submission must
	// not depend on a later platform_poll call: when a due timer keeps the poll
	// phase from running, a re-arm staged but never submitted would strand the fd.
	uring.submit(&loop.platform.ring, 0, nil)
	return true
}

// --- io_uring watcher table + generation tokens (#183) ---
//
// A POLL_ADD's user_data is a token, not a pointer: the low 32 bits are a slot
// index into Platform_Loop.watch_slots and the high 32 bits are that slot's
// generation. Encoding the generation makes every watcher token >= 1<<32, so it
// can never collide with the small reserved sentinels (wakeup = 1, cancel = 2).
uring_encode_token :: proc(index: u32, generation: u32) -> u64 {
	return (u64(generation) << 32) | u64(index)
}

uring_token_index :: proc(token: u64) -> u32 {
	return u32(token & 0xFFFF_FFFF)
}

uring_token_generation :: proc(token: u64) -> u32 {
	return u32(token >> 32)
}

// uring_slot_live reports whether `index` still names an in-use slot at exactly
// `generation`. A false here is the stale-completion signal: the slot was released
// (or reused at a newer generation) by unwatch_fd, so the completion must be
// dropped without touching the watcher it once referenced.
uring_slot_live :: proc(loop: ^Loop, index: u32, generation: u32) -> bool {
	if int(index) >= len(loop.platform.watch_slots) do return false
	slot := loop.platform.watch_slots[index]
	return slot.in_use && slot.generation == generation
}

// uring_alloc_slot reserves a table slot for `watcher` and returns its POLL_ADD
// token. A released index is popped off free_slots before the array grows, so the
// table stays sized to the high-water mark of concurrently watched fds and the
// allocation is O(1). A reused slot already carries a bumped, non-zero generation
// (uring_release_slot skips 0 on wrap); a freshly appended slot starts at 1 — so a
// token is always >= 1<<32, never a reserved sentinel.
uring_alloc_slot :: proc(loop: ^Loop, watcher: ^IO_Watcher) -> u64 {
	if len(loop.platform.free_slots) > 0 {
		index := pop(&loop.platform.free_slots)
		slot := &loop.platform.watch_slots[index]
		slot.watcher = watcher
		slot.in_use = true
		return uring_encode_token(index, slot.generation)
	}
	append(
		&loop.platform.watch_slots,
		Uring_Watch_Slot{watcher = watcher, generation = 1, in_use = true},
	)
	return uring_encode_token(u32(len(loop.platform.watch_slots) - 1), 1)
}

// uring_release_slot frees a slot and bumps its generation so any completion still
// in flight for the old token is recognized stale (uring_slot_live → false) and
// dropped. The freed index is pushed onto free_slots for O(1) reuse. Skipping
// generation 0 on wrap keeps tokens out of the sentinel range. Idempotent: a slot
// already free is left alone, so its index is never double-pushed onto free_slots.
uring_release_slot :: proc(loop: ^Loop, index: u32) {
	if int(index) >= len(loop.platform.watch_slots) do return
	slot := &loop.platform.watch_slots[index]
	if !slot.in_use do return
	slot.in_use = false
	slot.watcher = nil
	slot.generation += 1
	// Keep generations within 31 bits so a watcher token (generation << 32 | index) never
	// sets bit 63 — that bit is the op-token domain marker. Skip 0 on wrap (sentinel range).
	if slot.generation == 0 || slot.generation >= u32(1) << 31 do slot.generation = 1
	append(&loop.platform.free_slots, index)
}

// uring_cancel_poll asks the kernel to cancel the outstanding POLL_ADD identified
// by `target_token`. Best-effort: a failure to obtain an SQE is acceptable because
// the generation bump in uring_release_slot already makes any surviving completion
// safe to drop — the cancel is the promptness optimization, not the safety net.
// The cancel op's own completion carries URING_CANCEL_USER_DATA and is ignored.
// Returns whether the cancel SQE was actually queued (false = SQ momentarily full),
// so a caller suppressing duplicate cancels knows whether one is genuinely pending.
uring_cancel_poll :: proc(loop: ^Loop, target_token: u64) -> bool {
	sqe, ok := uring.get_sqe(&loop.platform.ring)
	if !ok {
		// SQ ring momentarily full: submit to free slots, then retry once.
		uring.submit(&loop.platform.ring, 0, nil)
		sqe, ok = uring.get_sqe(&loop.platform.ring)
		if !ok do return false
	}
	// Zero the recycled SQE slot — get_sqe does not clear it (mirrors arm_uring_poll).
	sqe^ = {}
	sqe.opcode = .ASYNC_CANCEL
	sqe.addr = target_token // match the POLL_ADD whose user_data == target_token
	sqe.user_data = URING_CANCEL_USER_DATA
	uring.submit(&loop.platform.ring, 0, nil)
	return true
}

// --- Proactor completion-op submission (io_uring RECV/SEND) ---
//
// These are the platform side of submit_recv/submit_send (loop.odin). Each allocates an
// op-slot, stages a RECV/SEND SQE under its op-domain token, and flushes it. The op's
// completion is handled in drain_uring_completions (op-domain branch): release the slot and
// fire the callback with the kernel result. Buffer lifetime is the caller's — `buf` must stay
// valid until the completion fires. (Op cancellation on teardown is Slice 1b, where the net
// connection lifecycle drives it.)

platform_proactor_available :: proc(loop: ^Loop) -> bool {
	return loop.platform.proactor_ok
}

// --- proactor capability probe (IORING_REGISTER_PROBE) ---
//
// io_uring_setup succeeding does not mean the RECV/SEND single-shot opcodes exist: they were
// added in Linux 5.6, after io_uring itself (5.1). On a 5.1–5.5 kernel the ring works for
// POLL_ADD (the readiness path) but a RECV/SEND SQE only fails at completion time with -EINVAL,
// past the submit_* return value the fallback contract keys on. So we ask the kernel, up front,
// which opcodes it supports via IORING_REGISTER_PROBE and gate the proactor on RECV+SEND (#286).

// IO_URING_OP_SUPPORTED: set in io_uring_probe_op.flags when the kernel implements that opcode.
URING_OP_SUPPORTED :: u16(1) << 0

// Mirror of the kernel's struct io_uring_probe_op (8 bytes); one per opcode in the probe reply.
Uring_Probe_Op :: struct {
	op:    u8,
	resv:  u8,
	flags: u16,
	resv2: u32,
}

// Mirror of struct io_uring_probe: a 16-byte header followed by `ops_len` Uring_Probe_Op entries.
// `op` is a u8, so 256 entries is the hard ceiling on what any kernel can report — sizing the
// array to that lets one fixed-size, stack-allocated buffer cover every opcode. The kernel's
// IORING_REGISTER_PROBE handler rejects (-EINVAL) any buffer that is not fully zeroed, so this
// must be zero-initialized before the register call.
Uring_Probe :: struct {
	last_op: u8,
	ops_len: u8,
	resv:    u16,
	resv2:   [3]u32,
	ops:     [256]Uring_Probe_Op,
}

uring_probe_proactor :: proc(ring_fd: linux.Fd) -> (proactor: bool, zc: bool) {
	probe := Uring_Probe{} // zero-initialized: the kernel requires the whole buffer to be zero.
	// nr_args is the number of ops[] slots offered; the kernel caps its fill to the opcodes it
	// knows. REGISTER_PROBE itself postdates RECV/SEND, so an error here means an old kernel
	// without the proactor opcodes — report unsupported and let callers use the readiness path.
	if errno := linux.io_uring_register(ring_fd, .REGISTER_PROBE, &probe, u32(len(probe.ops)));
	   errno != nil {
		return false, false
	}
	proactor = uring_probe_supports(&probe, .RECV) && uring_probe_supports(&probe, .SEND)
	// SEND_ZC (Slice 3b) is a real OPCODE, so it is probeable here exactly like RECV/SEND — unlike 2b's
	// RECV_MULTISHOT, which is an ioprio flag and could only be detected via a runtime -EINVAL. Probing
	// it up front sets zc_ok before any send, so the first large send doesn't eat a fallback -EINVAL and
	// a send-before-recv (outbound client) conn isn't denied ZC. Gated on the proactor (ZC rides it).
	zc = proactor && uring_probe_supports(&probe, .SEND_ZC)
	return proactor, zc
}

uring_probe_supports :: proc(probe: ^Uring_Probe, op: linux.IO_Uring_OP) -> bool {
	idx := u8(op)
	if idx > probe.last_op do return false // opcode beyond what this kernel reports
	return (probe.ops[idx].flags & URING_OP_SUPPORTED) != 0
}

// platform_submit_recv/send return the op token (a non-zero op-domain user_data) on success,
// or 0 if the proactor is unavailable or no SQE could be obtained.
platform_submit_recv :: proc(
	loop: ^Loop,
	fd: uintptr,
	buf: []byte,
	cb: Op_Completion,
	dispose: Op_Dispose,
	user_data: rawptr,
) -> u64 {
	if !loop.platform.proactor_ok do return 0
	token := uring_op_alloc_slot(loop, cb, dispose, user_data)
	if uring_arm_rw(loop, .RECV, fd, buf, token, {}) do return token
	uring_op_release_slot(loop, uring_op_token_index(token))
	return 0
}

platform_submit_send :: proc(
	loop: ^Loop,
	fd: uintptr,
	buf: []byte,
	cb: Op_Completion,
	dispose: Op_Dispose,
	user_data: rawptr,
) -> u64 {
	if !loop.platform.proactor_ok do return 0
	token := uring_op_alloc_slot(loop, cb, dispose, user_data)
	// NOSIGNAL: a send to a peer that has closed surfaces as -EPIPE in the completion rather
	// than raising SIGPIPE (which would kill the process).
	if uring_arm_rw(loop, .SEND, fd, buf, token, {.NOSIGNAL}) do return token
	uring_op_release_slot(loop, uring_op_token_index(token))
	return 0
}

// platform_cancel_op asks the kernel to cancel the op identified by `token`. The op still
// produces a terminal CQE that releases the slot and fires the callback; this just makes a
// pending op (e.g. a RECV on a fd being closed) tear down promptly instead of lingering. The
// generation check avoids issuing a cancel against a slot already reused for a new op.
platform_cancel_op :: proc(loop: ^Loop, token: u64) -> bool {
	if !loop.platform.proactor_ok do return false
	if uring_op_slot_live(loop, uring_op_token_index(token), uring_op_token_generation(token)) {
		return uring_cancel_poll(loop, token) // ASYNC_CANCEL(addr=token); its own CQE is ignored
	}
	return false
}

// uring_arm_rw STAGES a RECV/SEND SQE for `buf` under `token` (it does NOT submit — platform_poll_uring
// flushes the batch with one io_uring_enter before it waits/drains). If the SQ ring is momentarily
// full it submits once to make room and retries get_sqe, like arm_uring_poll.
uring_arm_rw :: proc(
	loop: ^Loop,
	opcode: linux.IO_Uring_OP,
	fd: uintptr,
	buf: []byte,
	token: u64,
	flags: linux.Socket_Msg,
) -> bool {
	sqe, ok := uring.get_sqe(&loop.platform.ring)
	if !ok {
		uring.submit(&loop.platform.ring, 0, nil)
		sqe, ok = uring.get_sqe(&loop.platform.ring)
		if !ok do return false
	}
	sqe^ = {}
	sqe.opcode = opcode
	sqe.fd = cast(linux.Fd)fd
	sqe.addr = cast(u64)uintptr(raw_data(buf))
	sqe.len = u32(min(len(buf), URING_MAX_RW)) // cap so a 4 GiB buffer doesn't wrap to 0
	sqe.msg_flags = flags
	sqe.user_data = token
	// Staged, NOT submitted here: platform_poll_uring flushes the whole batch with one
	// io_uring_enter before it waits/drains, so a burst of per-request arms (a send + a recv
	// re-arm, ×N connections in one drain) costs ONE enter instead of one enter per op — the
	// proactor's syscall win (Slice 1a's deferred batching, realized in 1b under load). The
	// op already counts toward active_io_count, so the loop will reach that flushing poll.
	return true
}

// --- op-slot table (op token domain; mirrors the watch-slot table) ---

uring_op_encode_token :: proc(index: u32, generation: u32) -> u64 {
	return URING_OP_DOMAIN | (u64(generation) << 32) | u64(index)
}
uring_op_token_index :: proc(token: u64) -> u32 {
	return u32(token & 0xFFFF_FFFF)
}
uring_op_token_generation :: proc(token: u64) -> u32 {
	return u32((token >> 32) & 0x7FFF_FFFF) // 31-bit generation (bit 63 is the domain marker)
}

uring_op_slot_live :: proc(loop: ^Loop, index: u32, generation: u32) -> bool {
	if int(index) >= len(loop.platform.op_slots) do return false
	slot := loop.platform.op_slots[index]
	return slot.in_use && slot.generation == generation
}

uring_op_alloc_slot :: proc(
	loop: ^Loop,
	cb: Op_Completion,
	dispose: Op_Dispose,
	user_data: rawptr,
) -> u64 {
	if len(loop.platform.op_free) > 0 {
		index := pop(&loop.platform.op_free)
		slot := &loop.platform.op_slots[index]
		slot.callback = cb
		slot.dispose = dispose
		slot.user_data = user_data
		slot.in_use = true
		return uring_op_encode_token(index, slot.generation)
	}
	append(
		&loop.platform.op_slots,
		Uring_Op_Slot {
			callback = cb,
			dispose = dispose,
			user_data = user_data,
			generation = 1,
			in_use = true,
		},
	)
	return uring_op_encode_token(u32(len(loop.platform.op_slots) - 1), 1)
}

uring_op_release_slot :: proc(loop: ^Loop, index: u32) {
	if int(index) >= len(loop.platform.op_slots) do return
	slot := &loop.platform.op_slots[index]
	if !slot.in_use do return
	slot.in_use = false
	slot.callback = nil
	slot.recv_cb = nil
	slot.send_cb = nil
	slot.dispose = nil
	slot.user_data = nil
	slot.generation += 1
	if slot.generation == 0 || slot.generation >= u32(1) << 31 do slot.generation = 1
	append(&loop.platform.op_free, index)
}

uring_op_alloc_slot_recv :: proc(
	loop: ^Loop,
	recv_cb: Op_Recv_Completion,
	dispose: Op_Dispose,
	user_data: rawptr,
) -> u64 {
	token := uring_op_alloc_slot(loop, nil, dispose, user_data)
	loop.platform.op_slots[uring_op_token_index(token)].recv_cb = recv_cb
	return token
}

// --- provided-buffer ring (Slice 2a; the memory moat) ---
//
// core:sys/linux exposes the opcodes/flags/CQE bits + io_uring_register but NOT these structs
// (as with Uring_Probe in 1a). The kernel OVERLAYS the producer `tail` (u16) on bufs[0]'s `resv`
// (bytes 14..15), so buf_ring_add writes ONLY the 14 bytes addr/len/bid, never resv.
//
// Layout below: types, then consts, then the package API (platform_*, called from loop.odin's
// eventloop wrappers), then the file-private helpers.

Uring_Buf_Reg :: struct {
	ring_addr:    u64,
	ring_entries: u32,
	bgid:         u16,
	flags:        u16,
	resv:         [3]u64,
}
#assert(size_of(Uring_Buf_Reg) == 40)

Uring_Buf :: struct {
	addr: u64,
	len:  u32,
	bid:  u16,
	resv: u16, // overlaid by the producer `tail` at bufs[0]; buf_ring_add never writes it
}
#assert(size_of(Uring_Buf) == 16)
#assert(align_of(Uring_Buf) == 8)

URING_BUFRING_BGID :: 0
URING_BUFRING_ENTRIES :: 256 // N — power of two
URING_BUFRING_BUFSIZE :: 16 * 1024 // M
URING_BUFRING_MASK :: URING_BUFRING_ENTRIES - 1

// --- package API (called from loop.odin's eventloop wrappers) ---

// platform_bufring_ok reports whether the provided-buffer ring is usable, initializing it lazily on
// the first call (loop thread; called from net_start_cb). So the pool/ring are allocated only when a
// connection actually wants ring-mode reads, and only once.
platform_bufring_ok :: proc(loop: ^Loop) -> bool {
	if !loop.platform.bufring_tried {
		loop.platform.bufring_tried = true
		buf_ring_init(loop)
	}
	return loop.platform.bufring_ok
}

// platform_submit_recv_ring stages a single-shot BUFFER_SELECT RECV (no per-conn buffer — the kernel
// picks one from the ring at completion). Returns the op token, or 0 (caller falls back to 1b).
platform_submit_recv_ring :: proc(
	loop: ^Loop,
	fd: uintptr,
	cb: Op_Recv_Completion,
	dispose: Op_Dispose,
	user_data: rawptr,
) -> u64 {
	if !loop.platform.bufring_ok do return 0
	token := uring_op_alloc_slot_recv(loop, cb, dispose, user_data)
	if uring_arm_recv_ring(loop, fd, token) do return token
	uring_op_release_slot(loop, uring_op_token_index(token))
	return 0
}

// platform_buf_ring_recycle returns buffer `bid` to the ring. The caller MUST have already copied
// any bytes it needs out of the buffer — once the tail is published the kernel may overwrite it.
platform_buf_ring_recycle :: proc(loop: ^Loop, bid: u16) {
	if !loop.platform.bufring_ok || int(bid) >= URING_BUFRING_ENTRIES do return
	off := int(bid) * URING_BUFRING_BUFSIZE
	buf_ring_add(
		loop,
		u32(loop.platform.bufring_tail) & URING_BUFRING_MASK,
		u64(uintptr(raw_data(loop.platform.bufring_pool[off:]))),
		URING_BUFRING_BUFSIZE,
		bid,
	)
	loop.platform.bufring_tail += 1
	buf_ring_publish_tail(loop)
}

// platform_buf_ring_buf returns the kernel-selected bytes for `bid` (the caller copies, does NOT retain).
platform_buf_ring_buf :: proc(loop: ^Loop, bid: u16, n: int) -> []byte {
	if !loop.platform.bufring_ok || int(bid) >= URING_BUFRING_ENTRIES || n <= 0 do return nil
	off := int(bid) * URING_BUFRING_BUFSIZE
	m := min(n, URING_BUFRING_BUFSIZE)
	return loop.platform.bufring_pool[off:off + m]
}

// --- file-private helpers ---

// buf_ring_add writes a buffer entry's 14 bytes (addr/len/bid) at ring index `idx`, NEVER the
// `resv` at bytes 14..15 — those alias the shared producer `tail` for bufs[0]. Used by seed + recycle.
@(private = "file")
buf_ring_add :: proc(loop: ^Loop, idx: u32, addr: u64, length: u32, bid: u16) {
	// Field stores (clearer than raw byte offsets, identical codegen) — but DELIBERATELY never
	// write `resv`: at idx 0 it aliases the shared producer `tail`, published separately with a
	// release store in buf_ring_publish_tail. (Matches liburing's io_uring_buf_ring_add, which
	// also leaves resv untouched.) `ring` is 8-aligned (page-aligned mmap), so the stores align.
	ring := cast([^]Uring_Buf)loop.platform.bufring
	entry := &ring[idx]
	entry.addr = addr
	entry.len = length
	entry.bid = bid
}

// buf_ring_publish_tail release-stores our producer index into the overlaid tail (bytes 14..15),
// so the buffer-entry writes are visible to the kernel before it observes the new tail.
@(private = "file")
buf_ring_publish_tail :: proc(loop: ^Loop) {
	tail_ptr := cast(^u16)(uintptr(loop.platform.bufring) + 14)
	sync.atomic_store_explicit(tail_ptr, loop.platform.bufring_tail, .Release)
}

// buf_ring_init allocates the pool + ring, seeds all N buffers, and registers the ring. Best-effort:
// returns false (and cleans up) if the proactor is unavailable, the kernel lacks NODROP (deferred
// CQ overflow — without it an overflow would silently drop a recv CQE and leak its buffer), the
// ring mmap fails, or REGISTER_PBUF_RING errors. bufring_ok gates the whole ring-recv path.
@(private = "file")
buf_ring_init :: proc(loop: ^Loop) -> bool {
	if !loop.platform.proactor_ok do return false
	if .NODROP not_in loop.platform.ring.features do return false
	pool := make([]byte, URING_BUFRING_ENTRIES * URING_BUFRING_BUFSIZE, loop.allocator)
	if pool == nil do return false
	ring_size := uint(URING_BUFRING_ENTRIES * size_of(Uring_Buf))
	ring_ptr, mmap_err := linux.mmap(0, ring_size, {.READ, .WRITE}, {.PRIVATE, .ANONYMOUS})
	if mmap_err != .NONE {
		delete(pool, loop.allocator)
		return false
	}
	loop.platform.bufring = ring_ptr
	loop.platform.bufring_size = ring_size
	loop.platform.bufring_pool = pool
	loop.platform.bufring_tail = 0
	for bid in 0 ..< u32(URING_BUFRING_ENTRIES) {
		off := int(bid) * URING_BUFRING_BUFSIZE
		buf_ring_add(
			loop,
			bid,
			u64(uintptr(raw_data(pool[off:]))),
			URING_BUFRING_BUFSIZE,
			u16(bid),
		)
	}
	loop.platform.bufring_tail = u16(URING_BUFRING_ENTRIES)
	buf_ring_publish_tail(loop)
	reg := Uring_Buf_Reg {
		ring_addr    = u64(uintptr(ring_ptr)),
		ring_entries = u32(URING_BUFRING_ENTRIES),
		bgid         = URING_BUFRING_BGID,
	}
	if errno := linux.io_uring_register(loop.platform.ring.fd, .REGISTER_PBUF_RING, &reg, 1);
	   errno != .NONE {
		linux.munmap(ring_ptr, ring_size)
		delete(pool, loop.allocator)
		loop.platform.bufring = nil
		loop.platform.bufring_pool = nil
		return false
	}
	loop.platform.bufring_ok = true
	// Attempt multishot (2b) by default: RECV_MULTISHOT is an ioprio flag, not a probeable opcode,
	// so a kernel with buffer rings (5.19) but without multishot recv (added 6.0) accepts the SQE
	// and reports -EINVAL via the CQE — net.odin disables multishot on that and re-arms single-shot.
	loop.platform.multishot_ok = true
	return true
}

// buf_ring_destroy frees the ring + pool. MUST run only AFTER the io_uring fd is closed
// (uring.destroy), which implicitly deregisters the buf_ring so the kernel can no longer touch it.
@(private = "file")
buf_ring_destroy :: proc(loop: ^Loop) {
	if loop.platform.bufring != nil {
		linux.munmap(loop.platform.bufring, loop.platform.bufring_size)
		loop.platform.bufring = nil
	}
	if loop.platform.bufring_pool != nil {
		delete(loop.platform.bufring_pool, loop.allocator)
		loop.platform.bufring_pool = nil
	}
	loop.platform.bufring_ok = false
}

// uring_arm_recv_ring stages the BUFFER_SELECT RECV SQE (addr/len 0 — the kernel sizes from the
// chosen buffer). Staged, NOT submitted: platform_poll_uring flushes the batch before it waits/drains.
@(private = "file")
uring_arm_recv_ring :: proc(loop: ^Loop, fd: uintptr, token: u64) -> bool {
	sqe, ok := uring.get_sqe(&loop.platform.ring)
	if !ok {
		uring.submit(&loop.platform.ring, 0, nil)
		sqe, ok = uring.get_sqe(&loop.platform.ring)
		if !ok do return false
	}
	sqe^ = {}
	sqe.opcode = .RECV
	sqe.fd = cast(linux.Fd)fd
	sqe.addr = 0
	sqe.flags = {.BUFFER_SELECT}
	sqe.buf_group = URING_BUFRING_BGID
	if loop.platform.multishot_ok {
		// Multishot (2b): RECV_MULTISHOT lives in ioprio (aliased here as sq_send_recv_flags), NOT
		// msg_flags; one submission then yields many CQEs (each F_MORE-set until it ends). The
		// multishot+BUFFER_SELECT API REQUIRES len == 0 (the kernel sizes from the chosen buffer);
		// a non-zero len is rejected with -EINVAL (which would silently disable multishot).
		sqe.sq_send_recv_flags = {.RECV_MULTISHOT}
		sqe.len = 0
	} else {
		// Single-shot: len MUST be the buffer size, not 0 — Linux 5.19 (the oldest kernel with
		// buffer rings, which the gate accepts) takes len literally for a BUFFER_SELECT recv, so
		// len=0 reads 0 bytes = a false EOF; only 6.1+ treats 0 as "use the buffer's size". The
		// kernel reports the actual bytes in cqe.res (<= this cap).
		sqe.len = u32(URING_BUFRING_BUFSIZE)
	}
	sqe.user_data = token
	return true
}

platform_recv_ring_multishot :: proc(loop: ^Loop) -> bool {return loop.platform.multishot_ok}
platform_disable_multishot :: proc(loop: ^Loop) {loop.platform.multishot_ok = false}

// --- MSG_ZEROCOPY send (Slice 3b) — Linux-internal; called only from the Linux-only net.odin ---
//
// Op_Send_Completion fires for a SEND_ZC op. SEND_ZC posts TWO CQEs: a result (`more=true`: bytes sent
// — the pages are pinned, a notification is owed) then a notification (`more=false`: the pages are
// released, the buffer is free). `more` is derived from IORING_CQE_F_MORE in the drain, so the existing
// F_MORE slot-lifetime machinery holds the op as ONE slot / ONE active_io_count from submit to the
// notification — see docs/lava/zerocopy-slice3b-design.md. The buffer is freeable exactly on the first
// `more=false` CQE; `res` (bytes/-errno) is an independent axis the net layer classifies.
Op_Send_Completion :: proc(loop: ^Loop, user_data: rawptr, res: i32, more: bool)

// uring_op_alloc_slot_send allocates an op slot carrying ONLY send_cb (callback/recv_cb stay nil), so
// the drain dispatches a SEND_ZC CQE to send_cb. Mirrors uring_op_alloc_slot_recv.
uring_op_alloc_slot_send :: proc(loop: ^Loop, send_cb: Op_Send_Completion, dispose: Op_Dispose, user_data: rawptr) -> u64 {
	token := uring_op_alloc_slot(loop, nil, dispose, user_data)
	loop.platform.op_slots[uring_op_token_index(token)].send_cb = send_cb
	return token
}

// submit_send_zc stages a SEND_ZC of `buf` and counts the op once (active_io_count, dropped once by the
// drain on the notification). Returns OP_ID_INVALID on no-proactor or an SQ that stayed full. It reuses
// uring_arm_rw (which zeroes the SQE — clearing ioprio/addr2 — sets opcode/addr/len/msg_flags, retries
// once on a full SQ, caps len at URING_MAX_RW, and stages for the batched flush), so the only ZC-specific
// bit is the .SEND_ZC opcode. NOSIGNAL like plain SEND. LOOP-THREAD ONLY.
submit_send_zc :: proc(loop: ^Loop, fd: uintptr, buf: []byte, cb: Op_Send_Completion, dispose: Op_Dispose, user_data: rawptr) -> Op_ID {
	if cb == nil || !loop.platform.proactor_ok do return OP_ID_INVALID
	token := uring_op_alloc_slot_send(loop, cb, dispose, user_data)
	if !uring_arm_rw(loop, .SEND_ZC, fd, buf, token, {.NOSIGNAL}) {
		uring_op_release_slot(loop, uring_op_token_index(token))
		return OP_ID_INVALID
	}
	loop.active_io_count += 1
	return Op_ID(token)
}

// send_zc_ok reports whether large sends may use SEND_ZC (probed at init, cleared by disable_zc on a
// runtime -EINVAL/-EOPNOTSUPP). disable_zc latches it off loop-wide. Both LOOP-THREAD ONLY.
send_zc_ok :: proc(loop: ^Loop) -> bool {return loop.platform.zc_ok}
disable_zc :: proc(loop: ^Loop) {loop.platform.zc_ok = false}
