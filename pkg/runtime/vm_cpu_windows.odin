#+build windows
package lava_runtime

import win "core:sys/windows"

// thread_cpu_ns: same contract as the POSIX one (vm_cpu_posix.odin) — the calling
// thread's user + kernel time, which does not advance while the thread is blocked.
// GetThreadTimes is declared with the other hand-bound kernel32 calls in os_windows.odin.
thread_cpu_ns :: proc() -> i64 {
	creation, exit, kernel, user: win.FILETIME
	if !GetThreadTimes(win.GetCurrentThread(), &creation, &exit, &kernel, &user) do return 0
	ft :: proc(f: win.FILETIME) -> i64 {
		return i64(u64(f.dwHighDateTime) << 32 | u64(f.dwLowDateTime))
	}
	// FILETIME counts 100 ns intervals.
	return (ft(kernel) + ft(user)) * 100
}
