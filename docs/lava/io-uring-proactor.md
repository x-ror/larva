# io_uring proactor (design)

Status: design / in progress. Tracks the move from the current **readiness** use of io_uring
to a **completion** (proactor) model for sockets, the "win lane" from the runtime strategy:
fewer syscalls per request and — with provided-buffer-rings — the lowest memory-per-idle-
connection of any of Node/Bun/Lava.

## Where we are today (readiness on io_uring)

`pkg/runtime/eventloop/loop_linux.odin` already has an io_uring backend, but it is used as a
drop-in **epoll**: `platform_watch_fd` submits a one-shot `IORING_OP_POLL_ADD` for `.IN`/`.OUT`
and re-arms it on each completion (`drain_uring_completions`). The watcher _callback_ then does
the actual transfer with raw `linux.recv`/`linux.send` (see `net.odin` `conn_read_cb` /
`net_flush`). The two sides differ today: the **read** side is a poll→recv pair (POLL_ADD
completion, then the callback's `recv`), but the **write** side already sends eagerly —
`net_flush` calls `linux.send` immediately and only arms `.Write` after `EAGAIN`. So the
clear per-request syscall win is on the read side (poll+recv → one RECV); the proactor SEND
mainly unifies the model and unlocks later batching/zero-copy, it is not a syscall reduction
on the common (un-backpressured) write path.

Stale-completion safety is handled by a **generation-token watcher table**
(`Uring_Watch_Slot` + `uring_encode_token`): a completion carries `(slot index, generation)`,
not a raw pointer, so a completion that races `unwatch_fd` is dropped without dereferencing a
possibly-freed watcher. **The proactor reuses this exact scheme for op completions.**

Profiling the hello-world server (after the timer + write-coalesce fixes) shows the remaining
cost is dominated by the per-request `recv`/`send` syscalls — the proactor's target.

## Goal (completion mode)

Submit the transfer itself to the kernel and act on its completion:

- **RECV**: submit `IORING_OP_RECV`; the completion delivers the bytes (count in `cqe.res`).
  Eliminates the poll→recv round-trip (one enter instead of two on the read side).
- **SEND**: submit `IORING_OP_SEND`; the completion reports bytes sent. This is model
  unification (and removes the backpressure re-arm dance), not a syscall reduction — the
  write side already sends eagerly today. It must handle **partial completions** (see safety
  rule 2).
- **Multishot RECV + provided-buffer-ring** (the memory win): `IORING_OP_RECV` submitted once
  with the `RECVSEND.MULTISHOT` flag + `IOSQE.BUFFER_SELECT` yields many completions, each
  naming a kernel-picked buffer from a _shared_ ring. (This is the socket-recv multishot —
  distinct from `IORING_OP_READ_MULTISHOT`/`uring.read_multishot`, which is a file/pipe read
  helper and is NOT what we use.) An idle keep-alive connection then holds **no** per-
  connection read buffer — the buffer is consumed only when data actually arrives. This is
  the moat: memory-per-idle-connection drops below Node/Bun.

## ABI status (Odin `core:sys/linux`)

- `IORING_OP.{RECV,SEND}`, the `RECVSEND.MULTISHOT` flag, `IOSQE.BUFFER_SELECT`,
  `REGISTER_PBUF_RING`/`UNREGISTER_PBUF_RING`, `IORING_OFF_PBUF_RING`, and the SQE
  `buf_group`/`buf_index` fields are all present — the kernel ABI is fully exposed. Socket
  multishot receive is `IORING_OP_RECV` + `RECVSEND.MULTISHOT` + `BUFFER_SELECT` (we do NOT
  use the `IORING_OP_READ_MULTISHOT` opcode / `uring.read_multishot`, a separate file-read
  helper).
- The `uring` package has `recv`/`send`/`recvmsg`/`sendmsg` helpers, but `provide_buffers`
  (and `read_multishot`) are **empty stubs** — so the buf-ring register/refill/recycle
  plumbing and the `MULTISHOT|BUFFER_SELECT` RECV submission are ours to write directly
  against the SQE (Slice 2). No missing kernel headers; just unwritten helpers.

## Safety model (the part that must be right)

This is completion-mode kernel I/O against JS-owned and native buffers; the lifetime rules
are the whole ballgame (the M2 crash was a buffer-lifetime bug — see
`http-server-concurrency-crash`).

1. **Op identity = generation token in a SEPARATE domain, never a pointer.** Each op carries
   a token from an op-slot table (same design as `Uring_Watch_Slot`). Op tokens must be
   distinguishable from the existing _poll-watcher_ tokens — both are otherwise `>= 1<<32`,
   and `drain_uring_completions` currently treats every non-sentinel `user_data` as a
   watcher-table index, so an undistinguished op CQE would be dropped as stale or, worse,
   dispatch an unrelated live watcher. Reserve **bit 63 as a domain discriminator**: `0` =
   poll-watcher token (existing scheme), `1` = op token; within each domain the layout is
   `(generation:31) << 32 | (index:32)` (generation capped to 31 bits, still skipping 0 on
   wrap). Sentinels (wakeup=1, cancel=2) keep bit 63 clear and are matched by exact value
   first; `drain_uring_completions` then dispatches by bit 63 (set → op-slot, clear →
   watcher-slot). A completion mapping to a released slot (generation mismatch) is dropped
   without touching freed memory.
2. **A submitted buffer is pinned until that op's terminal CQE.** For RECV the destination
   buffer (per-conn in Slice 1, ring-owned in Slice 2) must outlive the op. For SEND the
   _source_ bytes must outlive submission — SEND owns a per-op buffer in the connection's
   write state. SEND can complete **partially** (`cqe.res < len`, exactly like `send(2)`): on
   a short completion the unsent tail `buf[cqe.res:]` is re-submitted and the storage is
   freed only once the whole buffer has been acknowledged — never on the first completion. No
   JS-owned `Uint8Array` backing is handed to the kernel and released before completion.
3. **Buffer reclaim is tied to the op's terminal CQE, not to teardown.** On `net_close_conn`
   with an in-flight RECV/SEND, `ASYNC_CANCEL` + a generation bump only stops _stale dispatch_
   — the original op still produces a terminal CQE (its own `-ECANCELED`, or a real
   completion that beat the cancel), and the kernel may still write into the RECV buffer / read
   the SEND buffer until then. So the op buffer is freed when its CQE drains, even if the
   connection slot is already stale (the op-slot, not the connection, owns the buffer's life).
   `net_close_conn` defers the `Net_Connection` free as today; the op buffers are reclaimed by
   their completions. On loop destroy, buffers are reclaimed after the ring is drained/closed.
4. **Provided buffers are kernel-owned while armed.** A ring buffer is ours to read only
   between its completion and our recycle of it; we never free ring memory while the ring is
   registered. `-ENOBUFS` (ring momentarily empty) re-arms after refill rather than dropping
   the connection.
5. **Feature-gate + fallback.** Multishot recv and PBUF_RING need a recent kernel (≈5.19+/6.0).
   Probe at init; fall back to Slice-1 single-shot, then to the readiness path, then to epoll.

### What actually gates a slice

The hard gates (a regression fails the change): the `node:http`/`net` smokes, `test-all`,
the full node-compat suite, and the **crash guard** — the server under
`JSC_scribbleFreeCells=1 JSC_collectContinuously=1` (the standing M2-regression check). The
HTTP **benchmark is report-only**: `make bench-http` / `bench/http/run-http-bench.mjs` prints
req/s + mem-per-conn but has no thresholds and never fails. So each slice's perf claim is a
**manual** before/after comparison recorded on its PR; if we want CI to enforce throughput or
memory non-regression we must add a thresholded `--gate` mode to the bench (a follow-up,
mirroring the existing `bench --gate`), not rely on the report.

## Slices (each its own PR; crash-gated, perf measured)

- **Slice 1 — single-shot RECV/SEND completion path for net connections.** Adds an op-slot
  table + `submit_recv`/`submit_send` eventloop primitives and a `Net_Connection` proactor
  mode (per-conn recv buffer). Throughput win (poll+recv → recv); no memory change yet.
  Behind a capability flag, coexisting with the readiness path; fetch and other fds unchanged.
- **Slice 2 — provided-buffer-ring + multishot RECV.** The memory moat: shared buf_ring,
  `IORING_OP_RECV` + `RECVSEND.MULTISHOT` + `BUFFER_SELECT`, completion→buffer-id decode,
  recycle, `-ENOBUFS` re-arm. Target: lowest mem/idle-conn of the three runtimes, measured
  (report-only) by `make bench-http`.
- **Slice 3 — send-side scaling.** SEND batching / `MSG_ZEROCOPY` for large bodies;
  `SO_REUSEPORT` + per-core acceptors for multi-core throughput.

## Non-goals (for now)

Windows/macOS proactor (Linux-first; those stay on their current backends). Replacing the
readiness path for fetch/file fds — the proactor is opt-in per connection-class.

## Slice 1b — wiring net connections onto the proactor (detailed design, rev. 2)

Rev. 2 incorporated the first review (3 Critical + 7 Major + 2 Minor). **Rev. 3** fixes the
second review's findings — second-order bugs the rev.2 fixes themselves introduced (concurrent
recvs, lost allocator, missing per-conn mode, drain reentrancy, shutdown leak).

Connections become **full proactor** (recv op + send op, no readiness watcher) when
`proactor_available` AND the first submit succeeds, else stay on the readiness path. Per-conn.

### Connection state (proactor mode)

- `io_mode: enum { Readiness, Proactor }` (rev.3) — set to `.Proactor` ONLY after a successful
  first `submit_recv`; until then (and on any fallback) the connection is `.Readiness`. close/
  write/shutdown branch on `io_mode`, never on the global `proactor_available` or on op-ID
  liveness (after EOF both op IDs are `OP_ID_INVALID` yet the conn is still a proactor conn).
- `recv_buf: []byte` — a per-conn **kernel landing zone** (NET_PROACTOR_RECV = **16 KiB**, not
  64 KiB). It is REUSED across recvs; its bytes are **copied** into a JSC-owned allocation per
  chunk and never handed to JSC no-copy (Critical 2 — `make_uint8_array` transfers ownership to
  JSC, which may retain/free it; reusing the buffer would overwrite an emitted Buffer and
  double-free). The per-conn allocation is a real idle-memory cost (Major 9) — see "Memory".
- Writes use **two `[dynamic]byte`** buffers (Critical 1 — an Odin `[dynamic]` append can
  realloc/free its backing while io_uring still holds the old pointer): `active_send` +
  `active_send_off: int` is the IMMUTABLE buffer currently submitted to a send op (never
  resized/moved/freed before its CQE; the op submits `active_send[active_send_off:]`);
  `pending_writes` is the mutable queue appends land in. Both stay `[dynamic]byte` — a plain
  `[]byte` would lose the allocator + capacity, so `delete` could free with the wrong allocator/
  len (rev.3). When idle they are **rotated** (swap the two dynamic arrays, then `clear` the new
  `pending_writes`), preserving each backing's allocator/capacity and avoiding per-write churn.
- `recv_op`, `send_op: Op_ID`; `inflight: int` (op refcount); `read_paused`, `read_done: bool`
  (rev.3 — set at EOF, gates re-arm); `want_drain: bool`; `closing`, `silent_close`, `had_error`,
  `end_after_drain`.
- **`maybe_arm_recv(conn)` is the single chokepoint that submits a recv** (rev.3, Critical):
  it submits one ONLY when `recv_op == OP_ID_INVALID && !read_paused && !read_done && !closing`,
  so a recv can never be armed while one is already in flight (two kernel ops writing the same
  `recv_buf` = corruption/UAF), nor after EOF, nor during teardown. Every arm site calls it.

### Read lifecycle

- `net_start_cb`: alloc `recv_buf`; `id := submit_recv(...)`; if `id != OP_ID_INVALID`, set
  `io_mode = .Proactor`, `recv_op = id`, `inflight += 1`; **else free `recv_buf` and fall back to
  the readiness path** (init the watcher) — `io_mode` stays `.Readiness` (Major 4 + rev.3: never
  count a failed submit; the mode is set only on success).
- `on_recv_complete(conn, res)`: clear `recv_op`. If not `closing`:
  - `res > 0` → **copy** `recv_buf[:res]` into a fresh JSC-owned `Uint8Array` (the per-chunk
    copy, Critical 2) and call `on_data`; then `maybe_arm_recv(conn)` (its guards handle a
    handler that closed/paused — no separate check, and crucially it won't double-arm).
  - `res == 0` → set **`read_done = true`** (rev.3), `on_end` (true half-close; `maybe_arm_recv`
    will now never re-arm).
  - `res < 0`: `-ECANCELED` is teardown (no error — handled by `op_finished`); **`-EINTR`/
    `-EAGAIN` are transient → `maybe_arm_recv`** to re-submit a **fresh** recv (NOT a synchronous
    user-space spin — a new io_uring submit, after which the kernel arms its own internal poll
    past the initial `EAGAIN`); any other negative → `on_error` + `net_close_conn`.
- **End every completion with `op_finished(conn)`** = `inflight -= 1`; `maybe_free(conn)` — the
  LAST action, after all JS calls and all `conn.*` access (Critical 3). A synchronous
  `socket.destroy()` inside `on_data` sets `closing` and runs `maybe_free` while this op is still
  counted (`inflight >= 1` → no free); the conn is freed only when this completion's trailing
  decrement reaches 0. The inflight count IS the callback-held reference.

### Write lifecycle

- `net_write_cb` (proactor): append to `pending_writes`. If `send_op == OP_ID_INVALID`, **rotate**
  (`active_send` ⇄ `pending_writes`, `clear(&pending_writes)`, rev.3 — preserves allocator/cap),
  `active_send_off = 0`, submit `active_send[:]`; count only a valid id (on failure →
  error-and-close). Returns backpressure per the high-water rule — NOT "a send is in flight" (Major 8).
- `on_send_complete(conn, res)`: clear `send_op`. If not `closing`:
  - `res > 0` → `active_send_off += res`. If `< len(active_send)` re-submit `active_send[off:]`
    (partial send; same backing, never moved — Critical 1). Else `active_send` is fully sent:
    if `pending_writes` is non-empty, rotate+submit; else drained → `clear(&active_send)`, then run
    the **drain transition** (below) and, re-checking state afterwards, `maybe_arm_recv(conn)` and
    (if `end_after_drain`) close.
  - `res == 0` on a non-empty submission → no-progress → treat as error + close (Minor 11).
  - `res < 0`: `-ECANCELED` is teardown; **`-EINTR`/`-EAGAIN` → re-submit `active_send[off:]`**
    (a fresh op, not a spin); any other negative → `on_error` + close.
- Trailing `op_finished(conn)` as for reads.

### Backpressure & drain (Major 8; reentrancy-safe per rev.3)

Every io_uring send is asynchronous, so "a send is in flight" is NOT backpressure. Backpressure
is a **queued-byte high-water mark** (`writableHighWaterMark`, default 16 KiB): `net_write_cb`
returns `false` only when buffered bytes (`pending_writes` + the unsent tail of `active_send`)
≥ the mark, and sets `want_drain`. When the buffer empties, the native layer fires a **`drain`**
transition the JS `net.Socket` re-emits as `'drain'` (currently `net.js` emits no `drain`, so a
caller honoring `false` would wait forever; Slice 1b adds the native→JS path).
The **drain transition** is reentrancy-safe (rev.3 — the `'drain'` listener may write ≥ HWM
again or `destroy()`): (1) **clear `want_drain` before** emitting; (2) emit `'drain'`; (3) after
it returns, if `closing` stop, else **recompute** buffered bytes → `read_paused`, and only then
`maybe_arm_recv(conn)`. So a recv is never armed against fresh backpressure or after a reentrant
close, and no stale `want_drain` triggers a spurious future `'drain'`. Reads pause (`read_paused`,
not re-armed) only while buffered ≥ the mark, bounding memory against a slow reader.

### Teardown

- `net_close_conn(conn, had_error)` (proactor): **`conn.had_error |= had_error` FIRST** (rev.3 —
  sticky, before the idempotency guard, so a fatal completion's `net_close_conn(true)` after a
  reentrant `destroy()`→`net_close_conn(false)` is not lost to `false`); return if already
  `closing`; else set `closing`; **`shutdown(fd, SHUT_RDWR)`** to reliably wake a recv/send pending on an idle peer
  (Major 5 — `cancel_op` is best-effort: it silently no-ops if no SQE is free, so it cannot be
  relied on to produce `-ECANCELED`; the shutdown forces the pending op to complete); then
  `cancel_op(recv_op)`/`cancel_op(send_op)` for promptness; drop from the registry; **call
  `maybe_free(conn)`** (Major 6 — a conn at `inflight == 0`, e.g. after a peer-EOF half-close or
  a failed first submit, has no CQE/disposer to trigger reclaim otherwise). Do NOT close the fd,
  fire `on_close`, unprotect, or free here.
- `maybe_free(conn)`: returns unless `closing && inflight == 0`. Then finalize **in this order**
  (Major 7): `close(fd)` FIRST; if not `silent_close`, fire `on_close(had_error)` and unprotect
  the handlers (so the close event reports only after the socket is truly closed); `delete`
  `recv_buf`/`active_send`/`pending_writes`; `free(conn)`. Single free site; reached exactly once
  (at `inflight == 0`, after which no completion can call it again).

### Loop destruction with live proactor connections

`net_shutdown_active` (pre-destroy, no JS) iterates a **snapshot** of the registry (so freeing
mid-iteration can't invalidate it) and for each proactor conn: marks `closing` + `silent_close`,
unprotects handlers, `shutdown(fd, SHUT_RDWR)`, then **calls `maybe_free(conn)`** (rev.3, Major):
a conn already at `inflight == 0` (e.g. after a peer EOF — no op left, hence no disposer) is
finalized immediately here, fixing a leak; a conn with live ops is a no-op now and is freed by
its op's `Op_Dispose` during `eventloop.destroy` (ring close cancels+drains → `on_op_dispose`
does `inflight -= 1` + `maybe_free`, silent). `maybe_free` removes the conn from the registry as
it frees, so by the time `eventloop.destroy` runs only live-op conns remain and no disposer ever
dereferences a freed registry entry. Disposers decrement immediately (no JS reentrancy at
destroy). Exactly one free per conn.

### Memory (Major 9)

A per-conn 16 KiB `recv_buf` is ~160 MiB at 10k connections — a real regression vs today's
transient stack buffer (~0 per idle conn). Slice 1b therefore trades idle-conn memory for the
read-side syscall win, and **Slice 2's provided-buffer ring is what reclaims it** (no per-conn
read buffer → the actual memory moat). The 1b `bench-http` mem/conn is expected to rise; the
moat is a Slice-2 result. (16 KiB is a measured starting point, tunable.)

### Safety invariants (verification checklist)

1. `recv_buf`, `active_send`, `pending_writes` outlive every op referencing them (freed only in
   `maybe_free` at `inflight == 0`); `active_send` is never resized/moved while submitted.
2. `recv_buf` is never handed to JSC no-copy — only per-chunk copies are.
3. The conn outlives its ops and its in-flight completion (decrement is the completion's last
   act); no completion dereferences a freed conn.
4. Exactly one free per conn: `maybe_free` finalizes only on the `inflight` 1→0 transition while
   `closing` (NOT idempotent — a call after `free(conn)` would itself be a UAF; the guarantee is
   single-reach, since `inflight == 0` means no op remains to call it again).
5. JS handlers fire only while `!closing`, except `on_close`, which fires once at finalization
   after the fd is closed (and is suppressed on silent shutdown).
6. `-ECANCELED` is teardown (never a socket error), and transient `-EINTR`/`-EAGAIN`
   completions are retried (re-submit), not surfaced as fatal — only other negatives close the
   connection.
7. Failed submits are not counted (no inflated refcount / stalled conn); they fall back or close.
8. Teardown always reaches `maybe_free`, and a pending op on an idle peer is woken by
   `shutdown(SHUT_RDWR)` so it cannot pin the conn/loop forever.
9. Backpressure is high-water-based with a real `drain` event; reads pause only above the mark.
10. At most ONE recv is ever in flight per conn — `maybe_arm_recv` (the single arm site) never
    submits while `recv_op` is live, after `read_done` (EOF), while `read_paused`, or while
    `closing`; two recvs into the one `recv_buf` is impossible.
11. The connection's path is chosen by the explicit `io_mode` (set only after a successful first
    submit), never inferred from `proactor_available` or op-ID liveness (both IDs are invalid
    after EOF on a live proactor conn).
