// Pages-per-thread benchmark for #4: N concurrent trivial pages on one thread's page
// runner, reporting process RSS growth, start-up time on a cold and on a warm VM, and
// sustained pages/s with N in flight.
//
// Run:   make bench-pages   (N = 1, 10, 50, 100; medians of 5 launches per N; then the
//        heap-sampling and dispatcher arms below)
// One:   odin build bench/pages -collection:lava=. -o:speed -out:<bin>;
//        <bin> <N> [total] [budget] [heap_every] [shape]
//        (one N per process, so "cold" really is a VM that has run nothing)
//        heap_every  sample every Nth page's heap per VM in the churn round (0 = off)
//        shape       trivial (default) | heavy: the page also keeps 50k small objects
//                    alive until it ends, so the heap walk a sample costs is not tiny
// Dispatcher: <bin> dispatch <threads> <slots> [total]
//        `total` trivial pages submitted at once to a page dispatcher with `threads`
//        workers of `slots` pages each; prints pages/s, submit to last on_done.
// Sibling: <bin> sibling <K> <M> [slice_us]
//        one runner thread: M light pages, each pinging setInterval(1) for 900 ms, beside
//        one hog page with K timers due in a single tick (#35). Each light page prints
//        `gap_ms=` (its longest gap between two callbacks), the hog `hog_span_ms=` (its
//        first to last of the K callbacks), and the runner `max_round_ms=`. slice_us is
//        Page_Runner.slice_us (default RUNNER_SLICE_US; 0 = no slicing). M = 0 times
//        the hog alone, for what slicing costs it.
// Retirement: BENCH_RETIRE=off turns VM retirement off for the runner (VM_Pool.
//        retire_after_pages and retire_heap_bytes 0); BENCH_RETIRE=<n> retires every
//        n pages instead of VM_RETIRE_AFTER_PAGES. The churn line reports `retired=`.
// Smoke: make test-bench-pages-smoke (CI) — a small run must report no failed page,
//        and a run with budget 0 must report every page failed and exit 1.
//
// Metrics, all from one process:
//   cold_ms        mean wall time of page_runner_open for the first N pages, each on a
//                  VM that has never run anything (runtime install + top-level script)
//   warm_ms        the same for the next N pages, on the same VMs (CodeCache warm)
//   rss_growth_kb_per_live_page
//                  (VmRSS with N pages just opened - VmRSS before) / N. Whole-process
//                  growth: it includes JSC's one-time process initialisation, paid by
//                  the first VM, so at small N it overstates what one more page costs.
//   rss_growth_kb_per_vm
//                  (VmRSS after `total` pages of churn - VmRSS before) / VMs created.
//                  Also whole-process growth, so it lumps together JSC's process init,
//                  each VM's heap as left uncollected (vm_release runs no GC), malloc's
//                  high-water mark from the churn, and whatever `total` pages leave
//                  behind — with `total` fixed, a per-VM cost and a per-page-run cost
//                  cannot be told apart. It is NOT the steady-state cost of an idle
//                  pooled VM, only this workload's process growth spread over the VMs.
//   pages_per_s    sustained, N pages in flight, `total` pages in all
//   *_failed       pages of each round (cold, warm, churn) that did not finish .Ok —
//                  refused at open, threw, or were killed. Any of them makes the
//                  process exit 1: a refused page returns from page_runner_open at
//                  once, so a round of them would otherwise be timed as a fast start-up.
//
// What "trivial" means here: the full Node-profile runtime install (the Window
// profile does not exist yet, so its install time cannot be measured; see #5) and a
// script that schedules one timer.
package bench_pages

import "core:fmt"
import "core:os"
import "core:strconv"
import "core:strings"
import "core:sync"
import "core:time"
import lava "lava:pkg/runtime"

