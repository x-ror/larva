package lava_runtime

import "base:runtime"
import "core:c"
import "core:os"
import "lava:pkg/jsc"

// Native primitives behind process.stdout / process.stderr.
//
// The write goes through process_write, which is the single locked writer every output
// path uses — so console.log and process.stdout.write share one mutex and cannot
// interleave mid-line, and both inherit the retry loop that stopped stdout truncating on
// a non-blocking fd (see globals.odin). That sharing is the whole reason this is a thin
// binding rather than its own writer.
//
// Chunk conversion reuses fs_resolve_write_payload, which already implements Node's
// accepted-type set for fs.writeSync (string, Buffer, TypedArray, DataView) with the
// byteOffset/byteLength of a view honored. Duplicating it here is the §2 defect this
// codebase names most often.

// make_stdio_bindings returns the natives table for js/internal/stdio.js.
//
// Returns:
//   An object carrying `writeSync` and `isatty`; nil is never returned, an empty table
//   would surface as a missing-function throw in the JS layer instead.
// Node:
//   No Node counterpart — this is Lava's seam. The Node-visible shape is built on top in
//   js/internal/stdio.js and pinned by tests/node-compat/cases/60-process-stdio.js.
make_stdio_bindings :: proc(ctx: jsc.JSContextRef) -> jsc.JSObjectRef {
	bindings := jsc.JSObjectMake(ctx, nil, nil)
	inject_native_function(ctx, bindings, "writeSync", stdio_write_sync_cb)
	inject_native_function(ctx, bindings, "isatty", tty_isatty_cb)
	return bindings
}

// stdio_write_sync_cb is `writeSync(fd, chunk) -> bytesWritten`.
//
// Params:
//   fd       1 or 2; anything else is rejected rather than written to a stray descriptor.
//   chunk    string | Buffer | TypedArray | DataView, resolved by fs_resolve_write_payload.
//           Encoding is applied JS-side before this call: the Writable in stdio.js
//           converts with Buffer.from(chunk, encoding), so the primitive only ever sees
//           bytes or an already-utf8 string.
// Returns:
//   The byte count handed to the writer. Partial writes are impossible here — the writer
//   loops — so this is len(bytes) on success.
// Node:
//   node's process.stdout.write returns a BOOLEAN (backpressure), not a count. The
//   boolean is produced by the Writable in js/internal/stdio.js; this primitive reports
//   bytes so the JS layer can tell a short write from a refusal if that is ever needed.
// Deviates:
//   Writes are synchronous for every fd type. node writes files and TTYs synchronously
//   but queues pipes, so `write()` there can answer false; here nothing is ever buffered,
//   so it always answers true. Documented in js/internal/stdio.js beside the return.
stdio_write_sync_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()

	if argument_count < 2 {
		return jsc.JSValueMakeNumber(ctx, 0)
	}

	fd_num := jsc.JSValueToNumber(ctx, arguments[0], nil)
	// Compare BEFORE converting: a float->int conversion is undefined in Odin for NaN,
	// +/-Inf and out-of-range values, so `int(fd_num)` could land on any switch arm —
	// including 1 or 2. Reachable from JS, because stdio.js passes `this.fd` and that is a
	// plain writable property (`process.stdout.fd = NaN`). Same guard clear_timer_cb and
	// process_exit_cb already apply in globals.odin for the same reason.
	//
	// Only the two standard descriptors. A JS-supplied fd reaching a raw write is a
	// capability leak, and this binding is not a general fs.writeSync.
	target: ^os.File
	switch {
	case fd_num == 1:
		target = os.stdout
	case fd_num == 2:
		target = os.stderr
	case:
		if exception != nil {
			exception^ = make_js_error(ctx, "stdio writeSync: fd must be 1 or 2")
		}

		return jsc.JSValueMakeNumber(ctx, 0)
	}

	// (ctx, value) -> (bytes, owned, ok). `owned` means we allocated and must free; a
	// typed-array view is BORROWED into the JSC heap, which is safe here only because the
	// write below runs to completion on this thread with no JS in between.
	bytes, owned, ok := fs_resolve_write_payload(ctx, arguments[1])

	if !ok {
		if exception != nil {
			exception^ = make_js_error(ctx, "stdio writeSync: unsupported chunk type")
		}

		return jsc.JSValueMakeNumber(ctx, 0)
	}

	defer if owned {
		delete(bytes, context.allocator)
	}

	if len(bytes) == 0 {
		return jsc.JSValueMakeNumber(ctx, 0)
	}

	process_write_bytes(target, bytes)
	return jsc.JSValueMakeNumber(ctx, f64(len(bytes)))
}