12. `active_send`/`pending_writes` stay `[dynamic]byte` and are rotated (not reallocated) so their
    allocator/capacity are preserved across sends; `had_error` is sticky; the `drain` transition
    clears `want_drain` before emitting and re-checks `closing`/buffered state after.
13. `net_shutdown_active` finalizes zero-inflight conns itself (no orphaned leak) and iterates a
    registry snapshot; no disposer dereferences a freed registry entry.

### Gates / tests (Major 10)

A test-only **require-proactor** mode asserts a connection actually used the proactor (CI must
not silently exercise only readiness), plus a **forced-readiness** run for the fallback. Cases:
retained JS data buffers (no overwrite/double-free), realloc of `pending_writes` during an active
send, synchronous `socket.destroy()` from each of on_data/on_end/on_error, partial sends, a
failed submission, close after peer EOF (zero-inflight reclaim), loop destruction with 0/1/2 ops
in flight, cancel races, drain semantics, and bounded memory with a slow peer. **Rev.3 reentrancy
cases:** a `write` ≥ HWM while a recv is already in flight, with the send completing first (must
NOT spawn a second recv into `recv_buf`); EOF arriving while `read_paused` (must not re-arm); a
`'drain'` listener that writes ≥ HWM again (read must not resume against fresh backpressure); a
`'drain'` listener that `destroy()`s (no recv submitted after close); a fatal completion whose
`on_error` listener calls `destroy()` first, asserting `'close'` reports `hadError === true`; and
`net_shutdown_active` over a zero-inflight conn (not just a normal close). Plus `bench-http`
(throughput up, mem/conn noted as regressed pending Slice 2), the `scribbleFreeCells +
collectContinuously` crash guard, net+http smokes on the proactor path, and an adversarial
multi-lens review.

