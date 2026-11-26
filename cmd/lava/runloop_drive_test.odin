// Linux-only: the RunLoop drive adopts WebKitGTK's GLib context (pkg/jsc/runloop_linux.odin),
// the page runner exists only here, and the census reads /proc/self/fd.
#+build linux
package main

import "core:log"
import "core:strings"
import "core:testing"
import "core:time"
import jsc "lava:pkg/jsc"
import lava "lava:pkg/runtime"
import eventloop "lava:pkg/runtime/eventloop"

// JSC's WTF::RunLoop, driven (#91, #97): FinalizationRegistry cleanups run and
// WebAssembly.compile/instantiate settle, each in its own page's tick. What no oracle
// can see is pinned here: which thread adopts the drive, that a page's cleanup is
// charged to that page, that a page is kept alive for a pending compile and woken when it
// finishes, that a released VM leaves no timerfd once the RunLoop is iterated, and that
// the drive does not crash a churn of heavy pages. Isolation between two pages in a
// reused VM is page_lifecycle_test's runner_second_page_in_a_reused_vm_sees_nothing_of_a_finished_first.
//
// Every case runs on a thread of its own (on_fresh_thread). WTF binds a thread's RunLoop
// to the context that is thread-default when the thread creates its FIRST JSC VM, for
// good; a test-runner thread is reused across tests, and many tests create a bare
// JSGlobalContextCreate VM first, which leaves that thread without a drive — honestly
// reported (runloop_adopts_only_before_the_threads_first_vm), but useless to a test of
// what the drive does.
//
// Page-visible outcomes on `.Web` (no process.exitCode there): a page reports failure by
// throwing from a timer, which the Result carries as exit code 1.

@(private = "file")
DRIVE_LIMITS :: lava.Page_Limits {
	cpu_budget = 30,
}

// WASM_EMPTY_MODULE is the smallest valid module: the magic and version 1, no sections.
@(private = "file")
WASM_EMPTY_MODULE :: "new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])"

// runner_drive_until runs page_runner_step until no page is live or `seconds` pass,
// collecting every VM of the runner's pool before each step, so the GC that makes a
// FinalizationRegistry target dead happens at a known point rather than when an
// allocation threshold says. Returns whether the runner ran out of pages in time.
@(private = "file")
runner_drive_until :: proc(t: ^testing.T, runner: ^lava.Page_Runner, seconds: f64) -> bool {
	deadline := time.tick_add(time.tick_now(), time.Duration(seconds * f64(time.Second)))
	for lava.page_runner_live(runner) > 0 {
		if time.tick_diff(time.tick_now(), deadline) <= 0 {
			return false
		}

		for vm in runner.pool.vms {
			vm_collect(t, vm)
		}
		lava.page_runner_step(runner)
	}
	lava.page_runner_run(runner)
	return true
}

// The drive is on only for a thread whose first VM was created inside the push
// (pkg/jsc/runloop_linux.odin): a thread that made a VM before — a bare
// JSGlobalContextCreate, as many of this package's tests do — has its RunLoop bound to a
// context of WTF's own, and the self-test must say so rather than report a drive that
// never runs anything. A fresh thread whose first VM comes from the pool is the control.
@(test)
runloop_adopts_only_before_the_threads_first_vm :: proc(t: ^testing.T) {
	on_fresh_thread(t, proc(t: ^testing.T) {
		pool: lava.VM_Pool
		lava.vm_pool_init(&pool, 1, context.allocator)
		defer lava.vm_pool_destroy(&pool)
		_, err := lava.vm_acquire(&pool)
		testing.expect_value(t, err, lava.VM_Pool_Error.None)
		testing.expect_value(t, jsc.runloop_drive(), jsc.Runloop_Drive.Adopted)
		lava.vm_release(pool.vms[0])
	})
	on_fresh_thread(t, proc(t: ^testing.T) {
		bare := jsc.JSGlobalContextCreate(nil)
		jsc.JSGlobalContextRelease(bare)
		pool: lava.VM_Pool
		lava.vm_pool_init(&pool, 1, context.allocator)
		defer lava.vm_pool_destroy(&pool)
		_, err := lava.vm_acquire(&pool)
		testing.expect_value(t, err, lava.VM_Pool_Error.None)
		testing.expect_value(t, jsc.runloop_drive(), jsc.Runloop_Drive.Not_Adopted)
		lava.vm_release(pool.vms[0])
	})
}

