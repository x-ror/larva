// Pages-per-thread benchmark for #4: N concurrent trivial pages on one thread's page
// runner, reporting process RSS growth, start-up time on a cold and on a warm VM, and
// sustained pages/s with N in flight.
//
// Run:   make bench-pages   (N = 1, 10, 50, 100; medians of 5 launches per N)
// One:   odin build bench/pages -collection:lava=. -o:speed -out:<bin>; <bin> <N> [total] [budget]
//        (one N per process, so "cold" really is a VM that has run nothing)
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
import "core:time"
import lava "lava:pkg/runtime"

TRIVIAL :: "let x = 0; setTimeout(() => { x++; }, 0);"
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
}

discard :: proc(runner: ^lava.Page_Runner, user_data: rawptr, result: lava.Result) {
	result := result
	r := cast(^Round)user_data
	r.finished += 1
	if result.status != .Ok {
		r.failed += 1
		// One line per round is enough to say why; a refused churn round would
		// otherwise print `total` identical lines.
		if r.failed == 1 do fmt.eprintln("page failed:", result.status, result.message)
	}
	if r.opened < r.total {
		r.opened += 1
		lava.page_runner_open(runner, TRIVIAL, "<bench>", r.limits, r)
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
		fmt.eprintln("usage: bench-pages <N> [total] [budget]")
		os.exit(2)
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

	runner: lava.Page_Runner
	if !lava.page_runner_init(&runner, n, discard, context.allocator) {
		fmt.eprintln("page_runner_init failed")
		os.exit(1)
	}
	defer lava.page_runner_destroy(&runner)

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
	}
	start := time.tick_now()
	for _ in 0 ..< min(n, total) {
		churn.opened += 1
		lava.page_runner_open(&runner, TRIVIAL, "<bench>", limits, &churn)
	}
	lava.page_runner_run(&runner)
	secs := time.duration_seconds(time.tick_since(start))
	rss_end := rss_kb()

	_, created := lava.vm_pool_stats(&runner.pool)
	fmt.printf(
		"N=%d cold_ms=%.2f warm_ms=%.2f rss_growth_kb_per_live_page=%d rss_growth_kb_per_vm=%d pages_per_s=%.0f total=%d cold_failed=%d warm_failed=%d churn_failed=%d vms=%d\n",
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
	)
	if cold.failed + warm.failed + churn.failed > 0 do os.exit(1)
}