### Platform (Minor 12)

The fallback is **Linux** epoll/io_uring readiness. `node:net` is Linux-only; macOS/Windows
have empty bindings (`net_other.odin`) and still report `node:net` unavailable — proactor vs
readiness is a Linux-internal choice. Non-Linux compile checks are retained to catch shared-type
regressions.

## Slice 2 — provided-buffer ring + multishot RECV (detailed design, rev. 4)

The memory moat. Slice 1b gave every proactor connection its own 16 KiB `recv_buf` (~160 MiB at
10k idle keep-alives). Slice 2 draws reads from a **shared** kernel buffer ring, so an idle
connection holds **no** read buffer. Rev. 4 incorporates three review rounds (self-review: 6C/8M/4m;
two external: 6 + 3C/7M). The hard-won shape:

- **Slice 2a — provided-buffer ring, SINGLE-SHOT `BUFFER_SELECT` recv.** The moat. One CQE per op
  (like 1b), so op-slot / `active_io_count` / net `inflight` accounting is UNCHANGED. Ship first.
- **Slice 2b — multishot recv.** One submission, many CQEs — the remaining submit cut. Needs
  `F_MORE` threaded through three layers AND a backpressure-disarm; higher risk; separate later PR.
  Several 2b concerns below (overshoot, capability probe) are settled here but verified at 2b time.

