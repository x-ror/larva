package lava_runtime

import "base:runtime"
import "core:c"
import "core:fmt"
import "core:strconv"
import jsc "lava:pkg/jsc"
import sqlite "lava:pkg/std/sqlite"

// node:sqlite bridge. js/internal/sqlite.js implements the DatabaseSync /
// StatementSync classes on top of these native primitives; the heavy lifting
// (the libsqlite3 calls) lives in pkg/std/sqlite. JS holds opaque integer handle
// ids; the real ^sqlite.Database / ^sqlite.Statement live in the per-context
// registries on Runtime_State, so they are closed/freed when the context is torn
// down even if user code forgets to call db.close().

// make_sqlite_bindings builds the `native` object handed to js/internal/sqlite.js.
make_sqlite_bindings :: proc(ctx: jsc.JSContextRef) -> jsc.JSObjectRef {
	bindings := jsc.JSObjectMake(ctx, nil, nil)
	inject_native_function(ctx, bindings, "open", sqlite_open_cb)
	inject_native_function(ctx, bindings, "close", sqlite_close_cb)
	inject_native_function(ctx, bindings, "exec", sqlite_exec_cb)
	inject_native_function(ctx, bindings, "prepare", sqlite_prepare_cb)
	inject_native_function(ctx, bindings, "finalize", sqlite_finalize_cb)
	inject_native_function(ctx, bindings, "reset", sqlite_reset_cb)
	inject_native_function(ctx, bindings, "bind", sqlite_bind_cb)
	inject_native_function(ctx, bindings, "bindBigInt", sqlite_bind_bigint_cb)
	inject_native_function(ctx, bindings, "bindParameterCount", sqlite_bind_parameter_count_cb)
	inject_native_function(ctx, bindings, "bindParameterName", sqlite_bind_parameter_name_cb)
	inject_native_function(ctx, bindings, "step", sqlite_step_cb)
	inject_native_function(ctx, bindings, "row", sqlite_row_cb)
	inject_native_function(ctx, bindings, "changes", sqlite_changes_cb)
	inject_native_function(ctx, bindings, "lastInsertRowid", sqlite_last_insert_rowid_cb)
	return bindings
}

// sqlite_destroy_state finalizes every open statement and database for the context.
sqlite_destroy_state :: proc(state: ^Runtime_State) {
	if state == nil do return
	for _, ptr in state.sqlite_stmts {
		stmt := cast(^sqlite.Statement)ptr
		sqlite.finalize(stmt)
		free(stmt)
	}
	for _, ptr in state.sqlite_dbs {
		db := cast(^sqlite.Database)ptr
		sqlite.close(db)
		free(db)
	}
	delete(state.sqlite_dbs)
	delete(state.sqlite_stmts)
}

// --- registry helpers ---

sqlite_get_db :: proc(state: ^Runtime_State, id: u64) -> ^sqlite.Database {
	if state == nil do return nil
	if ptr, ok := state.sqlite_dbs[id]; ok do return cast(^sqlite.Database)ptr
	return nil
}

sqlite_get_stmt :: proc(state: ^Runtime_State, id: u64) -> ^sqlite.Statement {
	if state == nil do return nil
	if ptr, ok := state.sqlite_stmts[id]; ok do return cast(^sqlite.Statement)ptr
	return nil
}

sqlite_arg_id :: proc(ctx: jsc.JSContextRef, value: jsc.JSValueRef) -> u64 {
	return u64(jsc.JSValueToNumber(ctx, value, nil))
}

// --- native callbacks ---

