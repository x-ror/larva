// Linux-only: the runner waits through epoll, and the descriptor and RSS census read
// /proc/self.
#+build linux
package main

import "core:log"
import "core:testing"
import jsc "lava:pkg/jsc"
import lava "lava:pkg/runtime"

// VM retirement (#3, docs/LARVA.md decision 2): a pooled VM is destroyed at vm_release,
// instead of going back to the pool, once it has hosted retire_after_pages pages or a
// sampled heap reached retire_heap_bytes. The next acquire creates a fresh VM. What these
// tests pin: each trigger retires exactly when it should and not before, the retired
// VM's RunLoop timerfd closes with it, the page after a retirement runs (and sees
// nothing of the pages before), and a long churn of retirements leaves the process's
// descriptors flat.

@(private = "file")
RETIRE_LIMITS :: lava.Page_Limits {
	cpu_budget = 30,
}

// A page that fails if anything an earlier page on the thread left is visible: a
// global, a polluted prototype. It then leaves the same behind for the next one.
@(private = "file")
RETIRE_ISOLATION_PAGE :: `
const seen = [];
if (typeof leakR !== 'undefined') seen.push('leakR');
if ('pollutedR' in {}) seen.push('Object.prototype');
if (seen.length > 0) throw new Error('saw an earlier page: ' + seen.join(', '));
globalThis.leakR = 1;
Object.prototype.pollutedR = 1;
setTimeout(() => {}, 0);
`

@(private = "file")
RETIRE_HEAVY_PAGE :: "globalThis.keep = Array.from({ length: 400000 }, (_, i) => ({ i, s: 'x' + i }));"

// The approved defaults are what a pool starts with, the thread's implicit (eval's) pool
// included: 200 pages, 64 MB (approved 2026-11-26).
@(test)
vm_pool_starts_with_the_retirement_defaults :: proc(t: ^testing.T) {
	testing.expect_value(t, lava.VM_RETIRE_AFTER_PAGES, 200)
	testing.expect_value(t, lava.VM_RETIRE_HEAP_BYTES, i64(64 * 1024 * 1024))
	pool: lava.VM_Pool
	lava.vm_pool_init(&pool, 1, context.allocator)
	defer lava.vm_pool_destroy(&pool)
	testing.expect_value(t, pool.retire_after_pages, lava.VM_RETIRE_AFTER_PAGES)
	testing.expect_value(t, pool.retire_heap_bytes, lava.VM_RETIRE_HEAP_BYTES)
}

// A VM that has hosted retire_after_pages pages is retired at its last release: with a
// cap of 3, seven acquire/release pairs on a one-VM pool create three VMs and retire two,
// and the VM left has hosted only the seventh. With the cap off (0) one VM hosts all
// seven.
@(test)
vm_pool_retires_a_vm_at_its_page_cap :: proc(t: ^testing.T) {
	cycle :: proc(t: ^testing.T, cap: int) -> (created, retired, hosted: int) {
		pool: lava.VM_Pool
		lava.vm_pool_init(&pool, 1, context.allocator)
		defer lava.vm_pool_destroy(&pool)
		pool.retire_after_pages = cap
		for _ in 0 ..< 7 {
			vm, err := lava.vm_acquire(&pool)

			if err != .None {
				testing.fail_now(t, "vm_acquire failed")
			}

			ctx := lava.vm_create_context(vm, nil)
			jsc.JSGlobalContextRelease(ctx)
			lava.vm_release(vm)
		}
		busy: int
		busy, created, retired = lava.vm_pool_stats(&pool)
		testing.expect_value(t, busy, 0)
		testing.expect_value(t, len(pool.vms), 1)

		if len(pool.vms) == 1 {
			hosted = pool.vms[0].pages_hosted
		}

		return
	}
	created, retired, hosted := cycle(t, 3)
	testing.expect_value(t, created, 3)
	testing.expect_value(t, retired, 2)
	testing.expect_value(t, hosted, 1)
	created, retired, hosted = cycle(t, 0)
	testing.expect_value(t, created, 1)
	testing.expect_value(t, retired, 0)
	testing.expect_value(t, hosted, 7)
}

