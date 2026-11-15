// Linux-only: the page runner exists only there (page_runner_other.odin), and these
// tests read /proc/self/fd and make FIFOs.
#+build linux
package main

import "core:fmt"
import "core:log"
import "core:mem"
import "core:mem/virtual"
import "core:net"
import "core:os"
import "core:strings"
import "core:sync"
import "core:sys/posix"
import "core:testing"
import "core:thread"
import "core:time"
import lava "lava:pkg/runtime"

// #34: closing a page must not join pool work still blocked on the runner thread. A
// page whose worker is blocked — in open() on a FIFO nobody writes, or in a DNS
// lookup the resolver has not answered — closes at once: its JS side goes, and its
// loop waits on the runner's reaping list until the worker exits.
//
// Every test that blocks a worker on a FIFO also starts an Unblocker: a thread that
// opens the FIFO's write end after `delay`. It is the red phase's way out — a close
// that joins the worker would otherwise hang the test binary — so these tests fail on
// a timing assertion rather than time out.

@(private = "file")
LIMITS :: lava.Page_Limits {
	cpu_budget = 30,
}

// QUICK_PAGE runs 20 short timer turns, then sets exitCode 7, to prove it ran to the
// end beside a closing sibling.
@(private = "file")
QUICK_PAGE :: "let n = 0; (function f() { if (++n < 20) setTimeout(f, 1); else process.exitCode = 7; })();"

@(private = "file")
Outcome :: struct {
	done:   bool,
	status: lava.Status,
	kill:   lava.Kill_Reason,
	exit:   int,
}

@(private = "file")
record :: proc(runner: ^lava.Page_Runner, user_data: rawptr, result: lava.Result) {
	result := result
	(cast(^Outcome)user_data)^ = {
		done   = true,
		status = result.status,
		kill   = result.kill,
		exit   = result.exit_code,
	}
	lava.result_destroy(&result)
}

@(private = "file")
expect_exit :: proc(t: ^testing.T, o: Outcome, code: int, what: string, loc := #caller_location) {
	testing.expectf(t, o.done && o.status == .Ok && o.kill == .None && o.exit == code, "%s: %v, want exit %d", what, o, code, loc = loc)
}

// make_fifo creates a per-test FIFO and returns its heap-allocated path.
make_fifo :: proc(t: ^testing.T, name: string) -> string {
	path := fmt.aprintf("/tmp/lava-reap-%d-%s.fifo", os.get_pid(), name)
	os.remove(path)
	if posix.mkfifo(strings.clone_to_cstring(path, context.temp_allocator), {.IRUSR, .IWUSR}) != .OK {
		testing.fail_now(t, "mkfifo failed")
	}
	return path
}

drop_fifo :: proc(path: string) {
	os.remove(path)
	delete(path)
}

// fifo_release opens the FIFO's write end without blocking, writes a byte and closes
// it, so a reader blocked in open() gets through and then reads to EOF. false while
// no reader is there yet (ENXIO).
fifo_release :: proc(path: string) -> bool {
	fd := posix.open(strings.clone_to_cstring(path, context.temp_allocator), {.WRONLY, .NONBLOCK})
	if fd < 0 do return false
	b := [1]u8{'x'}
	posix.write(fd, raw_data(b[:]), 1)
	posix.close(fd)
	return true
}

release_within :: proc(path: string, limit: time.Duration) -> bool {
	deadline := time.tick_add(time.tick_now(), limit)
	for !fifo_release(path) {
		if time.tick_diff(time.tick_now(), deadline) <= 0 do return false
		time.sleep(time.Millisecond)
	}
	return true
}

@(private = "file")
Unblocker :: struct {
	paths: []string,
	delay: time.Duration,
	stop:  bool,
	th:    ^thread.Thread,
}

@(private = "file")
unblocker_start :: proc(u: ^Unblocker, paths: []string, delay: time.Duration) {
	u.paths = paths
	u.delay = delay
	u.th = thread.create_and_start_with_poly_data(u, unblocker_proc)
}