### ABI (define ourselves)

`core:sys/linux` exposes opcodes/flags/CQE bits + `io_uring_register`, NOT these
structs — as with `Uring_Probe` in 1a.

- `Uring_Buf_Reg` (40 B, `#assert(size_of == 40)`): `ring_addr: u64, ring_entries: u32, bgid: u16,
flags: u16, resv: [3]u64` in EXACTLY this order. **Zero-initialize**: `flags = 0` = the
  user-allocated-ring path (we pass `ring_addr`; NOT `IOU_PBUF_RING_MMAP`); `resv` all-zero (the
  kernel `-EINVAL`s unknown flags / non-zero resv — the `Uring_Probe` zeroing trap). Any non-`.NONE`
  errno → fall back (no crash).
- `Uring_Buf` (16 B, `#assert(size_of == 16)`): `addr: u64, len: u32, bid: u16, resv: u16`.
- Ring = `ring_entries` × `Uring_Buf`; the kernel **overlays the producer `tail` (u16) on
  `bufs[0]`'s `resv` (bytes 14..15)**. `ring_entries` power of two; `mask = ring_entries - 1`.
- SQE `buf_group`/`buf_index` are a `#raw_union`; set `buf_group` only.

### Buffer-id decode

`cqe.flags` is `bit_set[…; u32]`, not an int. `f := transmute(u32)cqe.flags; has_buf := .BUFFER in
cqe.flags; bid := u16(f >> 16)`. A `res > 0` CQE WITHOUT `BUFFER` selected no buffer → error (don't
read `pool[bid]`). Always validate `bid < N`.

