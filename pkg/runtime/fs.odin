package lava_runtime

import "base:runtime"
import "core:crypto"
import "core:io"
import "core:c"
import "core:fmt"
import "core:os"
import "core:path/filepath"
import "core:strings"
import "core:time"
import jsc "lava:pkg/jsc"
import eventloop "lava:pkg/runtime/eventloop"

fs_read_file_sync_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 do return jsc.JSValueMakeUndefined(ctx)

	args := arguments[:int(argument_count)]
	path_str, path_alloc := jsc_value_to_string_or_default(ctx, args[0])
	defer if path_alloc do delete(path_str, context.allocator)

	data, read_err := os.read_entire_file(path_str, context.allocator)
	if read_err != os.ERROR_NONE {
		if exception != nil {
			code, errno_val := fs_os_error_to_code(read_err)
			exception^ = fs_make_error(ctx, code, "open", path_str, errno_val)
		}
		return jsc.JSValueMakeUndefined(ctx)
	}

	// BYTES ONLY. This native used to decode here when an encoding was supplied, and that
	// branch was deleted rather than merely bypassed: it honored the PRESENCE of an
	// encoding but never its value (every name decoded as UTF-8), and its conversion
	// returned an empty string for input it could not decode. js/node/fs.js owns
	// decoding now, through Buffer's codecs. Leaving the branch in place would have left
	// the defective implementation reachable-looking for the next reader (#329).
	//
	// Hand ownership of `data` to JavaScriptCore as a Uint8Array (make_uint8_array
	// owns it and frees it on collection).
	return make_uint8_array(ctx, data)
}

// FS_Read_Request carries an async fs.readFile across three stages: the loop thread
// builds it, a pool worker reads the file off-loop (fs_read_work — touches ONLY this
// struct, never JSC/the loop), and the poll-phase completion (fs_read_complete_cb)
// invokes the JS callback with (err, data). allocator owns path/data/err_msg; it
// is the heap allocator (the proc "c" resets context to runtime.default_context), which
// also matches jsc_buffer_deallocator so a Buffer result handed to JSC frees correctly.
// The error's `path` property reuses req.path (no separate clone).
FS_Read_Request :: struct {
	ctx:       jsc.JSContextRef,
	callback:  jsc.JSObjectRef, // GC-protected until the completion fires (or dispose at teardown)
	allocator: runtime.Allocator, // owns path/data/err_msg; heap, matches the JSC deallocator
	path:      string, // owned clone; the worker reads this file off-loop (also the error path)
	data:      []byte, // file contents on success (ownership handed to JSC for a Buffer result)
	ok:        bool,
	err_msg:   string,
	err_code:  string, // static literal (not freed)
	err_errno: int,
}

// fs.readFile(path[, options], callback). The blocking read runs OFF the loop on the
// worker pool (fs_read_work); its completion is delivered on the loop's poll phase
// (fs_read_complete_cb re-queued via queue_io_callback by fs_read_pool_done), so the
// callback still runs before any setImmediate scheduled in the same turn — matching
// Node's I/O-before-check ordering. With no loop bound (bare eval) or if the pool
// cannot start, it falls back to a synchronous read, preserving the old behavior.
fs_read_file_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 2 {
		if exception != nil {
			exception^ = make_js_error(ctx, "fs.readFile requires a path and a callback")
		}
		return jsc.JSValueMakeUndefined(ctx)
	}

	args := arguments[:int(argument_count)]
	callback := callback_arg(ctx, args[argument_count - 1])
	if callback == nil {
		if exception != nil {
			exception^ = make_js_error(ctx, "fs.readFile callback must be a function")
		}
		return jsc.JSValueMakeUndefined(ctx)
	}

	path_str, path_alloc := jsc_value_to_string_or_default(ctx, args[0])
	defer if path_alloc do delete(path_str, context.allocator)

	// context is runtime.default_context here (proc "c"), so context.allocator is the
	// heap allocator — capture it so the off-loop worker and the completion agree, and
	// so a Buffer result freed by jsc_buffer_deallocator (also heap) matches.
	alloc := context.allocator
	req := new(FS_Read_Request, alloc)
	req.ctx = ctx
	req.callback = callback
	req.allocator = alloc
	req.path = strings.clone(path_str, alloc)
	jsc.JSValueProtect(ctx, cast(jsc.JSValueRef)callback)

	loop := get_loop_from_ctx(ctx)
	// Happy path: read off-loop on the pool. pool_submit keeps the loop alive until the
	// completion posts; fs_read_pool_done then re-queues onto the poll phase.
	if loop != nil &&
	   eventloop.pool_submit(loop, fs_read_work, fs_read_pool_done, req, fs_read_dispose, fs_read_cancel) {
		return jsc.JSValueMakeUndefined(ctx)
	}

	// Fallback (no loop, or the pool could not start): read synchronously here, then
	// deliver on the poll phase if there is a loop, else inline.
	fs_read_work(req)
	if loop != nil {
		eventloop.queue_io_callback(loop, fs_read_complete_cb, req, fs_read_dispose)
	} else {
		fs_read_complete_cb(nil, req)
	}
	return jsc.JSValueMakeUndefined(ctx)
}

// fs_read_work performs the blocking read. It runs on a pool worker (off the loop) on
// the happy path, and inline on the fallback path — either way it touches ONLY req
// (never JSC or the loop), reading through req.allocator so the result is owned
// independently of any thread's context.
fs_read_work :: proc(user_data: rawptr) {
	req := cast(^FS_Read_Request)user_data
	data, read_err := os.read_entire_file(req.path, req.allocator)
	if read_err != os.ERROR_NONE {
		req.ok = false
		req.err_code, req.err_errno = fs_os_error_to_code(read_err)
		req.err_msg = fmt.aprintf(
			"%s: %s, open '%s'",
			req.err_code,
			fs_errno_text(req.err_code),
			req.path,
			allocator = req.allocator,
		)
	} else {
		req.ok = true
		req.data = data
	}
}

// fs_read_pool_done runs on the loop thread (via post_async) once the worker finishes.
// It re-queues the completion onto the POLL phase so fs.readFile keeps Node's
// I/O-before-setImmediate ordering (post_async drains at the top of the tick, not in
// poll). The dispose hook frees the request if the loop tears down before poll runs it.
fs_read_pool_done :: proc(loop: ^eventloop.Loop, user_data: rawptr) {
	eventloop.queue_io_callback(loop, fs_read_complete_cb, user_data, fs_read_dispose)
}