TRIVIAL :: "let x = 0; setTimeout(() => { x++; }, 0);"
HEAVY :: "globalThis.keep = Array.from({ length: 50000 }, (_, i) => ({ i })); setTimeout(() => {}, 0);"
// Holds the page open (one pending timer) so RSS can be read with all N live.
WAITING :: "setTimeout(() => {}, 200);"

// Since #26 page_runner_open refuses a page without a CPU budget (.Invalid_Input), so
// every page here carries one. Seconds of thread CPU over the page's whole life
// (Page_Limits, vm_pool.odin) — 30, as in page_runner_alloc_test: far above what a
// trivial page uses, so it bounds a runaway without ever ending a page under test.
BENCH_LIMITS :: lava.Page_Limits {
	cpu_budget = 30,
}

rss_kb :: proc() -> int {
	data, err := os.read_entire_file("/proc/self/status", context.temp_allocator)
	if err != nil do return -1
	text := string(data)
	for line in strings.split_lines_iterator(&text) {
		if strings.has_prefix(line, "VmRSS:") {
			n := 0
			for ch in line do if ch >= '0' && ch <= '9' do n = n * 10 + int(ch - '0')
			return n
		}
	}
	return -1
}

// Every page the bench opens carries one of these as user_data, so every completion
// is counted — the cold and warm rounds too, not only the churn. A round with
// `total` 0 never refills; the churn round reopens until `total` pages have run.
Round :: struct {
	opened, finished, failed, total: int,
	limits:                          lava.Page_Limits,
	source:                          string,
	sampled:                         int,
}

discard :: proc(runner: ^lava.Page_Runner, user_data: rawptr, result: lava.Result) {
	result := result
	r := cast(^Round)user_data
	r.finished += 1
	if result.heap_bytes > 0 do r.sampled += 1
	if result.status != .Ok {
		r.failed += 1
		// One line per round is enough to say why; a refused churn round would
		// otherwise print `total` identical lines.
		if r.failed == 1 do fmt.eprintln("page failed:", result.status, result.message)
	}
	if r.opened < r.total {
		r.opened += 1
		lava.page_runner_open(runner, r.source, "<bench>", r.limits, r)
	}
	lava.result_destroy(&result)
}

// open_n opens n pages and returns the mean ms per page_runner_open (runtime install
// plus top-level script, the whole synchronous start-up of a page). page_runner_open
// returns nothing and reports a refusal through on_done like any other end, so
// whether these were really pages is only known from `r.failed` after the round runs.
open_n :: proc(runner: ^lava.Page_Runner, r: ^Round, n: int, source: string) -> f64 {
	start := time.tick_now()
	for _ in 0 ..< n do lava.page_runner_open(runner, source, "<bench>", r.limits, r)
	return time.duration_milliseconds(time.tick_since(start)) / f64(n)
}

