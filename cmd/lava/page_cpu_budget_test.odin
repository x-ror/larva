// Linux-only: the budget reads CLOCK_THREAD_CPUTIME_ID through core:sys/posix and eval
// only runs in a pooled VM off Windows. Darwin compiles the same code but is not run
// in CI.
#+build linux
package main

import "core:strings"
import "core:testing"
import jsc "lava:pkg/jsc"
import lava "lava:pkg/runtime"
import eventloop "lava:pkg/runtime/eventloop"

@(private = "file")
eval_limited :: proc(src: string, limits: lava.Page_Limits) -> lava.Result {
	loop := eventloop.init(real_time = true)
	return lava.eval(src, "<cpu-budget-test>", &loop, false, limits = limits)
}

// A page that never runs one long entry — thousands of 2 ms timer callbacks, ~10 s
// of CPU in total — slips under any per-entry limit. The cumulative budget is what
// stops it, and it stops it near the budget, not after the whole run.
@(test)
cpu_budget_kills_timer_spinner :: proc(t: ^testing.T) {
	src := `
	let n = 0;
	function spin() {
		const s = Date.now();
		while (Date.now() - s < 2) {}
		if (++n < 5000) setTimeout(spin, 0);
	}
	setTimeout(spin, 0);
	`
	before := thread_cpu_seconds()
	result := eval_limited(src, {entry_limit = 1, cpu_budget = 0.2})
	defer lava.result_destroy(&result)
	spent := thread_cpu_seconds() - before

	testing.expect_value(t, result.status, lava.Status.Execution_Error)
	testing.expect_value(t, result.kill, lava.Kill_Reason.Cpu_Budget)
	testing.expectf(t, strings.contains(result.message, "CPU budget"), "unexpected message: %q", result.message)
	// 0.2 s budget plus page setup and one callback of overshoot; the unkilled run
	// costs ~10 s.
	testing.expectf(t, spent < 1.0, "page ran %.3fs of CPU past a 0.2s budget", spent)
}

// One synchronous entry longer than the remaining budget is cut off by the watchdog,
// clamped to what is left, even with no per-entry limit at all.
@(test)
cpu_budget_clamps_a_single_entry :: proc(t: ^testing.T) {
	result := eval_limited("while (true) {}", {cpu_budget = 0.15})
	defer lava.result_destroy(&result)
	testing.expect_value(t, result.status, lava.Status.Execution_Error)
	testing.expect_value(t, result.kill, lava.Kill_Reason.Cpu_Budget)
}

// The per-entry limit kills a runaway top-level script and says so.
@(test)
entry_limit_kills_runaway_top_level :: proc(t: ^testing.T) {
	result := eval_limited("while (true) {}", {entry_limit = 0.1, cpu_budget = 30})
	defer lava.result_destroy(&result)
	testing.expect_value(t, result.status, lava.Status.Execution_Error)
	testing.expect_value(t, result.kill, lava.Kill_Reason.Entry_Limit)
	testing.expectf(
		t,
		strings.contains(result.message, "execution time limit"),
		"unexpected message: %q",
		result.message,
	)
}

// A runaway callback kills the whole page: the interval that would otherwise keep
// the loop alive forever must not keep running after the kill.
@(test)
entry_limit_kill_in_callback_stops_the_page :: proc(t: ^testing.T) {
	src := `
	setInterval(() => {}, 1);
	setTimeout(() => { while (true) {} }, 5);
	`
	result := eval_limited(src, {entry_limit = 0.1})
	defer lava.result_destroy(&result)
	testing.expect_value(t, result.status, lava.Status.Execution_Error)
	testing.expect_value(t, result.kill, lava.Kill_Reason.Entry_Limit)
}

// A page under its budget is unaffected: it runs to completion with status Ok.
@(test)
cpu_budget_spares_a_page_under_budget :: proc(t: ^testing.T) {
	src := `let k = 0; for (let i = 0; i < 20; i++) setTimeout(() => { k++; }, 0);`
	result := eval_limited(src, {entry_limit = 1, cpu_budget = 5})
	defer lava.result_destroy(&result)
	testing.expect_value(t, result.status, lava.Status.Ok)
	testing.expect_value(t, result.kill, lava.Kill_Reason.None)
}