// fs_read_dispose releases a request whose completion will never run — the pool job was
// dropped at teardown, or the re-queued poll callback was discarded when the loop died.
// Exactly one of {fs_read_complete_cb, fs_read_dispose} runs per request. For a job a
// worker had taken, fs_read_cancel already released the callback, and this runs later —
// possibly after the context is gone, possibly on a pool worker of a detached loop — so
// it frees memory only (all heap: req.allocator).
fs_read_dispose :: proc(user_data: rawptr) {
	context = runtime.default_context()
	req := cast(^FS_Read_Request)user_data
	if req == nil do return
	if req.callback != nil do jsc.JSValueUnprotect(req.ctx, cast(jsc.JSValueRef)req.callback)
	fs_read_request_free(req)
}

// fs_read_cancel releases the request's JS callback while a pool worker may still be
// reading the file (eventloop.Pool_Cancel): close_begin calls it on the loop thread
// with the context alive, so the later fs_read_dispose has no JS left to touch.
// fs_read_work never reads req.callback or req.ctx, so this races nothing.
fs_read_cancel :: proc(user_data: rawptr) {
	context = runtime.default_context()
	req := cast(^FS_Read_Request)user_data
	if req.callback != nil do jsc.JSValueUnprotect(req.ctx, cast(jsc.JSValueRef)req.callback)
	req.callback = nil
}

// fs_read_request_free releases everything the request owns. req.data is freed only when
// it is still owned here (the Buffer success path hands it to JSC and nils it first).
fs_read_request_free :: proc(req: ^FS_Read_Request) {
	a := req.allocator
	if req.data != nil do delete(req.data, a)
	if len(req.path) > 0 do delete(req.path, a)
	if len(req.err_msg) > 0 do delete(req.err_msg, a)
	free(req, a)
}

// fs_read_complete_cb runs in the poll phase and invokes the JS callback with the
// Node (err, data) convention, then releases the request.
fs_read_complete_cb :: proc(loop: ^eventloop.Loop, user_data: rawptr) {
	context = runtime.default_context()
	req := cast(^FS_Read_Request)user_data
	if req == nil do return
	ctx := req.ctx

	call_args: [2]jsc.JSValueRef
	if req.ok {
		call_args[0] = jsc.JSValueMakeNull(ctx)
		// Async completion runs from the event loop (not a JSC callback), so this must go
		// through make_uint8_array, which enters the VM around the creation (see
		// typed_array.odin) — a bare C-API typed-array call here would abort on a GC.
		// make_uint8_array takes ownership of req.data, so nil it to keep
		// fs_read_request_free from double-freeing what JSC now owns.
		//
		// Always bytes: the encoding-aware string branch that used to sit here was deleted
		// with its sync twin, for the reasons in fs_read_file_sync_cb (#329).
		call_args[1] = make_uint8_array(ctx, req.data)
		req.data = nil
	} else {
		err := make_js_error(ctx, req.err_msg)
		if jsc.JSValueIsObject(ctx, err) {
			err_obj := cast(jsc.JSObjectRef)err
			set_named(ctx, err_obj, "code", js_string_value(ctx, req.err_code))
			set_named(ctx, err_obj, "path", js_string_value(ctx, req.path))
			set_named(ctx, err_obj, "syscall", js_string_value(ctx, "open"))
			if req.err_errno != 0 {
				set_named(ctx, err_obj, "errno", jsc.JSValueMakeNumber(ctx, f64(-req.err_errno)))
			}
		}
		call_args[0] = err
		call_args[1] = jsc.JSValueMakeUndefined(ctx)
	}

	exception: jsc.JSValueRef
	invoke_user_callback(ctx, req.callback, raw_data(call_args[:]), 2, &exception)
	if exception != nil {
		report_uncaught(ctx, exception)
		mark_async_failed(ctx)
	}

	jsc.JSValueUnprotect(ctx, cast(jsc.JSValueRef)req.callback)
	fs_read_request_free(req)
}

// --- node:fs: writes, directories, stat ---

// fs_make_error builds a Node-style fs error: an Error with code/syscall/path.
fs_make_error :: proc(ctx: jsc.JSContextRef, code, syscall, path: string, errno_val := 0) -> jsc.JSValueRef {
	// A path-less syscall (e.g. close, which operates on an fd) gets no "'path'" clause
	// and no `path` property — matching Node, whose close error reads "EBADF: ..., close".
	msg: string
	if len(path) > 0 {
		msg = fmt.tprintf("%s: %s, %s '%s'", code, fs_errno_text(code), syscall, path)
	} else {
		msg = fmt.tprintf("%s: %s, %s", code, fs_errno_text(code), syscall)
	}
	err := make_js_error(ctx, msg)
	if jsc.JSValueIsObject(ctx, err) {
		obj := cast(jsc.JSObjectRef)err
		set_named(ctx, obj, "code", js_string_value(ctx, code))
		set_named(ctx, obj, "syscall", js_string_value(ctx, syscall))
		if len(path) > 0 do set_named(ctx, obj, "path", js_string_value(ctx, path))
		if errno_val != 0 {
			set_named(ctx, obj, "errno", jsc.JSValueMakeNumber(ctx, f64(-errno_val)))
		}
	}
	return err
}

// fs_make_rename_error builds Node's rename error, which differs from the generic
// fs error in two ways: the message names both paths ("rename 'old' -> 'new'")
// and the error carries a `dest` property in addition to `path`.
fs_make_rename_error :: proc(ctx: jsc.JSContextRef, code, old_path, new_path: string, errno_val := 0) -> jsc.JSValueRef {
	msg := fmt.tprintf("%s: %s, rename '%s' -> '%s'", code, fs_errno_text(code), old_path, new_path)
	err := make_js_error(ctx, msg)
	if jsc.JSValueIsObject(ctx, err) {
		obj := cast(jsc.JSObjectRef)err
		set_named(ctx, obj, "code", js_string_value(ctx, code))
		set_named(ctx, obj, "syscall", js_string_value(ctx, "rename"))
		set_named(ctx, obj, "path", js_string_value(ctx, old_path))
		set_named(ctx, obj, "dest", js_string_value(ctx, new_path))
		if errno_val != 0 {
			set_named(ctx, obj, "errno", jsc.JSValueMakeNumber(ctx, f64(-errno_val)))
		}
	}
	return err
}

fs_errno_text :: proc(code: string) -> string {
	switch code {
	case "ENOENT":        return "no such file or directory"
	case "EEXIST":        return "file already exists"
	case "ENOTDIR":       return "not a directory"
	case "EISDIR":        return "illegal operation on a directory"
	case "EACCES":        return "permission denied"
	case "EPERM":         return "operation not permitted"
	case "ENOTEMPTY":     return "directory not empty"
	case "EIO":           return "i/o error"
	case "EROFS":         return "read-only file system"
	case "ENOSPC":        return "no space left on device"
	case "EBADF":         return "bad file descriptor"
	case "EMFILE":        return "too many open files"
	case "ENFILE":        return "file table overflow"
	case "ELOOP":         return "too many symbolic links encountered"
	case "EINVAL":        return "invalid argument"
	case "ENOSYS":        return "function not implemented"
	case "ERR_FS_EISDIR": return "Path is a directory"
	}
	return "i/o error"
}