// FR_PAGE's cleanup cancels the timer that would fail it: the page ends .Ok only if a
// cleanup ran within 3 s, inside the page (it clears the page's own timer).
@(private = "file")
FR_PAGE :: `
globalThis.keep = new FinalizationRegistry(() => { clearTimeout(fail); });
(function () { for (let i = 0; i < 16; i++) keep.register({}, i); })();
const fail = setTimeout(() => { throw new Error('no FinalizationRegistry cleanup within 3 s'); }, 3000);
`

// A runner page's FinalizationRegistry cleanup runs (#91), in that page: the runner
// dispatches the RunLoop between rounds, the shim posts to the page's loop, and the
// cleanup runs in the page's next tick and clears its timer.
@(test)
runner_runs_a_finalization_cleanup_in_its_page :: proc(t: ^testing.T) {
	on_fresh_thread(t, proc(t: ^testing.T) {
		runner: lava.Page_Runner

		if !lava.page_runner_init(&runner, 1, record_page_outcome, context.allocator) {
			testing.expect(t, false, "page_runner_init failed")
			return
		}

		defer lava.page_runner_destroy(&runner)
		o: Page_Outcome
		lava.page_runner_open(&runner, FR_PAGE, "<fr-runner>", DRIVE_LIMITS, &o, .Web)
		testing.expect(t, runner_drive_until(t, &runner, 10), "the page never finished")
		testing.expectf(t, o.done && o.status == .Ok && o.exit == 0, "page: %s", describe_outcome(o))
	})
}

@(private = "file")
collect_before_the_loop :: proc(user_data: rawptr) -> bool {
	t := cast(^testing.T)user_data
	for vm in lava.thread_vm_pool().vms {
		if vm.in_use {
			vm_collect(t, vm)
		}
	}
	return true
}

// The same on eval's path (also `lava run` and the workers): the page's loop is the
// thread's driver, and page_tick services the RunLoop before each tick. The collection
// runs in eval's pre-run hook, between the top-level script and the first tick.
@(test)
eval_runs_a_finalization_cleanup :: proc(t: ^testing.T) {
	on_fresh_thread(t, proc(t: ^testing.T) {
		loop := eventloop.init(real_time = true)
		start := time.tick_now()
		result := lava.eval(FR_PAGE, "<fr-eval>", &loop, false, nil, collect_before_the_loop, t, surface = .Web)
		defer lava.result_destroy(&result)
		elapsed := time.duration_seconds(time.tick_since(start))
		testing.expectf(
			t,
			result.status == .Ok && result.exit_code == 0,
			"eval: %v exit %d %q",
			result.status,
			result.exit_code,
			result.message,
		)
		testing.expectf(t, elapsed < 2, "eval took %.2f s: the cleanup did not cancel the 3 s timer", elapsed)
	})
}

// A cleanup's CPU is its page's (CLAUDE.md §4's budget, docs/LARVA.md decision 2): page A
// registers one fresh target per 10 ms tick, the test collects between rounds, and each
// cleanup spins 2e7 iterations — 40 of them are well past A's 0.5 s budget, while A's own
// ticks are cheap. So A must die of its budget, and only A: B, its sibling on the same
// thread under the same budget, runs a light timer chain through the whole of it and
// ends .Ok. A cleanup run at the thread-level dispatch instead of in A's tick would be
// charged to nobody — the RunLoop runs outside every page's window — and A would finish.
@(test)
runner_charges_a_cleanup_to_its_own_page :: proc(t: ^testing.T) {
	on_fresh_thread(t, proc(t: ^testing.T) {
		runner: lava.Page_Runner

		if !lava.page_runner_init(&runner, 2, record_page_outcome, context.allocator) {
			testing.expect(t, false, "page_runner_init failed")
			return
		}

		defer lava.page_runner_destroy(&runner)
		a, b: Page_Outcome
		lava.page_runner_open(
			&runner,
			`globalThis.keep = new FinalizationRegistry(() => {
				let x = 0; for (let i = 0; i < 2e7; i++) x += i; globalThis.sink = x;
			});
			let n = 0;
			(function tick() { if (++n > 200) return; keep.register({}, n); setTimeout(tick, 10); })();`,
			"<heavy-cleanups>",
			{cpu_budget = 0.5},
			&a,
			.Web,
		)
		lava.page_runner_open(
			&runner,
			`let n = 0; (function tick() { if (++n < 150) setTimeout(tick, 10); })();`,
			"<light-sibling>",
			{cpu_budget = 0.5},
			&b,
			.Web,
		)
		testing.expect(t, runner_drive_until(t, &runner, 20), "the pages never finished")
		testing.expectf(
			t,
			a.done && a.kill == .Cpu_Budget,
			"A's cleanups were not charged to A: %s",
			describe_outcome(a),
		)
		testing.expectf(
			t,
			b.done && b.status == .Ok && b.kill == .None,
			"B paid for A's cleanups: %s",
			describe_outcome(b),
		)
	})
}

