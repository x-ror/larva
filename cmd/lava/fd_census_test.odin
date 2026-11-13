// Linux-only: the census reads /proc/self/fd.
#+build linux
package main

import "core:os"
import "core:strings"

// The same define core:testing's runner reads for its thread count
// (~/Odin core/testing/runner.odin:34). Re-declared here because
// `testing.TEST_THREADS` is not exported; #config resolves the identical -define at
// compile time, so this tracks the runner exactly. 0 is its default, meaning one
// thread per core.
RUNNER_THREADS :: #config(ODIN_TEST_THREADS, 0)

// fd_census counts this process's open descriptors — all of them, or only
// `anon_inode:[timerfd]` ones (JavaScriptCore's per-VM RunLoop timer) when
// `timerfds_only` is set. -1 when /proc cannot be read.
//
// /proc/self/fd is process-wide: with the runner's default thread-per-core every
// other test's sockets, files and VMs land in it, so a census only means something
// on one runner thread (`make test-odin-serial`). Callers skip — and log that they
// skipped — when RUNNER_THREADS != 1.
fd_census :: proc(timerfds_only := false) -> int {
	handle, err := os.open("/proc/self/fd")
	if err != nil do return -1
	defer os.close(handle)
	infos, read_err := os.read_directory(handle, -1, context.temp_allocator)
	if read_err != nil do return -1
	if !timerfds_only do return len(infos)
	n := 0
	for fi in infos {
		target, lerr := os.read_link(fi.fullpath, context.temp_allocator)
		if lerr == nil && strings.contains(target, "timerfd") do n += 1
	}
	return n
}
