// Linux-only: the page runner exists only there (page_runner_other.odin), and the two
// JSC debugging entry points below are resolved against libjavascriptcoregtk-6.0.
#+build linux
package main

import "core:fmt"
import "core:mem"
import "core:sys/posix"
import "core:testing"
import "core:time"
import jsc "lava:pkg/jsc"
import lava "lava:pkg/runtime"

// Issue #3's acceptance criteria that no oracle can see (CLAUDE.md §6): what a page
// can observe of a predecessor that finished cleanly in the same VM, whether a churn of
// pages with every fate gives back everything it took from the runner allocator, and
// whether a page leaves the VM's JSValueProtect count where it found it.

// Both are exported, plain-C entry points of WebKit's JSBasePrivate.h — the header is
// not installed, the symbols are (`nm -D libjavascriptcoregtk-6.0.so.1`). Declared here
// and not in pkg/jsc: nothing in production calls either, and the one production
// reader of JSGetMemoryUsageStatistics (jsc.heap_size_bytes) reads only heapCapacity.
// JSGarbageCollect, which pkg/jsc does bind, only reports an abandoned object graph to
// the heap; it collects nothing on its own.
//
// Resolved through dlsym, as jsc.heap_size_bytes resolves its symbol, not linked: a
// static reference to a private symbol is a link-time dependency of the whole cmd/lava
// test binary, so a JSC build without it would fail to link every test in the package,
// not just the ones that read it. Missing, each answers nil/false and the calling test
// fails with that reason. core:sys/posix's dlsym, with a nil handle (RTLD_DEFAULT on
// glibc), the lookup heap_size_bytes makes through its file-private binding.
@(private = "file")
Collect_Now_Proc :: #type proc "c" (ctx: jsc.JSContextRef)
@(private = "file")
Memory_Stats_Proc :: #type proc "c" (ctx: jsc.JSContextRef) -> jsc.JSObjectRef

// jsc_collect_now runs JSSynchronousGarbageCollectForDebugging on `ctx`'s VM; false
// when this JSC does not export it.
jsc_collect_now :: proc(ctx: jsc.JSContextRef) -> bool {
	p := posix.dlsym(nil, "JSSynchronousGarbageCollectForDebugging")

	if p == nil {
		return false
	}

	(transmute(Collect_Now_Proc)p)(ctx)
	return true
}

// jsc_memory_stats is JSGetMemoryUsageStatistics(ctx); nil when this JSC does not
// export it.
jsc_memory_stats :: proc(ctx: jsc.JSContextRef) -> jsc.JSObjectRef {
	p := posix.dlsym(nil, "JSGetMemoryUsageStatistics")

	if p == nil {
		return nil
	}

	return (transmute(Memory_Stats_Proc)p)(ctx)
}

// LIMITS is a CPU budget far above anything a passing page spends: the runner refuses
// a page without one, and reaching it is itself a failure (a kill, not the exit code
// the case waits for).
@(private = "file")
LIMITS :: lava.Page_Limits {
	cpu_budget = 30,
}

// The churn: pages in all, long-lived pages opened first and holding their slots
// until the runner is destroyed, and runner slots (one VM each).
@(private = "file")
CHURN_PAGES :: 48
@(private = "file")
CHURN_CANCELLED :: 2
@(private = "file")
CHURN_SLOTS :: 6

// Protect_Counts is what JSC's own books say about GC roots in one VM:
// JSC::Heap::protectedObjectCount — every cell with a JSValueProtect or a
// JSGlobalContextRetain outstanding, plus every Strong handle (see the protect-count
// test for the CodeCache's) — and how many of those are global objects.
@(private = "file")
Protect_Counts :: struct {
	objects: int,
	globals: int,
}

@(private = "file")
Churn_Fate :: enum {
	Finished,
	Thrown,
	Budget_Killed,
	// Throws from a timer with a fetch still in flight: status .Ok, exit 1.
	Async_Thrown,
	// Still running when the runner is destroyed: reported .Cancelled.
	Cancelled,
}