sqlite_open_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 {
		if exception != nil do exception^ = make_js_error(ctx, "sqlite open requires a path")
		return jsc.JSValueMakeUndefined(ctx)
	}
	state := get_state_from_ctx(ctx)
	if state == nil do return jsc.JSValueMakeUndefined(ctx)

	args := arguments[:int(argument_count)]
	path, path_alloc := jsc_value_to_string_or_default(ctx, args[0])
	defer if path_alloc do delete(path, context.allocator)

	db := new(sqlite.Database)
	result: sqlite.Result
	db^, result = sqlite.open(path)
	if result.status != .Ok {
		free(db)
		if exception != nil do exception^ = sqlite_error(ctx, result.message)
		return jsc.JSValueMakeUndefined(ctx)
	}

	id := state.next_sqlite_id
	state.next_sqlite_id += 1
	state.sqlite_dbs[id] = cast(rawptr)db
	return jsc.JSValueMakeNumber(ctx, f64(id))
}

sqlite_close_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 do return jsc.JSValueMakeUndefined(ctx)
	state := get_state_from_ctx(ctx)
	id := sqlite_arg_id(ctx, arguments[0])
	db := sqlite_get_db(state, id)
	if db != nil {
		sqlite.close(db)
		free(db)
		delete_key(&state.sqlite_dbs, id)
	}
	return jsc.JSValueMakeUndefined(ctx)
}

sqlite_exec_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 2 {
		if exception != nil do exception^ = make_js_error(ctx, "sqlite exec requires a handle and SQL")
		return jsc.JSValueMakeUndefined(ctx)
	}
	state := get_state_from_ctx(ctx)
	args := arguments[:int(argument_count)]
	db := sqlite_get_db(state, sqlite_arg_id(ctx, args[0]))
	if db == nil {
		if exception != nil do exception^ = make_js_error(ctx, "database is not open")
		return jsc.JSValueMakeUndefined(ctx)
	}
	sql, sql_alloc := jsc_value_to_string_or_default(ctx, args[1])
	defer if sql_alloc do delete(sql, context.allocator)

	result := sqlite.exec(db, sql)
	if result.status != .Ok && exception != nil {
		exception^ = sqlite_error(ctx, sqlite_error_text(db, result))
	}
	return jsc.JSValueMakeUndefined(ctx)
}

sqlite_prepare_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 2 {
		if exception != nil do exception^ = make_js_error(ctx, "sqlite prepare requires a handle and SQL")
		return jsc.JSValueMakeUndefined(ctx)
	}
	state := get_state_from_ctx(ctx)
	args := arguments[:int(argument_count)]
	db := sqlite_get_db(state, sqlite_arg_id(ctx, args[0]))
	if db == nil {
		if exception != nil do exception^ = make_js_error(ctx, "database is not open")
		return jsc.JSValueMakeUndefined(ctx)
	}
	sql, sql_alloc := jsc_value_to_string_or_default(ctx, args[1])
	defer if sql_alloc do delete(sql, context.allocator)

	stmt := new(sqlite.Statement)
	result: sqlite.Result
	stmt^, result = sqlite.prepare(db, sql)
	if result.status != .Ok {
		free(stmt)
		if exception != nil do exception^ = sqlite_error(ctx, sqlite_error_text(db, result))
		return jsc.JSValueMakeUndefined(ctx)
	}

	id := state.next_sqlite_id
	state.next_sqlite_id += 1
	state.sqlite_stmts[id] = cast(rawptr)stmt
	return jsc.JSValueMakeNumber(ctx, f64(id))
}

sqlite_finalize_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 do return jsc.JSValueMakeUndefined(ctx)
	state := get_state_from_ctx(ctx)
	id := sqlite_arg_id(ctx, arguments[0])
	stmt := sqlite_get_stmt(state, id)
	if stmt != nil {
		sqlite.finalize(stmt)
		free(stmt)
		delete_key(&state.sqlite_stmts, id)
	}
	return jsc.JSValueMakeUndefined(ctx)
}

sqlite_reset_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 do return jsc.JSValueMakeUndefined(ctx)
	state := get_state_from_ctx(ctx)
	stmt := sqlite_get_stmt(state, sqlite_arg_id(ctx, arguments[0]))
	if stmt != nil do sqlite.reset(stmt)
	return jsc.JSValueMakeUndefined(ctx)
}

