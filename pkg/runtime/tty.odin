package lava_runtime

import "base:runtime"
import "core:c"
import jsc "lava:pkg/jsc"

// node:tty native primitives. The only syscall-backed primitive is isatty(fd); the
// rest of node:tty (WriteStream/ReadStream, color depth) is pure JS in tty.js.
//
// Linux-first: tty_fd_isatty is implemented for Linux (tty_linux.odin) and stubbed for
// darwin/windows (tty_other.odin), per the project's Linux-first direction.
make_tty_bindings :: proc(ctx: jsc.JSContextRef) -> jsc.JSObjectRef {
	bindings := jsc.JSObjectMake(ctx, nil, nil)
	inject_native_function(ctx, bindings, "isatty", tty_isatty_cb)
	return bindings
}

// isatty(fd) -> bool. A non-numeric / out-of-range fd is reported as not a TTY, matching
// Node (which returns false rather than throwing for a bad fd).
tty_isatty_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()

	if argument_count < 1 {
		return jsc.JSValueMakeBoolean(ctx, false)
	}

	fd := jsc.JSValueToNumber(ctx, arguments[0], nil)

	// NaN / negative / non-integral fds are not terminals.
	if fd < 0 || fd != f64(int(fd)) {
		return jsc.JSValueMakeBoolean(ctx, false)
	}

	return jsc.JSValueMakeBoolean(ctx, b32(tty_fd_isatty(int(fd))))
}