@(private = "file")
unblocker_stop :: proc(u: ^Unblocker) {
	if u.th == nil do return
	sync.atomic_store(&u.stop, true)
	thread.destroy(u.th)
	u.th = nil
}

@(private = "file")
unblocker_proc :: proc(u: ^Unblocker) {
	deadline := time.tick_add(time.tick_now(), u.delay)
	for time.tick_diff(time.tick_now(), deadline) > 0 {
		if sync.atomic_load(&u.stop) do return
		time.sleep(5 * time.Millisecond)
	}
	released := make([]bool, len(u.paths), context.temp_allocator)
	give_up := time.tick_add(time.tick_now(), 5 * time.Second)
	for !sync.atomic_load(&u.stop) && time.tick_diff(time.tick_now(), give_up) > 0 {
		all := true
		for p, i in u.paths {
			if !released[i] do released[i] = fifo_release(p)
			all &&= released[i]
		}
		if all do return
		time.sleep(5 * time.Millisecond)
	}
}

// wait_reaped reaps until the runner's reaping list is empty or `limit` passes.
wait_reaped :: proc(runner: ^lava.Page_Runner, limit: time.Duration) -> bool {
	deadline := time.tick_add(time.tick_now(), limit)
	for lava.page_runner_reap(runner) > 0 {
		if time.tick_diff(time.tick_now(), deadline) <= 0 do return false
		time.sleep(time.Millisecond)
	}
	return true
}

// fd_link is what /proc/self/fd/<fd> points at ("pipe:[1234]"), "" once closed. The
// inode number tells the same pipe from a descriptor number reused by another.
@(private = "file")
fd_link :: proc(fd: int) -> string {
	target, err := os.read_link(fmt.tprintf("/proc/self/fd/%d", fd), context.temp_allocator)
	if err != nil do return ""
	return target
}

@(private = "file")
fifo_page :: proc(fifo: string, extra := "") -> string {
	return fmt.aprintf(`%srequire('fs').readFile(%q, () => {{}}); setTimeout(() => process.exit(4), 30);`, extra, fifo)
}

// Issue #34, the FIFO case: a page whose pool worker is blocked in open() on a FIFO
// closes at once, and its sibling on the thread finishes on time. The closed page's
// loop waits on the reaping list and is reaped once the worker gets through.
@(test)
runner_close_does_not_wait_for_a_worker_blocked_on_a_fifo :: proc(t: ^testing.T) {
	fifo := make_fifo(t, "close")
	defer drop_fifo(fifo)
	u: Unblocker
	unblocker_start(&u, {fifo}, 2 * time.Second)
	defer unblocker_stop(&u)
	runner: lava.Page_Runner
	if !lava.page_runner_init(&runner, 2, record, context.allocator) {
		testing.fail_now(t, "page_runner_init failed")
	}
	defer lava.page_runner_destroy(&runner)
	src := fifo_page(fifo)
	defer delete(src)

	a, b: Outcome
	start := time.tick_now()
	lava.page_runner_open(&runner, src, "<fifo>", LIMITS, &a)
	lava.page_runner_open(&runner, QUICK_PAGE, "<sibling>", LIMITS, &b)
	lava.page_runner_run(&runner)
	wall := time.duration_seconds(time.tick_since(start))

	expect_exit(t, a, 4, "fifo page")
	expect_exit(t, b, 7, "sibling")
	testing.expectf(t, wall < 1, "the runner took %.2fs: page_close waited on a worker blocked in open() on a FIFO", wall)
	testing.expect_value(t, lava.page_runner_reaping(&runner), 1)
	testing.expect(t, release_within(fifo, 2 * time.Second), "the worker was not blocked on the FIFO")
	testing.expect(t, wait_reaped(&runner, 3 * time.Second), "the closed page's loop was never reaped after its worker exited")
}

