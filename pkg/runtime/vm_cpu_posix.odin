#+build !windows
package lava_runtime

import "core:sys/posix"

// thread_cpu_ns reads the calling thread's CPU clock (user + system time), the clock
// the cumulative page budget is charged against. Time the thread spends blocked in
// the event loop's poll does not advance it, so a page is charged only for work.
//
// Not the vDSO fast path: Linux serves CLOCK_THREAD_CPUTIME_ID with a real syscall.
// That is why vm_cpu_enter reads it only when a budget is set.
thread_cpu_ns :: proc() -> i64 {
	ts: posix.timespec
	if posix.clock_gettime(.THREAD_CPUTIME_ID, &ts) != .OK do return 0
	return i64(ts.tv_sec) * 1_000_000_000 + i64(ts.tv_nsec)
}