main :: proc() {
	if len(os.args) < 2 {
		fmt.eprintln("usage: bench-pages <N> [total] [budget] [heap_every] [trivial|heavy] | dispatch <threads> <slots> [total]")
		os.exit(2)
	}
	if os.args[1] == "dispatch" {
		dispatch_main()
		return
	}
	if os.args[1] == "sibling" {
		sibling_main()
		return
	}
	n, _ := strconv.parse_int(os.args[1])
	total := 2000
	if len(os.args) > 2 do total, _ = strconv.parse_int(os.args[2])
	n = max(n, 1)
	limits := BENCH_LIMITS
	// Only the smoke passes a budget: 0 reproduces a caller that forgot one, which the
	// runner refuses, and the smoke requires that to surface as failed pages and exit 1.
	// An unparseable budget reads as 0 and is refused the same way, never run unbounded.
	if len(os.args) > 3 do limits.cpu_budget, _ = strconv.parse_f64(os.args[3])
	heap_every := 0
	if len(os.args) > 4 do heap_every, _ = strconv.parse_int(os.args[4])
	shape := TRIVIAL
	if len(os.args) > 5 && os.args[5] == "heavy" do shape = HEAVY

	runner: lava.Page_Runner
	if !lava.page_runner_init(&runner, n, discard, context.allocator) {
		fmt.eprintln("page_runner_init failed")
		os.exit(1)
	}
	defer lava.page_runner_destroy(&runner)
	if v, ok := os.lookup_env("BENCH_RETIRE", context.temp_allocator); ok {
		if v == "off" {
			runner.pool.retire_after_pages = 0
			runner.pool.retire_heap_bytes = 0
		} else if every, parsed := strconv.parse_int(v); parsed {
			runner.pool.retire_after_pages = every
		}
	}

	rss_base := rss_kb()
	// Round 1: every page gets a VM that has never run anything.
	cold := Round {
		limits = limits,
	}
	cold_ms := open_n(&runner, &cold, n, WAITING)
	rss_live := rss_kb()
	lava.page_runner_run(&runner)
	// Round 2: the same VMs again, CodeCache warm.
	warm := Round {
		limits = limits,
	}
	warm_ms := open_n(&runner, &warm, n, WAITING)
	lava.page_runner_run(&runner)

	// Sustained churn: n pages in flight, `total` pages in all.
	churn := Round {
		total  = total,
		limits = limits,
		source = shape,
	}
	// Only the churn round samples, so cold/warm stay comparable across arms.
	runner.heap_sample_every = heap_every
	start := time.tick_now()
	for _ in 0 ..< min(n, total) {
		churn.opened += 1
		lava.page_runner_open(&runner, shape, "<bench>", limits, &churn)
	}
	lava.page_runner_run(&runner)
	secs := time.duration_seconds(time.tick_since(start))
	rss_end := rss_kb()

	_, created, retired := lava.vm_pool_stats(&runner.pool)
	fmt.printf(
		"N=%d cold_ms=%.2f warm_ms=%.2f rss_growth_kb_per_live_page=%d rss_growth_kb_per_vm=%d pages_per_s=%.0f total=%d cold_failed=%d warm_failed=%d churn_failed=%d vms=%d heap_every=%d sampled=%d retired=%d rss_growth_kb=%d\n",
		n,
		cold_ms,
		warm_ms,
		(rss_live - rss_base) / n,
		(rss_end - rss_base) / max(created, 1),
		f64(churn.finished) / secs,
		churn.finished,
		cold.failed,
		warm.failed,
		churn.failed,
		created,
		heap_every,
		churn.sampled,
		retired,
		rss_end - rss_base,
	)
	if cold.failed + warm.failed + churn.failed > 0 do os.exit(1)
}

Dispatch_Tally :: struct {
	done, failed: int,
	last:         time.Tick,
}

dispatch_done :: proc(d: ^lava.Page_Dispatcher, user_data: rawptr, result: lava.Result) {
	result := result
	t := cast(^Dispatch_Tally)user_data
	if result.status != .Ok {
		if sync.atomic_add(&t.failed, 1) == 0 do fmt.eprintln("page failed:", result.status, result.message)
	}
	lava.result_destroy(&result)
	sync.atomic_add(&t.done, 1)
}

// dispatch_main: `total` trivial pages submitted at once, timed from the first submit to
// the last on_done. Workers start before the clock, and each worker's VMs are cold on
// its first `slots` pages — the same cold start the runner churn round includes.
dispatch_main :: proc() {
	if len(os.args) < 4 {
		fmt.eprintln("usage: bench-pages dispatch <threads> <slots> [total]")
		os.exit(2)
	}
	threads, _ := strconv.parse_int(os.args[2])
	slots, _ := strconv.parse_int(os.args[3])
	total := 2000
	if len(os.args) > 4 do total, _ = strconv.parse_int(os.args[4])
	tally: Dispatch_Tally
	d: lava.Page_Dispatcher
	if !lava.page_dispatcher_init(&d, threads, slots, dispatch_done) {
		fmt.eprintln("page_dispatcher_init failed")
		os.exit(1)
	}
	start := time.tick_now()
	refused := 0
	for _ in 0 ..< total {
		if !lava.page_dispatcher_submit(&d, TRIVIAL, "<bench>", BENCH_LIMITS, &tally) do refused += 1
	}
	for sync.atomic_load(&tally.done) < total - refused do time.sleep(time.Millisecond)
	secs := time.duration_seconds(time.tick_since(start))
	lava.page_dispatcher_shutdown(&d)
	fmt.printf(
		"mode=dispatch threads=%d slots=%d pages_per_s=%.0f total=%d failed=%d refused=%d\n",
		threads,
		slots,
		f64(tally.done) / secs,
		tally.done,
		tally.failed,
		refused,
	)
	if tally.failed + refused > 0 do os.exit(1)
}

