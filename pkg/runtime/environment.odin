package lava_runtime

import "base:runtime"
import "core:c"
import "core:os"
import "core:path/filepath"
import "core:strings"
import "core:unicode/utf16"
import "core:unicode/utf8"
import jsc "lava:pkg/jsc"
import eventloop "lava:pkg/runtime/eventloop"

// Контекст для завантажувача модулів
Module_Context :: struct {
	filename: string,
	dirname:  string,
}

// Головна функція, яка налаштовує середовище під Node.js (Тепер приймає loop)
//
// `surface` (see Global_Surface, runtime.odin) decides what the entry script can
// name. Under `.Web` the CommonJS entry bindings — `__filename`, `__dirname`,
// `require`, `__lava_precache`, `module`, `exports` — are never injected, and the
// Node globals the bootstrap still needed are removed once install_globals is done.
// `.Node` takes exactly the path it took before the parameter existed.
setup_module_environment :: proc(
	ctx: jsc.JSContextRef,
	file_path: string,
	loop: ^eventloop.Loop,
	surface: Global_Surface = .Node,
) {
	global_obj := jsc.JSContextGetGlobalObject(ctx)

	if surface == .Node {
		// 1. Розраховуємо __filename та __dirname
		abs_path, _ := filepath.abs(file_path, context.temp_allocator)
		dir_path := filepath.dir(abs_path)

		// 2. Інжектуємо __filename та __dirname як глобальні змінні
		inject_global_string(ctx, global_obj, "__filename", abs_path)
		inject_global_string(ctx, global_obj, "__dirname", dir_path)
	}

	// 2.5. Встановлюємо глобальні об'єкти Node (console, process, таймери).
	// Вказівник на Event Loop живе у приватних даних global object, а не у JS.
	install_globals(ctx, loop, surface)

	if surface == .Web {
		// The LAST step before user code: nothing below this point runs on `.Web`,
		// and eval evaluates the entry next.
		remove_node_globals(ctx, global_obj)
		return
	}

	// 3. Інжектуємо функцію require
	req_name := jsc.JSStringCreateWithUTF8CString("require")
	defer jsc.JSStringRelease(req_name)

	req_func := jsc.JSObjectMakeFunctionWithCallback(ctx, req_name, native_require_cb)

	// Виправлено: явне приведення типов cast(jsc.JSValueRef)
	jsc.JSObjectSetProperty(ctx, global_obj, req_name, cast(jsc.JSValueRef)req_func, {}, nil)

	// Internal bridge the CommonJS wrapper calls to register an in-progress
	// module's exports before its body runs (see native_require_cb), so a
	// circular require resolves to the partial exports instead of recursing.
	inject_native_function(ctx, global_obj, "__lava_precache", module_precache_cb)

	// 4. Створюємо та інжектуємо об'єкт module та module.children
	module_obj := jsc.JSObjectMake(ctx, nil, nil)
	children_arr := jsc.JSObjectMake(ctx, nil, nil)

	child_len_name := jsc.JSStringCreateWithUTF8CString("length")
	defer jsc.JSStringRelease(child_len_name)
	jsc.JSObjectSetProperty(ctx, children_arr, child_len_name, jsc.JSValueMakeNumber(ctx, 1), {}, nil)

	module_name := jsc.JSStringCreateWithUTF8CString("module")
	children_name := jsc.JSStringCreateWithUTF8CString("children")
	exports_name := jsc.JSStringCreateWithUTF8CString("exports")
	defer jsc.JSStringRelease(module_name)
	defer jsc.JSStringRelease(children_name)
	defer jsc.JSStringRelease(exports_name)

	// Виправлено: додано касти до JSValueRef для властивостей об'єкта
	jsc.JSObjectSetProperty(ctx, module_obj, children_name, cast(jsc.JSValueRef)children_arr, {}, nil)

	// Initialize module.exports = {} (and the `exports` alias) so the entry can do
	// `module.exports.foo = …` / `exports.foo = …` without first reassigning
	// module.exports, matching Node's CommonJS entry — the per-module wrapper does
	// the same for required modules. Without this, `module.exports` is undefined on
	// the entry and the partial-exports cache (register_entry_module) has nothing
	// to register.
	exports_obj := jsc.JSObjectMake(ctx, nil, nil)
	jsc.JSObjectSetProperty(ctx, module_obj, exports_name, cast(jsc.JSValueRef)exports_obj, {}, nil)

	jsc.JSObjectSetProperty(ctx, global_obj, module_name, cast(jsc.JSValueRef)module_obj, {}, nil)
	jsc.JSObjectSetProperty(ctx, global_obj, exports_name, cast(jsc.JSValueRef)exports_obj, {}, nil)
}

