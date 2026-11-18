// Linux-only: drives the epoll fallback's failure path and reads Linux rlimits.
#+build linux
package eventloop

import "core:log"
import "core:sys/linux"
import "core:testing"

// Mirrors core:testing's own thread-count define (runner.odin:34), which is not
// exported. This test mutates a PROCESS-WIDE resource limit, so it must not run
// beside other tests — `make test-eventloop-odin` pins one runner thread.
@(private = "file")
RUNNER_THREADS :: #config(ODIN_TEST_THREADS, 0)

// platform_init closes both wakeup-pipe ends when epoll_create1 fails, but must
// also reset them to -1: init returns the Loop regardless (loop.odin:206-210,
// backend stays .Unavailable) and destroy calls platform_destroy
// unconditionally (loop.odin:269), which closes any wakeup_pipe entry >= 0. A
// stale number there is closed a SECOND time.
//
// That is not a leak, it is a wrong-fd close, and the trigger makes it worse:
// epoll_create1 fails on EMFILE/ENFILE — descriptor exhaustion — which is
// exactly when the kernel is handing out recycled numbers, so the second close
// lands on whatever the process opened in between. darwin already resets
// (loop_darwin.odin:56-57); this pins the Linux side.
//
// The assertion observes the actual harm rather than the invariant: a canary
// descriptor is opened onto the recycled number after the failed init, and it
// must still be alive once destroy has run.
@(test)
failed_platform_init_does_not_double_close :: proc(t: ^testing.T) {
	when RUNNER_THREADS != 1 {
		log.info("skipped: mutates RLIMIT_NOFILE process-wide; needs -define:ODIN_TEST_THREADS=1")
		return
	}

	// The number the kernel will hand out next — pipe2 below takes it and the one
	// after it, and the canary later reclaims it.
	probe, probe_err := linux.epoll_create1({.FDCLOEXEC})
	testing.expectf(t, probe_err == nil, "could not open a probe descriptor: %v", probe_err)
	if probe_err != nil do return
	lowest := probe
	linux.close(probe)

	saved: linux.RLimit
	if get_err := linux.getrlimit(.NOFILE, &saved); get_err != nil {
		testing.expectf(t, false, "getrlimit failed: %v", get_err)
		return
	}
	// Room for exactly the two pipe ends: no descriptor may have a number >= cur,
	// so io_uring_setup and epoll_create1 both fail with EMFILE and platform_init
	// takes the path under test.
	tight := linux.RLimit {
		cur = uint(lowest) + 2,
		max = saved.max,
	}
	if set_err := linux.setrlimit(.NOFILE, &tight); set_err != nil {
		testing.expectf(t, false, "setrlimit failed: %v", set_err)
		return
	}

	loop := init()
	// Restore before anything else — the runner itself needs descriptors.
	linux.setrlimit(.NOFILE, &saved)

	testing.expect(t, loop.backend == .Unavailable, "platform_init was supposed to fail under the tightened limit")

	// Takes the number pipe2 just released. If platform_init left that number in
	// wakeup_pipe, destroy is about to close THIS descriptor.
	canary, canary_err := linux.epoll_create1({.FDCLOEXEC})
	testing.expectf(t, canary_err == nil, "could not open the canary: %v", canary_err)
	if canary_err != nil {
		destroy(&loop)
		return
	}
	testing.expectf(
		t,
		canary == lowest,
		"canary landed on fd %d, not the recycled %d — the test would prove nothing",
		canary,
		lowest,
	)

	destroy(&loop)

	st: linux.Stat
	fstat_err := linux.fstat(canary, &st)
	testing.expectf(t, fstat_err == nil, "destroy closed an unrelated descriptor: fstat(canary) -> %v", fstat_err)
	if fstat_err == nil do linux.close(canary)
}