// Issue #34, the DNS case: a fetch and a node:dns lookup whose resolver never answers
// do not hold their pages' close. core:net reads its nameservers from
// net.dns_configuration.resolv_conf on every lookup, so pointing it at a file that
// names two loopback addresses with nothing on port 53 makes every lookup wait out
// core:net's 1 s receive timeout per server and family — no resolver hook needed.
// The configuration is process-wide; only lookups of names absent from /etc/hosts
// reach it, and no other test resolves one.
//
// Then the runner is destroyed while both lookups still run, so both loops are
// detached, and its allocator — a virtual arena — is unmapped. What the DNS workers
// touch from then on (the node:dns request, fetch's DNS_Job and its host, which
// core:net re-reads for each family) must be on the heap, and the dns callback must
// already be unprotected: a late JSValueUnprotect from the worker would reach a VM
// the destroy freed. Either mistake faults once the resolver times out; the test
// waits for that, until both detached loops have closed their pipes.
@(test)
runner_close_does_not_wait_for_a_hanging_dns_lookup :: proc(t: ^testing.T) {
	conf := fmt.aprintf("/tmp/lava-reap-%d-resolv.conf", os.get_pid())
	if err := os.write_entire_file(conf, transmute([]u8)string("nameserver 127.77.0.1\nnameserver 127.77.0.2\n")); err != nil {
		testing.fail_now(t, "could not write the stub resolv.conf")
	}
	saved := net.dns_configuration.resolv_conf
	net.dns_configuration.resolv_conf = conf
	defer {
		net.dns_configuration.resolv_conf = saved
		os.remove(conf)
		delete(conf)
	}
	arena: virtual.Arena
	if virtual.arena_init_growing(&arena) != nil {
		testing.fail_now(t, "arena_init_growing failed")
	}
	arena_live := true
	defer if arena_live do virtual.arena_destroy(&arena)
	runner: lava.Page_Runner
	if !lava.page_runner_init(&runner, 3, record, virtual.arena_allocator(&arena)) {
		testing.fail_now(t, "page_runner_init failed")
	}

	f, d, b: Outcome
	start := time.tick_now()
	lava.page_runner_open(&runner, "fetch('http://lava-reap-hang.test/').then(() => {}, () => {}); setTimeout(() => process.exit(4), 30);", "<fetch>", LIMITS, &f)
	lava.page_runner_open(&runner, "require('dns').lookup('lava-reap-hang.test', () => {}); setTimeout(() => process.exit(4), 30);", "<dns>", LIMITS, &d)
	lava.page_runner_open(&runner, QUICK_PAGE, "<sibling>", LIMITS, &b)
	lava.page_runner_run(&runner)
	wall := time.duration_seconds(time.tick_since(start))

	expect_exit(t, f, 4, "fetch page")
	expect_exit(t, d, 4, "dns page")
	expect_exit(t, b, 7, "sibling")
	testing.expectf(t, wall < 1, "the runner took %.2fs: page_close waited for a DNS lookup", wall)
	if lava.page_runner_reaping(&runner) != 2 {
		lava.page_runner_destroy(&runner)
		testing.fail_now(t, "the lookups' loops are not on the reaping list")
	}
	pipes: [2]int
	links: [2]string
	for i in 0 ..< 2 {
		pipes[i] = int(runner.reaping[i].fd)
		links[i] = strings.clone(fd_link(pipes[i]))
	}
	defer for l in links do delete(l)

	destroy_start := time.tick_now()
	lava.page_runner_destroy(&runner)
	took := time.duration_seconds(time.tick_since(destroy_start))
	testing.expectf(t, took < 0.5, "page_runner_destroy took %.2fs: it joined a DNS lookup", took)
	virtual.arena_destroy(&arena)
	arena_live = false

	deadline := time.tick_add(time.tick_now(), 15 * time.Second)
	for i in 0 ..< 2 {
		for fd_link(pipes[i]) == links[i] && time.tick_diff(time.tick_now(), deadline) > 0 do time.sleep(5 * time.Millisecond)
		testing.expectf(t, fd_link(pipes[i]) != links[i], "a detached lookup loop's pipe (fd %d) was never closed after the resolver timed out", pipes[i])
	}
}

