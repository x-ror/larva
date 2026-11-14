---
name: odin-feature
description: Implementation pipeline for Lava/Larva work — reuse scout over the Odin SDK and linked C libraries, oracle-parity design (Node for the Node profile, Chrome for the Window profile), layered implementation, tests, and gates. Use when asked to add or change a Node or Web API, a DOM or page capability, a native primitive, the VM pool, an event-loop or I/O capability, or any performance work in `pkg/runtime`, `pkg/jsc`, or `pkg/runtime/js`.
argument-hint: '<what to build> [--no-scout] [--design-only] | --fix [findings file]'
---

# Feature pipeline

Six phases, 0–5. Do not skip phase 0 or phase 1 — writing low-level code that the Odin SDK or an
already-linked C library already implements is the failure mode this pipeline
exists to prevent.

You are the conductor ([conductor.md](conductor.md) — read it first). You own
phases 0 and 2 and the rulings in phase 5; everything that costs volume — the
oracle probe, the SDK sweep, the code, the gates — is a worker's, on a cheaper
model. The phases below say who.

Read `CLAUDE.md` and `docs/LARVA.md` first. Reuse index:
[odin-feature-reference/odin-sdk-map.md](odin-feature-reference/odin-sdk-map.md). Gate routing:
[pr-gate-reference/gates.md](pr-gate-reference/gates.md).

## Phase 0 — profile (conductor)

Decide which profile the surface belongs to (`docs/LARVA.md` decision 1) — it
picks the oracle for every later phase:

- **Node** (`process`, `require`, `Buffer`, `node:*`) → real `node` 22+/24.
- **Window** (anything a page can reach) → recorded Chrome output. No `process`,
  `require` or `Buffer`; plain `TypeError`/`DOMException` with Chrome's messages
  and no `code`; plain `Uint8Array`.
- **Shared** Web API code → both; error constructors and byte helpers come from
  the profile, never imported directly.

Also name the roadmap stage the work belongs to; a feature that depends on a
stage not yet built (e.g. a DOM API before stage 3's tree) is a planning problem,
not an implementation one.

## Phase 1 — oracle contract + reuse scout (workers, parallel)

Launch both in one message:

**(a) The oracle contract** — a `general-purpose` worker with `model: sonnet`:
this is running probes and tabulating output, not judgement. It writes the
probe script and the raw oracle output to the scratch dir and replies with the
contract as a table (one row per case: input → result or thrown
`name`/`code`/`message`), nothing else. Its task: determine exactly what the
oracle does for the target API. Node profile: run `node` for real and consult
<https://nodejs.org/api/>. Window profile: use a recorded Chrome result (stage-0
corpus) or record one — run the snippet in Chrome and keep the output with its
source; the WHATWG/W3C spec explains it but does not replace it, and Node's
output is never a stand-in for Chrome's. Capture: exported shape, argument coercion
_order_, defaults, return types, thrown `code`/`name`/`message`, event and
callback ordering, and the edge cases (empty, `NaN`, `-0`, out-of-range,
`undefined` vs missing, detached buffers, lone surrogates). This is the spec you
implement against — not your memory of the docs.

**(b) `odin-sdk-scout`** (sonnet). Ask for a use/wrap/reject verdict per capability the
feature needs, searching in-repo → `core:` → `vendor:` → already-linked C → new
dependency → hand-roll. Skip only with `--no-scout`, and only for a change that
writes no new low-level logic.

## Phase 2 — design (conductor)

This is the phase the conductor exists for: two short worker replies in, one
decision out. Write a short design (not a document — a message) covering:

- **Seam**: what is native (`pkg/runtime/*.odin`), what is embedded JS
  (`js/internal/*.js`), what crosses the `native` bindings argument, and why. Hot
  or unsafe → native; ergonomic spec surface → JS. Wrong-layer code is rejected in
  review even when it works.
- **Reuse decisions** from the scout: what you will call instead of write, and for
  each rejection, the evidence.
- **Ownership**: who allocates, under which allocator, who frees, when. Anything
  crossing a loop turn or a `proc "c"` boundary needs this pinned before coding.
- **Blocking**: anything that can block goes off-loop via `pool_submit`, with the
  completion re-queued so Node's phase ordering survives.
- **Platforms**: the Linux implementation plus honest stubs for windows/darwin
  (`make check` cross-checks both front ends).
- **Pages and VMs**: what is per page (arena), per VM, per session, per thread;
  how a reused VM comes back clean; whether a new VM entry path keeps the
  execution limit and CPU-budget accounting.
- **Deviation from the oracle**, if any: what it buys, measured how, pinned by
  which test.
