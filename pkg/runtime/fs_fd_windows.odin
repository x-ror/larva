#+build windows
package lava_runtime

// Linux-first stubs: fs.openSync/closeSync are not implemented on Windows yet (the
// POSIX implementation lives in fs_fd_posix.odin). They report ENOSYS so callers get a
// clean error rather than a crash.
fs_platform_open :: proc(path: string, flags_str: string, mode: int) -> (fd: int, err_code: string, errno_val: int) {
	return -1, "ENOSYS", 38
}

fs_platform_close :: proc(fd: int) -> (err_code: string, errno_val: int) {
	return "ENOSYS", 38
}