@(private = "file")
Churn_Page :: struct {
	churn:   ^Churn,
	fate:    Churn_Fate,
	source:  string,
	outcome: Page_Outcome,
	// 1-based position in the order pages were reported in; 0 = not reported.
	order:   int,
	reports: int,
}

@(private = "file")
Churn :: struct {
	pages:    []Churn_Page,
	// Next page on_done opens; pages open as earlier ones finish, so the runner is
	// always full and every page after the first few lands in a reused VM.
	next:     int,
	reported: int,
}

// A page that FINISHED NORMALLY in a VM leaves the next page in it nothing it can
// see (CLAUDE.md §6) — the counterpart of the killed and exited predecessors in
// page_runner_test.odin, which leave work behind; this one leaves only state. The first
// page writes a global, pollutes three intrinsics (Object.prototype, Array.prototype,
// JSON.parse) and Error.stackTraceLimit, and finishes with its loop idle. The second
// page, on the same VM (one runner slot), names each and must find the pristine value.
// What makes that hold is a fresh global context per page (page_open → page_close),
// each with its own intrinsics; a context kept across pages would carry every one of
// them.
//
// The first page also leaves a FinalizationRegistry cleanup DUE when it closes, which is
// the VM-level risk: the registry's cleanup is scheduled by the GC on the VM and queued on
// the thread's RunLoop, not on the page, so a drive after the page closed could run it on
// the next page's watch. The test collects right after the first page opens, so its 8
// targets are dead and the cleanup task is queued before the page's one and only tick
// ends it; the RunLoop is next dispatched by the runner's round after that close. What
// must happen then (js/internal/deferred.js, pkg/runtime/deferred.odin): the engine runs
// the shim in the closed realm, the shim asks for a turn on a page that is gone and
// drops the queue, and the cleanup — 1.5 s of busy wall time — runs nowhere. Two observations: the second page,
// under a 1 s budget, is not killed; and the whole stretch from the first page's close to
// the second's end takes well under 1.5 s of wall time on this thread, which a cleanup
// run anywhere on it (at the close, between the second page's rounds, inside its ticks)
// could not. The test forces full collections between every step of the second page too
// (vm_collect), rather than hoping one happens.
//
// On a fresh thread (on_fresh_thread), so the drive is on: a test-runner thread whose
// first VM was a bare JSGlobalContextCreate never adopts it, and the cleanup would never
// be dispatched at all — the test would pass for the wrong reason, as it did while it was
// a tripwire (Lava never ran a cleanup before #91).
//
// Not tested: the Symbol.for registry, which is the VM's and does survive into the
// next page. It is unobservable from there: Symbol.for(key) answers the same symbol
// whoever registered key first, and the second page has no handle on the first's.
@(test)
runner_second_page_in_a_reused_vm_sees_nothing_of_a_finished_first :: proc(t: ^testing.T) {
	on_fresh_thread(t, proc(t: ^testing.T) {
		runner: lava.Page_Runner

		if !lava.page_runner_init(&runner, 1, record_page_outcome, context.allocator) {
			testing.expect(t, false, "page_runner_init failed")
			return
		}

		defer lava.page_runner_destroy(&runner)
		first, second: Page_Outcome
		lava.page_runner_open(
			&runner,
			`globalThis.leakA = 1;
			Object.prototype.pollutedA = 1;
			Array.prototype.pollutedA = 1;
			JSON.parse = () => 'from the first page';
			Error.stackTraceLimit = 0;
			const fr = new FinalizationRegistry(() => { const s = Date.now(); while (Date.now() - s < 1500) {} });
			globalThis.keepFr = fr;
			(function () { for (let i = 0; i < 8; i++) fr.register({}, i); })();`,
			"<first>",
			LIMITS,
			&first,
		)

		if len(runner.pool.vms) != 1 {
			testing.expect(t, false, "the first page left no VM to reuse")
			return
		}

		testing.expect_value(t, jsc.runloop_drive(), jsc.Runloop_Drive.Adopted)
		vm := runner.pool.vms[0]
		vm_collect(t, vm)
		start := time.tick_now()
		lava.page_runner_run(&runner)
		testing.expectf(
			t,
			first.done && first.status == .Ok && first.kill == .None && first.exit == 0,
			"first page did not finish normally: %s",
			describe_outcome(first),
		)
		lava.page_runner_open(
			&runner,
			`const seen = [];
			if (typeof leakA !== 'undefined') seen.push('leakA');
			if ('pollutedA' in {}) seen.push('Object.prototype');
			if ('pollutedA' in []) seen.push('Array.prototype');
			if (JSON.parse('1') !== 1) seen.push('JSON.parse');
			if (Error.stackTraceLimit === 0) seen.push('Error.stackTraceLimit');
			if (seen.length > 0) throw new Error('second page saw the first: ' + seen.join(', '));
			let n = 0;
			(function tick() { if (++n < 20) setTimeout(tick, 1); })();`,
			"<second>",
			{cpu_budget = 1},
			&second,
		)
		for lava.page_runner_live(&runner) > 0 {
			lava.page_runner_step(&runner)
			vm_collect(t, vm)
		}
		lava.page_runner_run(&runner)
		elapsed := time.duration_seconds(time.tick_since(start))
		testing.expectf(
			t,
			second.done && second.status == .Ok && second.kill == .None && second.exit == 0,
			"second page: %s",
			describe_outcome(second),
		)
		testing.expectf(
			t,
			elapsed < 1.2,
			"the first page's close and the second page took %.2f s: the first page's cleanup ran after it closed",
			elapsed,
		)
		_, created, _ := lava.vm_pool_stats(&runner.pool)
		testing.expect_value(t, created, 1)
	})
}