// fs_validate_int_arg validates a JS value as a non-negative integer in [0, max] BEFORE
// any syscall, mirroring Node's validateInt32/validateUint32: a non-number throws
// ERR_INVALID_ARG_TYPE; a NaN / negative / non-integer / out-of-range number throws
// ERR_OUT_OF_RANGE. This is what stops fs.closeSync(3.5) (or a NaN/object) from coercing
// to a garbage fd and closing an unrelated descriptor (stdin, the loop's epoll fd, …).
fs_validate_int_arg :: proc(
	ctx: jsc.JSContextRef,
	value: jsc.JSValueRef,
	name: string,
	max: f64,
) -> (
	out: int,
	err: jsc.JSValueRef,
	ok: bool,
) {
	if !jsc.JSValueIsNumber(ctx, value) {
		return 0, err_invalid_arg_type(ctx, name, "number", value), false
	}
	f := jsc.JSValueToNumber(ctx, value, nil)
	// The (f >= 0 && f <= max) form rejects NaN (NaN compares false), -inf, and overflow
	// before the int() cast, so the cast below is always well-defined.
	if !(f >= 0 && f <= max) {
		rng := fmt.tprintf(">= 0 && <= %d", int(max))
		return 0, err_out_of_range(ctx, name, rng, fs_render_number(f)), false
	}
	out = int(f)
	if f != f64(out) {
		return 0, err_out_of_range(ctx, name, "an integer", fs_render_number(f)), false
	}
	return out, nil, true
}

// fs_render_number renders an offending numeric value for an ERR_OUT_OF_RANGE "Received …"
// clause: an integer-valued f64 prints without a decimal, NaN as "NaN".
fs_render_number :: proc(f: f64) -> string {
	if f != f do return "NaN"
	if f >= -9.2e18 && f <= 9.2e18 && f == f64(i64(f)) do return fmt.tprintf("%d", i64(f))
	return fmt.tprintf("%v", f)
}

// Map an os.Error to a Node-compatible error code string and positive errno number.
fs_os_error_to_code :: proc(err: os.Error) -> (code: string, errno_val: int) {
	#partial switch e in err {
	case os.General_Error:
		#partial switch e {
		case .Not_Exist:   return "ENOENT", 2
		case .Exist:       return "EEXIST", 17
		case .Invalid_Dir: return "EISDIR", 21
		case:              return "EIO", 5
		}
	case io.Error:
		#partial switch e {
		case .Permission_Denied: return "EACCES", 13
		case:                    return "EIO", 5
		}
	case os.Platform_Error:
		when ODIN_OS == .Windows {
			// On Windows os.Platform_Error carries a Win32 GetLastError code, not a
			// POSIX errno, so map the codes the fs paths actually produce. (Best
			// effort: the node-compat fs suite does not yet run on Windows CI.)
			switch i32(e) {
			case 2, 3, 267: return "ENOENT", 2  // FILE_NOT_FOUND / PATH_NOT_FOUND / DIRECTORY (libuv maps ERROR_DIRECTORY -> ENOENT)
			case 5:         return "EACCES", 13 // ACCESS_DENIED
			case 80, 183:   return "EEXIST", 17 // FILE_EXISTS / ALREADY_EXISTS
			case 145:       return "ENOTEMPTY", 41 // DIR_NOT_EMPTY (CRT errno 41 on Win32)
			case:           return "EIO", 5
			}
		} else {
			// Linux + Darwin/BSD: i32(e) is the platform errno, so it is the
			// authoritative errno_val. Only the numeric values that differ across
			// these platforms need both arms — notably ENOTEMPTY (Linux 39, BSD 66).
			errno := int(i32(e))
			switch errno {
			case 1:      return "EPERM", errno
			case 2:      return "ENOENT", errno
			case 13:     return "EACCES", errno
			case 17:     return "EEXIST", errno
			case 20:     return "ENOTDIR", errno
			case 21:     return "EISDIR", errno
			case 28:     return "ENOSPC", errno
			case 30:     return "EROFS", errno
			case 39, 66: return "ENOTEMPTY", errno
			case:        return "EIO", 5
			}
		}
	case:
		return "EIO", 5
	}
}

// is_data_view reports whether value is a DataView. JSC's C API has no DataView
// predicate (JSValueGetTypedArrayType returns .None for one), so check the brand via
// `constructor.name` — the same constructor-name pattern determine_received_type uses.
// This separates a real DataView from a plain {buffer, byteOffset, byteLength} object,
// which Node rejects and whose unchecked fields must not be fed to the slice below.
is_data_view :: proc(ctx: jsc.JSContextRef, obj: jsc.JSObjectRef) -> bool {
	ctor := get_named(ctx, obj, "constructor")
	if ctor == nil || !jsc.JSValueIsObject(ctx, ctor) do return false
	name, allocated := value_to_string(ctx, get_named(ctx, cast(jsc.JSObjectRef)ctor, "name"))
	defer if allocated do delete(name)
	return name == "DataView"
}

// fs_resolve_write_payload resolves a writeFile/writeFileSync `data` value into the
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
//     (ok=false) — Node throws ERR_INVALID_ARG_TYPE, where the previous code silently
//     wrote an empty file.
// Returns a nil slice for an empty payload (a zero-length file). Must run on the loop
// thread (it reads JSC); the caller must consume a borrowed result before its next JSC
// call (a later call may move the backing store).
fs_resolve_write_payload :: proc(
	ctx: jsc.JSContextRef,
	value: jsc.JSValueRef,
) -> (bytes: []byte, owned: bool, ok: bool) {
	t := jsc.JSValueGetTypedArrayType(ctx, value, nil)
	// A bare ArrayBuffer is not a valid fs write payload (Node: ERR_INVALID_ARG_TYPE).
	if t == .ArrayBuffer do return nil, false, false
	if t != .None {
		// A real typed array (Buffer included); typed_array_view is byteOffset-aware, so
		// a Buffer.subarray(...) writes its window, not the whole backing. Borrowed.
		view, view_ok := typed_array_view(ctx, value)
		if !view_ok do return nil, false, true
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
				// Pinned by cmd/lava/fs_write_payload_test.odin.
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
				if !(off_f >= 0 && len_f > 0 && off_f + len_f <= ab_len) do return nil, false, true
				base := jsc.JSObjectGetArrayBufferBytesPtr(ctx, ab, nil)
				if base == nil do return nil, false, true
				off, length := int(off_f), int(len_f)
				return (cast([^]byte)base)[off:off + length], false, true
			}
		}
	}
	// String, or any other value coerced to its string form. The string buffer is already
	// owned on context.allocator, so hand it back as-is (owned=true) — no extra copy.
	str, salloc := jsc_value_to_string_or_default(ctx, value)
	if !salloc do return nil, false, true // empty/unconvertible -> zero-length file
	return transmute([]byte)str, true, true
}

