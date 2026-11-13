# MSG_ZEROCOPY for large writes (Slice 3b) — design (review before impl)

Status: **IMPLEMENTED** — commit 1 (eventloop: `.SEND_ZC` probe → `zc_ok`, `send_cb` dispatch,
`submit_send_zc`), commit 2 (net: the two-axis state machine + `net_proactor_submit` choke point +
fallbacks + the `want_drain`-into-`net_maybe_arm_recv` move), commit 3 (tests + the `test-zerocopy-smoke`
CI gate). Threshold shipped at 32 KiB. Verified: the SEND_ZC cell matrix by direct invocation, large-body
byte-integrity (256 KiB, sha256), smokes both modes, crash guard, darwin/windows cross-check. The
real-NIC throughput bench (loopback always copies, so it can't show the ZC win) remains a manual
follow-up (§9 Q5). Design history below.

Status (design): **rev.5** — three internal adversarial rounds (rev.1: 3 crit/12 high; rev.2: 0 crit/7 high;
rev.3 round-3: 0 crit/0 high) + two Codex review rounds (rev.4: 5 findings — the two-axis ABI; rev.5: 4
Major / 5 Minor — all real, folded in). The two-axis model (`F_MORE` = pinned? vs `res` = bytes/errno,
independent) is the robust core. rev.5 changes: `zc_ok` set by an **init-time `.SEND_ZC` opcode probe**
(`SEND_ZC` IS probeable, unlike 2b's ioprio flag — kills the storm + the send-before-recv hole, M1); §1
softened so the **copied-send CQE count is not asserted** (version-dependent — the state machine
absorbs both shapes, M2); §10 tests the state machine by **direct invocation**, not an unobservable
loopback two-CQE sequence (M3); ZC eventloop surface kept **Linux-internal** (no stubs, M4); threshold
default raised to 32–64 KiB (m7). The 2b `F_MORE` slot-lifetime reuse + template-mirrored ordering are
unchanged. Ready for review-before-impl.

**Scope:** the proactor send path. Sends ≥ a threshold go via `IORING_OP_SEND_ZC` (kernel transmits
from user pages instead of copying); smaller sends keep the plain copy-`SEND`. Headline hello-world
bench unaffected. Linux/io_uring only. Final piece of the proactor epic.

---

## 1. The `SEND_ZC` two-CQE ABI (source: kernel io_uring `io_uring.h`, NOT the Odin bindings)

The Odin bindings provide only the `SEND_ZC`/`SENDMSG_ZC` opcode enum values and
`IO_Uring_CQE_Flags_Bits.MORE`(bit1)/`.NOTIF`(bit3); they model neither the SQE layout nor the two-CQE
shape — that is the kernel ABI. The SQE is a `#raw_union`, so writing `opcode=.SEND_ZC`, `addr`, `len`,
`msg_flags={.NOSIGNAL}` hits the right byte offsets despite the `raw_union_tag`s not listing `.SEND_ZC`
(tag = fmt metadata only). Plain user buffer; `FIXED_BUF` out of scope.

Kernel guarantees (per the `io_uring_enter(2)` `IORING_OP_SEND_ZC` text — re-assert at review against
the running kernel; `SEND_ZC` is ≥ 6.0). **The cardinal rule: check `F_MORE`, NOT `res`.** `res` (the
byte count or `-errno`) and `F_MORE` (whether the pages are pinned and a notification is owed) are
**independent** — every `(F_MORE, sign-of-res)` combination occurs:

1. **Pinned (`F_MORE` set on the result):** the pages are held; **exactly one** notification CQE
   (`F_NOTIF` set, `F_MORE` clear) follows when they release. This happens whether the result `res` is
   **≥ 0** (bytes sent, possibly partial) **OR `< 0`** — _an errored request may still have pinned and
   thus still notifies_ (man page: "even failed requests may generate a notification"). The notif is
   strictly **ordered after** the result for the same `user_data`. `F_MORE`+`F_NOTIF` never co-occur.
2. **Best-effort zerocopy — a send the kernel COPIES is a normal success, not an error.** The kernel
   declines zerocopy for small/unaligned segments, loopback, non-SG NICs (§9 Q5). **Whether a copied
   send clears `F_MORE` (a single `res > 0` CQE, no notif) OR still posts a result+notif pair (the copy
   observable only as `IORING_NOTIF_USAGE_ZC_COPIED` in the notif `res` under `REPORT_USAGE`) is
   KERNEL-VERSION-DEPENDENT** — newer kernels added the `F_MORE`-clear-on-copy optimization; earlier 6.x
   notify regardless. **The §3 state machine is robust to both**: a copy as `(!saw, res>0)` and a copy as
   `(saw=true after a res≥0 result, notif res ignored)` both converge on "advance `off`, drain". So we
   never assert a CQE _count_ for the copied path (§10) — only the outcome. Pre-transmission failures
   (`-EINVAL`, `-EOPNOTSUPP`, `-EBADF`, `-ENOTSOCK`, `-EAGAIN`/`-EINTR` zero-byte, optmem
   `-ENOBUFS`/`-ENOMEM`) are single `F_MORE`-clear CQEs (`res < 0`, never pinned); `res == 0` is a
   zero-byte stall.
3. A **cancel** past the result returns `-ENOENT`/`-EALREADY` and cannot un-pin handed-off pages — the
   notification still fires. A cancel that **beats** transmission yields a single `-ECANCELED`
   (`F_MORE` clear, no notif).

**Load-bearing consequences:**

- **Buffer lifetime** is driven by `F_MORE` ALONE: the buffer is freeable **exactly on the first
  `F_MORE`-clear CQE** for the op (the notification, or a single non-pinned CQE), never on a
  `F_MORE`-set result. `F_NOTIF` is informational; the slot lifetime is identical to multishot RECV.
- **Result classification** is `res`-driven and is the _separate_ axis: a `F_MORE`-set result records
  bytes (`res ≥ 0`) or a sticky error (`res < 0`) to act on at the terminal; a `F_MORE`-clear single
  CQE is a success (`res > 0` → advance), a stall (`res == 0`), or an error (`res < 0`). §3 is the
  full two-axis state machine.

---

## 2. Eventloop layer — a ZC-send completion + a distinct slot kind

Slot lifetime is **reused unchanged** from 2b: `drain_uring_completions` releases the slot + decrements
`active_io_count` only on the `F_MORE`-clear CQE, leaving both on `F_MORE`-set. So a `SEND_ZC` op is
**one** slot / **one** `active_io_count` / **one** `dispose` from submit to its terminal — no new
release path, no underflow, no leak.

- **`Op_Send_Completion :: proc(loop, user_data, res: i32, more: bool)`** — new completion type.
- **Slot callback representation — prefer a tagged union.** Adding `send_cb` makes three parallel
  nullable callback fields (`callback`/`recv_cb`/`send_cb`), only one ever set — fragile (needs the
  alloc-time "exactly one set" assert, the `recv→send→callback` nil-cascade, AND a "release must null
  `send_cb`" footgun). Represent the slot's callback as an Odin
  `union{Op_Completion, Op_Recv_Completion, Op_Send_Completion}` instead: mutual exclusion becomes
  _structural_, dispatch becomes a `switch` on the variant, and release just clears the union — no
  assert, no cascade, no per-field null footgun. (Small refactor of the existing 2a/2b slot; recommended
  while adding the third kind. If kept as separate fields, dispatch order is `recv_cb → send_cb →
callback`, `uring_op_release_slot` MUST also null `send_cb`, and a debug assert enforces one-set — but
  the union removes all three obligations.)
- A ZC CQE never reaches the `recv_cb` path (its `bid := transmute(u32)cqe.flags>>16` BUFFER-select
  read), since a send slot's variant is `Op_Send_Completion`, not recv.
- **`platform_submit_send_zc` reuses `uring_arm_rw`** — do NOT hand-roll the SQE. `uring_arm_rw` already
  does `sqe^ = {}` (zeroing ioprio/addr2/buf_index — `ioprio=0` falls out, no `REPORT_USAGE`/`FIXED_BUF`),
  the opcode+flags params, the SQ-full retry, the `URING_MAX_RW` len cap, and 1b staging. So it is just:
  `tok := uring_op_alloc_slot_send(...)`, `uring_arm_rw(loop, .SEND_ZC, fd, buf, tok, {.NOSIGNAL})`,
  release-on-fail — identical in shape to `platform_submit_send`. Avoids a second SQE-builder drifting.
- **Update the stale comment** at `loop_linux.odin:473` ("Non-recv ops never set F_MORE, so they always
  take this terminal path") — `SEND_ZC` is now exactly such an op. The code is already correct (it tests
  `.MORE in cqe.flags` generically); only the comment misleads.

---

## 3. Net layer — the ZC send completion (ordered pseudocode, mirrors the template)

`net_send_zc_complete` is the `send_cb`. It MUST be structured like `net_recv_ring_complete` /
`on_send_complete`: **early-return on the intermediate; on the terminal, clear the op id first, wrap the
buffer decision in `if !conn.closing`, and call `net_op_finished` LAST and unconditionally.** Invariants:

- **INV-1 (result CQE, `more=true` — pinned, notif owed) RECORDS ONLY; acts at the terminal.** It does
  exactly one of: `off += res` (if `res ≥ 0`) **or** record a sticky `conn.zc_err = res` (if `res < 0`
  — an errored-but-pinned send still notifies, so the error must be carried, NOT dropped). It must NOT
  `net_op_finished`, clear `send_op`, touch/rotate/clear/free `active_send`, re-submit, emit `'drain'`,
  re-arm, cancel, or close. (Stricter than recv's `more=true`, which pauses multishot.)
- **INV-2 — on the terminal (`more=false`): `send_op = OP_ID_INVALID` FIRST**, then the buffer decision
  **only `if !conn.closing`**, then **`net_op_finished` LAST** (unconditional — the sole terminal act
  that runs even while closing). This exact order is what `on_send_complete` (net.odin:689→712) and
  `net_recv_ring_complete` (net.odin:448→516) use; `net_op_finished` last keeps `inflight ≥ 1` across
  any re-submit so `net_maybe_free` can't transiently free mid-window (the C1 guard).
- **INV-3 — two `res` sources, never confused.** When `saw_result` (a `more=true` result preceded this
  terminal), the terminal IGNORES its own `res` (the notif's `res` is 0/usage) and acts on the recorded
  `off`/`zc_err`. When NOT `saw_result` (a single `F_MORE`-clear CQE — a copied success, stall, or
  pre-transmission error), the terminal's `res` IS the real result and is classified.
- **INV-4 — `off` advances only on a non-negative result** (a `more=true` result `res ≥ 0`, or a
  single-CQE `res > 0`). Any negative `res` leaves `off` untouched, so a fallback/retry re-sends exactly
  `active_send[off:]` (no double-send/skip). `off` monotonic, ≤ `len(active_send)`.

`saw_result` and `zc_err` (per-conn — safe because one send op per conn, §4) are **reset in the single
submit choke point `net_proactor_submit`** (§4), so EVERY submission (initial, tail, rotation, fallback)
clears them; never stale-carried.

```text
net_send_zc_complete(loop, conn, res, more):
  # ---- INTERMEDIATE: result CQE, pages PINNED, notif owed. INV-1: RECORD ONLY, then return. ----
  if more:
    conn.saw_result = true
    if res >= 0: conn.active_send_off += int(res)   # bytes sent (possibly partial)
    else:        conn.zc_err = res                  # errored-but-pinned: carry it; the notif surfaces it
    return

  # ---- TERMINAL: more=false, buffer FREE (F_MORE clear, §1). Mirror the template. ----
  saw := conn.saw_result
  conn.send_op = OP_ID_INVALID                       # FIRST — a re-entrant write()/kick sees a clear gate
  if !conn.closing:
    # Resolve the effective error and advance off for a single-CQE (non-pinned) success (INV-3/INV-4).
    err: i32 = 0
    if saw:           err = conn.zc_err              # 0 if the result succeeded; <0 if it errored (ignore THIS cqe's res)
    elif res > 0:     conn.active_send_off += int(res)   # single-CQE COPIED success — kernel didn't ZC; advance like plain
    elif res < 0:     err = res                      # single-CQE pre-transmission error
    # (saw=false, res==0 falls through with err=0 -> the zero-byte stall close below)

    if err < 0:                                      # off untouched on any error (INV-4) -> re-sends the exact tail
      switch err:
        -EINVAL, -EOPNOTSUPP (and conn.send_was_zc): disable_zc(loop); net_proactor_submit(conn, force_plain=true)  # protocol/capability -> plain
        -ENOBUFS, -ENOMEM:                            net_proactor_submit(conn, force_plain=true)                   # optmem -> copy-send, transient (NOT fatal)
        -EINTR, -EAGAIN:                              net_proactor_submit(conn)                                     # transient retry
        -ECANCELED:                                   pass                                                          # benign
        else:                                         net_emit_error(conn); net_close_conn(conn, true)              # fatal (EPIPE, …)
    elif !saw and res == 0:                          net_emit_error(conn); net_close_conn(conn, true)               # zero-byte stall (plain-path parity)
    elif conn.active_send_off < len(conn.active_send): net_proactor_submit(conn)                                   # unsent tail (choke point re-picks ZC vs plain)
    elif len(conn.pending_writes) > 0:                net_proactor_kick_send(conn)                                  # rotate + submit via the choke point
    else:                                            clear(conn.active_send); conn.active_send_off = 0
                                                     net_proactor_on_drained(conn)                                  # 'drain' + re-arm + end_after_drain close
  conn.zc_err = 0; conn.saw_result = false           # load-bearing ONLY on the closing path (no re-submit runs to reset via the choke point); otherwise redundant with net_proactor_submit's reset
  net_op_finished(conn)                              # LAST, unconditional (mirrors on_send_complete:712)
```

Notes: every `net_proactor_submit`/`kick_send` runs BEFORE `net_op_finished`, so `inflight` never
transiently hits 0 (the re-submit re-sets `send_op`+`inflight`); the re-submit's own internal
submit-failure close is safe for the same reason. On a closing conn the terminal does only
`net_op_finished` → `net_maybe_free` (frees `active_send` once, the buffer being unpinned), matching the
template's `!closing` envelope. The two **success** entries (`saw` with `zc_err==0`; or `!saw` with
`res>0`) converge on the same off-based decision (tail / rotate / drain); a single-CQE `res>0` is a
**copied** send the kernel chose not to zerocopy (§1(2)) — a normal success, not an error.

---

## 4. The submit choke point, threshold, partial sends, serialization

- **Single choke point `net_proactor_submit(conn, force_plain := false)`** decides per submission:
  `use_zc := !force_plain && zc_ok && len(active_send[off:]) >= NET_ZC_THRESHOLD` (proposal 16 KiB;
  `force_plain` is the §5 transient-fallback one-shot). It resets `conn.saw_result = false` and
  `conn.zc_err = 0`, sets `conn.send_was_zc = use_zc` (recomputed EVERY submission, like `recv_multishot`
  in `net_maybe_arm_recv` — never stale), then calls `submit_send_zc`
  (`send_cb=net_send_zc_complete`) or the plain `submit_send` (`callback=on_send_complete`). It is the
  **single submitter** that owns `send_op`+`inflight`. All submit sites route through it: the initial
  kick, the state-(c) tail, the §5 fallbacks, AND `net_proactor_kick_send` — which is updated to rotate
  `pending_writes`→`active_send` and then call `net_proactor_submit` (NOT the old plain
  `net_proactor_submit_send` directly), so a back-to-back large rotated chunk gets ZC instead of
  silently degrading to copy-send. (`net_proactor_submit` absorbs the old `net_proactor_submit_send`
  body; `kick_send` only rotates + gates on `send_op != INVALID`.) **Precondition (debug assert):**
  `net_proactor_submit` entry requires `conn.send_op == OP_ID_INVALID` — it owns `send_op`, so a caller
  must clear/gate first (all sites do). Asserting it documents + enforces the single-in-flight-send
  invariant cheaply, mirroring the alloc-time "exactly one callback variant" check.
- **Partial tail re-evaluates the threshold**: a 16 KiB ZC send that partials to a 4 KiB tail re-sends
  the tail as **plain** (sub-threshold) — no second pin+notif for a small tail. A connection thus mixes
  ZC and plain SENDs across submissions of one buffer; the completion variant follows whichever was
  submitted.
- **One in-flight ZC per conn**: `send_op` held until the terminal (INV-2) → a `write()` in the
  result→terminal window appends to `pending_writes` and `net_proactor_kick_send` no-ops (gated on
  `send_op != INVALID`). No second op, no rotation of the pinned backing.
- **Serialization latency (accepted tradeoff)**: the next write — even a small plain one (HTTP
  keep-alive next header after a big body) — waits one notification RTT, since `send_op` is held to the
  notif, not the result. v1 accepts this (ZC = large bodies). A per-op owned-buffer model that lets a
  later plain copy-SEND overlap the pinned window was considered and **deferred** (§9 Q2).
- A buffer > `URING_MAX_RW` (~2 GiB) is sent as **multiple serialized ops, each its own result+notif
  pair** (the tail is a fresh op via the choke point) — not one op with many notifs.

---

## 5. Capability + transient fallback (per-op attribution)

- **`zc_ok` is set by an init-time opcode PROBE, in `platform_init` beside `proactor_ok` — NOT coupled
  to `buf_ring_init`.** `SEND_ZC` is a real _opcode_, so — unlike `RECV_MULTISHOT` (an ioprio flag that
  2b genuinely couldn't probe) — it is probeable exactly like the existing `.RECV`/`.SEND` checks:
  extend `uring_probe_proactor` with `uring_probe_supports(&probe, .SEND_ZC)` and set
  `loop.platform.zc_ok` there. This (a) fixes a hole — `buf_ring_init` is **lazy** and recv-ring-specific
  (runs on the first ring-recv), so a **send-before-recv** conn (the outbound `startConnection` client
  path) would never have seen `zc_ok=true`; and (b) eliminates the `-EINVAL` storm on a 5.x kernel
  (`proactor_ok` true, `SEND_ZC` absent) — every worker would otherwise eat a first-send `-EINVAL`
  before latching off. `zc_ok` lives in `Platform_Loop` like `multishot_ok`; must NOT be left at Odin's
  `false` default (it is only ever _cleared_ by `disable_zc`). The runtime `-EINVAL`/`-EOPNOTSUPP`
  fallback **stays** for the per-socket/protocol case the probe can't see (a specific socket lacking ZC)
  — this is **probe AND runtime fallback**, not either/or.
- **`force_plain` — the one-shot the fallbacks need.** `net_proactor_submit(conn, force_plain := false)`
  computes `use_zc := !force_plain && zc_ok && len(active_send[off:]) >= NET_ZC_THRESHOLD`. A transient
  fallback (below) MUST pass `force_plain=true`: otherwise the choke point recomputes `use_zc` from the
  still-true `zc_ok` + still-large buffer and re-issues **another `SEND_ZC`** — re-failing/stalling
  instead of making progress.
- **`-EINVAL` / `-EOPNOTSUPP` (kernel < 6.0, or a protocol/socket without zerocopy support)** — a
  capability signal. Only a `send_was_zc` op treats it so: `disable_zc(loop)` (latches `zc_ok=false`
  loop-wide) **and** `net_proactor_submit(conn, force_plain=true)` — re-sends `active_send[off:]`
  (`off` untouched, INV-4 → exact tail) as plain. A **plain**-send `-EINVAL` (`send_was_zc=false`) stays
  fatal — no fallback loop. (Both the single-CQE form and an errored-but-pinned `zc_err` form route here
  via §3's `err<0` branch; `off` is untouched either way so the plain re-send is exact.)
- **`-ENOBUFS`/`-ENOMEM` (optmem/`RLIMIT_MEMLOCK` pressure)** is **transient, not fatal** — symmetric
  with the recv side's `-ENOBUFS` (which parks, never closes). Routes to `net_proactor_submit(conn,
force_plain=true)` (copy-send for THIS op; does NOT latch `zc_ok` off — pressure is transient). Under
  the large-body-to-many/slow-clients workload ZC targets, treating it as fatal would mass-drop
  connections.
- **Ordering** (in the §3 pseudocode): clear `send_op` → `net_proactor_submit` (re-sets
  `send_op`+`inflight`; its internal failure-close is safe because this op's `inflight` is still
  counted) → `net_op_finished` LAST. So `inflight` never transiently hits 0 mid-close.
- **Storm bound (corrected)**: `zc_ok` is checked at submit, so once the first `-EINVAL`/`-EOPNOTSUPP`
  terminal latches it off, no new ZC is attempted; the residual is bounded by the large sends **already
  in flight** when that terminal lands (per worker) × N workers — **not** "exactly one". Self-limiting;
  tests must not assert "exactly one".

---

## 6. Teardown — buffer frees strictly on the first `more=false`

- Frees on the **first `F_MORE`-clear CQE**, whatever its shape (notif / single error / `-ECANCELED`).
  Never on a `more=true` result; never on a cancel ack of an already-transmitting op.
- `net_close_conn_proactor` cancels `send_op` for promptness, but per §1(3) a cancel past the result is
  best-effort (`-ENOENT`/`-EALREADY`) — the **notification** is the guaranteed terminal that releases
  buffer+slot+`inflight`; `-ECANCELED` does not substitute for it. `conn.inflight` (held to the terminal
  via INV-2) keeps `active_send` alive until then.
- **Loop destroy (CORRECTED — the earlier reasoning was unsound):** closing the ring fd does **NOT** make
  the kernel stop reading the pinned pages. For `SEND_ZC` the pages are referenced by the TCP skbs in the
  socket's send/retransmit queue (via the io_uring `ubuf_info`/notif), released only when the last skb is
  freed (TX ACK / RST), asynchronously. `io_uring_release` tears down io_uring's request/ring state; it
  does **not** walk live skbs and drop their page refs. `linux.close(fd)` likewise orphans the socket with
  its retransmit queue intact (default linger). So `platform_destroy`'s dispose loop runs with **no barrier**
  against the kernel still transmitting those pages.
  - At true single-process exit this is benign — the address space is torn down, no meaningful reuse (M1).
  - Under **multi-worker (Slice 3a)** it is **not** benign: workers are threads sharing one heap, and a
    worker tearing down (crash or independent graceful drain) while siblings keep serving could free a
    still-pinned backing that a sibling's allocation then reuses and overwrites → silent in-flight TX
    corruption (M2). Needs a real NIC + the kernel choosing ZC + a loop destroyed in the post-result/
    pre-notif window + a racing reuse — rare, but real.
  - **Fix:** `net_maybe_free` does not free a backing still pinned at teardown. It detects the dispose-path
    case (`net_zc_pinned_at_teardown`: the last send was ZC and `send_op` is still live — the disposer, not
    the `more=false` terminal, drove `inflight→0`) and **leaks** the backing instead: a bounded, one-time
    leak (≤ pinned conns at teardown) reclaimed by the OS at process exit, safe because the orphaned
    allocation's address is never reused. The normal path is unchanged — the notification (the first
    `F_MORE`-clear CQE) clears `send_op` first, so `net_maybe_free` frees as before. A future refinement
    could bounded-drain the ring (or `SO_LINGER{1,0}` RST + reap) to free rather than leak.

---

## 7. Drain / `want_drain` / `end()` timing + the 2b recv-pause interaction

Moving the full-drain transition from the result to the **notification** (INV-2) shifts timing:

- `'drain'` + read re-arm (`net_proactor_on_drained`) and `end_after_drain` close fire on the terminal
  (one notif RTT later than plain). `end()` after a ≥threshold write closes only after the notif (closing
  on the result would free a pinned buffer — UAF). All three are terminal-`!closing`-only (§3).
- **The transitional window** (result done: `off==len`, so `net_proactor_buffered` ≈ 0, but
  `active_send` not cleared and `'drain'` not emitted until the notif): a recv terminal landing here must
  **not resume reads before `'drain'`** (an ordering break, not a memory hazard — re-arming a recv
  touches the recv ring, not `active_send`). rev.2 claimed `want_drain` keeps reads paused, but that gate
  exists **only** on the multishot `-ECANCELED` recv branch (net.odin:511); the single-shot normal
  terminal and the `-ENOBUFS` re-arm (`net_park_or_rearm`) call `net_maybe_arm_recv` with no
  `want_drain` check, and `net_maybe_arm_recv` gates only on `read_paused = buffered>=HWM` — which is
  false in the window. **Requirement:** fold the `want_drain` check **into `net_maybe_arm_recv`** (reads
  stay paused while a `'drain'` is owed), so ALL recv re-arm paths honor it, not just the `-ECANCELED`
  branch. This also simplifies the 2b `-ECANCELED` branch (its bespoke `!want_drain` guard becomes
  redundant). To be asserted in test (2a single-shot: a recv data terminal in the ZC window must not
  re-arm while `want_drain` is owed).
  - **This also tightens the pre-ZC 2a/1b steady state** (a behavior change beyond ZC, flagged for
    review): today the 2a single-shot, 1b Proactor data, `-EINTR`/`-EAGAIN`, and `-ENOBUFS`
    (`net_park_or_rearm`) re-arms resume reads as soon as `buffered < HWM` — on a _partial_ drain,
    before `'drain'`. After the move they stay paused until **full** drain (Node's
    input-paused-until-`'drain'` semantics — the intent already documented in the 2b `-ECANCELED`
    comment); an improvement, not a regression. `read_paused = buffered >= HWM` is still needed for the
    **no-owed-drain** case (a slow consumer that never crossed HWM, so `want_drain` is false) — the two
    gates are complementary. The §10 read-pause test must also cover the non-ZC 2a/1b partial-send case
    so this earlier-slice change is regression-covered.
- `net_proactor_buffered` counts `active_send[off:]` + `pending_writes`, correct mid-ZC for HWM/want_drain.
  A `write()` in the window appends to `pending_writes` (so `buffered` rises again) and
  `net_maybe_pause_multishot` (2b) stays consistent.

---

## 8. Scope guards

- **`SENDMSG_ZC` is unneeded** (not merely deferred): `pending_writes`/`active_send` are a single
  **contiguous** `[dynamic]byte` (writes concatenate), so there is no iovec to scatter-gather —
  single-buffer `SEND_ZC` suffices under the current and a future owned-buffer model.
- **`SEND_ZC_REPORT_USAGE` out of scope** for production — but a debug/verification build may set it to
  **assert the kernel actually zerocopied** (notif `res==0`) vs silently copied (loopback always copies,
  §9 Q5).
- Not the recv side; not below-threshold sends; no readiness-path change.

---

## 9. Open questions for review

1. **Threshold** — proposal raised to **32–64 KiB** (was 16 KiB): the net break-even is above the raw
   ~10 KiB zerocopy break-even because §4's serialization makes the next write wait one notification RTT
   that a plain copy-SEND would overlap (acute for pipelined keep-alive: a 16 KiB body then the next
   response's headers). Settle via the **pipelined keep-alive** bench (§10), not just one big body.
2. **Serialized one-ZC-per-conn (§4)** vs a per-op owned-buffer model letting a plain send overlap the
   pinned window — accept the one-notif-RTT serialization for v1 (recommended)?
3. **`-ENOBUFS`** — per-op copy-fallback only (recommended) vs also a `zc_ok` cooldown?
4. **Capability — RESOLVED: probe AND runtime fallback** (§5), not either/or. The 2b "latch, can't
   probe" analogy was false (`RECV_MULTISHOT` is an ioprio flag; `SEND_ZC` is a real opcode). Probe
   `.SEND_ZC` in `uring_probe_proactor` at init to gate `zc_ok` (kills the storm + the send-before-recv
   hole); keep the `-EINVAL`/`-EOPNOTSUPP` runtime fallback for per-socket/protocol gaps the probe
   can't see.
5. **Bench interface** — ZC ≈ no-op on loopback (kernel copies, possibly without even the F_MORE/notif
   pair, §1(2)); bench on a real NIC, or document the caveat + use `SEND_ZC_REPORT_USAGE` in a
   verification build to confirm actual zerocopy?

---

## 10. Test & verification plan

**No test asserts a real kernel two-CQE sequence** — loopback always copies and AF_UNIX (the
`make_socketpair` helper) doesn't support send-zerocopy at all (`SEND_ZC` there copies or returns
`-EOPNOTSUPP`); a genuine pinned result→notif needs a real NIC, which isn't CI-feasible. So the state
machine is tested by **direct invocation** and the F_MORE accounting by **reuse of the existing
multishot machinery**:

- **Net state machine (primary)**: call `net_send_zc_complete(loop, conn, res, more)` directly with
  crafted `(res, more)` tuples — no kernel ZC needed — covering **every `(more, res, saw_result)` cell**
  (next bullet). This is the real correctness test.
- **Eventloop F_MORE accounting**: it is callback-agnostic (`drain_uring_completions` releases the slot
  - decrements `active_io_count` only on the `F_MORE`-clear CQE for ANY op), already proven by the
    multishot-recv test. So SEND_ZC adds only: a unit test that a `send_cb` slot **routes to `send_cb`,
    never `recv_cb`/`callback`** (dispatch + release-nulls-`send_cb`), plus `submit_send_zc` returning a
    valid op id + `active_io_count` bookkeeping — NOT a real two-CQE kernel sequence.
- **Probe**: `uring_probe_proactor` reports `zc_ok` on a ≥6.0 kernel; a large send then actually submits
  `SEND_ZC` (vs plain below threshold). Forced fallback (`zc_ok=false` → plain). Teardown: an in-flight
  ZC op left **post-result/pre-notif** (crafted) disposed exactly once at destroy → conn freed once
  (ASAN); a forced submit-failure during the `-EINVAL` fallback frees the conn once.
- **State-machine — every `(more, res, saw_result)` cell** (the Codex-round additions): result-then-notif
  success; **`more=true, res<0` (errored-but-pinned)** → the notif surfaces the error (close/fallback),
  NOT a silent tail-resubmit; **`more=false, res>0` single-CQE COPIED success** → advances `off` and
  drains, does NOT close; `more=false, res==0` stall → close; `-EINVAL`/`-EOPNOTSUPP` → `disable_zc` +
  plain re-send; `-ENOBUFS` → `force_plain` re-send, conn NOT closed and `zc_ok` NOT latched off;
  `write()` between result and notif lands in `pending_writes`, NO second op until the terminal; `off`
  advances only on non-negative `res`; a notif on a **closing** conn runs only `net_op_finished`.
- **`zc_ok` init**: with no kernel `SEND_ZC` support, the FIRST large send `-EINVAL`s, latches
  `zc_ok=false`, and falls back to plain — and `zc_ok` must start `true` so ZC is attempted at all
  (assert a large send actually attempts ZC on a ≥6.0 kernel).
- **Buffer-lifetime (load-bearing, ASAN)**: large ZC write, **cancel AFTER the result but before the
  notif** → `active_send` freed only on the notif, never on the cancel/`-ECANCELED`; peer RST mid-send.
- **2b interaction**: 2a single-shot — a recv data terminal in the ZC result→notif window must NOT
  re-arm reads while `want_drain` is owed (the §7 `net_maybe_arm_recv` gate).
- **Net/HTTP smoke**: large body (≥ threshold) byte-for-byte vs Node, proactor (ZC) + readiness (no ZC);
  partial-send (small socket buf + large body) body integrity across ZC→plain tail; `end()` right after
  a ≥threshold write closes only after the notif.
- **Bench**: large-body throughput vs plain on a real interface (or document the loopback copy caveat);
  hello-world unchanged. Optional verification build asserts actual zerocopy via `REPORT_USAGE`.

## 11. Commit staging (one 3b PR)

**Platform placement (build-correctness):** the ZC eventloop surface — `Op_Send_Completion`, the slot
callback-union variant, `submit_send_zc`/`platform_submit_send_zc`, `zc_ok`/`disable_zc`, the
`.SEND_ZC` probe — is defined **inside `loop_linux.odin`** (the proactor is Linux-only) and called only
from the Linux-only `net.odin`. It is NOT added to the cross-platform `loop.odin` facade, so — unlike
`submit_recv_ring`, which has a `loop.odin` wrapper + darwin/windows no-op stubs — **no darwin/windows
stubs are needed** (nothing non-Linux references it). (If a future cross-platform caller appears, add
the `loop.odin` wrapper + the two stubs then.) This keeps the established "eventloop package compiles
everywhere" invariant intact.

1. Eventloop (Linux-internal): the `.SEND_ZC` probe in `uring_probe_proactor` → `zc_ok` at
   `platform_init` (decoupled from `buf_ring_init`, M1); `Op_Send_Completion` + the slot callback union
   (or `send_cb` field + release-nulls-it) + dispatch; `submit_send_zc` reusing `uring_arm_rw` (m5);
   `disable_zc`. Update the stale `loop_linux.odin:473` comment (m6). Eventloop unit tests (send_cb
   routing; NO real two-CQE sequence — §10).
2. Net (Linux): the §3 state machine (INV-1..4, ordered exactly as the pseudocode, two-axis cells) +
   the `net_proactor_submit(conn, force_plain)` choke point (threshold + `saw_result`/`zc_err`/
   `send_was_zc` reset + the `send_op==INVALID` entry assert) + `net_proactor_kick_send` routed through
   it + `-EINVAL`/`-EOPNOTSUPP`/`-ENOBUFS` fallbacks + the §7 `want_drain`-into-`net_maybe_arm_recv` move.
3. Tests (state-machine direct-invocation cells, buffer-lifetime ASAN incl. cancel-after-result,
   large-body integrity, end-after-write, 2b-window read-pause) + bench (pipelined keep-alive, real NIC)
   - docs.