// Through the page runner, with its pool's cap lowered to 2: five pages one after
// another on a one-slot runner run on three VMs, two of them retired, and every page —
// the ones on a fresh VM after a retirement included — finishes .Ok seeing nothing of
// the pages before it.
@(test)
runner_retires_a_vm_at_its_page_cap :: proc(t: ^testing.T) {
	runner: lava.Page_Runner

	if !lava.page_runner_init(&runner, 1, record_page_outcome, context.allocator) {
		testing.fail_now(t, "page_runner_init failed")
	}

	defer lava.page_runner_destroy(&runner)
	runner.pool.retire_after_pages = 2
	out: [5]Page_Outcome
	for &o in out {
		lava.page_runner_open(&runner, RETIRE_ISOLATION_PAGE, "<retire>", RETIRE_LIMITS, &o)
		lava.page_runner_run(&runner)
	}
	for o, i in out {
		testing.expectf(
			t,
			o.done && o.status == .Ok && o.kill == .None && o.exit == 0,
			"page %d: %s",
			i,
			describe_outcome(o),
		)
	}
	_, created, retired := lava.vm_pool_stats(&runner.pool)
	testing.expect_value(t, created, 3)
	testing.expect_value(t, retired, 2)
}

@(private = "file")
Retire_Heap :: struct {
	outcome: Page_Outcome,
	heap:    i64,
}

@(private = "file")
record_retire_heap :: proc(runner: ^lava.Page_Runner, user_data: rawptr, result: lava.Result) {
	r := cast(^Retire_Heap)user_data
	r.heap = result.heap_bytes
	record_page_outcome(runner, &r.outcome, result)
}

// run_heap_sequence runs a light page, a page keeping 400k objects, then a light page,
// one by one on a one-slot runner with the page cap off and the heap threshold at
// HEAP_COLLECT_BYTES (a 400k-object page reaches it: runner_collects_a_vm_whose_sampled_
// heap_was_large), and reports the pool's counts after the first page and at the end.
@(private = "file")
run_heap_sequence :: proc(
	t: ^testing.T,
	sample_every: int,
	out: ^[3]Retire_Heap,
) -> (
	created_after_light, created, retired: int,
) {
	runner: lava.Page_Runner

	if !lava.page_runner_init(&runner, 1, record_retire_heap, context.allocator) {
		testing.fail_now(t, "page_runner_init failed")
	}

	defer lava.page_runner_destroy(&runner)
	runner.heap_sample_every = sample_every
	runner.pool.retire_after_pages = 0
	runner.pool.retire_heap_bytes = lava.HEAP_COLLECT_BYTES
	sources := [3]string{"1", RETIRE_HEAVY_PAGE, "1"}
	for src, i in sources {
		lava.page_runner_open(&runner, src, "<heap>", RETIRE_LIMITS, &out[i])
		lava.page_runner_run(&runner)

		if i == 0 {
			_, created_after_light, _ = lava.vm_pool_stats(&runner.pool)
		}
	}
	for r, i in out {
		testing.expectf(t, r.outcome.done && r.outcome.status == .Ok, "page %d: %s", i, describe_outcome(r.outcome))
	}
	_, created, retired = lava.vm_pool_stats(&runner.pool)
	return
}

// A sampled heap at or above retire_heap_bytes retires its VM: the light page's VM is
// kept (its sample is under the threshold), the heavy page's is retired, and the last
// page runs on a second, fresh VM.
@(test)
runner_retires_a_vm_whose_sampled_heap_crossed_the_threshold :: proc(t: ^testing.T) {
	out: [3]Retire_Heap
	created_after_light, created, retired := run_heap_sequence(t, 1, &out)
	testing.expectf(
		t,
		out[0].heap > 0 && out[0].heap < lava.HEAP_COLLECT_BYTES,
		"the light page's sample (%d) is not under the threshold: the case proves nothing",
		out[0].heap,
	)
	testing.expectf(
		t,
		out[1].heap >= lava.HEAP_COLLECT_BYTES,
		"the heavy page's sample (%d) is under the threshold: the case proves nothing",
		out[1].heap,
	)
	testing.expect_value(t, created_after_light, 1)
	testing.expect_value(t, created, 2)
	testing.expect_value(t, retired, 1)
}

