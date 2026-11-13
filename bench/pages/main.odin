// Pages-per-thread benchmark for #4: N concurrent trivial pages on one thread's page
// runner, reporting RSS per live page, start-up time on a cold and on a warm VM, and
// sustained pages/s with N in flight.
//
// Run:   make bench-pages   (N = 1, 10, 50, 100; medians of 5 launches per N)
// One:   odin build bench/pages -collection:lava=. -o:speed -out:<bin>; <bin> <N> [total]
//        (one N per process, so "cold" really is a VM that has run nothing)
//
// Metrics, all from one process:
//   cold_ms        mean wall time of page_runner_open for the first N pages, each on a
//                  VM that has never run anything (runtime install + top-level script)
//   warm_ms        the same for the next N pages, on the same VMs (CodeCache warm)
//   live_kb_page   (RSS with N pages just opened - RSS before) / N
//   idle_kb_vm     (RSS after `total` pages of churn - RSS before) / VMs created: what
//                  a pooled VM keeps between pages
//   pages_per_s    sustained, N pages in flight, `total` pages in all
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

Churn :: struct {
	opened, finished, failed, total: int,
}

discard :: proc(runner: ^lava.Page_Runner, user_data: rawptr, result: lava.Result) {
	result := result
	if user_data != nil {
		c := cast(^Churn)user_data
		c.finished += 1
		if result.status != .Ok do c.failed += 1
		if c.opened < c.total {
			c.opened += 1
			lava.page_runner_open(runner, TRIVIAL, "<bench>", {}, c)
		}
	} else if result.status != .Ok {
		fmt.eprintln("page failed:", result.message)
	}
	lava.result_destroy(&result)
}

// open_n opens n pages and returns the mean ms per page_runner_open (runtime install
// plus top-level script, the whole synchronous start-up of a page).
open_n :: proc(runner: ^lava.Page_Runner, n: int, source: string) -> f64 {
	start := time.tick_now()
	for _ in 0 ..< n do lava.page_runner_open(runner, source, "<bench>", {}, nil)
	return time.duration_milliseconds(time.tick_since(start)) / f64(n)
}

main :: proc() {
	if len(os.args) < 2 {
		fmt.eprintln("usage: bench-pages <N> [total]")
		os.exit(2)
	}
	n, _ := strconv.parse_int(os.args[1])
	total := 2000
	if len(os.args) > 2 do total, _ = strconv.parse_int(os.args[2])
	n = max(n, 1)

	runner: lava.Page_Runner
	if !lava.page_runner_init(&runner, n, discard, context.allocator) {
		fmt.eprintln("page_runner_init failed")
		os.exit(1)
	}
	defer lava.page_runner_destroy(&runner)

	rss_base := rss_kb()
	// Round 1: every page gets a VM that has never run anything.
	cold_ms := open_n(&runner, n, WAITING)
	rss_live := rss_kb()
	lava.page_runner_run(&runner)
	// Round 2: the same VMs again, CodeCache warm.
	warm_ms := open_n(&runner, n, WAITING)
	lava.page_runner_run(&runner)

	// Sustained churn: n pages in flight, `total` pages in all.
	c := Churn {
		total = total,
	}
	start := time.tick_now()
	for _ in 0 ..< min(n, total) {
		c.opened += 1
		lava.page_runner_open(&runner, TRIVIAL, "<bench>", {}, &c)
	}
	lava.page_runner_run(&runner)
	secs := time.duration_seconds(time.tick_since(start))
	rss_end := rss_kb()

	_, created := lava.vm_pool_stats(&runner.pool)
	fmt.printf(
		"N=%d cold_ms=%.2f warm_ms=%.2f live_kb_page=%d idle_kb_vm=%d pages_per_s=%.0f total=%d failed=%d vms=%d\n",
		n,
		cold_ms,
		warm_ms,
		(rss_live - rss_base) / n,
		(rss_end - rss_base) / max(created, 1),
		f64(c.finished) / secs,
		c.finished,
		c.failed,
		created,
	)
	if c.failed > 0 do os.exit(1)
}