// The hazard that rules out closing the wakeup pipe early (#34): a reaping loop's
// pipe stays open — the same pipe, not just the same number — while its worker can
// still write it, through siblings opening and closing their own loops; the late
// completion and exit wakeups land in that pipe and wake the runner, which reaps the
// loop while its siblings run; and afterwards the fd count is back where it started.
@(test)
runner_reaping_loop_keeps_its_pipe_until_its_worker_exits :: proc(t: ^testing.T) {
	fifo := make_fifo(t, "pipe")
	defer drop_fifo(fifo)
	u: Unblocker
	unblocker_start(&u, {fifo}, 2 * time.Second)
	defer unblocker_stop(&u)
	runner: lava.Page_Runner
	if !lava.page_runner_init(&runner, 4, record, context.allocator) {
		testing.fail_now(t, "page_runner_init failed")
	}
	defer lava.page_runner_destroy(&runner)

	// Warm the VMs first, so the baseline already holds their permanent timerfds.
	warm: [3]Outcome
	for &w in warm do lava.page_runner_open(&runner, QUICK_PAGE, "<warm>", LIMITS, &w)
	lava.page_runner_run(&runner)
	base := fd_census()

	src := fifo_page(fifo)
	defer delete(src)
	a: Outcome
	lava.page_runner_open(&runner, src, "<fifo>", LIMITS, &a)
	lava.page_runner_run(&runner)
	expect_exit(t, a, 4, "fifo page")
	if lava.page_runner_reaping(&runner) != 1 {
		testing.fail_now(t, "the closed page's loop is not on the reaping list")
	}
	pipe := int(runner.reaping[0].fd)
	link := strings.clone(fd_link(pipe))
	defer delete(link)
	testing.expectf(t, strings.has_prefix(link, "pipe:"), "reaping fd %d is %q, not the loop's wakeup pipe", pipe, link)

	// Siblings open and close loops of their own — rings, epoll fds, pipes, pool
	// threads — while A's sits in the list.
	sibling := "require('fs').readFile('/proc/self/stat', () => { " + QUICK_PAGE + " });"
	sibs: [3]Outcome
	for &s in sibs do lava.page_runner_open(&runner, sibling, "<sibling>", LIMITS, &s)
	lava.page_runner_run(&runner)
	for s in sibs do expect_exit(t, s, 7, "sibling")
	now := fd_link(pipe)
	testing.expectf(t, now == link, "reaping loop's pipe fd %d went from %q to %q while its worker was blocked", pipe, link, now)

	// Release A's worker while two siblings wait on timers. Its late completion and
	// its exit write A's own pipe, which wakes the runner to reap A mid-run.
	late: [2]Outcome
	for &l in late do lava.page_runner_open(&runner, "setTimeout(() => { process.exitCode = 7; }, 300);", "<late>", LIMITS, &l)
	u2: Unblocker
	unblocker_start(&u2, {fifo}, 50 * time.Millisecond)
	lava.page_runner_run(&runner)
	unblocker_stop(&u2)
	for l in late do expect_exit(t, l, 7, "late sibling")
	testing.expect_value(t, lava.page_runner_reaping(&runner), 0)

	when RUNNER_THREADS == 1 {
		testing.expect(t, wait_reaped(&runner, 3 * time.Second), "reaping never finished")
		end := fd_census()
		testing.expectf(t, base >= 0 && end == base, "fd count went from %d to %d across a reaped page", base, end)
	} else {
		log.info("fd census skipped: needs -define:ODIN_TEST_THREADS=1 (make test-odin-serial)")
	}
}

@(private = "file")
Reuse :: struct {
	fifo, marker:  string,
	// The release thread's path list; it must outlive reuse_done's frame.
	fifo_list:     [1]string,
	first, second: Outcome,
	opened_second: bool,
	release:       Unblocker,
}

