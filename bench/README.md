# Benchmarks

Micro and macro benchmarks for the Lava runtime, measured **against Node as the oracle**
— the same ground-truth model the correctness tests use. Both runtimes run the identical
benchmark file on the same machine, so the reported **lava/node ratio** cancels the
machine's absolute speed and is what we compare and gate on.

## Run

```sh
make bench         # node-vs-Lava ratio table, report-only (never fails)
make bench-gate    # same, but fails if any ratio exceeds its cap in thresholds.json
```

Both build `bin/lava` first. Honor `NODE_BIN` / `LAVA_BIN` like the oracle runners:

```sh
LAVA_BIN=/path/to/lava NODE_BIN=/path/to/node ./scripts/run-bench.sh [--gate]
```

If `lava` is not runnable, the runner prints the Node baseline only (no ratios, no gate),
so the harness itself can be smoke-tested anywhere Node is present.

## Layout

- `lib/harness.js` — `bench(name, fn, opts)`: warms up, then times `iterations` calls of
  `fn` over `reps` repetitions and reports the **best** (min) wall time as a
  `##BENCH## {json}` line. Best-of-K suppresses GC/scheduler jitter. Runs under both Node
  and Lava (CommonJS; uses `performance.now()`, which both expose).
- `micro/` — `json`, `buffer`, `require` (cache-hit lookups); plus `noop.js`, the startup
  target spawned repeatedly to measure process boot.
- `macro/` — `fs` (64 KiB write+read throughput). Fetch throughput is a planned addition
  (needs a local origin, like the fetch smoke test).
- `run.mjs` — the orchestrator (Node): runs every bench under both runtimes, measures
  startup externally, prints the table, and applies the gate. All parsing/timing lives
  here (portable; no shell JSON parsing). `scripts/run-bench.sh` is a thin wrapper.
- `thresholds.json` — per-benchmark gate caps (max acceptable lava/node ratio).

## The gate, and calibrating it

`thresholds.json` ships with **generous starter caps**: they catch only catastrophic
regressions and are not meant to flake. CI currently runs `make bench` (report-only) so
the ratio table shows in the job log without ever failing the build.

To turn the gate on:

1. Run `make bench` (locally or read a CI run's table) to observe Lava's real ratios.
2. Tighten each cap in `thresholds.json` toward its observed ratio, leaving headroom for
   CI noise (a cap of ~1.5–2× the observed ratio is a reasonable start).
3. Flip the CI step from `make bench` to `make bench-gate` (`.github/workflows/ci.yml`).

A benchmark with no entry in `thresholds.json` is always report-only.

## Pages per thread (`make bench-pages`)

`bench/pages` drives N = 1, 10, 50 and 100 concurrent trivial pages on one thread's
page runner (#4) and reports, per N, the median of 5 launches (one process per N per
launch, so a "cold" VM really has run nothing):

| metric | meaning |
| --- | --- |
| `cold_ms` | mean `page_runner_open` of the first N pages, each on a fresh VM: Node-profile runtime install plus a one-timer script |
| `warm_ms` | the same for the next N pages on the same VMs (JSC CodeCache warm) |
| `rss_growth_kb_per_live_page` | whole-process VmRSS growth with N pages just opened, divided by N; includes JSC's one-time process init |
| `rss_growth_kb_per_vm` | whole-process VmRSS growth after `TOTAL` pages of churn, divided by VMs created (see below) |
| `pages_per_s` | sustained, N pages in flight, `TOTAL` pages in all |
| `*_failed` | pages of each round that did not finish `.Ok`; any makes the launch exit 1 |

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

| N | cold_ms | warm_ms | rss_growth_kb_per_live_page | rss_growth_kb_per_vm | pages_per_s |
| --- | --- | --- | --- | --- | --- |
| 1 | 28.95 | 9.88 | 23808 | 59216 | 111 |
| 10 | 23.49 | 10.6 | 6233 | 26254 | 109 |
| 50 | 23.93 | 10.17 | 4659 | 19701 | 113 |
| 100 | 24.44 | 10.94 | 4463 | 18688 | 107 |

Read: a page's start-up is dominated by the runtime install, cold or warm, so
throughput is CPU-bound and flat in N on one thread.
