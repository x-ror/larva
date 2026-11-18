package lava_runtime

import "base:runtime"
import "core:c"
import "core:fmt"
import "core:os"
import "core:path/filepath"
import "core:strings"
import jsc "lava:pkg/jsc"

noop_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	return jsc.JSValueMakeUndefined(ctx)
}

// module_precache_cb implements the global __lava_precache(resolvedPath, exports)
// the CommonJS wrapper invokes before running a module body. It registers the
// module's (initially empty) exports in the cache so a require() cycle that
// re-enters this module gets the partial exports instead of recursing forever.
// native_require_cb overwrites the entry with the final exports after the body
// runs (handling module.exports reassignment).
module_precache_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 2 do return jsc.JSValueMakeUndefined(ctx)
	state := get_state_from_ctx(ctx)
	if state == nil do return jsc.JSValueMakeUndefined(ctx)
	path, allocated := jsc_value_to_string_or_default(ctx, arguments[0])
	defer if allocated do delete(path, context.allocator)
	if !allocated do return jsc.JSValueMakeUndefined(ctx)
	module_cache_set(ctx, state, path, arguments[1])
	return jsc.JSValueMakeUndefined(ctx)
}

native_require_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	// All the path/wrapper scratch in this call is temporary; reclaim it on exit
	// instead of letting the per-thread arena grow unbounded across requires.
	defer free_all(context.temp_allocator)
	if argument_count < 1 do return jsc.JSValueMakeUndefined(ctx)

	state := get_state_from_ctx(ctx)

	args := arguments[:int(argument_count)]
	specifier, alloc := jsc_value_to_string_or_default(ctx, args[0])
	defer if alloc do delete(specifier, context.allocator)

	// Module cache: a previously-loaded module (by specifier or resolved path)
	// returns its existing exports so top-level code runs exactly once.
	if cached, ok := module_cache_get(state, specifier); ok {
		return cached
	}

	// 0. JS-implemented built-ins (util, events, assert, buffer, and their
	// node:-prefixed / assert-strict aliases). The resolver returns undefined
	// for anything it does not own, so we fall through to the native builtins
	// and the filesystem below.
	builtin_exception: jsc.JSValueRef
	if builtin := require_builtin(ctx, args[0], &builtin_exception); builtin != nil {
		module_cache_put(ctx, state, specifier, builtin)
		return builtin
	} else if builtin_exception != nil {
		if exception != nil do exception^ = builtin_exception
		return jsc.JSValueMakeUndefined(ctx)
	}

	// node:path is served by the JS internal-module loader above (require_builtin).

	// node:fs is served by the JS internal-module loader above (require_builtin), like
	// node:path — js/node/fs.js wraps the Odin primitives from make_fs_bindings. It
	// used to be assembled here instead, the one built-in with no JS layer, and that is
	// what let fs.readFileSync return a bare Uint8Array where node returns a Buffer for a
	// year (issue #329). Nothing may rebuild it here: require_builtin runs FIRST, so a
	// second construction would be dead code that silently disagrees with the live one.

	// Relative specifiers resolve against the requiring module's own directory,
	// which its bound require passes as args[1] (see the wrapper in the .cjs/.js
	// and .mjs branches). The entry's global require has no such argument and
	// falls back to the global __dirname. Because the directory is captured in the
	// module's require closure — not read from a call stack — a deferred/async
	// require resolves identically to a synchronous one.
	base_dir: string
	base_dir_alloc: bool
	if len(args) >= 2 && jsc.JSValueIsString(ctx, args[1]) {
		base_dir, base_dir_alloc = jsc_value_to_string_or_default(ctx, args[1])
	} else {
		base_dir, base_dir_alloc = global_dirname(ctx)
	}
	defer if base_dir_alloc do delete(base_dir, context.allocator)

	resolved, resolved_ok := resolve_module_path(specifier, base_dir)
	if !resolved_ok {
		// Node throws MODULE_NOT_FOUND rather than silently yielding undefined.
		if exception != nil {
			exception^ = make_module_not_found(ctx, specifier)
		}
		return jsc.JSValueMakeUndefined(ctx)
	}
	defer delete(resolved, context.allocator)

	if cached, ok := module_cache_get(state, resolved); ok {
		return cached
	}

	if strings.has_suffix(resolved, ".json") {
		data, err := os.read_entire_file(resolved, context.allocator)
		if err != os.ERROR_NONE {
			if exception != nil {
				exception^ = make_js_error(ctx, fmt.tprintf("Cannot read module '%s'", resolved))
			}
			return jsc.JSValueMakeUndefined(ctx)
		}
		defer delete(data, context.allocator)

		// Parse as JSON (Node uses JSON.parse), NOT JSEvaluateScript — wrapping the
		// file in (...) and evaluating it would execute arbitrary code from a .json
		// file and accept non-JSON. JSValueMakeFromJSONString returns null on a
		// malformed document, which we surface as a SyntaxError like Node.
		json_str := js_string_from_string(string(data))
		if json_str == nil do return jsc.JSValueMakeUndefined(ctx)
		defer jsc.JSStringRelease(json_str)
		value := jsc.JSValueMakeFromJSONString(ctx, json_str)
		if value == nil {
			if exception != nil {
				exception^ = make_js_named_error(
					ctx,
					"SyntaxError",
					fmt.tprintf("Unexpected token in JSON in %s", resolved),
				)
			}
			return jsc.JSValueMakeUndefined(ctx)
		}
		module_cache_put(ctx, state, resolved, value)
		return value
	}

	if strings.has_suffix(resolved, ".mjs") {
		data, err := os.read_entire_file(resolved, context.allocator)
		if err != os.ERROR_NONE {
			if exception != nil {
				exception^ = make_js_error(ctx, fmt.tprintf("Cannot read module '%s'", resolved))
			}
			return jsc.JSValueMakeUndefined(ctx)
		}
		defer delete(data, context.allocator)

		wrapped, wrap_ok := esm_wrap_source(ctx, string(data), resolved, exception)
		if !wrap_ok do return jsc.JSValueMakeUndefined(ctx)
		defer delete(wrapped, context.allocator)

		value := eval_source_value(ctx, wrapped, resolved, exception)
		if exception == nil || exception^ == nil {
			module_cache_put(ctx, state, resolved, value)
		} else {
			// The ESM wrapper calls __lava_precache BEFORE the body runs (so an
			// import cycle resolves), so a body that throws leaves an empty partial
			// namespace in the cache. Drop it — exactly as the CommonJS path below
			// does — so a later import re-runs the module instead of silently
			// succeeding with broken (empty) exports.
			module_cache_remove(ctx, state, resolved)
		}
		return value
	}

	if strings.has_suffix(resolved, ".cjs") || strings.has_suffix(resolved, ".js") {
		data, err := os.read_entire_file(resolved, context.allocator)
		if err != os.ERROR_NONE {
			if exception != nil {
				exception^ = make_js_error(ctx, fmt.tprintf("Cannot read module '%s'", resolved))
			}
			return jsc.JSValueMakeUndefined(ctx)
		}
		defer delete(data, context.allocator)

		dirname := filepath.dir(resolved)
		// __lava_precache registers this module's exports in the cache BEFORE the
		// body runs, so a circular require() that re-enters this module gets the
		// partial exports instead of recursing forever (then we overwrite with the
		// final exports below). The wrapper prefix must NOT end with a newline: the
		// module body has to start on line 1 so JSEvaluateScript (startingLineNumber
		// 1) reports the user's own source lines in stack traces, not a
		// wrapper-shifted line. (Matches Node's Module.wrap, whose prefix ends "{ ".)
		// The module body receives a `require` bound to this module's directory
		// (function(s){return require(s, dirname)}) — captured in its closure, so a
		// deferred/async require resolves against this module's dir, not the entry's.
		wrapper_parts := [?]string {
			"(function(){var module={exports:{},children:[]};var exports=module.exports;__lava_precache(",
			js_quote(resolved),
			",module.exports);(function(exports,require,module,__filename,__dirname){ ",
			string(data),
			"\n})(exports,function(s){return require(s,",
			js_quote(dirname),
			");},module,",
			js_quote(resolved),
			",",
			js_quote(dirname),
			");return module.exports;})()",
		}
		wrapped, wrapped_err := strings.concatenate(wrapper_parts[:], context.temp_allocator)
		if wrapped_err != nil do return jsc.JSValueMakeUndefined(ctx)

		value := eval_source_value(ctx, wrapped, resolved, exception)
		if exception == nil || exception^ == nil {
			// Overwrite the pre-registered partial entry with the final exports
			// (the body may have reassigned module.exports).
			module_cache_set(ctx, state, resolved, value)
		} else {
			// Module threw while loading: drop the partial so a later require
			// re-loads it rather than getting half-initialised exports.
			module_cache_remove(ctx, state, resolved)
		}
		return value
	}

	// A resolved path with an extension we don't load as a module (or any other
	// fall-through) must not silently yield undefined — Node throws
	// MODULE_NOT_FOUND, and the project guarantees the same.
	if exception != nil {
		exception^ = make_module_not_found(ctx, specifier)
	}
	return jsc.JSValueMakeUndefined(ctx)
}