### Pool + ring setup (loop init, gated)

- Pool: `N` × `M` (start `256 × 16 KiB` = 4 MiB, **independent of conn count**; tunable). One
  contiguous alloc; `bid` → `pool[bid*M : bid*M+M]`.
- Ring: **page-aligned** (`mmap`/`posix_memalign(PAGE_SIZE, N*16)`) — mandatory; assert
  `ring_addr % PAGE_SIZE == 0`.
- `buf_ring_add(idx, addr, len, bid)` writes ONLY 14 bytes (`addr`/`len`/`bid`), never `resv`
  (bytes 14..15 = the overlaid `tail`). Seed via `buf_ring_add` for all `N`, then publish `tail = N`
  with a **release** store; recycle uses the same helper — a full 16-byte struct store never occurs.
- **Require `IORING_FEAT_NODROP`** for ring mode (else fall back): on a NODROP kernel a CQ that
  fills is DEFERRED (kernel overflow list), not dropped — so a recv CQE (and its provided buffer) is
  never silently lost. Size CQ generously for the full burst (recv + send + cancel + wakeup + poll),
  not just `N`; treat CQSIZE as a perf safeguard, and monitor the CQ-overflow counter — CQ depth ≥ N
  alone is NOT a leak proof (it ignores the other CQE sources).