// The budget and the time spent belong to the page that held the VM: release clears
// them, so the next page on a reused VM starts at zero with no budget armed.
//
// The second page burns CPU, not wall time (spin_thread_cpu). The kill latched the watchdog at its 1 ms
// floor, so if release leaves it armed, JSC terminates the next entry once that
// entry has used 1 ms of thread CPU (and the watchdog timer has run since). This page used
// to spin 150 ms of wall time, and on a loaded runner that bought it too little CPU:
// with 64 busy loops pinned to its one core (`taskset -c 0`) the entry got 3.3-3.6 ms
// of CPU (14 instrumented runs) and the mutation that drops the clear survived 5 of
// 40 runs, as it once did in CI (mutation shard 3/3 on x-ror/larva#53). Spinning to
// 100 ms of thread CPU — 100x the floor whatever the load — killed that mutation in
// 40 of 40 runs under the same load and passed 8 of 8 unmutated. The passing run
// costs no more: 208 ms against 260 ms for the whole test, one unloaded run each.
@(test)
cpu_budget_is_cleared_on_release :: proc(t: ^testing.T) {
	pool: lava.VM_Pool
	lava.vm_pool_init(&pool, 1, context.allocator)
	defer lava.vm_pool_destroy(&pool)

	vm, _ := lava.vm_acquire(&pool)

	if vm == nil {
		testing.fail_now(t, "no VM")
	}

	lava.vm_set_cpu_budget(vm, 0.1)
	ctx := lava.vm_create_context(vm, nil)
	lava.vm_cpu_enter(vm)
	s := jsc.JSStringCreateWithUTF8CString("while (true) {}")
	exc: jsc.JSValueRef
	jsc.JSEvaluateScript(cast(jsc.JSContextRef)ctx, s, nil, nil, 1, &exc)
	jsc.JSStringRelease(s)
	lava.vm_cpu_exit(vm)
	testing.expect(t, exc != nil, "runaway entry was not terminated by the budget")
	testing.expect(t, vm.budget_hit, "termination not attributed to the budget")
	testing.expect(t, !vm.limit_hit, "budget kill misattributed to the entry limit")
	testing.expect_value(t, lava.vm_kill_reason(vm), lava.Kill_Reason.Cpu_Budget)
	jsc.JSGlobalContextRelease(ctx)
	lava.vm_release(vm)

	vm2, _ := lava.vm_acquire(&pool)
	testing.expect(t, vm2 == vm, "pool did not reuse its only VM")
	testing.expect(t, !vm2.budget_hit, "budget_hit survived release")
	testing.expect_value(t, lava.vm_kill_reason(vm2), lava.Kill_Reason.None)
	testing.expect(t, vm2.cpu_budget_ns == 0, "budget survived release")
	testing.expect_value(t, vm2.cpu_used_ns, 0)
	ctx2 := lava.vm_create_context(vm2, nil)
	lava.vm_cpu_enter(vm2)
	completed := spin_thread_cpu(t, ctx2)
	lava.vm_cpu_exit(vm2)
	testing.expect(t, completed, "a cleared budget still terminated the next page")
	jsc.JSGlobalContextRelease(ctx2)
	lava.vm_release(vm2)
}

// The watchdog must follow the budget LEFT, not the budget set: after ~0.85 s of a
// 1 s budget spent in short callbacks, a runaway entry gets ~0.15 s, not a fresh 1 s.
// Without the re-arm in vm_cpu_enter the page runs ~1.85 s. The page counts the time
// it spun itself, not the wall clock since it started: past nesting level 5 its 0 ms
// chain waits 4 ms between callbacks (the HTML timer clamp), idle time a wall-clock
// count would take for CPU — with 2 ms spins, only ~0.3 s was spent by the 850 ms mark
// and the test passed with the re-arm deleted.
@(test)
cpu_budget_clamps_to_the_budget_left :: proc(t: ^testing.T) {
	src := `
	let spun = 0;
	function spin() {
		const s = Date.now();
		while (Date.now() - s < 10) {}
		spun += Date.now() - s;
		if (spun < 850) setTimeout(spin, 0);
		else setTimeout(() => { while (true) {} }, 0);
	}
	setTimeout(spin, 0);
	`
	before := thread_cpu_seconds()
	result := eval_limited(src, {cpu_budget = 1.0})
	defer lava.result_destroy(&result)
	spent := thread_cpu_seconds() - before
	testing.expect_value(t, result.kill, lava.Kill_Reason.Cpu_Budget)
	testing.expectf(t, spent < 1.35, "runaway entry was given %.3fs of CPU against a 1s budget", spent)
}

// Nested enters are one stretch: only the outermost pair reads the clock, so time
// inside a nested pair is charged once.
@(test)
cpu_nested_enter_charges_once :: proc(t: ^testing.T) {
	pool: lava.VM_Pool
	lava.vm_pool_init(&pool, 1, context.allocator)
	defer lava.vm_pool_destroy(&pool)
	vm, _ := lava.vm_acquire(&pool)

	if vm == nil {
		testing.fail_now(t, "no VM")
	}

	defer lava.vm_release(vm)
	lava.vm_set_cpu_budget(vm, 100)

	burn :: proc(seconds: f64) {
		s := thread_cpu_seconds()
		for thread_cpu_seconds() - s < seconds {}
	}
	before := thread_cpu_seconds()
	lava.vm_cpu_enter(vm)
	burn(0.04)
	lava.vm_cpu_enter(vm)
	burn(0.03)
	lava.vm_cpu_exit(vm)
	burn(0.03)
	lava.vm_cpu_exit(vm)
	wall := thread_cpu_seconds() - before
	used := f64(vm.cpu_used_ns) / 1e9
	testing.expectf(t, used <= wall + 0.005, "nested stretch charged %.3fs for %.3fs of CPU", used, wall)
	testing.expectf(t, used >= 0.095, "only %.3fs of a ~0.1s stretch was charged", used)
}