// LIGHT_PAGE is a sibling that wants a turn every millisecond; the longest gap it saw is
// how long another page on its thread held it up.
LIGHT_PAGE :: `
let last = -1, max = 0;
const t0 = performance.now();
const id = setInterval(() => {
  const t = performance.now();
  if (last >= 0 && t - last > max) max = t - last;
  last = t;
  if (t - t0 > 900) { clearInterval(id); console.log('gap_ms=' + max.toFixed(2)); }
}, 1);
`

// hog_page has K timers due at once: they fall due at T, and a 4 ms callback at T-1 holds
// the loop until all of them are, so one tick finds the whole pile due. That 4 ms is the
// floor every arm shares: one callback no quantum can split.
hog_page :: proc(k: int) -> string {
	return fmt.aprintf(
		`
let x = 0, first = 0, done = 0; const o = {{ a: 1 }};
const K = %d;
function f(i) {{
  if (done === 0) first = performance.now();
  x = (x + i * o.a) | 0;
  if (++done === K) console.log('hog_span_ms=' + (performance.now() - first).toFixed(2));
}}
const T = performance.now() + 300;
setTimeout(() => {{ const e = performance.now() + 4; while (performance.now() < e); }}, 299);
for (let i = 0; i < K; i++) setTimeout(f, Math.max(0, Math.round(T - performance.now())), i);
`,
		k,
	)
}

sibling_failed := 0

sibling_done :: proc(runner: ^lava.Page_Runner, user_data: rawptr, result: lava.Result) {
	result := result
	if result.status != .Ok {
		sibling_failed += 1
		fmt.eprintln("page failed:", result.status, result.message)
	}
	lava.result_destroy(&result)
}

// sibling_main: see the header. Web-profile pages, as in the #35 measurements.
sibling_main :: proc() {
	if len(os.args) < 4 {
		fmt.eprintln("usage: bench-pages sibling <K> <M> [slice_us]")
		os.exit(2)
	}
	k, _ := strconv.parse_int(os.args[2])
	m, _ := strconv.parse_int(os.args[3])
	runner: lava.Page_Runner
	if !lava.page_runner_init(&runner, m + 1, sibling_done, context.allocator) {
		fmt.eprintln("page_runner_init failed")
		os.exit(1)
	}
	if len(os.args) > 4 do runner.slice_us, _ = strconv.parse_int(os.args[4])
	for _ in 0 ..< m do lava.page_runner_open(&runner, LIGHT_PAGE, "<light>", BENCH_LIMITS, nil)
	lava.page_runner_open(&runner, hog_page(k), "<hog>", BENCH_LIMITS, nil)
	max_round: f64
	for lava.page_runner_live(&runner) > 0 {
		start := time.tick_now()
		progressed := lava.page_runner_step(&runner)
		if progressed do max_round = max(max_round, time.duration_milliseconds(time.tick_since(start)))
	}
	fmt.printf(
		"mode=sibling K=%d M=%d slice_us=%d max_round_ms=%.2f failed=%d\n",
		k,
		m,
		runner.slice_us,
		max_round,
		sibling_failed,
	)
	lava.page_runner_destroy(&runner)
	if sibling_failed > 0 do os.exit(1)
}