- **Tests**: which oracle cases (Node or Chrome-recorded), which Odin tests
  (including a second page in a reused VM where isolation is in play), which smoke.
- **Gates**: the commands the touched paths require.

Then the contract must land where it survives the session — the design message
tells `odin-implementer` to write it first: the phase-1(a) findings go
into the **implementation file** as a contract comment (`CLAUDE.md` §4 for Odin,
§5 for JS) — params, returns, the `Node:` line with how it was verified, and
`Deviates:` with the test that pins it. A contract that exists only in this
message is gone by the next one, and the next reader re-derives it wrong.

Stop here with `--design-only`. Otherwise, for anything non-trivial, put the
design in front of the user before implementing.

## Phase 3 — red tests, then implement (`odin-implementer`, opus)

Brief `odin-implementer` with `design:` set to the phase-2 message and
`tests: write-first`. Pieces that touch disjoint files may go to parallel
instances in one message; pieces that share a file go to one. The conductor
edits the tree itself only for a change it can state as an exact edit of a few
lines — anything it would have to read a file to write is the implementer's.
What follows is what the implementer is held to, and what its reply must show.

**Tests first, and watch them fail.** Write the oracle cases and Odin tests
against the phase-2 contract before the code exists, run them, and confirm each
fails _for the reason it names_ — a new test that passes against an unimplemented
feature is measuring nothing, and that is exactly how two tests in #320 shipped
asserting less than their comments claimed. This red phase is the mutation check
(`CLAUDE.md` §6) paid up front; a test added after the code owes it separately.

Then implement. The conventions in `CLAUDE.md` §4–5 are binding: allocator capture, JSC protect/release pairing, `-> bool` for
C `_Bool`, primordials in JS, coded errors, `when ODIN_OS` honesty, contract
comments on user-visible surfaces, prose that explains why.

Order that avoids rework: contract comment → failing tests → native primitive →
wire the binding → JS surface. Keep `make check` green as you go rather than at
the end.

Two traps worth naming, both real:

- An assertion that holds with **and** without the code under test. Invert the
  pinned line and re-run; if it still passes, the test is decorative.
- An assertion aimed at state the test cannot observe. Check the allocator and
  the lifetime before trusting a leak check — anything allocated under
  `runtime.default_context()` (net connections, for one) is invisible to a
  caller-installed tracking allocator, and the runner does not fail on leaks
  anyway (`ODIN_TEST_FAIL_ON_BAD_MEMORY` defaults false).

## Phase 4 — verify (`gate-runner`, sonnet)

The implementer ran `make fmt` and the gates its own paths map to; its reply
lists them. Independent confirmation is `gate-runner`'s, never the conductor's:

1. `phase: compile`, then `phase: suites` — the routed suites and smokes,
   networking smokes on **both** backends.
2. The phase-1(a) probe script re-run under `bin/lava` and diffed against the
   recorded oracle output, for every surface touched — name it in the brief as
   an extra target.
3. `make bench` if the change touches a hot path, and always for a `perf(...)`
   change. A perf claim without the numbers does not pass the gate.

A red gate goes back to the same implementer instance (fix rounds,
[conductor.md](conductor.md)). A failing gate nobody could fix is stated
plainly to the human, not described as done.

## Phase 5 — hand off

- Commit message: `type(scope): imperative summary`.
- PR body: what changed, reuse verdict, gates run with results, oracle-parity
  evidence (which profile, which oracle) or the justified deviation, bench numbers
  if perf is claimed.
- Update the docs the change triggers (`quality-docs-auditor`'s table lists them:
  ARCHITECTURE for a base-runtime seam, `docs/LARVA.md` for a VM/profile/page/
  network decision or a roadmap stage, README for a new dependency, `make help`
  for a new target).
- Run `/pr-gate` before requesting review. Its confirmed P0/P1 list comes back
  here as a fix round.

## `--fix` — close findings

With `--fix`, skip phases 0–3. The input is a findings list (the file named, or
the last `/pr-gate` scorecard in this session) and/or a red gate log.

1. Brief `odin-implementer` in fix mode: `design:` is the confirmed P0/P1 list,
   one line each (`id severity path:line what → fix`). Reuse the instance that
   wrote the code when there is one.
2. Rule on anything it returns as `disputed:` — read the cited lines, then
   either withdraw the finding (say so to the human) or send it back.
3. `gate-runner` with `phase: rerun` on the gates that were red, plus
   `compile`.
4. Re-check only with the reviewers whose findings were open, `focus:` set to
   those findings.

Two rounds at most; what is still open after that is `NEEDS_HUMAN`. No scope
beyond the findings, no P1 waived.
