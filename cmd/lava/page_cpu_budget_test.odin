// Linux-only: the budget reads CLOCK_THREAD_CPUTIME_ID through core:sys/posix and eval
// only runs in a pooled VM off Windows. Darwin compiles the same code but is not run
// in CI.
#+build linux
package main

import "core:strings"
import "core:sys/posix"
import "core:testing"
import jsc "lava:pkg/jsc"
import lava "lava:pkg/runtime"
import eventloop "lava:pkg/runtime/eventloop"

@(private = "file")
thread_cpu_s :: proc() -> f64 {
	ts: posix.timespec
	posix.clock_gettime(.THREAD_CPUTIME_ID, &ts)
	return f64(ts.tv_sec) + f64(ts.tv_nsec) / 1e9
}

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
	before := thread_cpu_s()
	result := eval_limited(src, {entry_limit = 1, cpu_budget = 0.2})
	defer lava.result_destroy(&result)
	spent := thread_cpu_s() - before

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
	testing.expectf(t, strings.contains(result.message, "execution time limit"), "unexpected message: %q", result.message)
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
@(test)
cpu_budget_is_cleared_on_release :: proc(t: ^testing.T) {
	pool: lava.VM_Pool
	lava.vm_pool_init(&pool, 1, context.allocator)
	defer lava.vm_pool_destroy(&pool)

	vm, _ := lava.vm_acquire(&pool)
	if vm == nil do testing.fail_now(t, "no VM")
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
	testing.expect(t, lava.vm_cpu_over_budget(vm), "over-budget VM not reported")
	jsc.JSGlobalContextRelease(ctx)
	lava.vm_release(vm)

	vm2, _ := lava.vm_acquire(&pool)
	testing.expect(t, vm2 == vm, "pool did not reuse its only VM")
	testing.expect(t, !vm2.budget_hit, "budget_hit survived release")
	testing.expect(t, !lava.vm_cpu_over_budget(vm2), "over-budget state survived release")
	testing.expect(t, vm2.cpu_budget_ns == 0, "budget survived release")
	testing.expect_value(t, vm2.cpu_used_ns, 0)
	ctx2 := lava.vm_create_context(vm2, nil)
	lava.vm_cpu_enter(vm2)
	s2 := jsc.JSStringCreateWithUTF8CString("var s = Date.now(); while (Date.now() - s < 150) {}")
	exc2: jsc.JSValueRef
	jsc.JSEvaluateScript(cast(jsc.JSContextRef)ctx2, s2, nil, nil, 1, &exc2)
	jsc.JSStringRelease(s2)
	lava.vm_cpu_exit(vm2)
	testing.expect(t, exc2 == nil, "a cleared budget still terminated the next page")
	jsc.JSGlobalContextRelease(ctx2)
	lava.vm_release(vm2)
}