fs_write_file_sync_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 2 {
		if exception != nil do exception^ = make_js_error(ctx, "fs.writeFileSync requires a path and data")
		return jsc.JSValueMakeUndefined(ctx)
	}
	args := arguments[:int(argument_count)]
	path_str, path_alloc := jsc_value_to_string_or_default(ctx, args[0])
	defer if path_alloc do delete(path_str, context.allocator)

	// The sync write completes within this native call while a borrowed TypedArray/DataView
	// window is still valid, so write straight from it — no marshalling copy (only a coerced
	// string is an owned buffer, freed below).
	write_bytes, owned, data_ok := fs_resolve_write_payload(ctx, args[1])
	if !data_ok {
		if exception != nil do exception^ = err_invalid_arg_type(ctx, "data", "string or an instance of Buffer, TypedArray, or DataView", args[1])
		return jsc.JSValueMakeUndefined(ctx)
	}
	defer if owned do delete(write_bytes, context.allocator)

	if write_err := os.write_entire_file_from_bytes(path_str, write_bytes); write_err != nil {
		if exception != nil {
			code, errno_val := fs_os_error_to_code(write_err)
			exception^ = fs_make_error(ctx, code, "open", path_str, errno_val)
		}
	}
	return jsc.JSValueMakeUndefined(ctx)
}

// fs.writeFile(path, data[, options], callback). The data is marshalled into an owned
// buffer here on the loop thread (the worker must not read the JS value), the blocking
// write runs off-loop on the pool, and callback(err) is delivered on the poll phase
// (same ordering infra as readFile). Falls back to a synchronous write with no loop or
// if the pool cannot start.
fs_write_file_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 3 {
		if exception != nil do exception^ = make_js_error(ctx, "fs.writeFile requires a path, data and a callback")
		return jsc.JSValueMakeUndefined(ctx)
	}
	args := arguments[:int(argument_count)]
	callback := callback_arg(ctx, args[argument_count - 1])
	if callback == nil {
		if exception != nil do exception^ = make_js_error(ctx, "fs.writeFile callback must be a function")
		return jsc.JSValueMakeUndefined(ctx)
	}
	path_str, path_alloc := jsc_value_to_string_or_default(ctx, args[0])
	defer if path_alloc do delete(path_str, context.allocator)

	// context.allocator is the heap allocator here (proc "c"); capture it so the owned
	// path/data outlive this call and the worker frees through the same allocator.
	alloc := context.allocator
	// Resolve the payload NOW (JSC access is loop-thread only). An invalid payload (a bare
	// ArrayBuffer) is a synchronous throw, like Node — before anything is allocated.
	payload, owned, data_ok := fs_resolve_write_payload(ctx, args[1])
	if !data_ok {
		if exception != nil do exception^ = err_invalid_arg_type(ctx, "data", "string or an instance of Buffer, TypedArray, or DataView", args[1])
		return jsc.JSValueMakeUndefined(ctx)
	}
	// The worker writes off-loop, so it must own its bytes. A coerced string is already an
	// owned heap buffer on `alloc` — take it as-is; a borrowed TypedArray/DataView window
	// must be copied here (it aliases JSC memory). No JSC call between the resolve and this
	// copy, per fs_resolve_write_payload's borrowing contract.
	write_data: []byte
	if owned {
		write_data = payload
	} else if len(payload) > 0 {
		write_data = make([]byte, len(payload), alloc)
		copy(write_data, payload)
	}

	req := new(FS_Op_Request, alloc)
	req.ctx = ctx
	req.callback = callback
	req.allocator = alloc
	req.syscall = "open"
	req.path = strings.clone(path_str, alloc)
	req.write_data = write_data
	jsc.JSValueProtect(ctx, cast(jsc.JSValueRef)callback)

	loop := get_loop_from_ctx(ctx)
	if loop != nil &&
	   eventloop.pool_submit(loop, fs_write_work, fs_write_pool_done, req, fs_write_dispose, fs_write_cancel) {
		return jsc.JSValueMakeUndefined(ctx)
	}

	fs_write_work(req)
	if loop != nil {
		eventloop.queue_io_callback(loop, fs_op_complete_cb, req, fs_write_dispose)
	} else {
		fs_op_complete_cb(nil, req)
	}
	return jsc.JSValueMakeUndefined(ctx)
}

// fs_write_work performs the blocking write off the loop (or inline on the fallback
// path), touching ONLY req. Mirrors fs_read_work.
fs_write_work :: proc(user_data: rawptr) {
	req := cast(^FS_Op_Request)user_data
	write_err := os.write_entire_file_from_bytes(req.path, req.write_data)
	if write_err == nil {
		req.ok = true
	} else {
		req.ok = false
		req.err_code, req.err_errno = fs_os_error_to_code(write_err)
	}
}

// fs_write_pool_done re-queues the completion onto the poll phase (see fs_read_pool_done).
fs_write_pool_done :: proc(loop: ^eventloop.Loop, user_data: rawptr) {
	eventloop.queue_io_callback(loop, fs_op_complete_cb, user_data, fs_write_dispose)
}

// fs_write_dispose releases a request whose completion will never run (teardown). After
// fs_write_cancel it frees memory only, as fs_read_dispose does.
fs_write_dispose :: proc(user_data: rawptr) {
	context = runtime.default_context()
	req := cast(^FS_Op_Request)user_data
	if req == nil do return
	if req.callback != nil do jsc.JSValueUnprotect(req.ctx, cast(jsc.JSValueRef)req.callback)
	fs_op_request_free(req)
}

// fs_write_cancel is fs_read_cancel for a write: fs_write_work reads only path and
// write_data, never the callback.
fs_write_cancel :: proc(user_data: rawptr) {
	context = runtime.default_context()
	req := cast(^FS_Op_Request)user_data
	if req.callback != nil do jsc.JSValueUnprotect(req.ctx, cast(jsc.JSValueRef)req.callback)
	req.callback = nil
}