// WEB_REMOVED_GLOBALS are the Node globals install_globals puts on every context and
// `.Web` takes back off. Each one is needed while the bootstrap runs, which is why
// they are removed rather than never installed: the loader hands `process` to
// node:process, microtasks.js installs `process.nextTick` on it, and the eager
// modules capture at module-eval (blob.js fixes its EOL from process.platform,
// buffer.js publishes `Buffer`). The scheduler and the native drain never read them
// back off the global (Runtime_State.dispatch_fn / next_tick_drain), so removing
// them leaves timers and microtasks working.
@(private = "file")
WEB_REMOVED_GLOBALS :: [?]cstring{"process", "Buffer", "setImmediate", "clearImmediate", "global"}

// remove_node_globals deletes WEB_REMOVED_GLOBALS from the global object. All of
// them are plain configurable properties (set_named / inject_native_function pass no
// attributes; buffer.js assigns), so the delete cannot be refused. Deleting from the
// global object can move it to JSC's dictionary mode — a cost `.Web` alone pays,
// once per context; `.Node` never calls this.
@(private = "file")
remove_node_globals :: proc(ctx: jsc.JSContextRef, global_obj: jsc.JSObjectRef) {
	for name in WEB_REMOVED_GLOBALS {
		js_name := jsc.JSStringCreateWithUTF8CString(name)
		jsc.JSObjectDeleteProperty(ctx, global_obj, js_name, nil)
		jsc.JSStringRelease(js_name)
	}
}

inject_global_string :: proc(ctx: jsc.JSContextRef, global_obj: jsc.JSObjectRef, name: string, value: string) {
	c_name, c_name_err := strings.clone_to_cstring(name, context.temp_allocator)
	if c_name_err != nil do return
	c_value, c_value_err := strings.clone_to_cstring(value, context.temp_allocator)
	if c_value_err != nil do return

	js_name := jsc.JSStringCreateWithUTF8CString(c_name)
	js_val_str := jsc.JSStringCreateWithUTF8CString(c_value)
	defer jsc.JSStringRelease(js_name)
	defer jsc.JSStringRelease(js_val_str)

	js_val := jsc.JSValueMakeString(ctx, js_val_str)
	jsc.JSObjectSetProperty(ctx, global_obj, js_name, js_val, {}, nil)
}

// node:path is implemented in JavaScript (js/node/path.js) so the POSIX and
// Windows normalize/resolve/relative semantics match Node exactly; it is wired
// through the internal-module loader like the other built-ins.


// resolve_module_path resolves a `specifier` to a real file path, modeling Node's

eval_source_value :: proc(
	ctx: jsc.JSContextRef,
	source, source_name: string,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	script := js_string_from_string(source)
	if script == nil do return jsc.JSValueMakeUndefined(ctx)
	defer jsc.JSStringRelease(script)

	source_url := js_string_from_string(source_name)
	defer if source_url != nil do jsc.JSStringRelease(source_url)

	child_exception: jsc.JSValueRef
	value := jsc.JSEvaluateScript(ctx, script, nil, source_url, 1, &child_exception)
	if child_exception != nil && exception != nil {
		exception^ = child_exception
	}
	if value == nil do return jsc.JSValueMakeUndefined(ctx)
	return value
}