@(private = "file")
reuse_done :: proc(runner: ^lava.Page_Runner, user_data: rawptr, result: lava.Result) {
	r := cast(^Reuse)user_data
	if r.opened_second {
		record(runner, &r.second, result)
		return
	}
	record(runner, &r.first, result)
	r.opened_second = true
	// The runner's only VM, so this page reuses the first page's.
	lava.page_runner_open(
		runner,
		"setTimeout(() => { process.exitCode = (typeof leak === 'undefined' && typeof leakRan === 'undefined') ? 11 : 12; }, 300);",
		"<second>",
		LIMITS,
		r,
	)
	// Let the first page's worker through while the second page runs.
	r.fifo_list[0] = r.fifo
	unblocker_start(&r.release, r.fifo_list[:], 50 * time.Millisecond)
}

// A second page in the reused VM gets nothing from the first page's job (#34): the
// job's worker finishes while the second page runs, and its completion — which would
// set a global and write a marker file — goes nowhere: not into the second page, and
// not into the first page's dead context.
@(test)
runner_second_page_in_a_reused_vm_gets_no_callback_from_the_first_pages_job :: proc(t: ^testing.T) {
	r: Reuse
	r.fifo = make_fifo(t, "reuse")
	defer drop_fifo(r.fifo)
	r.marker = fmt.aprintf("/tmp/lava-reap-%d-reuse.marker", os.get_pid())
	os.remove(r.marker)
	defer {
		os.remove(r.marker)
		delete(r.marker)
	}
	u: Unblocker
	unblocker_start(&u, {r.fifo}, 2 * time.Second)
	defer unblocker_stop(&u)
	defer unblocker_stop(&r.release)
	runner: lava.Page_Runner
	if !lava.page_runner_init(&runner, 1, reuse_done, context.allocator) {
		testing.fail_now(t, "page_runner_init failed")
	}
	defer lava.page_runner_destroy(&runner)
	src := fmt.aprintf(
		`globalThis.leak = 1; require('fs').readFile(%q, () => {{ globalThis.leakRan = 1; require('fs').writeFileSync(%q, 'late'); }}); setTimeout(() => process.exit(4), 30);`,
		r.fifo,
		r.marker,
	)
	defer delete(src)

	start := time.tick_now()
	lava.page_runner_open(&runner, src, "<first>", LIMITS, &r)
	lava.page_runner_run(&runner)
	wall := time.duration_seconds(time.tick_since(start))

	expect_exit(t, r.first, 4, "first page")
	expect_exit(t, r.second, 11, "second page")
	testing.expect(t, !os.exists(r.marker), "the first page's callback ran after its page closed")
	testing.expectf(t, wall < 1.5, "two pages took %.2fs: the first page's close waited on its worker", wall)
	_, created := lava.vm_pool_stats(&runner.pool)
	testing.expect_value(t, created, 1)
	testing.expect(t, wait_reaped(&runner, 3 * time.Second), "the first page's loop was never reaped")
}