// fs_op_request_free releases everything an FS_Op_Request owns.
fs_op_request_free :: proc(req: ^FS_Op_Request) {
	a := req.allocator
	if req.write_data != nil do delete(req.write_data, a)
	if len(req.path) > 0 do delete(req.path, a)
	free(req, a)
}

// FS_Op_Request backs async fs operations whose callback takes only (err) — today
// fs.writeFile. The data to write is marshalled into an owned copy (write_data) on the
// loop thread, since the worker that performs the write must not touch the JS value it
// came from. allocator (heap) owns path/write_data; the error path reuses req.path.
FS_Op_Request :: struct {
	ctx:        jsc.JSContextRef,
	callback:   jsc.JSObjectRef,
	allocator:  runtime.Allocator,
	path:       string, // owned clone; the worker writes to this path off-loop (also the error path)
	write_data: []byte, // owned copy of the bytes to write (nil = empty file)
	ok:         bool,
	err_code:   string, // static literal (not freed)
	err_errno:  int,
	syscall:    string,
}

fs_op_complete_cb :: proc(loop: ^eventloop.Loop, user_data: rawptr) {
	context = runtime.default_context()
	req := cast(^FS_Op_Request)user_data
	if req == nil do return
	ctx := req.ctx

	call_args: [1]jsc.JSValueRef
	if req.ok {
		call_args[0] = jsc.JSValueMakeNull(ctx)
	} else {
		call_args[0] = fs_make_error(ctx, req.err_code, req.syscall, req.path, req.err_errno)
	}

	exception: jsc.JSValueRef
	invoke_user_callback(ctx, req.callback, raw_data(call_args[:]), 1, &exception)
	if exception != nil {
		report_uncaught(ctx, exception)
		mark_async_failed(ctx)
	}

	jsc.JSValueUnprotect(ctx, cast(jsc.JSValueRef)req.callback)
	fs_op_request_free(req)
}

// fs_options_recursive reads `options.recursive === true` from an options arg.
fs_options_recursive :: proc(ctx: jsc.JSContextRef, value: jsc.JSValueRef) -> bool {
	if value == nil || !jsc.JSValueIsObject(ctx, value) do return false
	r := get_named(ctx, cast(jsc.JSObjectRef)value, "recursive")
	if r == nil do return false
	return bool(jsc.JSValueToBoolean(ctx, r))
}

fs_mkdir_recursive :: proc(path: string) -> bool {
	if len(path) == 0 do return false
	if os.exists(path) do return os.is_dir(path)
	parent := filepath.dir(path)
	if parent != path && len(parent) > 0 && !os.exists(parent) {
		if !fs_mkdir_recursive(parent) do return false
	}
	if os.make_directory(path) == nil do return true
	return os.is_dir(path)
}

fs_mkdir_sync_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 {
		if exception != nil do exception^ = make_js_error(ctx, "fs.mkdirSync requires a path")
		return jsc.JSValueMakeUndefined(ctx)
	}
	args := arguments[:int(argument_count)]
	path_str, path_alloc := jsc_value_to_string_or_default(ctx, args[0])
	defer if path_alloc do delete(path_str, context.allocator)

	recursive := argument_count >= 2 && fs_options_recursive(ctx, args[1])

	if os.exists(path_str) {
		// Node: recursive mkdir on an existing dir is a no-op; non-recursive or
		// recursive on an existing *file* throws EEXIST.
		if !recursive || !os.is_dir(path_str) {
			if exception != nil do exception^ = fs_make_error(ctx, "EEXIST", "mkdir", path_str, 17)
		}
		return jsc.JSValueMakeUndefined(ctx)
	}

	ok := recursive ? fs_mkdir_recursive(path_str) : (os.make_directory(path_str) == nil)
	if !ok && exception != nil {
		exception^ = fs_make_error(ctx, "ENOENT", "mkdir", path_str)
	}
	return jsc.JSValueMakeUndefined(ctx)
}

fs_remove_recursive :: proc(path: string) -> bool {
	// Classify without following links (lstat): a symlink — even one pointing at
	// a directory — must be unlinked, never descended into. os.is_dir follows
	// links, so the recursion used to walk INTO the link target and delete its
	// contents outside the removed tree (issue #88). Node removes only the link.
	is_real_dir := false
	if info, stat_err := os.lstat(path, context.allocator); stat_err == nil {
		is_real_dir = info.type == .Directory
		os.file_info_delete(info, context.allocator)
	}
	if is_real_dir {
		handle, open_err := os.open(path)
		if open_err == nil {
			infos, read_err := os.read_directory(handle, -1, context.allocator)
			os.close(handle)
			if read_err == nil {
				for info in infos {
					child, join_err := filepath.join({path, info.name}, context.allocator)
					if join_err == nil {
						fs_remove_recursive(child)
						delete(child, context.allocator)
					}
				}
				os.file_info_slice_delete(infos, context.allocator)
			}
		}
	}
	return os.remove(path) == nil
}

fs_rm_sync_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 {
		if exception != nil do exception^ = make_js_error(ctx, "fs.rmSync requires a path")
		return jsc.JSValueMakeUndefined(ctx)
	}
	args := arguments[:int(argument_count)]
	path_str, path_alloc := jsc_value_to_string_or_default(ctx, args[0])
	defer if path_alloc do delete(path_str, context.allocator)

	force := false
	recursive := false
	if argument_count >= 2 && jsc.JSValueIsObject(ctx, args[1]) {
		opts := cast(jsc.JSObjectRef)args[1]
		recursive = fs_options_recursive(ctx, args[1])
		f := get_named(ctx, opts, "force")
		if f != nil do force = bool(jsc.JSValueToBoolean(ctx, f))
	}

	// Use lstat so a dangling symlink is visible (os.exists follows links and
	// would incorrectly treat a dangling symlink as "not found").
	lstat_info, lstat_err := os.lstat(path_str, context.allocator)
	path_missing := lstat_err != nil
	is_dir := !path_missing && lstat_info.type == .Directory
	if lstat_err == nil do os.file_info_delete(lstat_info, context.allocator)

	if path_missing {
		if !force && exception != nil {
			exception^ = fs_make_error(ctx, "ENOENT", "stat", path_str, 2)
		}
		return jsc.JSValueMakeUndefined(ctx)
	}

	if recursive {
		ok := fs_remove_recursive(path_str)
		if !ok && !force && exception != nil {
			exception^ = fs_make_error(ctx, "ENOTEMPTY", "rmdir", path_str, 39)
		}
	} else {
		// Non-recursive on a directory: Node 22 throws ERR_FS_EISDIR regardless of
		// whether the dir is empty, because rm(1) requires --recursive/-r for dirs.
		if is_dir && !force {
			if exception != nil do exception^ = fs_make_error(ctx, "ERR_FS_EISDIR", "rm", path_str, 21)
			return jsc.JSValueMakeUndefined(ctx)
		}
		remove_err := os.remove(path_str)
		if remove_err != nil && !force && exception != nil {
			code, errno_val := fs_os_error_to_code(remove_err)
			exception^ = fs_make_error(ctx, code, "rm", path_str, errno_val)
		}
	}
	return jsc.JSValueMakeUndefined(ctx)
}