### Recv submission

- 2a (single-shot): `IORING_OP_RECV`, `addr = 0`, `len = 0`, `buf_group = BGID`,
  `IOSQE.BUFFER_SELECT`, token in `user_data`. A NEW arm path, not `uring_arm_rw`.
- 2b (multishot): same SQE PLUS `sqe.ioprio |= IORING_RECV_MULTISHOT` — the recv-multishot flag is
  an **`ioprio`** flag, NOT `msg_flags` (which is recv(2) `MSG_*`). The Odin `RECVSEND` set maps to
  `ioprio`.

### Completion handling (2a) — ORDER IS LOAD-BEARING

Per CQE, in this exact order:

1. Decode `has_buf`/`bid`/`res`; validate `bid < N`.
2. If `has_buf` and `res > 0`: **copy `pool[bid][:res]` into a JSC-owned `Uint8Array` NOW**, while
   we still own the buffer (never no-copy). If `closing`, skip the copy.
3. If `has_buf`: **recycle `bid`** (`buf_ring_add` + release-store `tail+1`) — UNCONDITIONALLY,
   even when `closing`/error/EOF. Recycle is a pure pool op (no JS reentrancy). Then run the wake
   scheduler (below).
   > Critical ordering: copy BEFORE recycle. Once `tail+1` is published the kernel may immediately
   > overwrite `pool[bid]`; recycling first would corrupt the copy and could disclose another
   > connection's bytes. And recycle must NOT be gated by `closing`, or a data CQE racing
   > `net_close_conn` leaks its buffer → the ring drains → every conn wedges on `-ENOBUFS`.