// esm_wrap_source rewrites an ES module `source` (resolved at `filename`) into a
// self-contained CommonJS expression by calling js/bootstrap/esm.js. The returned
// string is allocated in context.allocator and must be freed by the caller. On
// failure it sets `exception` (when non-nil) and returns ("", false).
esm_wrap_source :: proc(
	ctx: jsc.JSContextRef,
	source, filename: string,
	exception: ^jsc.JSValueRef,
) -> (
	string,
	bool,
) {
	state := get_state_from_ctx(ctx)
	if state == nil || state.esm_transform == nil {
		if exception != nil {
			exception^ = make_js_error(ctx, "ESM transform unavailable")
		}
		return "", false
	}

	abs_path, abs_err := filepath.abs(filename, context.temp_allocator)
	if abs_err != os.ERROR_NONE {
		// Fall back to the path as given when abs resolution fails.
		abs_path = filename
	}
	dir := filepath.dir(abs_path)
	url := esm_file_url(abs_path)

	args := [4]jsc.JSValueRef {
		js_string_value(ctx, source),
		js_string_value(ctx, url),
		js_string_value(ctx, abs_path),
		js_string_value(ctx, dir),
	}
	call_exception: jsc.JSValueRef
	result := jsc.JSObjectCallAsFunction(
		ctx,
		cast(jsc.JSObjectRef)state.esm_transform,
		nil,
		4,
		raw_data(args[:]),
		&call_exception,
	)
	if call_exception != nil {
		if exception != nil do exception^ = call_exception
		return "", false
	}

	wrapped, allocated := jsc_value_to_string_or_default(ctx, result)
	if !allocated {
		if exception != nil {
			exception^ = make_js_error(ctx, "ESM transform produced no output")
		}
		return "", false
	}
	return wrapped, true
}

// esm_file_url builds the `file://` URL exposed to a module as import.meta.url.
esm_file_url :: proc(abs_path: string) -> string {
	when ODIN_OS == .Windows {
		slashed, _ := strings.replace_all(abs_path, "\\", "/", context.temp_allocator)
		parts := [?]string{"file:///", slashed}
		result, err := strings.concatenate(parts[:], context.temp_allocator)
		if err != nil do return abs_path
		return result
	} else {
		parts := [?]string{"file://", abs_path}
		result, err := strings.concatenate(parts[:], context.temp_allocator)
		if err != nil do return abs_path
		return result
	}
}

// js_quote renders `value` as a double-quoted JS/JSON string literal, escaping
// every character that would otherwise change the literal's meaning. The CJS
// module wrapper splices resolved paths (__filename, __dirname, the precache key,
// the require base) through this, so unescaped input would corrupt or break the
// generated source: a Windows drive path's backslashes ("C:\utils") read as
// string escapes (an invalid \u → SyntaxError for the whole module), and a path
// component containing a quote or newline (legal on POSIX) terminates the literal
// early and injects into the module text. Equivalent to JSON.stringify of a
// string (which is what esm.js uses for the same job).
js_quote :: proc(value: string) -> string {
	b := strings.builder_make(context.temp_allocator)
	strings.write_byte(&b, '"')
	for i := 0; i < len(value); i += 1 {
		c := value[i]
		switch c {
		case '"':
			strings.write_string(&b, "\\\"")
		case '\\':
			strings.write_string(&b, "\\\\")
		case '\b':
			strings.write_string(&b, "\\b")
		case '\f':
			strings.write_string(&b, "\\f")
		case '\n':
			strings.write_string(&b, "\\n")
		case '\r':
			strings.write_string(&b, "\\r")
		case '\t':
			strings.write_string(&b, "\\t")
		case:
			if c < 0x20 {
				// Other control characters as \u00XX (JSON requires escaping these).
				strings.write_string(&b, "\\u00")
				hex := "0123456789abcdef"
				strings.write_byte(&b, hex[(c >> 4) & 0xf])
				strings.write_byte(&b, hex[c & 0xf])
			} else {
				// Pass bytes >= 0x20 through verbatim (UTF-8 stays intact).
				strings.write_byte(&b, c)
			}
		}
	}
	strings.write_byte(&b, '"')
	return strings.to_string(b)
}