// fs.openSync(path[, flags='r'][, mode=0o666]) -> fd. Opens the file and returns its
// integer OS file descriptor (the platform impl lives in fs_fd_posix.odin /
// fs_fd_windows.odin). A numeric flags argument (Node also accepts one) is not handled
// yet; the common string forms are. Errors raise a Node-coded fs error.
fs_open_sync_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 {
		if exception != nil do exception^ = make_js_error(ctx, "fs.openSync requires a path")
		return jsc.JSValueMakeUndefined(ctx)
	}
	args := arguments[:int(argument_count)]
	path_str, path_alloc := jsc_value_to_string_or_default(ctx, args[0])
	defer if path_alloc do delete(path_str, context.allocator)

	flags := "r"
	flags_alloc := false
	if argument_count >= 2 && jsc.JSValueIsString(ctx, args[1]) {
		flags, flags_alloc = jsc_value_to_string_or_default(ctx, args[1])
	}
	defer if flags_alloc do delete(flags, context.allocator)

	mode := 0o666
	if argument_count >= 3 && jsc.JSValueIsNumber(ctx, args[2]) {
		// A provided numeric mode must be a non-negative 32-bit integer (Node's
		// validateUint32 via parseFileMode); a fractional/NaN/negative value throws.
		m, mode_err, mode_ok := fs_validate_int_arg(ctx, args[2], "mode", 0xffffffff)
		if !mode_ok {
			if exception != nil do exception^ = mode_err
			return jsc.JSValueMakeUndefined(ctx)
		}
		mode = m
	}

	fd, code, errno_val := fs_platform_open(path_str, flags, mode)
	if code != "" {
		if exception != nil do exception^ = fs_make_error(ctx, code, "open", path_str, errno_val)
		return jsc.JSValueMakeUndefined(ctx)
	}
	return jsc.JSValueMakeNumber(ctx, f64(fd))
}

// fs.closeSync(fd) — close an fd previously returned by openSync.
fs_close_sync_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 {
		if exception != nil do exception^ = make_js_error(ctx, "fs.closeSync requires a fd")
		return jsc.JSValueMakeUndefined(ctx)
	}
	// Validate the fd BEFORE the syscall: an unvalidated coercion (3.5 -> 3, NaN/object ->
	// garbage) would otherwise close an unrelated descriptor (stdin, the loop's epoll fd).
	fd, fd_err, fd_ok := fs_validate_int_arg(ctx, arguments[0], "fd", 0x7fffffff)
	if !fd_ok {
		if exception != nil do exception^ = fd_err
		return jsc.JSValueMakeUndefined(ctx)
	}
	code, errno_val := fs_platform_close(fd)
	if code != "" {
		if exception != nil do exception^ = fs_make_error(ctx, code, "close", "", errno_val)
	}
	return jsc.JSValueMakeUndefined(ctx)
}

// fs.unlinkSync(path) — remove a file or symlink. Unlike rmSync, unlink never
// removes a directory; os.remove would happily rmdir an empty one, so classify
// with lstat first. A symlink — even one pointing at a directory — reports
// .Symlink (not .Directory) under lstat and is correctly unlinked, not followed.
// unlink(2) on a directory fails with EISDIR on Linux but EPERM on Darwin/BSD and
// Windows, so the directory error is branched per platform. lstat failures (a
// missing path, or a non-directory component → ENOTDIR) keep their real code via
// fs_os_error_to_code rather than collapsing to ENOENT.
fs_unlink_sync_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 {
		if exception != nil do exception^ = make_js_error(ctx, "fs.unlinkSync requires a path")
		return jsc.JSValueMakeUndefined(ctx)
	}
	args := arguments[:int(argument_count)]
	path_str, path_alloc := jsc_value_to_string_or_default(ctx, args[0])
	defer if path_alloc do delete(path_str, context.allocator)

	info, lstat_err := os.lstat(path_str, context.allocator)
	if lstat_err != nil {
		if exception != nil {
			code, errno_val := fs_os_error_to_code(lstat_err)
			exception^ = fs_make_error(ctx, code, "unlink", path_str, errno_val)
		}
		return jsc.JSValueMakeUndefined(ctx)
	}
	is_dir := info.type == .Directory
	os.file_info_delete(info, context.allocator)
	if is_dir {
		if exception != nil {
			when ODIN_OS == .Linux {
				exception^ = fs_make_error(ctx, "EISDIR", "unlink", path_str, 21)
			} else {
				exception^ = fs_make_error(ctx, "EPERM", "unlink", path_str, 1)
			}
		}
		return jsc.JSValueMakeUndefined(ctx)
	}

	if remove_err := os.remove(path_str); remove_err != nil && exception != nil {
		code, errno_val := fs_os_error_to_code(remove_err)
		exception^ = fs_make_error(ctx, code, "unlink", path_str, errno_val)
	}
	return jsc.JSValueMakeUndefined(ctx)
}

// fs.rmdirSync(path) — remove an empty directory. Node throws ENOTDIR when the
// path is not a directory and ENOTEMPTY when it still has entries. os.remove on a
// plain file would unlink it, so classify with lstat first; a non-empty directory
// surfaces the OS error (ENOTEMPTY on POSIX) through fs_os_error_to_code.
// (fs.rmSync({recursive:true}) is the modern replacement for recursive removal;
// rmdirSync stays non-recursive to match Node 22+, whose `recursive` option here
// is removed/throwing.)
fs_rmdir_sync_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 {
		if exception != nil do exception^ = make_js_error(ctx, "fs.rmdirSync requires a path")
		return jsc.JSValueMakeUndefined(ctx)
	}
	args := arguments[:int(argument_count)]
	path_str, path_alloc := jsc_value_to_string_or_default(ctx, args[0])
	defer if path_alloc do delete(path_str, context.allocator)

	info, lstat_err := os.lstat(path_str, context.allocator)
	if lstat_err != nil {
		if exception != nil {
			code, errno_val := fs_os_error_to_code(lstat_err)
			exception^ = fs_make_error(ctx, code, "rmdir", path_str, errno_val)
		}
		return jsc.JSValueMakeUndefined(ctx)
	}
	is_dir := info.type == .Directory
	os.file_info_delete(info, context.allocator)
	if !is_dir {
		// rmdir of a non-directory: POSIX reports ENOTDIR, but on Windows
		// RemoveDirectoryW fails with ERROR_DIRECTORY, which libuv/Node surface as
		// ENOENT (verified against Node 24 on the Windows CI runner).
		if exception != nil {
			when ODIN_OS == .Windows {
				exception^ = fs_make_error(ctx, "ENOENT", "rmdir", path_str, 2)
			} else {
				exception^ = fs_make_error(ctx, "ENOTDIR", "rmdir", path_str, 20)
			}
		}
		return jsc.JSValueMakeUndefined(ctx)
	}

	if remove_err := os.remove(path_str); remove_err != nil && exception != nil {
		code, errno_val := fs_os_error_to_code(remove_err)
		exception^ = fs_make_error(ctx, code, "rmdir", path_str, errno_val)
	}
	return jsc.JSValueMakeUndefined(ctx)
}

