#+build windows
package lava_runtime

import win "core:sys/windows"

// Not in core:sys/windows; hand-declared (it lived beside the node:os kernel32 calls
// until those went with the Node profile).
foreign import kernel32 "system:Kernel32.lib"
@(default_calling_convention = "stdcall")
foreign kernel32 {
	GetThreadTimes :: proc(hThread: win.HANDLE, lpCreationTime, lpExitTime, lpKernelTime, lpUserTime: ^win.FILETIME) -> win.BOOL ---
}

// thread_cpu_ns: same contract as the POSIX one (vm_cpu_posix.odin) — the calling
// thread's user + kernel time, which does not advance while the thread is blocked.
// Unreachable today — Windows eval runs without a pooled VM and refuses limits — and
// kept real rather than stubbed so a future Windows pool cannot inherit a clock that
// silently never advances.
thread_cpu_ns :: proc() -> i64 {
	creation, exit, kernel, user: win.FILETIME

	if !GetThreadTimes(win.GetCurrentThread(), &creation, &exit, &kernel, &user) {
		return 0
	}

	ft :: proc(f: win.FILETIME) -> i64 {
		return i64(u64(f.dwHighDateTime) << 32 | u64(f.dwLowDateTime))
	}
	// FILETIME counts 100 ns intervals.
	return (ft(kernel) + ft(user)) * 100
}
