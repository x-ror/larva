# Conductor protocol

How a session runs the specialists. `/odin-feature` and `/pr-gate` both follow
this; read it once at the start of either.

The split is deliberate. The **conductor** is the session's own model — run the
session on the strongest one available (Fable). It is the most expensive model
per token and the only one that sees the whole task, so it spends tokens on
exactly three things: deciding what to delegate, judging what comes back, and
telling the human what is wrong. The **workers** are pinned to cheaper models in
their frontmatter and do everything that costs volume: reading files, running
gates, writing code, sweeping the SDK.

Nothing here self-starts. A human types the command; the conductor runs the
workers that command calls for, and stops.

## The orchestra

| Agent                     | Model  | Does                                                                   | Run when                                                                |
| ------------------------- | ------ | ---------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `odin-implementer`        | opus   | Writes code and tests (feature work **and** fix rounds)                | a scoped task with the design settled, or a findings list to close      |
| `regression-hunter`       | opus   | Correctness: logic bugs, removed behavior, wiring drift                | every review above tier 0                                               |
| `safety-security-auditor` | opus   | Memory safety, JSC/GC lifetimes, concurrency, isolation, hostile input | any `.odin`, `pkg/jsc`, or a security-routed path (list in the agent)   |
| `oracle-test-auditor`     | opus   | Criterion 1 (oracle parity) and whether the tests would catch a revert | every review above tier 0                                               |
| `perf-memory-auditor`     | opus   | Criterion 2: allocations, copies, crossings, evidence behind claims    | hot paths, VM pool/page lifecycle, `perf(...)` titles, `bench/**`       |
| `quality-docs-auditor`    | sonnet | Reuse, simplification, layering, size, comments and repo docs          | every review                                                            |
| `odin-sdk-scout`          | sonnet | Reuse verdict from real SDK source                                     | before new native code; on a diff that hand-rolls an SDK-shaped routine |
| `gate-runner`             | sonnet | Runs the routed `make` targets, returns a PASS/FAIL table              | every pipeline; the conductor never runs a gate itself                  |

Opus gets the work where a missed defect is expensive and reasoning depth pays
(writing code, lifetimes, parity, perf). Sonnet gets the work that is wide rather
than deep (grepping the SDK, running commands, checking docs against a table).
A specialist never inherits the session model: `model: inherit` on a worker
silently bills volume work at the conductor's rate, and
`scripts/agents-mirror.test.mjs` rejects it.

For a plain "where is X" search with no judgement in it, use the harness's
built-in `Explore` agent rather than a specialist.

## What the conductor does itself

1. **Triage** from `git diff --stat` and the changed-file list — never from the
   diff body. Which gates the paths route to is `gate-runner`'s question.
2. **Design decisions** (`/odin-feature` phase 2). The seam, ownership and
   deviation calls are the judgement the pipeline exists to concentrate here.
3. **Briefs** (template below).
4. **Adjudication** of what comes back (below). This is where the conductor
   earns its cost.
5. **The verdict and the explanation to the human**: what is wrong, why it
   matters, what to do — in the human's terms, not as a pasted report.

## What the conductor never does

- Run `make`, a smoke, or a bench. Gate output is the largest single source of
  wasted context; `gate-runner` returns a table and keeps the logs on disk.
- Read a diff body or a whole file to "get oriented". Workers orient; the
  conductor reads only the lines a finding cites (see Adjudication).
- Paste code, diffs or logs into a brief. Pass paths.
- Redo a worker's investigation because the reply was thin, or grep the diff
  to check a claim. Ask that worker a follow-up (`SendMessage` to the same
  agent keeps its context; where the harness defers that tool, load it with
  `ToolSearch` first) or open its report file at the cited section.
- Open `pr-gate-reference/gates.md`. Routing is `gate-runner`'s; the conductor
  reads the table in its reply.
- Spawn a reviewer the paths do not route to "for completeness".

## Tiers

Pick one from the stat, before spawning anything.

| Tier | Diff                               | Workers                                                                                                                             |
| ---- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Every changed path is a `.md` file | `gate-runner` + `quality-docs-auditor`                                                                                              |
| 1    | Everything else                    | `gate-runner` + the two "every review" opus reviewers + `quality-docs-auditor` + whichever conditional reviewers the paths route to |

Tier 0 is decided by extension, not by reading: one path that is not `.md` —
a workflow, a script, a test, a manifest — makes it tier 1. A diff that only
deletes a CI step or a smoke is exactly the change that needs
`regression-hunter` and `oracle-test-auditor`, and it contains no code.

There is no tier that skips `gate-runner`, and no tier where the conductor is
the only reviewer of code. A review gate whose owner did not run is never
printed as PASS: it is `N/A` when no changed path routes to that owner, and
`NOT REVIEWED` when the owner was due and did not report
([scoring.md](pr-gate-reference/scoring.md)).

## Brief template

Every spawn uses this shape and nothing more. Send all independent spawns in
one message so they run concurrently.

```text
task: <one sentence — what to judge or build>
target: <branch | PR | commit range | working tree> @ <sha>
base: <sha the diff is taken against>
scratch: <session scratch dir>          # reports land in <scratch>/<agent>.md
diff: <scratch>/diff.patch
files: <scratch>/files.txt
gates: <scratch>/gate-runner.md          # omit if not run yet
profile: node | window | shared | n/a
focus: <optional: the one thing you most want checked, with path:line>
constraints: read-only | may edit <paths> ; toolchain present | absent
phase: compile | suites | rerun | quick | ci      # gate-runner only
```

`focus:` goes to one worker. The same focus handed to two reviewers buys the
same investigation twice — in the first trial run both opus reviewers mutated
the same test.

For `odin-implementer` add `design:` (the phase-2 message, or the findings to
close as `id severity path:line what → fix`) and `tests: write-first | exist`.

## Adjudication

Replies arrive as ≤40 lines each
([report-contract.md](conductor-reference/report-contract.md)). For each one:

1. **Every P0 and P1 gets a ruling: confirm, demote, or reject — with a
   reason.** To rule, read the cited `path:line` with ~30 lines of context
   (`Read` with `offset`/`limit`, never the whole file) and, only if that does
   not settle it, the finding's section of the report file. A finding with no
   concrete failure path is a question, not a defect: demote it.
2. **Merge duplicates.** Same `path:line` and same claim from two agents is one
   finding; keep the higher severity and name both.
3. **Cross-check the two criteria.** A `perf-memory-auditor` win that
   `oracle-test-auditor` calls a divergence is a P0, not a win.
4. **Look for what nobody said.** The conductor is the only participant who
   sees all reports at once: a gate that failed with no reviewer explaining it,
   two reports that assume opposite ownership of the same value, a surface in
   `files.txt` that no reviewer's reply mentions. Each is a follow-up question
   to the owning worker, not a reason to start reading the tree.
5. **A worker that failed or returned nothing** is recorded as `failed` in the
   verdict. Re-spawn it once; never silently drop it.

P2s and nits stay in the report files. The conductor reports their count and
where they live.

## Fix rounds

A red gate or a confirmed P0/P1 goes back to `odin-implementer` — the same
agent instance via `SendMessage` when it wrote the code, so it does not re-read
what it already knows. Then `gate-runner` again, and only the reviewers whose
findings were open re-check, with `focus:` set to those findings.

At most **two** fix rounds. A finding still open after the second is reported
as `NEEDS_HUMAN: <reason>` and the pipeline stops. A P1 is never waived by the
conductor or by a worker.