// A churn of pages with every fate gives back everything it took from the runner
// allocator (CLAUDE.md §4). 48 pages through 6 slots — so 6 VMs, each reused about
// eight times — finishing normally, throwing at top level, killed by the CPU budget,
// throwing from a timer, and two cancelled by page_runner_destroy while they still
// run. Every page that does not finish normally keeps something registered past its
// end (an interval, a pending timer or fetch), so a closing loop's cancel paths run on
// every other fate; the finished pages run a fetch and a timer chain to the end. Each
// page's delay is a permutation of its index, so pages close in an order unrelated
// to the one they opened in (asserted, or the case would only cover FIFO). The runner
// runs on a tracking allocator that records a free of memory it never handed out
// instead of panicking; after destroy its books must be empty, with no such free.
//
// The tracking allocator sees what the runner allocates through its own allocator —
// bookkeeping, every page's Runtime_State, Result messages — which
// is the allocator the runner's entry points install as context.allocator. Page
// loops and what JSC is handed are on the heap by design (page_runner.odin,
// Runner_Page) and are not counted here.
@(test)
runner_churn_of_mixed_fates_frees_everything_it_allocates :: proc(t: ^testing.T) {
	track: mem.Tracking_Allocator
	mem.tracking_allocator_init(&track, context.allocator)
	defer mem.tracking_allocator_destroy(&track)
	track.bad_free_callback = mem.tracking_allocator_bad_free_callback_add_to_array

	pages := make([]Churn_Page, CHURN_PAGES)
	defer delete(pages)
	churn := Churn {
		pages = pages,
	}
	defer for &cp in pages {
		delete(cp.source)
	}
	for &cp, i in pages {
		cp.churn = &churn
		// 0..22 ms, a permutation of the index: 17 and 23 are coprime.
		delay := (i * 17) % 23
		cp.fate = i < CHURN_CANCELLED ? .Cancelled : Churn_Fate(i % 4)
		switch cp.fate {
		case .Finished:
			cp.source = fmt.aprintf(
				`fetch('http://127.0.0.1:1/').catch(() => {{}});
				let n = 0; (function f() {{ if (++n < 3) setTimeout(f, %d); else throw 7; }})();`,
				delay,
			)
		case .Thrown:
			cp.source = fmt.aprintf(
				`setInterval(() => {{}}, 1); setTimeout(() => {{}}, %d); throw new Error('churn %d');`,
				delay,
				i,
			)
		case .Budget_Killed:
			cp.source = fmt.aprintf(
				`setInterval(() => {{}}, 1);
				setTimeout(function spin() {{ const s = Date.now(); while (Date.now() - s < 2) {{}} setTimeout(spin, 0); }}, %d);`,
				delay,
			)
		case .Async_Thrown:
			cp.source = fmt.aprintf(
				`fetch('http://127.0.0.1:1/').catch(() => {{}});
				setTimeout(() => {{ throw 4; }}, %d);`,
				delay,
			)
		case .Cancelled:
			cp.source = fmt.aprint(`setInterval(() => {}, 5); fetch('http://127.0.0.1:1/').catch(() => {});`)
		}
	}

	runner: lava.Page_Runner

	if !lava.page_runner_init(&runner, CHURN_SLOTS, churn_done, mem.tracking_allocator(&track)) {
		testing.fail_now(t, "page_runner_init failed")
	}

	for i in 0 ..< CHURN_SLOTS {
		churn_open(&runner, &churn, i)
	}
	// Every page but the cancelled ones reports; those never end on their own. Bounded,
	// so a page that never reports fails the case instead of hanging the runner: the
	// whole churn takes well under a second.
	deadline := time.tick_add(time.tick_now(), 20 * time.Second)
	for churn.reported < CHURN_PAGES - CHURN_CANCELLED && time.tick_diff(time.tick_now(), deadline) > 0 {
		lava.page_runner_step(&runner)
	}
	testing.expect_value(t, lava.page_runner_live(&runner), CHURN_CANCELLED)
	_, created, _ := lava.vm_pool_stats(&runner.pool)
	lava.page_runner_destroy(&runner)

	testing.expect_value(t, created, CHURN_SLOTS)
	out_of_order := 0
	for cp, i in pages {
		o := cp.outcome
		ok := cp.reports == 1 && o.done
		switch cp.fate {
		case .Finished:
			ok = ok && o.status == .Ok && o.kill == .None && o.exit == 1
		case .Thrown:
			ok = ok && o.status == .Execution_Error && o.kill == .None && o.exit == 1
		case .Budget_Killed:
			ok = ok && o.status == .Execution_Error && o.kill == .Cpu_Budget
		case .Async_Thrown:
			ok = ok && o.status == .Ok && o.kill == .None && o.exit == 1
		case .Cancelled:
			ok = ok && o.status == .Execution_Error && o.kill == .Cancelled
		}
		testing.expectf(t, ok, "page %d (%v) reported %d time(s) as %s", i, cp.fate, cp.reports, describe_outcome(o))

		if i > 0 && cp.order < pages[i - 1].order {
			out_of_order += 1
		}
	}
	testing.expectf(t, out_of_order > 0, "pages closed in the order they opened: the churn covered FIFO only")
	testing.expectf(
		t,
		len(track.bad_free_array) == 0,
		"%d free(s) through the runner allocator of memory it never allocated",
		len(track.bad_free_array),
	)
	for _, entry in track.allocation_map {
		testing.expectf(t, false, "runner allocator leaked %d bytes from %v", entry.size, entry.location)
	}
}