// A killed page leaves nothing behind for the next eval on the thread's pool: the
// next page runs unlimited and completes.
//
// The next page must burn CPU, not wall time: the kill latched the watchdog at its
// 1 ms floor, and a leaked watchdog cuts an entry only once it has used that much
// thread CPU (see spin_thread_cpu for why a wall-time spin can miss it under load).
// lava.eval builds its own context, so there is no bare context to put a `cpu()` on
// before the script runs; the page does a fixed amount of work instead, sized so the
// loop alone costs ~100x the floor on a fast machine and more on a slow or loaded
// one. Measured through lava.eval on this thread, three unloaded runs each: 3e8
// iterations took 147-173 ms of thread CPU, an empty page 2.8 ms, and the 150 ms
// wall-time spin it replaces 152 ms. `| 0` keeps the sum an int32 and the global
// write keeps the loop observable, so neither tier can drop it.
@(test)
eval_after_a_killed_page_runs_unlimited :: proc(t: ^testing.T) {
	killed := eval_limited("while (true) {}", {cpu_budget = 0.05})
	lava.result_destroy(&killed)
	loop := eventloop.init(real_time = true)
	result := lava.eval("var x = 0; for (var i = 0; i < 3e8; i++) x = (x + i) | 0;", "<after-kill>", &loop, false)
	defer lava.result_destroy(&result)
	// The kill reason first: it names the leaked watchdog, where a bare
	// Execution_Error could be anything.
	testing.expect_value(t, result.kill, lava.Kill_Reason.None)
	testing.expect_value(t, result.status, lava.Status.Ok)
}

// Many timers due in ONE tick: each is a fresh entry with a fresh watchdog window, so
// only a per-callback charge stops this near the budget (the review case behind
// vm_cpu_checkpoint). Unchecked it runs 5000 x 2 ms.
@(test)
cpu_budget_kills_many_timers_in_one_tick :: proc(t: ^testing.T) {
	src := `
	for (let i = 0; i < 5000; i++) setTimeout(() => { const s = Date.now(); while (Date.now() - s < 2) {} }, 0);
	`
	before := thread_cpu_seconds()
	result := eval_limited(src, {cpu_budget = 0.2})
	defer lava.result_destroy(&result)
	spent := thread_cpu_seconds() - before
	testing.expect_value(t, result.kill, lava.Kill_Reason.Cpu_Budget)
	testing.expectf(t, spent < 1.0, "one tick ran %.3fs of CPU past a 0.2s budget", spent)
}

// A kill must latch. After the watchdog cuts an entry, JSC still drains the promise
// jobs queued before the cut as that entry returns, and the next nextTick drain pass
// is a fresh entry: each used to get a fresh window of the armed limit, so a page
// spent about twice its budget (measured against JSC 2.52: 0.202 s for a 0.1 s
// limit, one probe run). Margins: the latched page stops near 0.5 s plus setup; the
// unlatched one runs ~1.0 s.
@(test)
cpu_budget_kill_latches_over_queued_microtasks :: proc(t: ^testing.T) {
	src := `
	function spin() { const s = Date.now(); while (Date.now() - s < 2) {} }
	let n = 0;
	function f() { spin(); if (++n < 1000) Promise.resolve().then(f); }
	Promise.resolve().then(f);
	while (true) {}
	`
	before := thread_cpu_seconds()
	result := eval_limited(src, {cpu_budget = 0.5})
	defer lava.result_destroy(&result)
	spent := thread_cpu_seconds() - before
	testing.expect_value(t, result.kill, lava.Kill_Reason.Cpu_Budget)
	testing.expectf(t, spent < 0.75, "killed page ran %.3fs of CPU against a 0.5s budget", spent)
}

// Same latch for the entry limit: the window the queued jobs get must not be a fresh
// entry_limit. Latched ~0.3 s; unlatched ~0.6 s.
@(test)
entry_limit_kill_latches_over_queued_microtasks :: proc(t: ^testing.T) {
	src := `
	function spin() { const s = Date.now(); while (Date.now() - s < 2) {} }
	let n = 0;
	function f() { spin(); if (++n < 1000) Promise.resolve().then(f); }
	Promise.resolve().then(f);
	while (true) {}
	`
	before := thread_cpu_seconds()
	result := eval_limited(src, {entry_limit = 0.3, cpu_budget = 30})
	defer lava.result_destroy(&result)
	spent := thread_cpu_seconds() - before
	testing.expect_value(t, result.kill, lava.Kill_Reason.Entry_Limit)
	testing.expectf(t, spent < 0.45, "killed page ran %.3fs of CPU against a 0.3s entry limit", spent)
}
