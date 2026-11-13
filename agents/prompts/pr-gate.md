---
name: pr-gate
description: Merge gate for Lava changes — runs the mechanical gates the changed paths require, fans out specialist reviewers in parallel, and returns a scorecard (oracle parity — Node or Chrome by profile, speed/memory, plus correctness, safety, security, coverage, quality, docs) with a SHIP / SHIP-AFTER / BLOCK verdict. Use before opening or merging a PR, when the user asks to review a branch, PR, or working diff, or asks "is this ready to merge".
argument-hint: '[--local | --branch <name> | --pr <number|url>] [--quick | --review-only] [--post-pending]'
---

# PR gate

You orchestrate. You do not author the deep findings yourself — specialists do,
in parallel, each with one lens. Your job is to run the mechanical gates, route
the right specialists, merge and dedupe their findings, and produce one scorecard
a human can act on in under a minute.

Read [pr-gate-reference/gates.md](pr-gate-reference/gates.md) (command routing) and
[pr-gate-reference/scoring.md](pr-gate-reference/scoring.md) (rubric and verdict rules) before
starting.

## Step 1 — collect the diff

Parse the argument:

- empty or `--local` → `git diff HEAD` plus untracked files as `--no-index` diffs
- `--branch <name>` → merge-base against `origin/master` (fall back `origin/main`),
  then `git diff <base>..<name>`
- `--pr <n|url>` → `gh pr view` + `gh pr diff` (needs `gh` auth)
- a bare number or a GitHub pull URL → PR mode; anything else → try as a branch

Write the diff and the changed-file list to the session scratch directory. Empty
diff → say "nothing to review" and stop. Over 10 MB → stop. Over 1 MB → ask first.

Report: `Reviewing <target>: N files, +A/-B lines.`

## Step 2 — mechanical gates first

Specialists reviewing code that does not compile is wasted work. Run, in order,
what [pr-gate-reference/gates.md](pr-gate-reference/gates.md) routes for the changed paths:

1. `make check` — always
2. `make check-js` — if any JS changed
3. `make check-md` — if any `.md` changed
4. `make check-actions` — if any `.github/workflows/*.yml` changed
5. `make build`
6. `make test` (and `make test-lava` unless `--quick`)
7. the routed per-path smokes and benches

Capture real output. If `make check` or `make build` fails, stop and report —
verdict is **BLOCK** with the compiler output; do not spawn specialists.
A later gate failing is a finding, not a stop: record it and continue.

With `--quick`, run steps 1–5 only and mark the untested gates explicitly as
"not run" in the report. Never let "not run" read as "passed".

With `--review-only`, skip this step entirely — run no `make` target and no build
of any kind. The environment is expected to lack the toolchain (Odin, LLVM,
JavaScriptCore, SQLite, OpenSSL, vite-plus) and a separate CI job is running the
gates on the same commit. This mode requires a target that resolves to an exact
SHA — `--pr <n>` or `--branch <name>`; it is meaningless with `--local`.

Read that job's result instead of reproducing it: `gh pr checks <n>` gives a
conclusion per check. Then, for **every** gate the changed paths route to, decide
which of two states it is in:

- A CI check covers it → `DELEGATED (CI: <check> — success | failure | pending)`.
- No CI check covers it → `NOT RUN`. Not every routed target is in CI:
  [pr-gate-reference/gates.md](pr-gate-reference/gates.md) names the ones that are not. A gate
  nothing executed is not delegated — it is missing, and it blocks `SHIP` exactly
  as a skipped gate does in the normal mode.

Never wait on a pending check, and never infer a conclusion you did not read — a
job triggered by the same event as CI will usually observe CI still in flight, and
"pending" is the honest answer there. Verdict rules for this mode are in
[pr-gate-reference/scoring.md](pr-gate-reference/scoring.md).

## Step 3 — fan out specialists

Launch every applicable agent **in one message** so they run concurrently. Give
each: the diff path, the changed-file list, the repo root, the target description,
and the mechanical-gate results.

