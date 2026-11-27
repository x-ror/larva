# Benchmarks

Micro and macro benchmarks for the Lava runtime. Since the Node profile went (#130)
`lava run` executes a page with the Window globals only, so the micro benches are page
scripts and their yardstick is **Lava itself**: every number is absolute (ns per
operation), measured on two binaries — a **baseline** and the one under test — on the
same machine, interleaved launch by launch. The **new/base ratio** is what a change is
judged on and what `make bench-gate` enforces.

## Run

```sh
make bench         # new-vs-base ns/op table, report-only (never fails on timing)
make bench-gate    # same, but fails if any new/base ratio exceeds its cap in thresholds.json
```

Both build `bin/lava` (the binary under test) first. The baseline:

```sh
make bench                         # origin/master, built once in a temporary git worktree
make bench BASE_REF=HEAD~1         # any ref; cached by sha under bin/bench-base/<sha>/lava
make bench BASE=/path/to/lava      # an existing binary
make bench BASE=bin/lava           # A/A: both sides the same binary, every ratio is noise
make bench BASE=none               # absolute numbers only (bench-gate refuses this)
```

`BENCH_LAUNCHES` (default 5) sets launches per binary; every number is their median.
`BENCH_STARTUP_REPS` (default 10) sets spawns per launch for `startup`, best of. A default
run takes about 1.5 minutes on 4 cores, plus ~15 s the first time a baseline is built.

## Layout

- `lib/harness.js` — `bench(name, fn, opts)` and `benchAsync(name, fn, opts)`: warm up,
  time `iterations` calls over `reps` repetitions, report the **best** repetition as a
  `##BENCH## {json}` line with `nsPerOp`, then `##BENCH-DONE##`. Not a module: a page has
  no `require`, so `run.mjs` prepends it to each bench file and runs the concatenation as
  one classic script. Async benches (Blob reads) await every call.
- `micro/` — `encoding` (TextDecoder routes, TextEncoder, btoa/atob), `url`
  (URL shapes, URLSearchParams), `json`, `blob`, `structured-clone`, `fetch` (Headers,
  Request, Response construction), `events` (EventTarget dispatch, AbortController); plus
  `noop.js`, the start-up target spawned repeatedly and timed from outside (no harness).
  Each file runs under Window globals only — no `require`, `process` or `Buffer`.
- `run.mjs` — the orchestrator (Node only drives the runs): resolves or builds the
  baseline, runs every bench file under both binaries, alternating which goes first each
  launch, measures start-up externally, prints the table and applies the gate.
  `scripts/run-bench.sh` is a thin wrapper.
- `thresholds.json` — the gate's caps: max acceptable new/base ratio per benchmark.

There is no Chrome column. Chrome is the oracle for page-facing behaviour, and would be
the natural yardstick for page-facing speed, but the headless runner the web oracle uses
(`scripts/lib/web-oracle.mjs`) drives Chrome through `--dump-dom`, which reads the DOM at
the load event — before an async benchmark settles — and under `--virtual-time-budget`
the clock stands still inside a task, so a Blob read would time as zero. A Chrome column
needs Chrome driven over DevTools instead; until then, absolute numbers against a
baseline answer what a change needs: did it make Lava slower.

## The gate, and calibrating it

`make bench-gate` fails when, for any benchmark, the median-of-launches new/base ratio
exceeds its cap, when a bench file fails or never reports `##BENCH-DONE##` under the
binary under test, when either binary cannot run, or when no baseline is given. Every
benchmark is gated: by its entry in `caps`, else by `default_cap`, unless it is listed in
`report_only`, so a new bench cannot land unmonitored. A benchmark the baseline cannot run
(new coverage, or an API the base lacks) has no ratio and is shown as `-`.

It is **local only**: CI does not run it, because a ratio between two builds is only
meaningful with the baseline built on the same runner, which doubles the build. Run it
for anything on a hot path, and for every `perf(...)` change.

The caps were set from A/A runs (`BASE=bin/lava`, the same binary on both sides), which
measure exactly the noise the gate must not fire on; `thresholds.json` records the
observed spread beside them. A cap is a regression net sized above that noise, not a
target — to tighten one, re-measure A/A on the box you care about first.

## Pages per thread (`make bench-pages`)

`bench/pages` drives N = 1, 10, 50 and 100 concurrent trivial pages on one thread's
page runner (#4) and reports, per N, the median of 5 launches (one process per N per
launch, so a "cold" VM really has run nothing):

| metric                        | meaning                                                                                                                |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `cold_ms`                     | mean `page_runner_open` of the first N pages, each on a fresh VM: Node-profile runtime install plus a one-timer script |
| `warm_ms`                     | the same for the next N pages on the same VMs (JSC CodeCache warm)                                                     |
| `rss_growth_kb_per_live_page` | whole-process VmRSS growth with N pages just opened, divided by N; includes JSC's one-time process init                |
| `rss_growth_kb_per_vm`        | whole-process VmRSS growth after `TOTAL` pages of churn, divided by VMs created (see below)                            |
| `pages_per_s`                 | sustained, N pages in flight, `TOTAL` pages in all                                                                     |
| `*_failed`                    | pages of each round that did not finish `.Ok`; any makes the launch exit 1                                             |

`rss_growth_kb_per_vm` is an upper bound, not the steady-state cost of an idle pooled
VM: it lumps together JSC's process init, each VM's heap as left uncollected
(`vm_release` runs no GC) and malloc's high-water mark, and with `TOTAL` fixed a
per-VM cost cannot be told from a per-page-run one. At N = 1 both RSS columns are
dominated by the one-off process init.

Report-only; CI runs only `make test-bench-pages-smoke`, which checks that the bench
runs and fails on a refused page, not its numbers. Measured at commit `aee73e1` on 4
cores, Intel Xeon @ 2.10GHz (CI-class Ubuntu runner), one thread used: `make
bench-pages` (`-o:speed`), every page with `cpu_budget` = 30 s of thread CPU
(`BENCH_LIMITS`), `TOTAL` = 1000 pages per launch, medians of 5 launches per N,
interleaved (each round runs N = 1, 10, 50, 100 once):

| N   | cold_ms | warm_ms | rss_growth_kb_per_live_page | rss_growth_kb_per_vm | pages_per_s |
| --- | ------- | ------- | --------------------------- | -------------------- | ----------- |
| 1   | 28.95   | 9.88    | 23808                       | 59216                | 111         |
| 10  | 23.49   | 10.6    | 6233                        | 26254                | 109         |
| 50  | 23.93   | 10.17   | 4659                        | 19701                | 113         |
| 100 | 24.44   | 10.94   | 4463                        | 18688                | 107         |

Read: a page's start-up is dominated by the runtime install, cold or warm, so
throughput is CPU-bound and flat in N on one thread.
