// Linux-only: the page runner exists only here.
#+build linux
package main

import "core:testing"
import "core:time"
import lava "lava:pkg/runtime"
import eventloop "lava:pkg/runtime/eventloop"

// WebAssembly.compile/instantiate run page code — an instantiate's start function and
// imports, a `then` getter a page puts on WebAssembly.Module.prototype, a species
// constructor's resolve — and all of it must run inside its own page's tick: charged to
// that page's budget, under its limits, and never once the page has closed. The engine's
// own asynchronous path ran it from JSC's RunLoop instead, at thread level (#97 review,
// safety F1/F2: a budget bypass, a thread stall after close, and a kill charged to the
// next page in the VM). Lava compiles synchronously in the caller's entry and settles one
// task later on the page's loop (pkg/runtime/wasm.odin); these pin that.

// WASM_EMPTY_MODULE is the smallest valid module: the magic and version 1, no sections.
@(private = "file")
WASM_EMPTY_MODULE :: "new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])"

// (module (import "m" "f" (func)) (start 0)): instantiating it calls m.f.
@(private = "file")
WASM_START :: "new Uint8Array([0,97,115,109,1,0,0,0,1,4,1,0x60,0,0,2,7,1,1,0x6d,1,0x66,0,0,8,1,0])"

// run_for steps the runner until no page is live or `seconds` pass; whether it emptied.
@(private = "file")
run_for :: proc(runner: ^lava.Page_Runner, seconds: f64) -> bool {
	deadline := time.tick_add(time.tick_now(), time.Duration(seconds * f64(time.Second)))
	for lava.page_runner_live(runner) > 0 {
		if time.tick_diff(time.tick_now(), deadline) <= 0 {
			return false
		}

		lava.page_runner_step(runner)
	}
	lava.page_runner_run(runner)
	return true
}

@(private = "file")
WASM_SPIN :: "function spin(ms) { const e = Date.now() + ms; while (Date.now() < e) {} }\n"

// A page that chains ten instantiates whose start function spins 300 ms — each under its
// 0.5 s entry limit, 3 s in all against a 1 s budget — dies of its budget. Run from the
// RunLoop, the start function was charged to nobody and the page finished .Ok.
@(test)
wasm_start_function_is_charged_to_its_page :: proc(t: ^testing.T) {
	runner: lava.Page_Runner

	if !lava.page_runner_init(&runner, 1, record_page_outcome, context.allocator) {
		testing.fail_now(t, "page_runner_init failed")
	}

	defer lava.page_runner_destroy(&runner)
	o: Page_Outcome
	lava.page_runner_open(
		&runner,
		WASM_SPIN +
		"const bytes = " +
		WASM_START +
		`;
		let n = 0;
		(function next() {
			if (++n > 10) return;
			WebAssembly.instantiate(bytes, { m: { f() { spin(300); } } }).then(next);
		})();`,
		"<wasm-charged>",
		{entry_limit = 0.5, cpu_budget = 1},
		&o,
	)
	lava.page_runner_run(&runner)
	testing.expectf(t, o.done && o.kill == .Cpu_Budget, "the start functions were not charged: %s", describe_outcome(o))
}

@(private = "file")
Pair :: struct {
	a, b: Page_Outcome,
}

@(private = "file")
open_b_on_a_done :: proc(runner: ^lava.Page_Runner, user_data: rawptr, result: lava.Result) {
	p := cast(^Pair)user_data

	if p.a.done {
		record_page_outcome(runner, &p.b, result)
		return
	}

	record_page_outcome(runner, &p.a, result)
	lava.page_runner_open(
		runner,
		`let k = 0; (function tick() { if (++k < 30) setTimeout(tick, 10); })();`,
		"<wasm-next>",
		{entry_limit = 0.5, cpu_budget = 5},
		p,
	)
}

