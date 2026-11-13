# Scorecard

Two ranked criteria decide whether the change is _good_. Six gates decide whether
it is _mergeable_. A change can be fast and still not merge.

## Ranked criteria

### 1. Oracle conformance (primary)

The oracle depends on the profile (`docs/LARVA.md` decision 1): real Node 22+/24
for the Node profile, recorded Chrome output for the Window profile, both for
shared Web API code. A diff touching several profiles is graded by its worst.

| Grade | Meaning                                                                                                                                                 |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A     | Verified against the profile's oracle on every surface the diff touches; no divergence.                                                                 |
| B     | Verified; divergences exist and every one is intentional, commented, declared in the PR, and pinned by a Lava-only test.                                |
| C     | Plausible parity, not verified empirically (no oracle run, no `bin/lava` diff, or no Chrome recording for a Window surface).                            |
| F     | Undeclared divergence on a user-visible surface; a wrong error `code`/type/order on a common path; a Node global or `ERR_*` code reachable from a page. |

`F` blocks the merge. `C` blocks a PR that claims parity. Until the stage-0
Chrome corpus covers a surface, a Window-profile change is at best `C`: it may
merge if it does not claim parity and the PR names the recording still owed.

Deviation is legitimate **only** for measured speed or memory control, or an
explicit non-goal in `docs/LARVA.md` — and then
the trade must be written at the call site and in the PR body.

### 2. Speed and memory (secondary)

| Grade | Meaning                                                                                                                      |
| ----- | ---------------------------------------------------------------------------------------------------------------------------- |
| A     | Measured improvement (bench/profile output in the PR), no parity cost.                                                       |
| B     | Neutral, or a small measured cost taken deliberately to buy correctness/parity.                                              |
| C     | Direction plausible but unmeasured, on a path that is not hot.                                                               |
| F     | Measured regression, or a perf claim with no number, or a pathological cost (unbounded allocation, O(n²) per request, leak). |

A perf claim without evidence is graded `F` on this axis regardless of how the
code reads.

## Merge gates

Each gate is pass / fail. Any fail with an open **P0** blocks.

| Gate          | Owner agent             | Fails when                                                                                                                                                                                            |
| ------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Correctness   | `regression-hunter`     | Introduced defect, removed behavior, broken wiring.                                                                                                                                                   |
| Native safety | `odin-safety-auditor`   | UAF, race, GC hazard, allocator mismatch, lying stub, false probe latch, VM entered off-thread, state crossing pages in a reused VM, arena freed before wrappers.                                     |
| Security      | `security-auditor`      | Reachable memory corruption, verification bypass, single-peer or single-page DoS, page/session isolation break, Node surface reachable from a page, pollution vector, path escape, secret disclosure. |
| Test coverage | `test-coverage-auditor` | New behavior or bug fix with no test; test deleted or gap widened without reason; smoke not wired into CI.                                                                                            |
| Code quality  | `code-quality-auditor`  | Duplicates an existing helper or SDK routine on a hot path; wrong layer; file past ~1k with no split; high incidental complexity with a clear delete path.                                            |
| Documentation | `docs-auditor`          | A repo document is now false; a lifetime/probe/deviation rule shipped unexplained.                                                                                                                    |

Reuse (`odin-sdk-scout`) is not a separate gate — it feeds Code quality: a
hand-rolled routine that `core:`/`vendor:`/an already-linked C library implements
is a Code-quality **P1** with the concrete deletion named.

## Severity

| Severity | Meaning                                                                                                                                                   | Action                                            |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| **P0**   | Correctness, safety, security, isolation, or an undeclared divergence from the oracle.                                                                    | Blocks merge.                                     |
| **P1**   | Structural or contract problem: duplicated helper on a hot path, wrong layer, unproven perf claim, missing test for the main path, a document made false. | Fix, or waive explicitly in the PR with a reason. |
| **P2**   | Real improvement, not a blocker.                                                                                                                          | Optional in this PR.                              |
| **nit**  | Style, wording.                                                                                                                                           | Ignore unless free.                               |

## Verdict

```text
SHIP        — no P0; P1s either fixed or explicitly waived
SHIP-AFTER  — P0 count is small and each has a concrete named fix
BLOCK       — P0 with no clear fix, or a mechanical gate is red
```

Report the verdict with the two criterion grades, the six gate results, and the
P0/P1 list. Never report SHIP while a mechanical gate (`make check`,
`make check-js`, `make test`, the routed smokes) is failing or was not run.

When the mechanical gates are **delegated** (`--review-only` — reviewing from a
machine without the toolchain, while CI runs the build on the same SHA), grade
them from the conclusion you actually read off that job — never from the fact
that it exists:

| State of the routed gate            | Counts as | Verdict effect                                                                          |
| ----------------------------------- | --------- | --------------------------------------------------------------------------------------- |
| CI check succeeded on this SHA      | PASS      | SHIP is available if no P0 survives                                                     |
| CI check pending / not yet reported | neither   | Ceiling is `SHIP-AFTER` — say the gates are still running                               |
| CI check failed                     | FAIL      | `BLOCK`, naming the failed check                                                        |
| **No CI check covers it**           | `NOT RUN` | Ceiling is `SHIP-AFTER` — name the gate and say it must be run locally or wired into CI |

The last row is the one that is easy to get wrong: `gates.md` routes several targets
CI does not execute, and calling those `DELEGATED` would report an unrun gate as
someone else's PASS.

"Same SHA" is load-bearing: a green check from an earlier push says nothing about
this diff. If you cannot tie the conclusion to the commit under review, treat it as
pending. Always name where the mechanical results live.
