// Linux-only: jsc_memory_stats (page_lifecycle_test.odin) is resolved against
// libjavascriptcoregtk-6.0, and the deadline cases time a real_time loop's blocking poll.
#+build linux
package main

import "base:runtime"
import "core:mem"
import "core:testing"
import "core:time"
import jsc "lava:pkg/jsc"
import lava "lava:pkg/runtime"
import eventloop "lava:pkg/runtime/eventloop"

// The persistent-page API of issue #3 (page.odin): page_create + page_run_script, which
// page_open is made of, then page_eval and page_run_until on the live page before
// page_close. No oracle observes a native page API, so this is Lava-only (CLAUDE.md §6).
// Every page here runs on the `.Web` surface: it needs nothing of the Node modules, and
// its error and exit behaviour is the one a browser page has.

// API_LIMITS is a CPU budget far above anything a passing page spends: reaching it is a
// failure the case reports as a kill, not a hang.
@(private = "file")
API_LIMITS :: lava.Page_Limits {
	cpu_budget = 30,
}

@(private = "file")
KILL_LIMITS :: lava.Page_Limits {
	cpu_budget = 0.05,
}

// page_create + page_run_script + page_close leaves the Result page_open does, on the
// three paths page_open's contract names: a script that runs (echoed completion), a
// top-level throw (the page finishes), and a pre-flight refusal (`.mjs` on `.Web`),
// which page_open makes before a context exists and page_run_script on a live page.
@(test)
page_create_then_run_script_ends_like_page_open :: proc(t: ^testing.T) {
	Case :: struct {
		name:        string,
		source:      string,
		source_name: string,
	}
	cases := []Case {
		{"runs", `setTimeout(() => {}, 1); 6 * 7`, "<runs>"},
		{"throws", `setTimeout(() => {}, 1); throw new Error('top-level')`, "<throws>"},
		{"refused", `1`, "entry.mjs"},
	}
	for c in cases {
		opened := run_to_close_via_open(c.source, c.source_name)
		defer lava.result_destroy(&opened)
		split := run_to_close_via_create(c.source, c.source_name)
		defer lava.result_destroy(&split)
		testing.expectf(
			t,
			opened.status == split.status &&
			opened.exit_code == split.exit_code &&
			opened.kill == split.kill &&
			opened.message == split.message,
			"%s: page_open ended %v/%d/%v %q, create+run_script %v/%d/%v %q",
			c.name,
			opened.status,
			opened.exit_code,
			opened.kill,
			opened.message,
			split.status,
			split.exit_code,
			split.kill,
			split.message,
		)
	}
	// The three paths are different Results, or the comparison proves nothing.
	runs := run_to_close_via_create(`6 * 7`, "<runs>")
	defer lava.result_destroy(&runs)
	testing.expect_value(t, runs.message, "42")
	refused := run_to_close_via_create(`1`, "entry.mjs")
	defer lava.result_destroy(&refused)
	testing.expect_value(t, refused.status, lava.Status.Invalid_Input)
}

// A page has one top-level script. A second page_run_script is refused before it runs
// — it would take the completion slot the first one protected — and leaves the page as
// it was: live, with the first script's state.
@(test)
page_run_script_runs_once :: proc(t: ^testing.T) {
	page: lava.Page
	loop: eventloop.Loop
	open_web_page(t, &page, &loop, `globalThis.runs = 1;`)
	defer close_page(&page)

	again := lava.page_run_script(&page, `globalThis.runs = 2; 'again'`, "<page-api>", true)
	testing.expect(t, !again, "a second page_run_script was accepted")
	testing.expect(t, !page.finished, "a refused second page_run_script finished the page")
	v, ok := lava.page_eval(&page, `runs`)
	testing.expect(t, ok, "page_eval after a refused page_run_script failed")
	testing.expectf(t, eval_number(&page, v) == 1, "the second script ran: runs=%v", eval_number(&page, v))
}