4. If `!conn.closing`: `res > 0` → `on_data(the copy)`; `res == 0` → EOF; `res == -ENOBUFS` → park
   (below); other `res < 0` (not `-ECANCELED`) → `on_error` + close. Re-arm a fresh single-shot
   recv unless paused/EOF/closing. One CQE per op → slot/`active_io_count`/`inflight` release as in
   1b (no accounting change in 2a).

### `-ENOBUFS` refill scheduler — event-driven, lifetime-safe, fair (2a)

On `-ENOBUFS` no buffer was selected; a ring conn holds none, so it can't self-recycle — the ring
refills only when OTHER conns' data CQEs recycle. Design:

- Track `available` (buffers currently in the ring): `++` on recycle, `--` when the kernel selects
  one (a `has_buf` CQE).
- **Park** a starved conn on a list with an explicit `recv_starved` flag (**no duplicate insertion**).
  Before parking, **re-check `available > 0` and re-arm immediately instead of parking** — this
  closes the lost-wakeup where a data CQE recycled (empty list → no wake) just before the `-ENOBUFS`
  CQE is processed.
- **Lifetime:** a parked conn is referenced by the list. `net_close_conn`/`net_shutdown_active`
  MUST remove it from the list (clear `recv_starved`) before `net_maybe_free`, or a later recycle
  walks a freed conn (UAF). Parking keeps the conn reachable; the loop stays alive because whoever
  holds the buffers has live ops.
- **Fair, budgeted wake:** on recycle, wake at most the **buffer credit** that became available
  (one recycle → wake one parked conn), not the whole list — else with K readable conns and N≪K,
  one recycle re-arms all K, most re-`-ENOBUFS`, approaching quadratic CQE work. Round-robin the
  list. Run the scheduler after BOTH a recycle and a park.
- Size `N ≥ expected concurrent active conns`; undersizing degrades to latency (parking), not a
  spin. The stress test asserts **bounded CPU** at large-K/small-N, plus buffer conservation.

### Multishot (2b) — `F_MORE` lifetime + backpressure + capability

- **Three-layer `F_MORE`:** the op/slot, `active_io_count`, net `recv_op`, net `inflight` are
  one-per-op and release/clear **exactly once on the `F_MORE`-clear (terminal) CQE**, never per
  intermediate CQE. Requires: (1) `Op_Completion` carries `more`+`bid`+`has_buf`; (2) the drain
  op-branch releases slot + drops `active_io_count` only when `!more`; (3) net `on_recv_complete`
  clears `recv_op`/re-arms/`net_op_finished` only on the terminal CQE. A terminal CQE may STILL
  carry a buffer → copy(if res>0)+recycle it regardless. `-ENOBUFS`/`-ECANCELED` are terminal.