// A runner page whose only work is a pending WebAssembly.compile or instantiate stays
// alive until it settles (#97), and the settlement reaches the page. The page reads it
// back through its exit code: the handler throws once it holds the Module (an unhandled
// rejection, exit 1), and a rejection is caught, so exit 1 means "settled with a Module
// while the page lived" and exit 0 means the page ended first.
@(test)
runner_holds_a_page_until_its_wasm_settles :: proc(t: ^testing.T) {
	on_fresh_thread(t, proc(t: ^testing.T) {
		runner: lava.Page_Runner

		if !lava.page_runner_init(&runner, 2, record_page_outcome, context.allocator) {
			testing.expect(t, false, "page_runner_init failed")
			return
		}

		defer lava.page_runner_destroy(&runner)
		compiled, instantiated: Page_Outcome
		lava.page_runner_open(
			&runner,
			"WebAssembly.compile(" +
			WASM_EMPTY_MODULE +
			").then((m) => { if (m instanceof WebAssembly.Module) throw new Error('settled'); }, () => {});",
			"<wasm-compile>",
			DRIVE_LIMITS,
			&compiled,
			.Web,
		)
		lava.page_runner_open(
			&runner,
			"WebAssembly.instantiate(" +
			WASM_EMPTY_MODULE +
			").then((r) => { if (r.instance instanceof WebAssembly.Instance) throw new Error('settled'); }, () => {});",
			"<wasm-instantiate>",
			DRIVE_LIMITS,
			&instantiated,
			.Web,
		)
		testing.expect(t, runner_drive_until(t, &runner, 10), "the pages never finished")
		testing.expectf(t, compiled.done && compiled.exit == 1, "compile: %s", describe_outcome(compiled))
		testing.expectf(
			t,
			instantiated.done && instantiated.exit == 1,
			"instantiate: %s",
			describe_outcome(instantiated),
		)
	})
}

// eval's page blocks in its own poll, and a compile finishes on a JSC worker thread, so
// the wake must come through the RunLoop descriptor the page loop watches. Twenty
// compiles in a chain — each started from the previous one's handler, so at least the
// later ones finish while the tick is blocked — must all land well before the 5 s timer
// that would fail the page. That timer spins into the page's 1 s entry limit rather than
// throwing: a page held for a compile whose completion never wakes it would otherwise
// block in its poll for good, and the test would hang instead of failing.
@(test)
eval_wakes_for_wasm_completions :: proc(t: ^testing.T) {
	on_fresh_thread(t, proc(t: ^testing.T) {
		loop := eventloop.init(real_time = true)
		start := time.tick_now()
		result := lava.eval(
			"const bytes = " +
			WASM_EMPTY_MODULE +
			`;
			let left = 20;
			const fail = setTimeout(() => { while (true) {} }, 5000);
			(function next() {
				WebAssembly.compile(bytes).then((m) => {
					if (!(m instanceof WebAssembly.Module)) throw new Error('not a Module');
					if (--left > 0) next(); else clearTimeout(fail);
				});
			})();`,
			"<wasm-eval>",
			&loop,
			surface = .Web,
			limits = {entry_limit = 1, cpu_budget = 30},
		)
		defer lava.result_destroy(&result)
		elapsed := time.duration_seconds(time.tick_since(start))
		testing.expectf(
			t,
			result.status == .Ok && result.exit_code == 0 && result.kill == .None,
			"eval: %v exit %d kill %v %q",
			result.status,
			result.exit_code,
			result.kill,
			result.message,
		)
		testing.expectf(t, elapsed < 2.5, "20 compiles took %.2f s: the page slept through their completions", elapsed)
	})
}