// The reaping list is bounded (#34): at the bound page_runner_open refuses a page
// with its own reason — reported from the run loop, before it takes a VM — and once
// the blocked workers exit and their loops are reaped, pages open again.
@(test)
runner_refuses_pages_while_its_reaping_list_is_full :: proc(t: ^testing.T) {
	fifos := [2]string{make_fifo(t, "bound-0"), make_fifo(t, "bound-1")}
	defer for f in fifos do drop_fifo(f)
	u: Unblocker
	unblocker_start(&u, fifos[:], 2 * time.Second)
	defer unblocker_stop(&u)
	runner: lava.Page_Runner
	if !lava.page_runner_init(&runner, 4, record, context.allocator) {
		testing.fail_now(t, "page_runner_init failed")
	}
	defer lava.page_runner_destroy(&runner)
	runner.reap_limit = 2

	blocked: [2]Outcome
	srcs := [2]string{fifo_page(fifos[0]), fifo_page(fifos[1])}
	defer for s in srcs do delete(s)
	for s, i in srcs do lava.page_runner_open(&runner, s, "<fifo>", LIMITS, &blocked[i])
	lava.page_runner_run(&runner)
	for b in blocked do expect_exit(t, b, 4, "fifo page")
	testing.expect_value(t, lava.page_runner_reaping(&runner), 2)
	_, created_before := lava.vm_pool_stats(&runner.pool)

	refused: Outcome
	lava.page_runner_open(&runner, "process.exitCode = 3;", "<refused>", LIMITS, &refused)
	testing.expect(t, !refused.done, "the refusal was reported from inside page_runner_open")
	testing.expect_value(t, lava.page_runner_live(&runner), 0)
	lava.page_runner_run(&runner)
	testing.expectf(t, refused.done && refused.status == .Execution_Error && refused.kill == .Reaping_Full, "page opened at the bound: %v", refused)
	_, created_after := lava.vm_pool_stats(&runner.pool)
	testing.expect_value(t, created_after, created_before)

	for f in fifos do testing.expect(t, release_within(f, 2 * time.Second), "a worker was not blocked on its FIFO")
	testing.expect(t, wait_reaped(&runner, 3 * time.Second), "the blocked loops were never reaped")
	again: Outcome
	lava.page_runner_open(&runner, "process.exitCode = 3;", "<again>", LIMITS, &again)
	lava.page_runner_run(&runner)
	expect_exit(t, again, 3, "page opened after the reap")
}

// page_runner_destroy detaches, it does not join (#34): it returns at once with one
// worker blocked under a closed page and another under a live one, and leaves those
// loops to their workers. Everything a worker touches afterwards is on the heap: the
// runner's allocator is a virtual arena, unmapped right after destroy, so a worker
// that touched runner memory on its way out would fault. The pipes stay open until
// the workers exit, then close; serially, the fd count returns to where it started.
@(test)
runner_destroy_detaches_loops_whose_workers_are_blocked :: proc(t: ^testing.T) {
	fifos := [2]string{make_fifo(t, "destroy-0"), make_fifo(t, "destroy-1")}
	defer for f in fifos do drop_fifo(f)
	u: Unblocker
	unblocker_start(&u, fifos[:], 2 * time.Second)
	defer unblocker_stop(&u)
	// JSC opens process-wide descriptors with its first VM; run one page first so the
	// baseline already holds them (this test may be the first in the process to).
	{
		warm: lava.Page_Runner
		w: Outcome
		if !lava.page_runner_init(&warm, 1, record, context.allocator) {
			testing.fail_now(t, "page_runner_init failed")
		}
		lava.page_runner_open(&warm, QUICK_PAGE, "<warm>", LIMITS, &w)
		lava.page_runner_run(&warm)
		lava.page_runner_destroy(&warm)
	}
	base := fd_census() - fd_census(timerfds_only = true)

	arena: virtual.Arena
	if virtual.arena_init_growing(&arena) != nil {
		testing.fail_now(t, "arena_init_growing failed")
	}
	arena_live := true
	defer if arena_live do virtual.arena_destroy(&arena)
	runner: lava.Page_Runner
	if !lava.page_runner_init(&runner, 2, record, virtual.arena_allocator(&arena)) {
		testing.fail_now(t, "page_runner_init failed")
	}
	closed_src := fifo_page(fifos[0])
	live_src := fmt.aprintf(`require('fs').readFile(%q, () => {{}}); setTimeout(() => {{}}, 100000);`, fifos[1])
	defer delete(closed_src)
	defer delete(live_src)

	closed, live: Outcome
	lava.page_runner_open(&runner, closed_src, "<closed>", LIMITS, &closed)
	lava.page_runner_run(&runner)
	expect_exit(t, closed, 4, "closed page")
	if lava.page_runner_reaping(&runner) != 1 {
		lava.page_runner_destroy(&runner)
		testing.fail_now(t, "the closed page's loop is not on the reaping list")
	}
	pipe := int(runner.reaping[0].fd)
	link := strings.clone(fd_link(pipe))
	defer delete(link)
	lava.page_runner_open(&runner, live_src, "<live>", LIMITS, &live)
	time.sleep(50 * time.Millisecond) // the live page's worker is in open() by now

	start := time.tick_now()
	lava.page_runner_destroy(&runner)
	took := time.duration_seconds(time.tick_since(start))
	testing.expectf(t, took < 0.5, "page_runner_destroy took %.2fs: it joined a worker blocked in open()", took)
	testing.expectf(t, live.done && live.kill == .Cancelled, "live page: %v", live)
	now := fd_link(pipe)
	testing.expectf(t, now == link, "destroy closed a detached loop's pipe (fd %d: %q -> %q) while its worker was blocked", pipe, link, now)

	virtual.arena_destroy(&arena)
	arena_live = false
	for f in fifos do testing.expect(t, release_within(f, 2 * time.Second), "a worker was not blocked on its FIFO")
	deadline := time.tick_add(time.tick_now(), 3 * time.Second)
	for fd_link(pipe) == link && time.tick_diff(time.tick_now(), deadline) > 0 do time.sleep(time.Millisecond)
	testing.expectf(t, fd_link(pipe) != link, "the detached loop's pipe (fd %d) was never closed after its worker exited", pipe)
	when RUNNER_THREADS == 1 {
		// The second detached loop is the live page's, whose fd the test never saw:
		// wait for the count to settle. Timerfds are left out of both counts — every
		// VM the runner created keeps one until process exit (vm_pool.odin).
		end := fd_census() - fd_census(timerfds_only = true)
		for end != base && time.tick_diff(time.tick_now(), deadline) > 0 {
			time.sleep(time.Millisecond)
			end = fd_census() - fd_census(timerfds_only = true)
		}
		testing.expectf(t, end == base, "fd count (timerfds aside) went from %d to %d once the detached workers exited", base, end)
	} else {
		log.info("fd census skipped: needs -define:ODIN_TEST_THREADS=1 (make test-odin-serial)")
	}
}