// register_entry_module caches the entry module's exports under its resolved
// absolute path, so a module that require()s the entry by path gets the same
// instance instead of re-executing the entry's top level (and an entry-involved
// require cycle terminates). The .mjs entry registers itself via __lava_precache
// in its transformed body; this covers the CommonJS/script entry, whose body runs
// raw against the global `module`. Call it before evaluating the entry (so a cycle
// sees the partial exports, like Node) and again after (the body may reassign
// module.exports).
register_entry_module :: proc(ctx: jsc.JSContextRef, state: ^Runtime_State, source_name: string) {
	if state == nil do return
	abs_path, abs_err := filepath.abs(source_name, context.temp_allocator)
	if abs_err != os.ERROR_NONE || len(abs_path) == 0 do return

	global_obj := jsc.JSContextGetGlobalObject(ctx)
	mod_name := jsc.JSStringCreateWithUTF8CString("module")
	defer jsc.JSStringRelease(mod_name)
	mod_val := jsc.JSObjectGetProperty(ctx, global_obj, mod_name, nil)
	if !jsc.JSValueIsObject(ctx, mod_val) do return

	exp_name := jsc.JSStringCreateWithUTF8CString("exports")
	defer jsc.JSStringRelease(exp_name)
	exports := jsc.JSObjectGetProperty(ctx, cast(jsc.JSObjectRef)mod_val, exp_name, nil)
	if exports == nil do return

	module_cache_set(ctx, state, abs_path, exports)
}

js_string_value :: proc(ctx: jsc.JSContextRef, value: string) -> jsc.JSValueRef {
	// NUL-free ASCII (the overwhelming bridge case: property names, headers,
	// paths) is copied straight into 8-bit string storage with no UTF-8
	// validation pass. NULs stay excluded so the fast path can never differ from
	// the fallback's documented truncate-at-NUL behavior.
	if len(value) > 0 && bytes_all_ascii_no_nul(transmute([]byte)value) {
		if str, dst, ok := jsc.string_alloc8(len(value)); ok {
			copy(dst, value)
			defer jsc.JSStringRelease(str)
			return jsc.JSValueMakeString(ctx, str)
		}
	}

	c_value, err := strings.clone_to_cstring(value, context.temp_allocator)
	if err != nil do return jsc.JSValueMakeUndefined(ctx)

	js_str := jsc.JSStringCreateWithUTF8CString(c_value)
	defer jsc.JSStringRelease(js_str)

	return jsc.JSValueMakeString(ctx, js_str)
}

// js_string_from_bytes builds a JS string from raw UTF-8 bytes that may contain
// embedded NULs, by converting to UTF-16 and passing an explicit length. Unlike
// js_string_value (which routes through a NUL-terminated cstring and so truncates
// at the first 0x00), this preserves the full content — needed for SQLite TEXT,
// where a NUL is a legal byte.
js_string_from_bytes :: proc(ctx: jsc.JSContextRef, value: string) -> jsc.JSValueRef {
	if len(value) == 0 do return js_string_value(ctx, "")
	// ASCII (NULs included — this builder's contract preserves them) copies
	// straight into 8-bit string storage.
	if bytes_all_ascii(transmute([]byte)value) {
		if str, dst, ok := jsc.string_alloc8(len(value)); ok {
			copy(dst, value)
			defer jsc.JSStringRelease(str)
			return jsc.JSValueMakeString(ctx, str)
		}
	}
	runes := utf8.string_to_runes(value, context.temp_allocator)
	// Each rune is at most two UTF-16 code units (a surrogate pair).
	units := make([]u16, len(runes) * 2, context.temp_allocator)
	n := utf16.encode(units, runes)
	js_str := jsc.JSStringCreateWithCharacters(raw_data(units), c.size_t(n))
	defer jsc.JSStringRelease(js_str)
	return jsc.JSValueMakeString(ctx, js_str)
}