// A released VM's RunLoop timer source closes its timerfd only when the thread's context
// is next iterated (session probe p4), and vm_pool_destroy iterates once after its
// releases. Before the drive this descriptor outlived the VM for the life of the thread.
// Process-wide census, so only meaningful on one runner thread (fd_census).
@(test)
vm_pool_releases_its_timerfds :: proc(t: ^testing.T) {
	when RUNNER_THREADS != 1 {
		log.info("skipped: /proc/self/fd is process-wide; needs -define:ODIN_TEST_THREADS=1")
		return
	}
	on_fresh_thread(t, proc(t: ^testing.T) {
		pool: lava.VM_Pool
		lava.vm_pool_init(&pool, 4, context.allocator)
		before := fd_census(timerfds_only = true)
		vms: [4]^lava.VM
		for &vm in vms {
			vm, _ = lava.vm_acquire(&pool)
			ctx := lava.vm_create_context(vm, nil)
			src := jsc.JSStringCreateWithUTF8CString("var q = []; for (let i = 0; i < 20000; i++) q.push({ i }); 0")
			jsc.JSEvaluateScript(cast(jsc.JSContextRef)ctx, src, nil, nil, 1, nil)
			jsc.JSStringRelease(src)
			jsc.JSGlobalContextRelease(ctx)
		}
		for vm in vms {
			lava.vm_release(vm)
		}
		live := fd_census(timerfds_only = true)
		lava.vm_pool_destroy(&pool)
		after := fd_census(timerfds_only = true)
		log.infof("timerfds: %d before, %d with 4 VMs, %d after their release", before, live, after)
		testing.expectf(
			t,
			live > before,
			"no timerfd while the VMs lived (%d -> %d): the census cannot see them",
			before,
			live,
		)
		testing.expectf(t, after == before, "%d timerfd(s) outlived their VMs", after - before)
	})
}

@(private = "file")
Churn_Run :: struct {
	opened:   int,
	reported: int,
	ok:       int,
	first:    Page_Outcome,
}

@(private = "file")
CHURN_RUN_PAGES :: 200

@(private = "file")
CHURN_RUN_SOURCE :: `globalThis.keep = Array.from({ length: 50000 }, (_, i) => ({ i })); setTimeout(() => {}, 25);`

@(private = "file")
churn_run_done :: proc(runner: ^lava.Page_Runner, user_data: rawptr, result: lava.Result) {
	c := cast(^Churn_Run)user_data
	o: Page_Outcome
	record_page_outcome(runner, &o, result)
	c.reported += 1

	if o.status == .Ok && o.kill == .None && o.exit == 0 {
		c.ok += 1
	} else if !c.first.done {
		c.first = o
	}

	if c.opened < CHURN_RUN_PAGES {
		c.opened += 1
		lava.page_runner_open(runner, CHURN_RUN_SOURCE, "<churn>", DRIVE_LIMITS, c, .Web)
	}
}

// 200 pages through 2 runner slots, each leaving 50k objects in its VM's heap, with the
// RunLoop driven between rounds. With JSC's GC activity timers left on, driving the
// RunLoop eventually fires the full-GC timer, which reaches RunLoop::mainSingleton() —
// null in this embedding — and the process dies with SIGSEGV (session probes p7/q3: 12/12
// runs). jsc.runloop_before_vm turns those timers off before the first VM; this pins that
// it does, and that the drive survives a churn that keeps the collector busy. Each page
// waits 25 ms, so the churn lasts ~2.5 s: with 2 ms pages it ended before the full-GC
// timer came due and survived the timers being left on (1 run); at 25 ms that aborted the
// process (exit 134, 1 run).
@(test)
runner_churn_with_the_drive_does_not_crash :: proc(t: ^testing.T) {
	on_fresh_thread(t, proc(t: ^testing.T) {
		runner: lava.Page_Runner
		c: Churn_Run

		if !lava.page_runner_init(&runner, 2, churn_run_done, context.allocator) {
			testing.expect(t, false, "page_runner_init failed")
			return
		}

		for _ in 0 ..< 2 {
			c.opened += 1
			lava.page_runner_open(&runner, CHURN_RUN_SOURCE, "<churn>", DRIVE_LIMITS, &c, .Web)
		}
		lava.page_runner_run(&runner)
		lava.page_runner_destroy(&runner)
		testing.expect_value(t, jsc.runloop_drive(), jsc.Runloop_Drive.Adopted)
		testing.expect_value(t, c.reported, CHURN_RUN_PAGES)
		testing.expectf(
			t,
			c.ok == CHURN_RUN_PAGES,
			"%d of %d pages ended .Ok; first other: %s",
			c.ok,
			CHURN_RUN_PAGES,
			describe_outcome(c.first),
		)
	})
}