// page_eval runs on the page the top-level script left: it sees the script's globals
// and an earlier page_eval's, and returns its own completion value.
@(test)
page_eval_sees_the_page_and_returns_its_completion :: proc(t: ^testing.T) {
	page: lava.Page
	loop: eventloop.Loop
	open_web_page(t, &page, &loop, `globalThis.a = 40;`)
	defer close_page(&page)

	v, ok := lava.page_eval(&page, `var b = a + 1; b`)
	testing.expect(t, ok, "page_eval of a script that reads the top-level global failed")
	testing.expect_value(t, eval_number(&page, v), 41)

	v, ok = lava.page_eval(&page, `b + 1`)
	testing.expect(t, ok, "page_eval of a script that reads an earlier page_eval's var failed")
	testing.expect_value(t, eval_number(&page, v), 42)
}

// A throw inside page_eval is the call's failure, not the page's: unlike the top-level
// script it does not decide the page's Result, so the page stays evaluable and closes Ok.
@(test)
page_eval_throw_leaves_the_page_usable :: proc(t: ^testing.T) {
	page: lava.Page
	loop: eventloop.Loop
	open_web_page(t, &page, &loop, `globalThis.n = 1;`)

	_, ok := lava.page_eval(&page, `throw new Error('from page_eval')`)
	testing.expect(t, !ok, "a throwing page_eval reported ok")
	testing.expect(t, !page.finished, "a throwing page_eval finished the page")

	v, ok2 := lava.page_eval(&page, `n + 1`)
	testing.expect(t, ok2, "page_eval after a thrown one was refused")
	testing.expect_value(t, eval_number(&page, v), 2)

	result, busy := lava.page_close(&page)
	defer lava.result_destroy(&result)
	testing.expect(t, busy == nil, "page_close handed back a busy loop")
	testing.expect_value(t, result.status, lava.Status.Ok)
	testing.expect_value(t, result.exit_code, 0)
}

// A CPU-budget kill inside page_eval DOES end the page — the budget is the page's, not
// the call's — and every later page_eval is refused.
@(test)
page_eval_cpu_budget_kill_finishes_the_page :: proc(t: ^testing.T) {
	page: lava.Page
	loop: eventloop.Loop
	open_web_page(t, &page, &loop, `globalThis.n = 1;`, KILL_LIMITS)

	_, ok := lava.page_eval(&page, `for (;;) {}`)
	testing.expect(t, !ok, "a page_eval killed by the CPU budget reported ok")
	testing.expect(t, page.finished, "a CPU-budget kill inside page_eval left the page running")

	_, ok = lava.page_eval(&page, `n`)
	testing.expect(t, !ok, "page_eval on a killed page was not refused")

	result, _ := lava.page_close(&page)
	defer lava.result_destroy(&result)
	testing.expect_value(t, result.status, lava.Status.Execution_Error)
	testing.expect_value(t, result.kill, lava.Kill_Reason.Cpu_Budget)
}

// page_eval keeps exactly ONE value GC-protected: the latest. Counted by JSC itself
// (protectedObjectCount, read on the page's own context), so each call must protect
// its value and release the one before. The count also carries one Strong handle per
// distinct source JSC's CodeCache has compiled in the VM (page_lifecycle_test.odin),
// probed here too: a new source, even a 7-char one, raised it by 1 the first time and
// by 0 after. So every source runs once to warm the cache before anything is counted.
// `0` holds nothing (a number is not a cell), so it empties the slot.
@(test)
page_eval_protects_one_value_at_a_time :: proc(t: ^testing.T) {
	page: lava.Page
	loop: eventloop.Loop
	open_web_page(t, &page, &loop, `globalThis.n = 1;`)
	defer close_page(&page)

	sources := []string{`({a:1})`, `({b:2})`, `({c:3})`}
	for source in sources {
		lava.page_eval(&page, source)
	}
	lava.page_eval(&page, `0`)
	empty := page_protected_count(t, &page)

	for source in sources {
		_, ok := lava.page_eval(&page, source)
		held := page_protected_count(t, &page)
		testing.expectf(t, ok, "page_eval(%q) failed", source)
		testing.expectf(
			t,
			held == empty + 1,
			"after page_eval(%q) JSC counts %d protected objects, want %d: the slot holds one value",
			source,
			held,
			empty + 1,
		)
	}
	lava.page_eval(&page, `0`)
	testing.expect_value(t, page_protected_count(t, &page), empty)
}

