#+build !linux
package lava_runtime

// os_process_rss_bytes is 0 off Linux, as it always was: darwin's task_info and
// Windows' GetProcessMemoryInfo (psapi) are not bound. memoryUsage().rss still
// reports a number, it is just not a measurement there.
os_process_rss_bytes :: proc() -> u64 {
	return 0
}