| Agent                   | Run when                                                                                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `regression-hunter`     | always                                                                                                                                                                                                 |
| `code-quality-auditor`  | always                                                                                                                                                                                                 |
| `test-coverage-auditor` | always                                                                                                                                                                                                 |
| `docs-auditor`          | always                                                                                                                                                                                                 |
| `odin-safety-auditor`   | any `.odin` changed — always for `vm_pool.odin`, `runtime.odin`, page/DOM lifecycle, `pkg/jsc`                                                                                                         |
| `oracle-parity-auditor` | any user-visible surface: `js/**`, a native binding behind a Node or Web API, error construction, event/callback ordering, anything a page can reach — tell it the profile if you know it              |
| `perf-memory-auditor`   | hot paths (buffer, http, net, fetch, url, jsc, eventloop), any `perf(...)` title or perf claim, any `bench/**` change                                                                                  |
| `security-auditor`      | parsing (HTTP, HTML), networking, TLS/crypto, sessions/cookies, VM pool or page lifecycle, the Window profile's global set, fs paths, URL handling, module loader, or any native code fed by JS values |
| `odin-sdk-scout`        | the diff hand-rolls a parser, codec, hash, container, socket dance, or time/number/string conversion — ask it whether `core:`/`vendor:`/an already-linked C library already does it                    |

Specialists are read-only: instruct each explicitly not to modify repo sources.
In `--review-only` mode, also tell every specialist that the toolchain is absent —
read-only analysis only, no `make`, no `odin`, no build, no test or bench run.
They have Bash and will otherwise try to build and report the failure as a finding.
If one fails or returns nothing, record it as `failed` and continue — a missing
specialist is reported, never silently dropped.

## Step 4 — merge and triage

- Same `file:line` + same claim from several agents → one finding, list the agents,
  keep the highest severity and confidence.
- Drop nits already implied by a P1 in the same place.
- Demote anything an agent could not tie to a concrete failure path — a finding
  with no reproducer is a question, not a defect.
- Cross-check the two criteria against each other: a `perf-memory-auditor` win
  that `oracle-parity-auditor` calls a divergence is a **P0**, not a win.
- An `oracle-parity-auditor` verdict of `unverified (no Chrome oracle)` is not a
  pass: grade criterion 1 `C` (see scoring.md).

## Step 5 — report

```text
PR gate — <target>

Criterion 1 · Oracle parity : A|B|C|F  — profile(s) + oracle, one line
Criterion 2 · Speed & memory: A|B|C|F  — one line

Mechanical gates
  make check         PASS
  make check-js      PASS
  make test          PASS
  make test-http-smoke  FAIL  (or NOT RUN — reason, or DELEGATED — where)

Review gates
  Correctness    PASS/FAIL   Safety      PASS/FAIL
  Security       PASS/FAIL   Coverage    PASS/FAIL
  Quality        PASS/FAIL   Docs        PASS/FAIL

P0 (blocks merge)
  1. <file:line> — <what> → <fix>

P1 (fix or waive with a reason)
  1. ...

P2 / nit: <count>, in <scratch merge file>

Verdict: SHIP | SHIP-AFTER | BLOCK
Specialists: <n> run, <failed: …>
```

Then offer: fix the P0/P1 list, or re-run after fixes. Fixing is a **new task**,
not part of this skill.

## Step 6 — optional PENDING GitHub review

Only with `--pr` **and** `--post-pending` **and** at least one actionable finding.
Build the review JSON with no `event` field so it stays PENDING, inline comments
only for `(file,line)` pairs present on the RIGHT side of the PR diff, everything
else promoted into the body, then
`gh api repos/{owner}/{repo}/pulls/{n}/reviews --input <file>`.

Never submit (approve/request-changes) on the user's behalf. Never post an empty
review.

## Rules

- Orchestrate; do not deep-review the whole diff yourself. The one exception:
  after merging, you may add a short **Policy** section for violations of
  `CLAUDE.md` §2 and §4 (reuse law, file-size, layer, `*_host` measurement rule)
  that no specialist covered — with `file:line` evidence only.
- Report gate results faithfully. A skipped gate is reported as skipped.
- Fewer, high-conviction findings beat volume.
- No emojis.