// page_eval is its own temp-arena choke point (CLAUDE.md §4), like eval and require:
// the scratch it takes (the source name's cstring, and on `.Node` the source plus its
// appended drain) is reclaimed when the call returns, not left for the next tick. A
// host evaluating repeatedly between ticks, or on a page with no loop at all, would
// otherwise grow the thread's temp arena by every source it ran. The test installs its
// own arena as the temp allocator so the reading is this call's alone.
@(test)
page_eval_leaves_the_temp_arena_empty :: proc(t: ^testing.T) {
	page: lava.Page
	loop: eventloop.Loop
	open_web_page(t, &page, &loop, `globalThis.n = 1;`)
	defer close_page(&page)

	arena: runtime.Arena
	defer runtime.arena_destroy(&arena)
	saved := context.temp_allocator
	context.temp_allocator = runtime.arena_allocator(&arena)
	_, ok := lava.page_eval(&page, `n + 1`, "<page-eval-temp>")
	used := arena.total_used
	context.temp_allocator = saved

	testing.expect(t, ok, "page_eval failed")
	testing.expectf(t, used == 0, "page_eval left %d bytes in the temp arena", used)
}

// Met: the condition turns true once a timer has fired, which takes ticks.
@(test)
page_run_until_met_after_a_timer :: proc(t: ^testing.T) {
	page: lava.Page
	loop: eventloop.Loop
	open_web_page(t, &page, &loop, `globalThis.done = false; setTimeout(() => { done = true; }, 20);`)
	defer close_page(&page)

	timers := len(loop.timer_index)
	stop := lava.page_run_until(&page, cond_global_done, nil, 10_000)
	testing.expect_value(t, stop, lava.Run_Stop.Met)
	testing.expect(t, !page.finished, "Met finished the page")
	testing.expectf(
		t,
		len(loop.timer_index) == timers - 1,
		"page_run_until left %d timers on the loop, want %d (the deadline timer is cleared)",
		len(loop.timer_index),
		timers - 1,
	)
}

// Met without a tick: a condition already true is answered before the loop runs. Seen
// twice: the loop's tick counter does not move, and a timer the script left already
// due (it spins past the timer's delay before returning) has not fired — the first
// tick's timer phase would fire it.
@(test)
page_run_until_met_before_any_tick :: proc(t: ^testing.T) {
	page: lava.Page
	loop: eventloop.Loop
	open_web_page(
		t,
		&page,
		&loop,
		`globalThis.fired = false; setTimeout(() => { fired = true; }, 0);
		const s = Date.now(); while (Date.now() - s < 5) {}`,
	)
	defer close_page(&page)

	ticks := eventloop.iteration_count(&loop)
	calls := 0
	stop := lava.page_run_until(&page, cond_count_true, &calls, 10_000)
	testing.expect_value(t, stop, lava.Run_Stop.Met)
	testing.expect_value(t, calls, 1)
	testing.expectf(
		t,
		eventloop.iteration_count(&loop) == ticks,
		"the loop ticked %d time(s) before Met",
		eventloop.iteration_count(&loop) - ticks,
	)
	v, _ := lava.page_eval(&page, `fired`)
	testing.expect(t, !jsc.JSValueToBoolean(cast(jsc.JSContextRef)page.ctx, v), "a due timer fired before Met")
}

// Idle: the loop runs out of work long before the deadline, and that is reported at
// once — the deadline timer is unreffed, so it neither keeps the loop alive nor makes
// the call wait for it — and the page is still evaluable afterwards.
@(test)
page_run_until_idle_returns_before_the_deadline :: proc(t: ^testing.T) {
	page: lava.Page
	loop: eventloop.Loop
	open_web_page(t, &page, &loop, `globalThis.x = 0; setTimeout(() => { x = 1; }, 5);`)
	defer close_page(&page)

	timers := len(loop.timer_index)
	start := time.tick_now()
	stop := lava.page_run_until(&page, cond_never, nil, 3_000)
	elapsed := time.duration_seconds(time.tick_since(start))
	testing.expect_value(t, stop, lava.Run_Stop.Idle)
	testing.expectf(t, elapsed < 1.5, "Idle took %.2fs: the deadline timer kept the loop alive", elapsed)
	testing.expect_value(t, len(loop.timer_index), timers - 1)

	v, ok := lava.page_eval(&page, `x`)
	testing.expect(t, ok, "page_eval after Idle was refused")
	testing.expect_value(t, eval_number(&page, v), 1)
}

