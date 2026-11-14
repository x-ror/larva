---
name: pr-gate
description: Merge gate for Lava changes — runs the mechanical gates the changed paths require, fans out specialist reviewers in parallel, and returns a scorecard (oracle parity — Node or Chrome by profile, speed/memory, plus correctness, safety, security, coverage, quality, docs) with a SHIP / SHIP-AFTER / BLOCK verdict. Use before opening or merging a PR, when the user asks to review a branch, PR, or working diff, or asks "is this ready to merge".
argument-hint: '[--local | --branch <name> | --pr <number|url>] [--quick | --review-only] [--post-pending]'
---

# PR gate

You are the conductor ([conductor.md](conductor.md) — read it first; its rules
on what you delegate and what you never do yourself bind every step here). You
do not run the gates and you do not author the deep findings: `gate-runner` and
the reviewers do, in parallel, on cheaper models. Your job is to route, to rule
on what comes back, and to produce one scorecard a human can act on in under a
minute.

Read [pr-gate-reference/scoring.md](pr-gate-reference/scoring.md) (rubric and
verdict rules). [pr-gate-reference/gates.md](pr-gate-reference/gates.md) is
`gate-runner`'s reference, not yours — you read its table, not the routing.

## Step 1 — collect the diff, without reading it

Parse the argument:

- empty or `--local` → `git diff HEAD` plus untracked files as `--no-index` diffs
- `--branch <name>` → merge-base against `origin/master` (fall back `origin/main`),
  then `git diff <base>..<name>`
- `--pr <n|url>` → the PR's head SHA and diff (GitHub MCP tools, or `gh`)
- a bare number or a GitHub pull URL → PR mode; anything else → try as a branch

Redirect the diff to `<scratch>/diff.patch` and the changed-file list to
`<scratch>/files.txt`; read back only `--stat` and the file list. Empty diff →
say "nothing to review" and stop. Over 10 MB → stop. Over 1 MB → ask first.

Report: `Reviewing <target>: N files, +A/-B lines — tier <0|1>.`

## Step 2 — compile gate

Spawn `gate-runner` with `phase: compile` and wait for it. Reviewers on code
that does not compile are wasted opus tokens: if `make check` or `make build`
fails, the verdict is **BLOCK** with the failing lines from its reply, and no
reviewer is spawned.

With `--quick`, this is the only gate phase: `gate-runner` gets `phase: quick`
and lists every routed-but-unrun target as `NOT RUN`. Never let "not run" read
as "passed".

With `--review-only`, the environment is expected to lack the toolchain (Odin,
LLVM, JavaScriptCore, SQLite, OpenSSL, vite-plus) and a separate CI job is
running the gates on the same commit. Skip this step; `gate-runner` gets
`phase: ci` in step 3 and reads CI's conclusions for the exact SHA instead of
reproducing them. This mode requires a target that resolves to an exact SHA —
`--pr <n>` or `--branch <name>`; it is meaningless with `--local`. Verdict
rules for delegated gates are in
[pr-gate-reference/scoring.md](pr-gate-reference/scoring.md).

## Step 3 — fan out

Launch, **in one message**, `gate-runner` with `phase: suites` (or `ci`) and
every reviewer the tier and the paths call for, each with the brief template
from [conductor.md](conductor.md).

| Agent                     | Model  | Run when                                                                                                                                                                                                                        |
| ------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `quality-docs-auditor`    | sonnet | always                                                                                                                                                                                                                          |
| `regression-hunter`       | opus   | tier 1                                                                                                                                                                                                                          |
| `oracle-test-auditor`     | opus   | tier 1 — tell it the profile if you know it                                                                                                                                                                                     |
| `safety-security-auditor` | opus   | any `.odin` changed; `pkg/jsc`; parsing (HTTP, HTML), networking, TLS/crypto, sessions/cookies, VM pool or page lifecycle, the Window profile's global set, fs paths, URL handling, module loader, native code fed by JS values |
| `perf-memory-auditor`     | opus   | hot paths (buffer, http, net, fetch, url, jsc, eventloop), VM pool or page lifecycle, any `perf(...)` title or perf claim, any `bench/**` change                                                                                |
| `odin-sdk-scout`          | sonnet | the diff hand-rolls a parser, codec, hash, container, socket dance, or time/number/string conversion — or `quality-docs-auditor` came back with a `Lens: reuse` suspicion it could not settle                                   |

Reviewers are read-only: `constraints: read-only` in every brief. In
`--review-only` mode add `toolchain absent` — they have Bash and will otherwise
try to build and report the failure as a finding.

## Step 4 — adjudicate

Follow **Adjudication** in [conductor.md](conductor.md): rule on every P0 and
P1 from the cited lines, merge duplicates, cross-check the two criteria, look
for what no report mentions, record a failed worker as `failed`. Then:

- Drop nits already implied by a P1 in the same place.
- A later gate failing is a finding, not a stop: it enters the report with the
  reviewer finding that explains it, or as an unexplained P0 if none does.
- An `oracle-test-auditor` parity verdict of `unverified (no Chrome oracle)` is
  not a pass: grade criterion 1 `C` (see scoring.md).
- You may add a short **Policy** section for violations of `CLAUDE.md` §2 and
  §4 (reuse law, file-size, layer, `*_host` measurement rule) that no reviewer
  covered — with `file:line` evidence only.

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

P2 / nit: <count>, in <scratch>/<agent>.md

Rejected / demoted: <n> — <finding → one-line reason each>
Verdict: SHIP | SHIP-AFTER | BLOCK
Workers: <n> run, <failed: …>
```

Under the scorecard, say in two or three sentences what is actually wrong with
the change and what you would do about it — the ruling, not a restatement of
the list.

Then offer the fix round: `/odin-feature --fix` hands the confirmed P0/P1 list
to `odin-implementer`. Fixing is not part of this command; `/pr-gate` never
edits the tree.

## Step 6 — optional PENDING GitHub review

Only with `--pr` **and** `--post-pending` **and** at least one actionable finding.
Build the review JSON with no `event` field so it stays PENDING, inline comments
only for `(file,line)` pairs present on the RIGHT side of the PR diff, everything
else promoted into the body, then
`gh api repos/{owner}/{repo}/pulls/{n}/reviews --input <file>`.

Never submit (approve/request-changes) on the user's behalf. Never post an empty
review.

## Rules

- Conduct; do not deep-review the diff yourself and do not run a gate yourself.
- Report gate results faithfully. A skipped gate is reported as skipped.
- Every rejected or demoted P0/P1 is listed with its reason — a ruling the
  human cannot see is a waiver.
- Fewer, high-conviction findings beat volume.
- No emojis.