// make_module_not_found builds the Error Node throws for an unresolved require,
// including the `code: 'MODULE_NOT_FOUND'` property user code commonly checks.
make_module_not_found :: proc(ctx: jsc.JSContextRef, specifier: string) -> jsc.JSValueRef {
	return make_native_error(ctx, "Error", fmt.tprintf("Cannot find module '%s'", specifier), "MODULE_NOT_FOUND")
}

// inject_native_function attaches a native function to `object`, preferring
// JSC's internal host-call convention (no per-call lock drop or argument
// re-marshaling): an explicitly supplied `host` wrapper is used directly;
// otherwise the callback goes through the generic callee-keyed trampoline
// (host_natives.odin), which also caches — repeated injections of the same
// callback (fs.Stats methods, per-instance handles) share one function object.
// When the host path is unavailable the portable C-API callback is used.
// `arity` is the function's `.length`. It defaults to 1 because that is right for
// almost every `native.*` binding, which JS-internal code reaches through the
// factory's fourth argument where `.length` is unobservable. It matters for the
// few natives injected onto globalThis (setTimeout & co, globals.odin), where
// `.length` IS user-visible and Node is the oracle.
//
// THE TWO CREATION PATHS ARE NOT OBSERVABLY EQUIVALENT, which earlier comments
// left the reader to assume. Measured on setTimeout (2026-07-28; node row re-probed
// 2026-11-16):
//
//	host path (jsc.host_function_create): .length == arity, constructible
//	C-API fallback:                       .length == 0,     `new` throws TypeError
//	node 26.13.0:                         .length == 2,     constructible
//
// "Constructible" on the host path is itself only half of Node: create_raw
// reuses the call callback as the constructor slot, so `new setTimeout(fn)`
// evaluates to the CALL result — undefined, where Node (like any ordinary
// function) yields an object. Nothing observed in the wild constructs timers;
// recorded and pinned (host_native_construct_returns_call_result,
// cmd/lava/host_native_registry_test.odin), not repaired.
//
// Neither difference is repairable from the public C API. JSObjectSetProperty
// routes through defineOwnProperty only when the property is ABSENT, and it tests
// that with hasProperty, which walks the prototype chain — `length` is inherited
// from Function.prototype, so the call always degrades to a [[Set]] against a
// writable:false slot and silently no-ops (deleting the own copy first does not
// help, for the same reason). Fixing it needs a JS-level defineProperty, i.e.
// evaluating script during global installation, which is not worth it for a path
// taken only when the private ABI is missing.
//
// So the divergence is pinned instead of papered over:
// tests/node-compat/cases/56-native-function-arity.js asserts Node's arities in
// the DEFAULT configuration. A JSC upgrade that renamed the mangled symbol
// pkg/jsc dlsyms silently demotes every native to the fallback — that case is
// what turns it into a loud failure rather than a `.length` that quietly became 0.
inject_native_function :: proc(
	ctx: jsc.JSContextRef,
	object: jsc.JSObjectRef,
	name: string,
	callback: jsc.JSObjectCallAsFunctionCallback,
	host: jsc.Host_Function_Proc = nil,
	arity: int = 1,
) {
	c_name, err := strings.clone_to_cstring(name, context.temp_allocator)
	if err != nil do return

	js_name := jsc.JSStringCreateWithUTF8CString(c_name)
	defer jsc.JSStringRelease(js_name)

	fn: jsc.JSObjectRef
	if host != nil {
		fn, _ = jsc.host_function_create(ctx, name, host, arity)
	} else {
		fn = host_native_create(ctx, name, callback, arity)
	}
	if fn == nil {
		fn = jsc.JSObjectMakeFunctionWithCallback(ctx, js_name, callback)
	}
	jsc.JSObjectSetProperty(ctx, object, js_name, cast(jsc.JSValueRef)fn, {}, nil)
}

// resolve_module_path resolves a relative or absolute `specifier` to a real file
// path. Relative specifiers resolve against `base_dir` — the requiring module's
// own directory, supplied by its bound require (see native_require_cb) — so a
// deferred/async require resolves the same as a synchronous one.