// Deadline: work that never ends (an interval) and work that blocks well past the
// deadline (one far timer: the tick's poll would sleep until it) both return at about
// the deadline. The far timer is the case the deadline timer exists for — without it a
// blocking tick sleeps through the deadline.
@(test)
page_run_until_returns_at_the_deadline :: proc(t: ^testing.T) {
	// The far timer first: a run that misses the deadline there ends Idle after 3 s,
	// while on the interval it would never end, so the case stops at the first miss.
	sources := []string{`setTimeout(() => {}, 3000);`, `setInterval(() => {}, 1);`}
	for source in sources {
		page: lava.Page
		loop: eventloop.Loop
		open_web_page(t, &page, &loop, source)

		start := time.tick_now()
		stop := lava.page_run_until(&page, cond_never, nil, 100)
		elapsed := time.duration_seconds(time.tick_since(start))
		testing.expectf(t, stop == .Deadline, "%q: stopped with %v, want Deadline", source, stop)
		testing.expectf(t, elapsed >= 0.09 && elapsed < 1.5, "%q: Deadline after %.3fs, want ~0.1s", source, elapsed)
		testing.expect(t, !page.finished, "Deadline finished the page")
		close_page(&page)

		if stop != .Deadline {
			return
		}
	}
}

// Deadline holds even when page JS tries to cancel the deadline timer by clearing every
// id up to a fresh probe's (ids come from one counter per loop that only grows,
// next_handle_id, loop.odin). Since #92 clearTimeout reaches only the timers the JS
// globals made, so the wake-up survives these; its re-arm after a clear is pinned by
// page_run_until_deadline_survives_a_native_clear_of_its_wake. Two shapes:
// an interval that does it every turn and burns CPU (with the deadline timer as the
// only signal, the run never ends; the 2 s budget turns that into a kill, so the case
// fails instead of hanging), and one timer that does it once and leaves only a far
// timer behind (a deadline that is not re-armed sleeps through to it).
@(test)
page_run_until_deadline_survives_page_js_clearing_it :: proc(t: ^testing.T) {
	CLEAR_ALL :: `function clearAll(keep) {
			const probe = setTimeout(() => {}, 0);
			for (let i = 1; i <= probe; i++) if (i !== keep) clearTimeout(i);
		}
		`
	Case :: struct {
		name:   string,
		source: string,
	}
	cases := []Case {
		{
			"spinning interval",
			CLEAR_ALL +
			`let me; me = setInterval(() => { clearAll(me); const s = Date.now(); while (Date.now() - s < 1) {} }, 1);`,
		},
		{"far timer", CLEAR_ALL + `const far = setTimeout(() => {}, 3000); setTimeout(() => clearAll(far), 10);`},
	}
	for c in cases {
		page: lava.Page
		loop: eventloop.Loop
		open_web_page(t, &page, &loop, c.source, {cpu_budget = 2})

		start := time.tick_now()
		stop := lava.page_run_until(&page, cond_never, nil, 100)
		elapsed := time.duration_seconds(time.tick_since(start))
		testing.expectf(t, stop == .Deadline, "%s: stopped with %v, want Deadline", c.name, stop)
		testing.expectf(t, elapsed < 1.5, "%s: Deadline after %.3fs, want ~0.1s", c.name, elapsed)
		close_page(&page)
	}
}

// cond_clear_unreffed_timers is a page_run_until condition that is never met and, between
// ticks, clears every unreffed timer waiting on the page's loop — natively, as an embedder
// or a runtime timer of the same loop could, since page JS cannot (#92: clearTimeout only
// reaches the timers the JS globals made). The deadline wake-up is the one unreffed timer
// there. user_data counts the timers it cleared.
@(private = "file")
cond_clear_unreffed_timers :: proc(page: ^lava.Page, user_data: rawptr) -> bool {
	loop := page.loop
	ids := make([dynamic]eventloop.Timer_ID, context.temp_allocator)

	for id, idx in loop.timer_index {
		if loop.timers[idx].unreffed {
			append(&ids, id)
		}
	}

	for id in ids {
		if eventloop.clear_timeout(loop, id) {
			(cast(^int)user_data)^ += 1
		}
	}

	return false
}

