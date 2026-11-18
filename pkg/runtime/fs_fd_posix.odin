#+build linux, darwin
package lava_runtime

import "core:strings"
import "core:sys/posix"

// fd-based fs primitives (openSync/closeSync) for Linux/darwin via core:sys/posix, which
// yields a real OS file descriptor — the integer Node's fs.openSync returns. Windows is
// stubbed in fs_fd_windows.odin per the Linux-first direction.

// fs_platform_open opens `path` with a Node flags string and create mode, returning the
// fd on success or a Node error code (+ errno) on failure.
fs_platform_open :: proc(path: string, flags_str: string, mode: int) -> (fd: int, err_code: string, errno_val: int) {
	flags, ok := fs_open_flags(flags_str)

	if !ok {
		return -1, "EINVAL", 22
	}

	cpath := strings.clone_to_cstring(path, context.temp_allocator)
	res := posix.open(cpath, flags, fs_mode_t(mode))

	if i32(res) < 0 {
		e := posix.errno()
		return -1, fs_posix_errno_code(e), int(i32(e))
	}

	return int(res), "", 0
}

// fs_mode_t builds a POSIX mode_t bit_set from an octal permission int. Done bit by bit
// (not a transmute) because _mode_t differs by platform (u32 on Linux, u16 on Darwin).
fs_mode_t :: proc(mode: int) -> posix.mode_t {
	m: posix.mode_t

	if mode & 0o400 != 0 {
		m += {.IRUSR}
	}

	if mode & 0o200 != 0 {
		m += {.IWUSR}
	}

	if mode & 0o100 != 0 {
		m += {.IXUSR}
	}

	if mode & 0o040 != 0 {
		m += {.IRGRP}
	}

	if mode & 0o020 != 0 {
		m += {.IWGRP}
	}

	if mode & 0o010 != 0 {
		m += {.IXGRP}
	}

	if mode & 0o004 != 0 {
		m += {.IROTH}
	}

	if mode & 0o002 != 0 {
		m += {.IWOTH}
	}

	if mode & 0o001 != 0 {
		m += {.IXOTH}
	}

	if mode & 0o4000 != 0 {
		m += {.ISUID}
	}

	if mode & 0o2000 != 0 {
		m += {.ISGID}
	}

	if mode & 0o1000 != 0 {
		m += {.ISVXT}
	}

	return m
}

fs_platform_close :: proc(fd: int) -> (err_code: string, errno_val: int) {
	if posix.close(posix.FD(fd)) != .OK {
		e := posix.errno()
		return fs_posix_errno_code(e), int(i32(e))
	}

	return "", 0
}

// fs_open_flags maps a Node fs flags string to POSIX open flags. Returns ok=false for an
// unknown string (the caller raises EINVAL, matching Node's ERR_INVALID_ARG_VALUE-ish).
fs_open_flags :: proc(s: string) -> (posix.O_Flags, bool) {
	switch s {
	case "r", "rs", "sr":
		return {}, true // O_RDONLY
	case "r+", "rs+", "sr+":
		return {.RDWR}, true
	case "w":
		return {.WRONLY, .CREAT, .TRUNC}, true
	case "wx", "xw":
		return {.WRONLY, .CREAT, .TRUNC, .EXCL}, true
	case "w+":
		return {.RDWR, .CREAT, .TRUNC}, true
	case "wx+", "xw+":
		return {.RDWR, .CREAT, .TRUNC, .EXCL}, true
	case "a", "as", "sa":
		return {.WRONLY, .CREAT, .APPEND}, true
	case "ax", "xa":
		return {.WRONLY, .CREAT, .APPEND, .EXCL}, true
	case "a+", "as+", "sa+":
		return {.RDWR, .CREAT, .APPEND}, true
	case "ax+", "xa+":
		return {.RDWR, .CREAT, .APPEND, .EXCL}, true
	}
	return {}, false
}

fs_posix_errno_code :: proc(e: posix.Errno) -> string {
	#partial switch e {
	case .ENOENT:
		return "ENOENT"
	case .EACCES:
		return "EACCES"
	case .EEXIST:
		return "EEXIST"
	case .EISDIR:
		return "EISDIR"
	case .ENOTDIR:
		return "ENOTDIR"
	case .EMFILE:
		return "EMFILE"
	case .ENFILE:
		return "ENFILE"
	case .EBADF:
		return "EBADF"
	case .EPERM:
		return "EPERM"
	case .ELOOP:
		return "ELOOP"
	case .ENOSPC:
		return "ENOSPC"
	case .EROFS:
		return "EROFS"
	}
	return "EIO"
}