// --- JS string → owned UTF-8 (exact size) ------------------------------------
// Pure codecs live in pkg/jsc/string_utf8.odin; these wrappers allocate.

js_string_ref_to_utf8_owned :: proc(js_string: jsc.JSStringRef) -> (string, bool) {
	if js_string == nil do return "", false
	length := int(jsc.JSStringGetLength(js_string))
	if length == 0 do return "", false

	// 8-bit storage read directly (GetCharactersPtr would widen the whole string
	// to UTF-16 first).
	if s8, ok8 := jsc.string_chars8(js_string); ok8 {
		return latin1_to_utf8_owned(s8)
	}

	chars := jsc.JSStringGetCharactersPtr(js_string)
	if chars == nil do return "", false
	return utf16_to_utf8_owned(chars, length)
}

// latin1_to_utf8_owned copies 8-bit string storage into an owned exact-size
// UTF-8 buffer: ASCII verbatim, Latin-1 high bytes as two UTF-8 bytes each.
@(private = "file")
latin1_to_utf8_owned :: proc(s8: []byte) -> (string, bool) {
	if bytes_all_ascii(s8) {
		buffer := make([]byte, len(s8), context.allocator)
		copy(buffer, s8)
		return string(buffer), true
	}
	n := len(s8)
	for b in s8 {
		if b >= 0x80 do n += 1
	}
	buffer := make([]byte, n, context.allocator)
	o := 0
	for b in s8 {
		if b < 0x80 {
			buffer[o] = b
			o += 1
		} else {
			buffer[o] = 0xC0 | (b >> 6)
			buffer[o + 1] = 0x80 | (b & 0x3F)
			o += 2
		}
	}
	return string(buffer), true
}

@(private = "file")
utf16_to_utf8_owned :: proc(chars: [^]jsc.JSChar, length: int) -> (string, bool) {
	// Fast path: pure ASCII (paths, headers, small identifiers). Exact-size copy.
	ascii := true
	for i in 0 ..< length {
		if chars[i] >= 0x80 {
			ascii = false
			break
		}
	}
	if ascii {
		buffer := make([]byte, length, context.allocator)
		for i in 0 ..< length do buffer[i] = byte(chars[i])
		return string(buffer), true
	}

	n := jsc.utf16_js_utf8_byte_len(chars, length)
	if n <= 0 do return "", false
	buffer := make([]byte, n, context.allocator)
	// Exact-size buffer: the capped writer never truncates here (need always
	// fits), so it yields the same bytes as an uncapped encode.
	written := jsc.utf16_js_to_utf8_capped(chars, length, buffer)
	if written != n {
		delete(buffer, context.allocator)
		return "", false
	}
	return string(buffer), true
}

// jsc_value_to_string_or_default converts a JS value to an owned UTF-8 Odin string
// (caller's allocator). Returns ("", false) for empty / non-convertible values —
// callers treat false as "empty string, no free". Exact UTF-8 size (no 3n+1).
jsc_value_to_string_or_default :: proc(ctx: jsc.JSContextRef, value: jsc.JSValueRef) -> (string, bool) {
	// Flat string values resolve with no C-API call; everything else (ropes,
	// non-strings needing coercion) goes through JSValueToStringCopy.
	if s8, ok := jsc.value_chars8(ctx, value); ok {
		if len(s8) == 0 do return "", false
		return latin1_to_utf8_owned(s8)
	}
	if s16, ok := jsc.value_chars16(ctx, value); ok {
		if len(s16) == 0 do return "", false
		return utf16_to_utf8_owned(raw_data(s16), len(s16))
	}

	js_string := jsc.JSValueToStringCopy(ctx, value, nil)
	if js_string == nil do return "", false
	defer jsc.JSStringRelease(js_string)
	return js_string_ref_to_utf8_owned(js_string)
}