// A page killed with wasm work pending leaves nothing of it to run: not on its VM while
// the VM is idle (where no limit is armed, so a spin would stall the thread), and not on
// the next page that takes the VM (where it would run under that page's limits and get
// that page killed). One runner slot, so B reuses A's VM; three ways A's code reaches the
// settlement: the start function, a `then` getter on WebAssembly.Module.prototype, and a
// species constructor on Promise.prototype. Each A spins 3 s if reached; B must end .Ok
// and the whole run well under those 3 s.
@(test)
wasm_of_a_killed_page_runs_nothing_after_it :: proc(t: ^testing.T) {
	TAIL :: "\nspin(100); while (true) {}"
	sources := [?]string {
		WASM_SPIN +
		"const bytes = " +
		WASM_START +
		`; WebAssembly.instantiate(bytes, { m: { f() { spin(3000); } } });` +
		TAIL,
		WASM_SPIN +
		`Object.defineProperty(WebAssembly.Module.prototype, 'then', { get() { spin(3000); } });
		WebAssembly.compile(new Uint8Array([0,97,115,109,1,0,0,0]));` +
		TAIL,
		WASM_SPIN +
		`class Evil extends Promise { constructor(ex) { super((res, rej) => ex(() => spin(3000), rej)); } }
		Promise.prototype.constructor = Evil; Evil[Symbol.species] = Evil;
		WebAssembly.compile(new Uint8Array([0,97,115,109,1,0,0,0]));` +
		TAIL,
	}
	for src, i in sources {
		runner: lava.Page_Runner

		if !lava.page_runner_init(&runner, 1, open_b_on_a_done, context.allocator) {
			testing.fail_now(t, "page_runner_init failed")
		}

		p: Pair
		start := time.tick_now()
		lava.page_runner_open(
			&runner,
			src,
			"<wasm-killed>",
			{entry_limit = 0.3, cpu_budget = 5},
			&p,
		)
		lava.page_runner_run(&runner)
		elapsed := time.duration_seconds(time.tick_since(start))
		lava.page_runner_destroy(&runner)
		killed := p.a.done && p.a.kill == .Entry_Limit
		testing.expectf(t, killed, "vector %d: A was not killed: %s", i, describe_outcome(p.a))
		testing.expectf(
			t,
			p.b.done && p.b.status == .Ok && p.b.kill == .None,
			"vector %d: the next page paid for A's wasm: %s",
			i,
			describe_outcome(p.b),
		)
		testing.expectf(t, elapsed < 2, "vector %d: A's code ran after it closed (%.2f s)", i, elapsed)
	}
}

// A runner page whose only work is a pending WebAssembly.compile or instantiate stays
// alive until it settles (#97) — the job's task is what holds the loop — and the
// settlement reaches the page. The page reads it
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
			{cpu_budget = 30},
			&compiled,
		)
		lava.page_runner_open(
			&runner,
			"WebAssembly.instantiate(" +
			WASM_EMPTY_MODULE +
			").then((r) => { if (r.instance instanceof WebAssembly.Instance) throw new Error('settled'); }, () => {});",
			"<wasm-instantiate>",
			{cpu_budget = 30},
			&instantiated,
		)
		testing.expect(t, run_for(&runner, 10), "the pages never finished")
		testing.expectf(t, compiled.done && compiled.exit == 1, "compile: %s", describe_outcome(compiled))
		testing.expectf(
			t,
			instantiated.done && instantiated.exit == 1,
			"instantiate: %s",
			describe_outcome(instantiated),
		)
	})
}

// On eval's path (also `lava run` and the workers) twenty compiles in a chain — each
// started from the previous one's handler, so each settles from a task the page's own
// blocking loop must run — all land well before the 5 s timer that would fail the page.
// That timer spins into the page's 1 s entry limit rather than throwing, so a settlement
// that never comes ends the page instead of hanging the test.
@(test)
eval_settles_a_chain_of_wasm_compiles :: proc(t: ^testing.T) {
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
		testing.expectf(t, elapsed < 2.5, "20 compiles took %.2f s: the page slept through their settlements", elapsed)
	})
}