// Every page leaves the VM's protect count where it found it (CLAUDE.md §4: one
// Unprotect per Protect, on fire or on cancel). Counted by JSC itself rather than by
// wrapping our call sites, so a Protect nobody thought to wrap is counted too. One VM,
// one page at a time, each a different way of holding JS values across loop turns:
// timers and an interval that runs out, promise chains across timers, a fetch whose
// callbacks fire, a page doing all of it at once, and three pages that end with
// callbacks still registered — killed by the entry limit, by the CPU budget, and by a
// top-level throw — whose cancel paths must unprotect what fire never did. A page
// proves it reached the state it claims by throwing from the callback that gets there:
// exit code 1, which a page that never got there does not have.
// The globals count is the context itself: a page whose context is not released
// leaves its global protected.
//
// Why every case runs twice and only the second pass is asserted: JSC's count is not
// only JSValueProtect. Heap::protectedObjectCount also walks the Strong handles, and
// the VM's CodeCache keeps one per distinct source it has compiled — measured here,
// with no Lava in the loop: a bare context in the same group evaluating a ~110-char
// script raised the count by 1, the same script again by 0, a one-character edit of
// it by 1 (a 10-char script by 0: too short to be cached). Through the runner the
// same held for a page's source: +1 the first time a text ran in the VM, 0 after. So
// the first pass fills the CodeCache with every source involved, and from then on a
// change in the count is a root the page left behind.
@(test)
runner_pages_leave_the_vm_protect_count_where_they_found_it :: proc(t: ^testing.T) {
	Case :: struct {
		name:    string,
		source:  string,
		limits:  lava.Page_Limits,
		// How the page must end, so a case that never reached the state it claims
		// to leave behind fails rather than passing on an empty page.
		status:  lava.Status,
		kill:    lava.Kill_Reason,
		exit:    int,
	}
	// 127.0.0.1:1 refuses at once on any box with nothing bound to tcpmux, which is
	// what the fetch cases want: a real request whose callbacks come back promptly.
	// The killed and exited pages start one first, so it is in flight when they end.
	cases := []Case {
		{
			"timers",
			`let n = 0; setTimeout(() => {}, 1);
			const i = setInterval(() => { if (++n === 3) { clearInterval(i); throw 7; } }, 1);`,
			LIMITS,
			.Ok,
			.None,
			1,
		},
		{
			"promises",
			`new Promise((r) => setTimeout(r, 2)).then(() => Promise.resolve(1)).then((v) => {
				queueMicrotask(() => { if (v === 1) throw v; });
			});`,
			LIMITS,
			.Ok,
			.None,
			1,
		},
		{
			"fetch",
			`fetch('http://127.0.0.1:1/').then(() => {}, () => { throw 7; });`,
			LIMITS,
			.Ok,
			.None,
			1,
		},
		{
			"web",
			`setTimeout(() => {}, 1); fetch('http://127.0.0.1:1/').then(() => {}, () => {});
			new Promise((r) => setTimeout(r, 2)).then(() => {});`,
			LIMITS,
			.Ok,
			.None,
			0,
		},
		{
			"entry-limit kill",
			`setInterval(() => {}, 1); fetch('http://127.0.0.1:1/').catch(() => {});
			new Promise(() => {}).then(() => {});
			setTimeout(() => { for (;;) {} }, 5);`,
			{entry_limit = 0.05, cpu_budget = LIMITS.cpu_budget},
			.Execution_Error,
			.Entry_Limit,
			1,
		},
		{
			"cpu-budget kill",
			`setInterval(() => {}, 1); fetch('http://127.0.0.1:1/').catch(() => {});
			(function spin() { const s = Date.now(); while (Date.now() - s < 2) {} setTimeout(spin, 0); })();`,
			{cpu_budget = 0.05},
			.Execution_Error,
			.Cpu_Budget,
			1,
		},
		{
			"top-level throw",
			`setInterval(() => {}, 1); setTimeout(() => {}, 1000); fetch('http://127.0.0.1:1/').catch(() => {});
			throw new Error('top');`,
			LIMITS,
			.Execution_Error,
			.None,
			1,
		},
	}

	runner: lava.Page_Runner

	if !lava.page_runner_init(&runner, 1, record_page_outcome, context.allocator) {
		testing.fail_now(t, "page_runner_init failed")
	}

	defer lava.page_runner_destroy(&runner)
	before: Protect_Counts
	for pass in 0 ..< 2 {
		for c in cases {
			o: Page_Outcome
			lava.page_runner_open(&runner, c.source, c.name, c.limits, &o)
			lava.page_runner_run(&runner)
			testing.expectf(
				t,
				o.done && o.status == c.status && o.kill == c.kill && o.exit == c.exit,
				"%s page ended as %s, want %v/%v/exit %d",
				c.name,
				describe_outcome(o),
				c.status,
				c.kill,
				c.exit,
			)

			if pass == 0 {
				continue
			}

			after, _ := vm_protect_counts(runner.pool.vms[0])
			testing.expectf(
				t,
				after == before,
				"%s page left the VM's protect count at %v, was %v",
				c.name,
				after,
				before,
			)
			before = after
		}

		// The VM exists from the first page on, and one runner slot keeps it the only
		// one, so every page of both passes is in it.
		if pass == 0 {
			ok: bool
			before, ok = vm_protect_counts(runner.pool.vms[0])

			if !ok {
				testing.fail_now(t, "JSGetMemoryUsageStatistics has no protected counts")
			}
		}
	}
	_, created, _ := lava.vm_pool_stats(&runner.pool)
	testing.expect_value(t, created, 1)
}