// The heap trigger reads the page's sample and takes no reading of its own (vm_pool.odin
// says why): with sampling off the same heavy page does not retire its VM, and only the
// page cap bounds it.
@(test)
runner_does_not_retire_on_heap_without_a_sample :: proc(t: ^testing.T) {
	out: [3]Retire_Heap
	_, created, retired := run_heap_sequence(t, 0, &out)
	testing.expectf(t, out[1].heap == 0, "sampling off, the heavy page was sampled: %d", out[1].heap)
	testing.expect_value(t, created, 1)
	testing.expect_value(t, retired, 0)
}

// A retired VM's RunLoop timerfd closes at its retirement, not at the pool's (or the
// thread's) end: vm_release iterates the RunLoop once after JSContextGroupRelease.
// Process-wide census, so only meaningful on one runner thread (fd_census); on a fresh
// thread, so the thread's RunLoop is driven (on_fresh_thread).
@(test)
vm_retirement_closes_the_retired_vms_timerfd :: proc(t: ^testing.T) {
	when RUNNER_THREADS != 1 {
		log.info("skipped: /proc/self/fd is process-wide; needs -define:ODIN_TEST_THREADS=1")
		return
	}
	on_fresh_thread(t, proc(t: ^testing.T) {
		pool: lava.VM_Pool
		lava.vm_pool_init(&pool, 1, context.allocator)
		defer lava.vm_pool_destroy(&pool)
		pool.retire_after_pages = 1
		before := fd_census(timerfds_only = true)
		vm, err := lava.vm_acquire(&pool)

		if err != .None {
			testing.fail_now(t, "vm_acquire failed")
		}

		ctx := lava.vm_create_context(vm, nil)
		src := jsc.JSStringCreateWithUTF8CString("var q = []; for (let i = 0; i < 20000; i++) q.push({ i }); 0")
		jsc.JSEvaluateScript(cast(jsc.JSContextRef)ctx, src, nil, nil, 1, nil)
		jsc.JSStringRelease(src)
		jsc.JSGlobalContextRelease(ctx)
		live := fd_census(timerfds_only = true)
		lava.vm_release(vm)
		after := fd_census(timerfds_only = true)
		_, _, retired := lava.vm_pool_stats(&pool)
		testing.expect_value(t, retired, 1)
		testing.expect_value(t, len(pool.vms), 0)
		testing.expectf(
			t,
			live > before,
			"no timerfd while the VM lived (%d -> %d): the census cannot see it",
			before,
			live,
		)
		testing.expectf(t, after == before, "%d timerfd(s) outlived the retired VM", after - before)
	})
}

@(private = "file")
RETIRE_CHURN_PAGES :: 1000

@(private = "file")
RETIRE_CHURN_WARMUP :: 100

@(private = "file")
RETIRE_CHURN_SOURCE :: "globalThis.keep = Array.from({ length: 5000 }, (_, i) => ({ i })); setTimeout(() => {}, 0);"

@(private = "file")
Retire_Churn :: struct {
	// Pages are reopened from on_done until `opened` reaches `target`.
	target, opened, reported, ok: int,
	first_bad:                    Page_Outcome,
}

@(private = "file")
retire_churn_done :: proc(runner: ^lava.Page_Runner, user_data: rawptr, result: lava.Result) {
	c := cast(^Retire_Churn)user_data
	o: Page_Outcome
	record_page_outcome(runner, &o, result)
	c.reported += 1

	if o.status == .Ok && o.kill == .None && o.exit == 0 {
		c.ok += 1
	} else if !c.first_bad.done {
		c.first_bad = o
	}

	if c.opened < c.target {
		c.opened += 1
		lava.page_runner_open(runner, RETIRE_CHURN_SOURCE, "<churn>", RETIRE_LIMITS, c)
	}
}