sqlite_bind_parameter_count_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 do return jsc.JSValueMakeNumber(ctx, 0)
	state := get_state_from_ctx(ctx)
	stmt := sqlite_get_stmt(state, sqlite_arg_id(ctx, arguments[0]))
	if stmt == nil do return jsc.JSValueMakeNumber(ctx, 0)
	return jsc.JSValueMakeNumber(ctx, f64(sqlite.bind_parameter_count(stmt)))
}

// sqlite_bind_parameter_name_cb(stmtId, index) -> the 1-based parameter's name
// (with its ":"/"@"/"$" sigil), or "" for an anonymous "?" parameter. Lets the JS
// wrapper map a named-parameter object's keys onto bind positions.
sqlite_bind_parameter_name_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 2 do return js_string_value(ctx, "")
	state := get_state_from_ctx(ctx)
	stmt := sqlite_get_stmt(state, sqlite_arg_id(ctx, arguments[0]))
	if stmt == nil do return js_string_value(ctx, "")
	index := int(jsc.JSValueToNumber(ctx, arguments[1], nil))
	return js_string_value(ctx, sqlite.bind_parameter_name(stmt, index))
}

// sqlite_bind_cb(stmtId, index, value): binds one 1-based parameter, inferring the
// SQLite type from the JS value (null/number/string/Uint8Array).
sqlite_bind_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 3 {
		if exception != nil do exception^ = make_js_error(ctx, "sqlite bind requires handle, index and value")
		return jsc.JSValueMakeUndefined(ctx)
	}
	state := get_state_from_ctx(ctx)
	args := arguments[:int(argument_count)]
	stmt := sqlite_get_stmt(state, sqlite_arg_id(ctx, args[0]))
	if stmt == nil {
		if exception != nil do exception^ = make_js_error(ctx, "statement is not prepared")
		return jsc.JSValueMakeUndefined(ctx)
	}
	index := int(jsc.JSValueToNumber(ctx, args[1], nil))
	value := args[2]

	// js/internal/sqlite.js validates the value type before calling here, so the
	// bridge only ever sees the bindable types (null/number/string/TypedArray) and
	// routes BigInt through sqlite_bind_bigint_cb. The default branch stays as a
	// defensive backstop: undefined, booleans, plain objects, etc. throw rather
	// than silently coercing (matching node:sqlite).
	res: sqlite.Result
	#partial switch jsc.JSValueGetType(ctx, value) {
	case .Null:
		res = sqlite.bind_null(stmt, index)
	case .Number:
		// Node binds EVERY JS number with sqlite3_bind_double, whole ones included
		// (verified against node 24: `SELECT typeof(?)` with 42 reports "real").
		// Binding a whole number as INTEGER changed results, not just the type tag:
		// SQLite divides integers with integer division, so `SELECT ? / 2` with 5
		// returned 2 instead of 2.5, and a value written into a typeless column came
		// back with a different storage class than the same script produces under
		// Node. A column with INTEGER affinity still converts the REAL losslessly on
		// the way in; asking for an INTEGER bind explicitly is what BigInt is for
		// (sqlite_bind_bigint_cb). Pinned by tests/std/sqlite/cases/08-coercion-parity.js.
		res = sqlite.bind_double(stmt, index, jsc.JSValueToNumber(ctx, value, nil))
	case .String:
		s, alloc := jsc_value_to_string_or_default(ctx, value)
		defer if alloc do delete(s, context.allocator)
		res = sqlite.bind_text(stmt, index, s)
	case .Object:
		if jsc.JSValueGetTypedArrayType(ctx, value, nil) != .None {
			bytes: []byte = nil
			if view, ok := typed_array_view(ctx, value); ok {
				bytes = view
			}
			res = sqlite.bind_blob(stmt, index, bytes)
		} else if exception != nil {
			exception^ = make_js_error(ctx, "unsupported SQLite bind value type")
		}
	case:
		if exception != nil do exception^ = make_js_error(ctx, "unsupported SQLite bind value type")
	}
	sqlite_throw_bind_error(ctx, res, exception)
	return jsc.JSValueMakeUndefined(ctx)
}