// Reaping keeps the runner allocator's books balanced (CLAUDE.md §4): the runner owns
// its pages and the reaping list's backing; the reaped loop — struct, pool, threads,
// pipe — is the heap's, and is freed there, never through the runner allocator. The
// runner runs on a tracking allocator that records a free of memory it never handed
// out instead of panicking, and the books must end empty with no such free.
@(test)
runner_reaping_frees_through_matching_allocators :: proc(t: ^testing.T) {
	fifo := make_fifo(t, "alloc")
	defer drop_fifo(fifo)
	u: Unblocker
	unblocker_start(&u, {fifo}, 2 * time.Second)
	defer unblocker_stop(&u)
	track: mem.Tracking_Allocator
	mem.tracking_allocator_init(&track, context.allocator)
	defer mem.tracking_allocator_destroy(&track)
	track.bad_free_callback = mem.tracking_allocator_bad_free_callback_add_to_array

	runner: lava.Page_Runner
	if !lava.page_runner_init(&runner, 2, record, mem.tracking_allocator(&track)) {
		testing.fail_now(t, "page_runner_init failed")
	}
	src := fifo_page(fifo)
	defer delete(src)
	a, b, c: Outcome
	lava.page_runner_open(&runner, src, "<fifo>", LIMITS, &a)
	lava.page_runner_open(&runner, QUICK_PAGE, "<sibling>", LIMITS, &b)
	lava.page_runner_run(&runner)
	testing.expect_value(t, lava.page_runner_reaping(&runner), 1)
	testing.expect(t, release_within(fifo, 2 * time.Second), "the worker was not blocked on the FIFO")
	testing.expect(t, wait_reaped(&runner, 3 * time.Second), "the closed page's loop was never reaped")
	lava.page_runner_open(&runner, QUICK_PAGE, "<after>", LIMITS, &c)
	lava.page_runner_run(&runner)
	lava.page_runner_destroy(&runner)

	expect_exit(t, a, 4, "fifo page")
	expect_exit(t, b, 7, "sibling")
	expect_exit(t, c, 7, "page after the reap")
	testing.expectf(t, len(track.bad_free_array) == 0, "%d free(s) through the runner allocator of memory it never allocated", len(track.bad_free_array))
	for _, entry in track.allocation_map {
		testing.expectf(t, false, "runner allocator leaked %d bytes from %v", entry.size, entry.location)
	}
}