// The re-arm of the deadline wake-up, reached the only way left since #92: the wake is
// cleared natively between ticks (cond_clear_unreffed_timers), after every tick. The page
// leaves a 10 ms timer, so the first tick returns well before the deadline, and a far
// timer behind it: a wake that is not re-armed for the second tick lets it sleep 3 s, to
// the far timer, instead of returning at the 100 ms deadline.
@(test)
page_run_until_deadline_survives_a_native_clear_of_its_wake :: proc(t: ^testing.T) {
	page: lava.Page
	loop: eventloop.Loop
	open_web_page(t, &page, &loop, `setTimeout(() => {}, 3000); setTimeout(() => {}, 10);`)
	defer close_page(&page)

	cleared := 0
	start := time.tick_now()
	stop := lava.page_run_until(&page, cond_clear_unreffed_timers, &cleared, 100)
	elapsed := time.duration_seconds(time.tick_since(start))
	testing.expect_value(t, stop, lava.Run_Stop.Deadline)
	testing.expectf(t, cleared >= 1, "the condition cleared no wake-up timer: the case tested nothing")
	testing.expectf(t, elapsed < 1.5, "Deadline after %.3fs, want ~0.1s: the cleared wake-up was not re-armed", elapsed)
}

// Finished: a limit kill inside a timer ends the page; the run reports it rather than
// Idle, and the Result is the kill.
@(test)
page_run_until_finished_by_a_kill :: proc(t: ^testing.T) {
	page: lava.Page
	loop: eventloop.Loop
	open_web_page(t, &page, &loop, `setTimeout(() => { for (;;) {} }, 5);`, KILL_LIMITS)

	stop := lava.page_run_until(&page, cond_never, nil, 10_000)
	testing.expect_value(t, stop, lava.Run_Stop.Finished)
	testing.expect(t, page.finished, "Finished left the page running")

	result, _ := lava.page_close(&page)
	defer lava.result_destroy(&result)
	testing.expect_value(t, result.kill, lava.Kill_Reason.Cpu_Budget)
}

// The whole persistent-page lifecycle gives back everything it took from the
// allocator it ran under (CLAUDE.md §4): create, the script, three page_evals (one
// throwing), a run_until to Met, close. A warm-up page first, untracked, so lazily
// built thread state (the thread's VM pool, host-native tables) is not counted as
// this page's. The loop's own tables are on the same allocator, so the deadline
// timer's bookkeeping is counted too.
@(test)
page_api_lifecycle_frees_everything_it_allocates :: proc(t: ^testing.T) {
	{
		warm: lava.Page
		warm_loop: eventloop.Loop
		open_web_page(t, &warm, &warm_loop, `1`)
		lava.page_eval(&warm, `1`)
		close_page(&warm)
	}

	track: mem.Tracking_Allocator
	mem.tracking_allocator_init(&track, context.allocator)
	defer mem.tracking_allocator_destroy(&track)
	track.bad_free_callback = mem.tracking_allocator_bad_free_callback_add_to_array

	{
		context.allocator = mem.tracking_allocator(&track)
		page: lava.Page
		loop: eventloop.Loop
		open_web_page(t, &page, &loop, `globalThis.done = false; setTimeout(() => { done = true; }, 5);`)
		lava.page_eval(&page, `var k = 1; k`)
		lava.page_eval(&page, `throw new Error('k')`)
		lava.page_eval(&page, `({k})`)
		testing.expect_value(t, lava.page_run_until(&page, cond_global_done, nil, 10_000), lava.Run_Stop.Met)
		result, _ := lava.page_close(&page)
		testing.expect_value(t, result.status, lava.Status.Ok)
		lava.result_destroy(&result)
		free_all(context.temp_allocator)
	}

	testing.expectf(
		t,
		len(track.bad_free_array) == 0,
		"%d free(s) of memory the tracking allocator never handed out",
		len(track.bad_free_array),
	)
	for _, entry in track.allocation_map {
		testing.expectf(t, false, "the page leaked %d bytes from %v", entry.size, entry.location)
	}
}