// retire_churn_to runs pages through both slots until `target` pages have been opened
// in all, and returns once none is live, so every census is taken in the same state.
@(private = "file")
retire_churn_to :: proc(runner: ^lava.Page_Runner, c: ^Retire_Churn, target: int) {
	c.target = target
	for _ in 0 ..< 2 {
		c.opened += 1
		lava.page_runner_open(runner, RETIRE_CHURN_SOURCE, "<churn>", RETIRE_LIMITS, c)
	}
	lava.page_runner_run(runner)
}

// RETIRE_CHURN_RSS_SLACK bounds the RSS growth between the warm-up and the churn's end.
// Each retirement gives its VM's heap back; what is left is malloc's high-water mark
// moving. Measured on this case (two runs, one runner thread, Ryzen 7 7700X, 2026-11-26):
// +6.8 MB and +8.0 MB; with the retired VMs' groups never released, +720 MB and 90 more
// descriptors (one run). The bound sits far from both.
@(private = "file")
RETIRE_CHURN_RSS_SLACK :: 32 * 1024 * 1024

// 1000 pages through 2 slots with a page cap of 10 — a retirement every 10 pages per VM,
// ~100 VMs in all — leave the process's descriptor count where it was after the first
// 100 pages, and its RSS within RETIRE_CHURN_RSS_SLACK of it. One runner thread
// (fd_census), on a fresh thread so the RunLoop is driven. The runner's own
// between-rounds dispatch also closes a retired VM's timerfd here, so this case does
// not pin vm_retire's iteration — vm_retirement_closes_the_retired_vms_timerfd does; it
// pins that a retirement gives the VM back at all.
@(test)
runner_churn_with_retirement_keeps_fds_flat_and_rss_bounded :: proc(t: ^testing.T) {
	when RUNNER_THREADS != 1 {
		log.info("skipped: /proc/self/fd is process-wide; needs -define:ODIN_TEST_THREADS=1")
		return
	}
	on_fresh_thread(t, proc(t: ^testing.T) {
		runner: lava.Page_Runner
		c: Retire_Churn

		if !lava.page_runner_init(&runner, 2, retire_churn_done, context.allocator) {
			testing.expect(t, false, "page_runner_init failed")
			return
		}

		runner.pool.retire_after_pages = 10
		// The warm-up has retired VMs several times, so first-touch growth is behind it.
		retire_churn_to(&runner, &c, RETIRE_CHURN_WARMUP)
		fds_warm := fd_census()
		rss_warm := int(lava.os_process_rss_bytes())
		retire_churn_to(&runner, &c, RETIRE_CHURN_PAGES)
		fds_end := fd_census()
		rss_end := int(lava.os_process_rss_bytes())
		_, created, retired := lava.vm_pool_stats(&runner.pool)
		kept := len(runner.pool.vms)
		lava.page_runner_destroy(&runner)
		log.infof(
			"churn: %d VMs created, %d retired; fds %d -> %d; rss %d KB -> %d KB",
			created,
			retired,
			fds_warm,
			fds_end,
			rss_warm / 1024,
			rss_end / 1024,
		)
		testing.expect_value(t, c.reported, RETIRE_CHURN_PAGES)
		testing.expectf(
			t,
			c.ok == RETIRE_CHURN_PAGES,
			"%d of %d pages ended .Ok; first other: %s",
			c.ok,
			RETIRE_CHURN_PAGES,
			describe_outcome(c.first_bad),
		)
		testing.expectf(t, retired >= 98, "only %d VMs retired over %d pages at a cap of 10", retired, c.reported)
		testing.expect_value(t, created, retired + kept)
		testing.expectf(t, fds_end == fds_warm, "descriptors grew from %d to %d over the churn", fds_warm, fds_end)
		testing.expectf(
			t,
			rss_end - rss_warm < RETIRE_CHURN_RSS_SLACK,
			"RSS grew by %d KB over the churn",
			(rss_end - rss_warm) / 1024,
		)
	})
}