// sqlite_bind_bigint_cb(stmtId, index, decimalString): binds a JS BigInt as a
// 64-bit INTEGER (matching node:sqlite). The JS wrapper has already range-checked
// that the value fits in i64 and passes it as a decimal string, so the i64 parse
// here cannot overflow; a failed parse is treated defensively as a bind error.
sqlite_bind_bigint_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 3 {
		if exception != nil do exception^ = make_js_error(ctx, "sqlite bindBigInt requires handle, index and value")
		return jsc.JSValueMakeUndefined(ctx)
	}
	state := get_state_from_ctx(ctx)
	args := arguments[:int(argument_count)]
	stmt := sqlite_get_stmt(state, sqlite_arg_id(ctx, args[0]))
	if stmt == nil {
		if exception != nil do exception^ = make_js_error(ctx, "statement is not prepared")
		return jsc.JSValueMakeUndefined(ctx)
	}
	index := int(jsc.JSValueToNumber(ctx, args[1], nil))
	s, alloc := jsc_value_to_string_or_default(ctx, args[2])
	defer if alloc do delete(s, context.allocator)
	v, ok := strconv.parse_i64(s)
	if !ok {
		if exception != nil do exception^ = make_js_error(ctx, "invalid BigInt value")
		return jsc.JSValueMakeUndefined(ctx)
	}
	sqlite_throw_bind_error(ctx, sqlite.bind_int(stmt, index, v), exception)
	return jsc.JSValueMakeUndefined(ctx)
}

// sqlite_error builds the JS Error for a failure that came out of libsqlite3.
//
// Params:
//   message  SQLite's own text (errmsg/errstr), used verbatim as in Node.
// Returns:
//   An `Error` instance carrying `code` "ERR_SQLITE_ERROR".
// Node:
//   node:sqlite stamps ERR_SQLITE_ERROR on EVERY library-originated error — a bad
//   path in the constructor, a syntax error from exec/prepare, a constraint
//   violation surfaced from step, a rejected bind — verified against node 24
//   (`new DatabaseSync('/nonexistent/x.db')`, `db.exec('NOT SQL')`, a UNIQUE
//   violation). Only the bind path used to set it here, so the documented
//   `err.code === 'ERR_SQLITE_ERROR'` branch silently missed every other error.
//   Pinned by tests/std/sqlite/cases/08-coercion-parity.js.
//
// The plain "Error" constructor is the captured intrinsic (make_native_error), not
// globalThis.Error, so user code that patches the global cannot intercept it.
sqlite_error :: proc(ctx: jsc.JSContextRef, message: string) -> jsc.JSValueRef {
	return make_native_error(ctx, "Error", message, "ERR_SQLITE_ERROR")
}

// sqlite_throw_bind_error surfaces a failed bind (e.g. SQLITE_RANGE from an
// out-of-range index — how node:sqlite reports too many positional params) as a
// JS Error carrying SQLite's text and the ERR_SQLITE_ERROR code, instead of
// letting the statement execute with the slot silently unbound.
sqlite_throw_bind_error :: proc(
	ctx: jsc.JSContextRef,
	res: sqlite.Result,
	exception: ^jsc.JSValueRef,
) {
	if res.status == .Ok do return
	if exception == nil do return
	// Don't clobber a more specific exception already set by the caller.
	if exception^ != nil do return
	msg := len(res.message) > 0 ? res.message : "sqlite bind failed"
	exception^ = sqlite_error(ctx, msg)
}