// open_web_page creates a `.Web` page on a fresh real_time loop and runs `source` as
// its top-level script, failing the test if either step ends the page.
@(private = "file")
open_web_page :: proc(
	t: ^testing.T,
	page: ^lava.Page,
	loop: ^eventloop.Loop,
	source: string,
	limits := API_LIMITS,
	loc := #caller_location,
) {
	loop^ = eventloop.init(real_time = true)

	if !lava.page_create(page, "<page-api>", loop, limits = limits, surface = .Web) {
		testing.fail_now(t, "page_create refused the page", loc)
	}

	lava.page_run_script(page, source, "<page-api>")

	if page.finished {
		testing.fail_now(t, "the top-level script ended the page", loc)
	}
}

@(private = "file")
close_page :: proc(page: ^lava.Page) {
	result, busy := lava.page_close(page)
	lava.result_destroy(&result)

	if busy != nil {
		eventloop.close_finish(busy)
	}
}

// run_to_close_via_open drives a page the way eval does: page_open, tick, close.
@(private = "file")
run_to_close_via_open :: proc(source, source_name: string) -> lava.Result {
	page: lava.Page
	loop := eventloop.init(real_time = true)

	if lava.page_open(&page, source, source_name, &loop, true, limits = API_LIMITS, surface = .Web) {
		for {
			if alive, _ := lava.page_tick(&page); !alive {
				break
			}
		}
	}

	result, _ := lava.page_close(&page)
	return result
}

// run_to_close_via_create drives the same page through the split steps.
@(private = "file")
run_to_close_via_create :: proc(source, source_name: string) -> lava.Result {
	page: lava.Page
	loop := eventloop.init(real_time = true)

	if lava.page_create(&page, source_name, &loop, limits = API_LIMITS, surface = .Web) &&
	   lava.page_run_script(&page, source, source_name, true) {
		for {
			if alive, _ := lava.page_tick(&page); !alive {
				break
			}
		}
	}

	result, _ := lava.page_close(&page)
	return result
}

@(private = "file")
eval_number :: proc(page: ^lava.Page, v: jsc.JSValueRef) -> f64 {
	if v == nil {
		return -1
	}

	return jsc.JSValueToNumber(cast(jsc.JSContextRef)page.ctx, v, nil)
}

// page_protected_count reads JSC's protectedObjectCount on the page's own context.
// Unlike page_lifecycle_test's vm_protect_counts, which reads an idle VM through a
// throwaway context, this one reads a live page between its entries; the reading is a
// C-API exit on the page's context, which drains its (empty) microtask queue.
@(private = "file")
page_protected_count :: proc(t: ^testing.T, page: ^lava.Page) -> int {
	ctx := cast(jsc.JSContextRef)page.ctx
	stats := jsc_memory_stats(ctx)

	if stats == nil {
		testing.fail_now(t, "JSGetMemoryUsageStatistics returned nothing")
	}

	key := jsc.JSStringCreateWithUTF8CString("protectedObjectCount")
	defer jsc.JSStringRelease(key)
	v := jsc.JSObjectGetProperty(ctx, stats, key, nil)

	if v == nil || !jsc.JSValueIsNumber(ctx, v) {
		testing.fail_now(t, "JSGetMemoryUsageStatistics has no protectedObjectCount")
	}

	return int(jsc.JSValueToNumber(ctx, v, nil))
}

// cond_global_done reads the page's `done` global through page_eval.
@(private = "file")
cond_global_done :: proc(page: ^lava.Page, user_data: rawptr) -> bool {
	v, ok := lava.page_eval(page, `done`)
	return ok && jsc.JSValueToBoolean(cast(jsc.JSContextRef)page.ctx, v)
}

@(private = "file")
cond_count_true :: proc(page: ^lava.Page, user_data: rawptr) -> bool {
	(cast(^int)user_data)^ += 1
	return true
}

@(private = "file")
cond_never :: proc(page: ^lava.Page, user_data: rawptr) -> bool {
	return false
}
