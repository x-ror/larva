#+build linux, darwin
package lava_runtime

import "core:os"
import "core:sys/posix"

// Retry classification for the locked stdout/stderr writer, POSIX half.
//
// This is split by platform for a front-end reason, not a taste one: `os.Platform_Error`
// is `linux.Errno` on Linux and `posix.Errno` on darwin, but `win32.System_Error` on
// Windows, which has no EAGAIN/EINTR members at all — so a single `#partial switch` over
// them fails the windows_amd64 check `make check` runs. Same split as
// fs_fd_posix.odin / fs_fd_windows.odin.

// LINUX IS THE ONLY TARGET WHERE THIS ACTUALLY CLASSIFIES. On darwin core:os collapses a
// failed write to General_Error .Unknown (core/os/file_posix.odin, the `.Write` arm does
// `err = .Unknown` and discards errno), never a Platform_Error — so the assertion below
// fails for EAGAIN too and darwin still abandons on a full pipe. Acceptable under the
// Linux-first direction, recorded here so a future darwin build does not read the
// `#+build linux, darwin` tag as coverage.
//
// stdio_retryable reports whether a failed write should be retried rather than abandoned.
//
// EINTR is a signal arriving mid-write and carries no information about the fd. EAGAIN is
// the one that loses data in practice: nothing in Lava sets O_NONBLOCK on fd 1/2, so it
// arrives INHERITED — a parent (process manager, editor task runner, CI harness) hands the
// child a non-blocking pipe and every write past the first buffer-full fails. Treating
// either as fatal is what silently truncated output to exactly one pipe buffer.
stdio_retryable :: proc(err: os.Error) -> bool {
	perr, ok := err.(os.Platform_Error)

	if !ok {
		return false
	}

	// Cross-package enum reinterpret: on Linux `perr` is a linux.Errno and this reads it as
	// a posix.Errno. Sound only because Linux's posix.Errno is defined from the same ABI —
	// verified equal for the two that matter (EAGAIN 11, EINTR 4). On darwin it is identity.
	#partial switch posix.Errno(perr) {
	case .EAGAIN, .EINTR:
		return true
	}
	return false
}

// stdio_wait_writable blocks until `fd` accepts more bytes, so the EAGAIN retry in
// process_write_all waits instead of spinning on a full pipe. A poll error (or a
// hangup) simply returns: the caller retries the write, which then reports the real
// error rather than looping here forever.
stdio_wait_writable :: proc(fd: ^os.File) {
	pfd := posix.pollfd {
		fd     = posix.FD(os.fd(fd)),
		events = {.OUT},
	}
	fds := []posix.pollfd{pfd}
	posix.poll(raw_data(fds), 1, -1)
}