// DEFERRED_CHROME_PRELUDE is case.js's `collect()` on a `.Web` page: it parks until the
// harness has run a full collection (vm_collect, which a page cannot ask for), then
// gives the cleanups the same 50 ms turn Chrome's recording gives them after `gc()`.
@(private = "file")
DEFERRED_CHROME_PRELUDE :: `globalThis.collect = () =>
  new Promise((resolve) => { globalThis.gcResume = resolve; globalThis.wantGC = true; })
    .then(() => new Promise((resolve) => setTimeout(resolve, 50)));
`

@(private = "file")
DEFERRED_CHROME_CASE :: #load("testdata/deferred-chrome/case.js", string)

@(private = "file")
DEFERRED_CHROME_EXPECTED :: #load("testdata/deferred-chrome/expected.txt", string)

// first_differing_line is the first line of `a` that is not the same line of `b`, or ""
// when `a` runs out first.
@(private = "file")
first_differing_line :: proc(a, b: string) -> string {
	a, b := a, b
	for line in strings.split_lines_iterator(&a) {
		other, ok := strings.split_lines_iterator(&b)

		if !ok || line != other {
			return line
		}
	}

	return ""
}

@(private = "file")
cond_wants_gc_or_reported :: proc(page: ^lava.Page, user_data: rawptr) -> bool {
	v, ok := lava.page_eval(page, `globalThis.wantGC === true || globalThis.report != null`)
	return ok && jsc.JSValueToBoolean(cast(jsc.JSContextRef)page.ctx, v)
}

@(private = "file")
cond_reported :: proc(page: ^lava.Page, user_data: rawptr) -> bool {
	v, ok := lava.page_eval(page, `globalThis.report != null`)
	return ok && jsc.JSValueToBoolean(cast(jsc.JSContextRef)page.ctx, v)
}

// A `.Web` page sees FinalizationRegistry and WebAssembly.compile/instantiate as Chrome
// does (testdata/deferred-chrome: case.js, Chrome 158's expected.txt, record-chrome.py):
// the wrapped constructor and functions keep the engine's name, length, attributes,
// prototype, subclassing and TypeErrors; compile and instantiate settle with a Module and
// an Instance, and reject a bad buffer with CompileError; every dead target gets one
// cleanup, called with its held value alone and `this` undefined, and one registry's
// cleanups run as one task, before the microtasks they queue. Byte for byte, on a page
// driven by page_run_until — a single page whose loop is its thread's driver.
@(test)
web_page_sees_finalization_and_wasm_as_chrome_does :: proc(t: ^testing.T) {
	on_fresh_thread(t, proc(t: ^testing.T) {
		page: lava.Page
		loop := eventloop.init(real_time = true)

		if !lava.page_create(&page, "<deferred-chrome>", &loop, limits = DRIVE_LIMITS, surface = .Web) {
			testing.expect(t, false, "page_create refused the page")
			result, _ := lava.page_close(&page)
			lava.result_destroy(&result)
			return
		}

		lava.page_run_script(&page, DEFERRED_CHROME_PRELUDE + DEFERRED_CHROME_CASE, "<deferred-chrome>")
		stop := lava.page_run_until(&page, cond_wants_gc_or_reported, nil, 5000)
		testing.expectf(t, stop == .Met, "the case never asked for its collection: %v", stop)

		if stop == .Met {
			vm_collect(t, page.vm)
			lava.page_eval(&page, `globalThis.wantGC = false; gcResume();`)
			stop = lava.page_run_until(&page, cond_reported, nil, 5000)
			testing.expectf(t, stop == .Met, "the case never reported: %v", stop)
		}

		if v, ok := lava.page_eval(&page, `String(globalThis.report) + '\n'`); ok {
			got, allocated := lava.value_to_string(cast(jsc.JSContextRef)page.ctx, v)
			testing.expectf(
				t,
				got == DEFERRED_CHROME_EXPECTED,
				"first difference: Lava %q, Chrome %q\nLava:\n%s\nChrome:\n%s",
				first_differing_line(got, DEFERRED_CHROME_EXPECTED),
				first_differing_line(DEFERRED_CHROME_EXPECTED, got),
				got,
				DEFERRED_CHROME_EXPECTED,
			)

			if allocated {
				delete(got)
			}
		} else {
			testing.expect(t, false, "could not read the report")
		}

		result, _ := lava.page_close(&page)
		lava.result_destroy(&result)
	})
}
