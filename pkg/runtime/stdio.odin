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
// Chunk conversion is stdio_resolve_write_payload: Node's accepted-type set for a
// write (string, Buffer, TypedArray, DataView) with the byteOffset/byteLength of a view
// honored. It was written for fs.writeSync and moved here when node:fs went with the
// Node profile; stdio is its only caller now.

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
	inject_native_function(ctx, bindings, "isatty", stdio_isatty_cb)
	return bindings
}

// stdio_write_sync_cb is `writeSync(fd, chunk) -> bytesWritten`.
//
// Params:
//   fd       1 or 2; anything else is rejected rather than written to a stray descriptor.
//   chunk    string | Buffer | TypedArray | DataView, resolved by stdio_resolve_write_payload.
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
	bytes, owned, ok := stdio_resolve_write_payload(ctx, arguments[1])

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

// stdio_isatty_cb is `isatty(fd) -> bool`. A non-numeric / out-of-range fd is reported
// as not a TTY, matching Node (which returns false rather than throwing for a bad fd).
// tty_fd_isatty is the platform half (tty_linux.odin, stubbed in tty_other.odin).
stdio_isatty_cb :: proc "c" (
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

// is_data_view reports whether value is a DataView. JSC's C API has no DataView
// predicate (JSValueGetTypedArrayType returns .None for one), so check the brand via
// `constructor.name` — the same constructor-name pattern determine_received_type uses.
// This separates a real DataView from a plain {buffer, byteOffset, byteLength} object,
// which Node rejects and whose unchecked fields must not be fed to the slice below.
is_data_view :: proc(ctx: jsc.JSContextRef, obj: jsc.JSObjectRef) -> bool {
	ctor := get_named(ctx, obj, "constructor")

	if ctor == nil || !jsc.JSValueIsObject(ctx, ctor) {
		return false
	}

	name, allocated := value_to_string(ctx, get_named(ctx, cast(jsc.JSObjectRef)ctor, "name"))
	defer if allocated {
		delete(name)
	}
	return name == "DataView"
}

// stdio_resolve_write_payload resolves a process.stdout/stderr write chunk into the
// bytes to write. The returned slice EITHER borrows JavaScriptCore-owned memory (a
// TypedArray/DataView window: owned=false — valid only for the current native call,
// never stored or freed) OR is a heap allocation on context.allocator the caller must
// free (a coerced string: owned=true). It mirrors the data types Node accepts:
//   - TypedArray / Buffer: its bytes, honoring byteOffset/byteLength (typed_array_view).
//   - DataView: its window of the backing ArrayBuffer. JSC's C API has no DataView byte
//     accessor, so confirm the object is a DataView (is_data_view) and read its
//     `.byteOffset`/`.byteLength` against the `.buffer` backing. The window is validated
//     in f64 so a non-finite or out-of-range value rejects safely (NaN/Inf fail every
//     comparison) instead of reaching an undefined float->int conversion.
//   - string (and anything non-object, coerced to string): its UTF-8 bytes.
//   - a bare ArrayBuffer (or any non-DataView object that is not coercible): rejected
//     (ok=false) — Node throws ERR_INVALID_ARG_TYPE.
// Returns a nil slice for an empty payload (a zero-length write). Must run on the loop
// thread (it reads JSC); the caller must consume a borrowed result before its next JSC
// call (a later call may move the backing store).
stdio_resolve_write_payload :: proc(
	ctx: jsc.JSContextRef,
	value: jsc.JSValueRef,
) -> (
	bytes: []byte,
	owned: bool,
	ok: bool,
) {
	t := jsc.JSValueGetTypedArrayType(ctx, value, nil)

	// A bare ArrayBuffer is not a valid write payload (Node: ERR_INVALID_ARG_TYPE).
	if t == .ArrayBuffer {
		return nil, false, false
	}

	if t != .None {
		// A real typed array (Buffer included); typed_array_view is byteOffset-aware, so
		// a Buffer.subarray(...) writes its window, not the whole backing. Borrowed.
		view, view_ok := typed_array_view(ctx, value)

		if !view_ok {
			return nil, false, true
		}

		return view, false, true
	}

	// A DataView is an object whose `.buffer` is an ArrayBuffer; read its window directly
	// from the backing buffer (no C-API DataView accessor exists).
	if jsc.JSValueIsObject(ctx, value) {
		obj := cast(jsc.JSObjectRef)value

		if is_data_view(ctx, obj) {
			buffer_val := get_named(ctx, obj, "buffer")

			if buffer_val != nil && jsc.JSValueGetTypedArrayType(ctx, buffer_val, nil) == .ArrayBuffer {
				ab := cast(jsc.JSObjectRef)buffer_val
				// Read the claimed window FIRST, because these two reads are the only step
				// here that can run user JS: `byteOffset`/`byteLength` may be OWN accessors,
				// and such a getter can resize or transfer the backing buffer before it
				// returns. Anything sampled before them is stale by the time they finish —
				// which is exactly the bug this ordering fixes. A getter that shrank the
				// buffer used to pass a bounds check against the pre-shrink size, and the
				// resolver then handed back a slice reaching past the allocation: 4088 bytes
				// of out-of-bounds heap written into a caller-named file.
				// Pinned by cmd/lava/stdio_write_payload_test.odin.
				off_f := jsc.JSValueToNumber(ctx, get_named(ctx, obj, "byteOffset"), nil)
				len_f := jsc.JSValueToNumber(ctx, get_named(ctx, obj, "byteLength"), nil)
				// Now that no further JS can run, sample the authoritative length and take
				// the base pointer back to back: the pointer is only valid until the next
				// JSC API call (a GC/realloc can move it), so nothing may come between them
				// but the pure-Odin validation below.
				ab_len := f64(jsc.JSObjectGetArrayBufferByteLength(ctx, ab, nil))

				// NaN/Infinity fail every comparison, so an invalid window rejects to an empty
				// payload here rather than truncating to an undefined int. len_f > 0 also folds
				// the zero-length DataView into the empty-file path.
				if !(off_f >= 0 && len_f > 0 && off_f + len_f <= ab_len) {
					return nil, false, true
				}

				base := jsc.JSObjectGetArrayBufferBytesPtr(ctx, ab, nil)

				if base == nil {
					return nil, false, true
				}

				off, length := int(off_f), int(len_f)
				return (cast([^]byte)base)[off:off + length], false, true
			}
		}
	}

	// String, or any other value coerced to its string form. The string buffer is already
	// owned on context.allocator, so hand it back as-is (owned=true) — no extra copy.
	str, salloc := jsc_value_to_string_or_default(ctx, value)

	if !salloc {return nil, false, true} 	// empty/unconvertible -> zero-length write
	return transmute([]byte)str, true, true
}