- **Backpressure is a BOUNDED OVERSHOOT, not a hard stop.** At `NET_WRITE_HWM`, `cancel_op` the
  multishot to disarm + re-submit from the drain transition. But CQEs already posted (or racing the
  cancel) must still be drained and may carry data → some `on_data` fire after HWM. This is a
  **bounded** overshoot (the in-flight CQEs at cancel time), documented as such — cancellation is
  not a strict per-byte boundary. (2a has no overshoot: it simply doesn't re-arm while paused.)
- **Capability probe:** multishot is an `ioprio` flag, not a separately-probeable opcode — an
  unsupported kernel ACCEPTS the SQE and returns `-EINVAL` via the CQE, after the conn committed to
  ring mode. So **actively probe at startup** (submit a multishot recv on an `AF_UNIX` socketpair;
  if its first CQE is `-EINVAL`, multishot is unsupported) and gate 2b on it. Defensively, treat a
  terminal `-EINVAL` on a multishot recv as a capability failure: disable 2b globally and re-arm
  that conn via 2a (single-shot ring) rather than closing it.

### Integration with 1b — `net_is_proactor()` (do NOT add a mode that bypasses cleanup)

Adding `.ProactorRing` to the `io_mode` enum is a HAZARD: `net_write_cb`, `net_end_cb`,
`net_close_conn`, and `net_shutdown_active` currently test `io_mode == .Proactor` by exact equality,
so a new value would silently take the READINESS branch and free a conn while a kernel recv is armed
(UAF). Introduce `net_is_proactor(conn) :: conn.io_mode == .Proactor || conn.io_mode == .ProactorRing`
and replace every `== .Proactor` send/teardown check with it (the send path + teardown are shared);
the RECV path branches separately on the exact mode (per-conn buffer vs ring). Every
`.ProactorRing` write/end/close/shutdown branch is tested.

- Mode decided at **first submit only** (like 1b): a failed first ring recv → allocate a per-conn
  `recv_buf` and fall back to `.Proactor`, then `.Readiness` — never strand a ring conn with no
  buffer. A mid-life SQ-full re-arm uses submit-and-retry; only error+close if that also fails.
- `.ProactorRing` drops `recv_buf`; send (active_send/pending_writes) + teardown unchanged from 1b
  (the recv op counts as one `inflight` until its terminal CQE; `cancel_op` + `shutdown(SHUT_RDWR)`
  end it with a terminal CQE), plus the starved-list removal above.

### Teardown (one coherent model)

At loop destroy, the existing path closes the io_uring fd (`uring.destroy`), which **implicitly
deregisters** the buf_ring and tears down in-flight ops (their `Op_Dispose` runs). So: dispose op
slots → close the ring fd (implicit `UNREGISTER_PBUF_RING`) → THEN `munmap` the ring + free the
pool (after the fd is closed the kernel can no longer touch them). Do NOT attempt an explicit
`UNREGISTER_PBUF_RING` after the fd is closed (impossible) or before draining live recvs.

### Safety invariants (verification checklist)

1. Per CQE the order is copy(if delivering, while owned) → recycle(unconditional) → JS; a buffer is
   never read after its `tail+1` is published, and never handed to JSC no-copy.
2. Every CQE carrying a buffer recycles its `bid` exactly once regardless of conn state; `bid < N`;
   a `res>0` CQE without `BUFFER` is an error, not a `pool[bid]` read.
3. `tail` advances via a release store from the single loop thread; `buf_ring_add` writes 14 bytes,
   never the overlaid tail (incl. `idx == 0`).
4. The starved list: no duplicate insertion; park re-checks `available` first (no lost wakeup);
   `net_close_conn`/shutdown remove a conn before freeing it (no UAF); wake is buffer-credit-budgeted
   and round-robin (no completion storm); `-ENOBUFS` never drops a conn and never spins.
5. Ring/pool freed only AFTER the ring fd is closed (implicit dereg); never while registered.
6. (2b) op slot / `active_io_count` / `recv_op` / `inflight` release exactly once on the terminal
   CQE; a terminal CQE still recycles+delivers its buffer; backpressure disarms with a documented
   bounded overshoot; the multishot ioprio flag + the startup capability probe + `-EINVAL` fallback.
7. `.ProactorRing` takes proactor (not readiness) cleanup everywhere via `net_is_proactor`; all 1b
   connection invariants still hold; 2a changes only the buffer source.
8. Ring mode requires `IORING_FEAT_NODROP`; CQ overflow is deferred, not dropped (no buffer loss).

### Gating / tests

Probe `REGISTER_PBUF_RING` (≈5.19) + `IORING_FEAT_NODROP` + (2b) the active multishot socketpair
probe; fall back 2b→2a→1b→readiness. `#assert` struct sizes. Deterministic tests: N=1 rapid reuse
with byte-integrity; close/destroy while parked on the starved list; data-CQE-before-`-ENOBUFS`
lost-wakeup ordering; large-K/tiny-N bounded-CPU + buffer-conservation (`seeded == in-ring +
in-flight + held`); unsupported-multishot fallback (2b→2a); CQEs queued before a backpressure
cancel completes; destroy with live ring ops + register-failure cleanup; every `.ProactorRing`
write/end/close/shutdown branch; the `LAVA_NET_FORCE_READINESS` dual-mode smokes extended to force
each read path; the crash guard; and `bench-http` **mem/idle-conn** (the moat — idle memory to ~Bun
levels). An adversarial multi-lens review as for 1a/1b.