// fs.renameSync(oldPath, newPath) — rename/move a path. Thin wrapper over
// os.rename; the OS error (e.g. ENOENT for a missing source) is mapped to Node's
// code/errno. Node reports the syscall as "rename" with `path`=old and `dest`=new.
fs_rename_sync_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 2 {
		if exception != nil do exception^ = make_js_error(ctx, "fs.renameSync requires oldPath and newPath")
		return jsc.JSValueMakeUndefined(ctx)
	}
	args := arguments[:int(argument_count)]
	old_str, old_alloc := jsc_value_to_string_or_default(ctx, args[0])
	defer if old_alloc do delete(old_str, context.allocator)
	new_str, new_alloc := jsc_value_to_string_or_default(ctx, args[1])
	defer if new_alloc do delete(new_str, context.allocator)

	if rename_err := os.rename(old_str, new_str); rename_err != nil && exception != nil {
		code, errno_val := fs_os_error_to_code(rename_err)
		exception^ = fs_make_rename_error(ctx, code, old_str, new_str, errno_val)
	}
	return jsc.JSValueMakeUndefined(ctx)
}

// fs_mkdtemp_alphabet is the character set for mkdtempSync's random suffix. Node's
// exact alphabet is an unspecified implementation detail; [A-Za-z0-9] is filename-
// safe on every platform and avoids the path separators '/' and '\'.
@(rodata)
fs_mkdtemp_alphabet := "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"

// fs_mkdtemp_wants_buffer reports whether the options arg requests a Buffer return
// ('buffer' or { encoding: 'buffer' }); otherwise mkdtempSync returns a string.
fs_mkdtemp_wants_buffer :: proc(ctx: jsc.JSContextRef, value: jsc.JSValueRef) -> bool {
	enc := value
	if jsc.JSValueIsObject(ctx, value) {
		enc = get_named(ctx, cast(jsc.JSObjectRef)value, "encoding")
	}
	if enc == nil || !jsc.JSValueIsString(ctx, enc) do return false
	s, alloc := jsc_value_to_string_or_default(ctx, enc)
	defer if alloc do delete(s, context.allocator)
	return s == "buffer"
}

// fs.mkdtempSync(prefix[, options]) — create a uniquely-named temp directory and
// return its path. Node appends exactly six random characters to the LITERAL
// prefix ("/tmp/foo-" -> "/tmp/foo-a1b2c3"); a '*' in the prefix is kept verbatim.
// os.make_directory_temp can't be reused: it treats '*' as a placeholder and
// re-joins a (dir, name) pair with a path separator, neither of which matches
// Node. So build "<prefix><random>" directly and retry on the rare collision.
// With { encoding: 'buffer' } (or 'buffer') the path is returned as bytes, modeled
// as a Uint8Array like the rest of Lava's Buffer surface.
fs_mkdtemp_sync_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 {
		if exception != nil do exception^ = make_js_error(ctx, "fs.mkdtempSync requires a prefix")
		return jsc.JSValueMakeUndefined(ctx)
	}
	args := arguments[:int(argument_count)]
	prefix_str, prefix_alloc := jsc_value_to_string_or_default(ctx, args[0])
	defer if prefix_alloc do delete(prefix_str, context.allocator)

	as_buffer := argument_count >= 2 && fs_mkdtemp_wants_buffer(ctx, args[1])

	created: string
	created_ok := false
	rand_buf: [6]byte
	suffix: [6]byte
	for _ in 0 ..< 64 {
		crypto.rand_bytes(rand_buf[:])
		for b, i in rand_buf {
			suffix[i] = fs_mkdtemp_alphabet[int(b) % len(fs_mkdtemp_alphabet)]
		}
		candidate := strings.concatenate({prefix_str, string(suffix[:])}, context.allocator)
		mk_err := os.make_directory(candidate)
		if mk_err == nil {
			created = candidate
			created_ok = true
			break
		}
		delete(candidate, context.allocator)
		// EEXIST → collision, try another suffix; anything else (e.g. ENOENT for a
		// missing parent) is terminal and reported with Node's mkdtemp semantics.
		code, errno_val := fs_os_error_to_code(mk_err)
		if code != "EEXIST" {
			if exception != nil do exception^ = fs_make_error(ctx, code, "mkdtemp", prefix_str, errno_val)
			return jsc.JSValueMakeUndefined(ctx)
		}
	}
	if !created_ok {
		if exception != nil do exception^ = fs_make_error(ctx, "EEXIST", "mkdtemp", prefix_str, 17)
		return jsc.JSValueMakeUndefined(ctx)
	}
	defer delete(created, context.allocator)

	if as_buffer {
		// Hand a private copy of the path bytes to JSC as a Uint8Array; the original
		// `created` is freed by the defer above, the copy by make_uint8_array.
		bytes := make([]byte, len(created), context.allocator)
		copy(bytes, created)
		return make_uint8_array(ctx, bytes)
	}
	return js_string_value(ctx, created)
}

fs_time_ms :: proc(t: time.Time) -> f64 {
	return f64(time.to_unix_nanoseconds(t)) / 1.0e6
}

stats_ftype :: proc(ctx: jsc.JSContextRef, obj: jsc.JSObjectRef) -> int {
	v := get_named(ctx, obj, "__lava_ftype")
	if v == nil do return 0
	return int(jsc.JSValueToNumber(ctx, v, nil))
}

stats_is_file_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	return jsc.JSValueMakeBoolean(ctx, b32(stats_ftype(ctx, this_object) == 1))
}

stats_is_directory_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	return jsc.JSValueMakeBoolean(ctx, b32(stats_ftype(ctx, this_object) == 2))
}

stats_is_symlink_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	return jsc.JSValueMakeBoolean(ctx, b32(stats_ftype(ctx, this_object) == 3))
}