// sqlite_step_cb(stmtId) -> 0 (row available) | 1 (done). Throws on error.
sqlite_step_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 do return jsc.JSValueMakeNumber(ctx, 1)
	state := get_state_from_ctx(ctx)
	id := sqlite_arg_id(ctx, arguments[0])
	stmt := sqlite_get_stmt(state, id)
	if stmt == nil {
		if exception != nil do exception^ = make_js_error(ctx, "statement is not prepared")
		return jsc.JSValueMakeNumber(ctx, 1)
	}
	switch sqlite.step(stmt) {
	case .Row:
		return jsc.JSValueMakeNumber(ctx, 0)
	case .Done:
		return jsc.JSValueMakeNumber(ctx, 1)
	case .Error:
		// The owning db id is passed as the 2nd arg so we can surface its errmsg.
		db := argument_count >= 2 ? sqlite_get_db(state, sqlite_arg_id(ctx, arguments[1])) : nil
		if exception != nil {
			msg := db != nil ? sqlite.errmsg(db, context.temp_allocator) : "sqlite step failed"
			if len(msg) == 0 do msg = "sqlite step failed"
			exception^ = sqlite_error(ctx, msg)
		}
		return jsc.JSValueMakeNumber(ctx, 1)
	}
	return jsc.JSValueMakeNumber(ctx, 1)
}

// sqlite_row_cb(stmtId) builds the current row as a { columnName: value } object,
// coercing each column to the matching JS type.
sqlite_row_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 do return jsc.JSValueMakeUndefined(ctx)
	state := get_state_from_ctx(ctx)
	stmt := sqlite_get_stmt(state, sqlite_arg_id(ctx, arguments[0]))
	if stmt == nil do return jsc.JSValueMakeUndefined(ctx)

	read_big_ints := sqlite_read_big_ints(ctx, argument_count, arguments, 1)
	row := jsc.JSObjectMake(ctx, nil, nil)
	count := sqlite.column_count(stmt)
	for i in 0 ..< count {
		name := sqlite.column_name(stmt, i)
		value: jsc.JSValueRef
		switch sqlite.column_type(stmt, i) {
		case .Integer:
			value = sqlite_int_value(ctx, sqlite.column_int(stmt, i), read_big_ints, exception)
			// An out-of-range INTEGER throws (ERR_OUT_OF_RANGE) — abandon the row.
			if exception != nil && exception^ != nil do return jsc.JSValueMakeUndefined(ctx)
		case .Float:
			value = jsc.JSValueMakeNumber(ctx, sqlite.column_double(stmt, i))
		case .Text:
			// SQLite TEXT may legally contain embedded NULs; build the JS string
			// from explicit bytes so it isn't truncated at the first NUL (which a
			// NUL-terminated cstring would do). column_text already returns the
			// full byte slice via sqlite3_column_bytes.
			value = js_string_from_bytes(ctx, sqlite.column_text(stmt, i))
		case .Blob:
			value = sqlite_blob_to_value(ctx, sqlite.column_blob(stmt, i))
		case .Null:
			value = jsc.JSValueMakeNull(ctx)
		}
		set_named(ctx, row, name, value)
	}
	return cast(jsc.JSValueRef)row
}

sqlite_changes_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 do return jsc.JSValueMakeNumber(ctx, 0)
	state := get_state_from_ctx(ctx)
	db := sqlite_get_db(state, sqlite_arg_id(ctx, arguments[0]))
	if db == nil do return jsc.JSValueMakeNumber(ctx, 0)
	read_big_ints := sqlite_read_big_ints(ctx, argument_count, arguments, 1)
	// Unsafe counts throw like a column read (node 26); see sqlite_int_value.
	return sqlite_int_value(ctx, sqlite.changes(db), read_big_ints, exception)
}

sqlite_last_insert_rowid_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 do return jsc.JSValueMakeNumber(ctx, 0)
	state := get_state_from_ctx(ctx)
	db := sqlite_get_db(state, sqlite_arg_id(ctx, arguments[0]))
	if db == nil do return jsc.JSValueMakeNumber(ctx, 0)
	read_big_ints := sqlite_read_big_ints(ctx, argument_count, arguments, 1)
	return sqlite_int_value(ctx, sqlite.last_insert_rowid(db), read_big_ints, exception)
}

// --- helpers ---

// SQLite stores INTEGER columns as i64; JS numbers are exact only up to 2^53-1.
SQLITE_MAX_SAFE_INTEGER :: i64(9007199254740991)