@(private = "file")
Wake :: struct {
	fifos:   [2]string,
	a, b:    Outcome,
	pipe:    int,
	link:    string,
	closed:  bool, // atomic: the checker saw the reaped loop's pipe closed in time
	checker: ^thread.Thread,
}

@(private = "file")
wake_done :: proc(runner: ^lava.Page_Runner, user_data: rawptr, result: lava.Result) {
	w := cast(^Wake)user_data
	if result.exit_code != 4 {
		record(runner, &w.b, result)
		return
	}
	record(runner, &w.a, result)
	// Delivered right after runner_finish put A's loop on the list.
	if lava.page_runner_reaping(runner) == 1 {
		w.pipe = int(runner.reaping[0].fd)
		w.link = strings.clone(fd_link(w.pipe))
	}
	w.checker = thread.create_and_start_with_poly_data(w, wake_checker)
}

// wake_checker lets A's worker through, looks at A's pipe half a second later from off
// the runner thread — the runner itself only ever looks after a reap pass — and then
// lets B's worker through, which is what ends the run.
@(private = "file")
wake_checker :: proc(w: ^Wake) {
	time.sleep(50 * time.Millisecond)
	release_within(w.fifos[0], time.Second)
	time.sleep(500 * time.Millisecond)
	sync.atomic_store(&w.closed, w.link != "" && fd_link(w.pipe) != w.link)
	release_within(w.fifos[1], 2 * time.Second)
}

// A reaping loop wakes the runner by itself (#34): its worker's exit writes the loop's
// wakeup pipe, which sits in the runner's epoll set, so the runner reaps it while the
// only live page waits on a FIFO with no timer at all — the runner's wait has no
// timeout, and nothing else would wake it until that page's own read completes.
@(test)
runner_reaps_a_loop_as_soon_as_its_worker_exits :: proc(t: ^testing.T) {
	w: Wake
	w.fifos = {make_fifo(t, "wake-0"), make_fifo(t, "wake-1")}
	defer for f in w.fifos do drop_fifo(f)
	defer delete(w.link)
	u: Unblocker
	unblocker_start(&u, w.fifos[:], 5 * time.Second)
	defer unblocker_stop(&u)
	runner: lava.Page_Runner
	if !lava.page_runner_init(&runner, 2, wake_done, context.allocator) {
		testing.fail_now(t, "page_runner_init failed")
	}
	defer lava.page_runner_destroy(&runner)
	a_src := fifo_page(w.fifos[0])
	b_src := fmt.aprintf(`require('fs').readFile(%q, () => {{ process.exitCode = 5; }});`, w.fifos[1])
	defer delete(a_src)
	defer delete(b_src)

	lava.page_runner_open(&runner, a_src, "<reaped>", LIMITS, &w)
	lava.page_runner_open(&runner, b_src, "<waiting>", LIMITS, &w)
	lava.page_runner_run(&runner)
	if w.checker != nil do thread.destroy(w.checker)

	expect_exit(t, w.a, 4, "reaped page")
	expect_exit(t, w.b, 5, "waiting page")
	testing.expectf(t, strings.has_prefix(w.link, "pipe:"), "A's loop was not on the reaping list when it was reported (%q)", w.link)
	testing.expect(t, sync.atomic_load(&w.closed), "A's loop was still unreaped 500 ms after its worker exited: the runner slept through its wakeup pipe")
}