fs_build_stats :: proc(ctx: jsc.JSContextRef, info: os.File_Info) -> jsc.JSValueRef {
	obj := jsc.JSObjectMake(ctx, nil, nil)

	set_named(ctx, obj, "size", jsc.JSValueMakeNumber(ctx, f64(info.size)))
	set_named(ctx, obj, "mtimeMs", jsc.JSValueMakeNumber(ctx, fs_time_ms(info.modification_time)))
	set_named(ctx, obj, "atimeMs", jsc.JSValueMakeNumber(ctx, fs_time_ms(info.access_time)))
	set_named(ctx, obj, "ctimeMs", jsc.JSValueMakeNumber(ctx, fs_time_ms(info.modification_time)))
	set_named(ctx, obj, "birthtimeMs", jsc.JSValueMakeNumber(ctx, fs_time_ms(info.creation_time)))

	ftype := 0
	#partial switch info.type {
	case .Regular:
		ftype = 1
	case .Directory:
		ftype = 2
	case .Symlink:
		ftype = 3
	}
	// __lava_ftype backs the is*() methods; kept non-enumerable so it does not
	// surface in Object.keys / JSON.stringify of the Stats object.
	ftype_name := jsc.JSStringCreateWithUTF8CString("__lava_ftype")
	defer jsc.JSStringRelease(ftype_name)
	jsc.JSObjectSetProperty(
		ctx,
		obj,
		ftype_name,
		jsc.JSValueMakeNumber(ctx, f64(ftype)),
		{.DontEnum},
		nil,
	)

	inject_native_function(ctx, obj, "isFile", stats_is_file_cb)
	inject_native_function(ctx, obj, "isDirectory", stats_is_directory_cb)
	inject_native_function(ctx, obj, "isSymbolicLink", stats_is_symlink_cb)
	return cast(jsc.JSValueRef)obj
}

fs_stat_sync_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 {
		if exception != nil do exception^ = make_js_error(ctx, "fs.statSync requires a path")
		return jsc.JSValueMakeUndefined(ctx)
	}
	args := arguments[:int(argument_count)]
	path_str, path_alloc := jsc_value_to_string_or_default(ctx, args[0])
	defer if path_alloc do delete(path_str, context.allocator)

	info, stat_err := os.stat(path_str, context.allocator)
	if stat_err != nil {
		if exception != nil do exception^ = fs_make_error(ctx, "ENOENT", "stat", path_str)
		return jsc.JSValueMakeUndefined(ctx)
	}
	defer os.file_info_delete(info, context.allocator)

	return fs_build_stats(ctx, info)
}

fs_readdir_sync_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 {
		if exception != nil do exception^ = make_js_error(ctx, "fs.readdirSync requires a path")
		return jsc.JSValueMakeUndefined(ctx)
	}
	args := arguments[:int(argument_count)]
	path_str, path_alloc := jsc_value_to_string_or_default(ctx, args[0])
	defer if path_alloc do delete(path_str, context.allocator)

	handle, open_err := os.open(path_str)
	if open_err != nil {
		if exception != nil do exception^ = fs_make_error(ctx, "ENOENT", "scandir", path_str)
		return jsc.JSValueMakeUndefined(ctx)
	}
	infos, read_err := os.read_directory(handle, -1, context.allocator)
	os.close(handle)
	if read_err != nil {
		if exception != nil do exception^ = fs_make_error(ctx, "ENOTDIR", "scandir", path_str)
		return jsc.JSValueMakeUndefined(ctx)
	}
	defer os.file_info_slice_delete(infos, context.allocator)

	// Set each name as it is created — never park unrooted JSValueRefs in a temp_allocator
	// slice for JSObjectMakeArray (GC-invisible heap → use-after-free; see build_string_array).
	arr := jsc.JSObjectMakeArray(ctx, 0, nil, nil)
	for info, i in infos {
		jsc.JSObjectSetPropertyAtIndex(ctx, arr, c.uint(i), js_string_value(ctx, info.name), nil)
	}
	return cast(jsc.JSValueRef)arr
}

fs_exists_sync_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 do return jsc.JSValueMakeBoolean(ctx, false)

	args := arguments[:int(argument_count)]
	path_str, alloc := jsc_value_to_string_or_default(ctx, args[0])
	defer if alloc do delete(path_str, context.allocator)

	return jsc.JSValueMakeBoolean(ctx, b32(module_file_exists(path_str)))
}

// make_fs_bindings returns the Odin-backed primitives behind `node:fs`, for
// js/node/fs.js to wrap.
//
// Returns:
//   A fresh object carrying one native function per primitive; the loader hands it to the
//   fs factory as its fourth argument, so nothing lands on globalThis.
// Node:
//   The set is unchanged from what require.odin installed directly before the JS layer
//   existed — this moved the same callbacks behind a factory, it did not add or drop one.
//   fs.js re-exports the pass-through entries by identity, so their `.name`/`.length` and
//   object identity are still whatever inject_native_function produced.
//
// The read primitives are the reason the layer exists: they return a bare Uint8Array and
// node returns a Buffer, which is a re-tag JS can do zero-copy but a native would need a
// protected, swept Buffer.prototype handle to do at all (issue #329).
make_fs_bindings :: proc(ctx: jsc.JSContextRef) -> jsc.JSObjectRef {
	bindings := jsc.JSObjectMake(ctx, nil, nil)
	inject_native_function(ctx, bindings, "readFile", fs_read_file_cb)
	inject_native_function(ctx, bindings, "readFileSync", fs_read_file_sync_cb)
	inject_native_function(ctx, bindings, "writeFile", fs_write_file_cb)
	inject_native_function(ctx, bindings, "writeFileSync", fs_write_file_sync_cb)
	inject_native_function(ctx, bindings, "openSync", fs_open_sync_cb)
	inject_native_function(ctx, bindings, "closeSync", fs_close_sync_cb)
	inject_native_function(ctx, bindings, "existsSync", fs_exists_sync_cb)
	inject_native_function(ctx, bindings, "mkdirSync", fs_mkdir_sync_cb)
	inject_native_function(ctx, bindings, "mkdtempSync", fs_mkdtemp_sync_cb)
	inject_native_function(ctx, bindings, "rmSync", fs_rm_sync_cb)
	inject_native_function(ctx, bindings, "rmdirSync", fs_rmdir_sync_cb)
	inject_native_function(ctx, bindings, "unlinkSync", fs_unlink_sync_cb)
	inject_native_function(ctx, bindings, "renameSync", fs_rename_sync_cb)
	inject_native_function(ctx, bindings, "statSync", fs_stat_sync_cb)
	inject_native_function(ctx, bindings, "readdirSync", fs_readdir_sync_cb)
	return bindings
}