@(private = "file")
churn_done :: proc(runner: ^lava.Page_Runner, user_data: rawptr, result: lava.Result) {
	cp := cast(^Churn_Page)user_data
	churn := cp.churn
	churn.reported += 1
	cp.order = churn.reported
	cp.reports += 1
	record_page_outcome(runner, &cp.outcome, result)

	if churn.next < len(churn.pages) {
		churn_open(runner, churn, churn.next)
	}
}

@(private = "file")
churn_open :: proc(runner: ^lava.Page_Runner, churn: ^Churn, i: int) {
	churn.next = max(churn.next, i + 1)
	cp := &churn.pages[i]
	limits := LIMITS

	if cp.fate == .Budget_Killed {
		limits.cpu_budget = 0.02
	}

	lava.page_runner_open(runner, cp.source, "<churn>", limits, cp)
}

// vm_protect_counts reads `vm`'s protect counts through a throwaway context in its
// group. That context's own global is protected while it lives, so every reading
// carries the same +1 in both counts; only differences between readings mean
// anything. The VM must be idle (no page in it): a pooled VM never hosts two live
// contexts outside this test file, and the stats call is a C-API exit, which drains
// the VM's microtask queue.
@(private = "file")
vm_protect_counts :: proc(vm: ^lava.VM) -> (counts: Protect_Counts, ok: bool) {
	probe := jsc.JSGlobalContextCreateInGroup(vm.group, nil)

	if probe == nil {
		return {}, false
	}

	defer jsc.JSGlobalContextRelease(probe)
	ctx := cast(jsc.JSContextRef)probe
	stats := jsc_memory_stats(ctx)

	if stats == nil {
		return {}, false
	}

	read :: proc(ctx: jsc.JSContextRef, stats: jsc.JSObjectRef, name: cstring) -> (int, bool) {
		key := jsc.JSStringCreateWithUTF8CString(name)
		defer jsc.JSStringRelease(key)
		v := jsc.JSObjectGetProperty(ctx, stats, key, nil)

		if v == nil || !jsc.JSValueIsNumber(ctx, v) {
			return 0, false
		}

		return int(jsc.JSValueToNumber(ctx, v, nil)), true
	}

	objects, objects_ok := read(ctx, stats, "protectedObjectCount")
	globals, globals_ok := read(ctx, stats, "protectedGlobalObjectCount")
	return {objects, globals}, objects_ok && globals_ok
}

// vm_collect runs a full synchronous collection of `vm`'s heap, through a throwaway
// context in its group, so a test does not have to hope an allocation-driven GC
// happens to land where it matters. Safe between a live page's ticks: the heap is the
// VM's, the throwaway context sees none of the page, and a tick leaves no promise job
// queued for the C-API exit to drain.
vm_collect :: proc(t: ^testing.T, vm: ^lava.VM, loc := #caller_location) {
	probe := jsc.JSGlobalContextCreateInGroup(vm.group, nil)

	if probe == nil {
		testing.fail_now(t, "could not create a probe context to collect in", loc)
	}

	collected := jsc_collect_now(cast(jsc.JSContextRef)probe)
	jsc.JSGlobalContextRelease(probe)

	if !collected {
		testing.fail_now(t, "this JSC does not export JSSynchronousGarbageCollectForDebugging", loc)
	}
}