// sqlite_read_big_ints reads the optional readBigInts flag (the StatementSync's
// setReadBigInts() state) threaded as the trailing argument of row/changes/rowid.
sqlite_read_big_ints :: proc(
	ctx: jsc.JSContextRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	index: int,
) -> bool {
	if int(argument_count) <= index do return false
	// JSValueToBoolean is ABI-safe now that the binding returns a 1-byte `bool`
	// (the old `b32` return read undefined upper bytes, so a JS `false` came back
	// `true` — the historical "heisenbug" this once worked around with a
	// JSValueToNumber 0/1 hack). Pinned by cmd/lava jsc_value_predicates (#159).
	return jsc.JSValueToBoolean(ctx, arguments[index])
}

// sqlite_int_value converts an i64 column/rowid value to a JS value honoring the
// statement's readBigInts flag. With read_big_ints it returns a BigInt; otherwise
// a JS number, throwing ERR_OUT_OF_RANGE (like node:sqlite) when the value is not
// exactly representable. That includes run()'s changes/lastInsertRowid: node 26
// throws for them after the statement has run (the row stays written); node 24
// returned a lossy number. Pinned by tests/std/sqlite/cases/04-bigint.js.
sqlite_int_value :: proc(
	ctx: jsc.JSContextRef,
	v: i64,
	read_big_ints: bool,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	if read_big_ints do return sqlite_make_bigint(ctx, v)
	if (v > SQLITE_MAX_SAFE_INTEGER || v < -SQLITE_MAX_SAFE_INTEGER) {
		if exception != nil {
			msg := fmt.tprintf(
				"Value is too large to be represented as a JavaScript number: %d",
				v,
			)
			exception^ = make_native_error(ctx, "RangeError", msg, "ERR_OUT_OF_RANGE")
		}
		return jsc.JSValueMakeUndefined(ctx)
	}
	return jsc.JSValueMakeNumber(ctx, f64(v))
}

// sqlite_make_bigint builds a JS BigInt for an exact i64 by calling the global
// BigInt() with the decimal string (the JSC C API has no BigInt constructor).
sqlite_make_bigint :: proc(ctx: jsc.JSContextRef, v: i64) -> jsc.JSValueRef {
	s := fmt.tprintf("%d", v)
	global := jsc.JSContextGetGlobalObject(ctx)
	name := jsc.JSStringCreateWithUTF8CString("BigInt")
	defer jsc.JSStringRelease(name)
	fn := jsc.JSObjectGetProperty(ctx, global, name, nil)
	if !jsc.JSValueIsObject(ctx, fn) do return jsc.JSValueMakeNumber(ctx, f64(v))
	args := [1]jsc.JSValueRef{js_string_value(ctx, s)}
	result := jsc.JSObjectCallAsFunction(
		ctx,
		cast(jsc.JSObjectRef)fn,
		nil,
		1,
		raw_data(args[:]),
		nil,
	)
	if result == nil do return jsc.JSValueMakeNumber(ctx, f64(v))
	return result
}

// sqlite_error_text returns the live SQLite error string when available, falling
// back to the Result's static message. The returned string is freed before return
// (make_js_error copies it into the JS string).
sqlite_error_text :: proc(db: ^sqlite.Database, result: sqlite.Result) -> string {
	detail := sqlite.errmsg(db, context.temp_allocator)
	if len(detail) > 0 do return detail
	return result.message
}

sqlite_blob_to_value :: proc(ctx: jsc.JSContextRef, data: []byte) -> jsc.JSValueRef {
	// Copy into a buffer JSC owns (make_uint8_array frees it on collection);
	// sqlite's blob pointer is only valid until the next step/reset/finalize.
	buf := make([]byte, len(data), runtime.heap_allocator()) // freed by jsc_buffer_deallocator, on the heap
	if len(data) > 0 do copy(buf, data)
	return make_uint8_array(ctx, buf)
}
