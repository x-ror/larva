#+build linux, darwin
package main

import "core:strings"
import "core:testing"
import jsc "lava:pkg/jsc"
import lava "lava:pkg/runtime"

// Pins compile-on-first-require for the embedded builtin factories
// (install_internal_modules / builtin_compile_cb, globals.odin): context init
// compiles only what the loader's eager list pulls in, a lazy builtin's source is
// evaluated by its first require and by nothing else, and the loader's instance
// cache keeps a second require from compiling it again. Lava-only: how many
// JSEvaluateScript calls happen before user code is not something Node exposes.
// Runtime_State.builtin_compiles is the observable; it counts successful compiles.
//
// Built by hand rather than through lava.eval so the state outlives each script and
// the counter can be read between them. Scoped linux+darwin, where JSC links.
@(test)
builtin_factories_compile_on_first_require :: proc(t: ^testing.T) {
	jsc.lava_jsc_init()
	gclass := lava.make_global_class()
	gctx := jsc.JSGlobalContextCreate(gclass)
	testing.expect(t, gctx != nil, "could not create a JSC global context")
	if gctx == nil {
		jsc.JSClassRelease(gclass)
		return
	}
	defer jsc.JSClassRelease(gclass)
	defer jsc.JSGlobalContextRelease(gctx)
	ctx := cast(jsc.JSContextRef)gctx

	state := lava.new_runtime_state(nil)
	jsc.JSObjectSetPrivate(jsc.JSContextGetGlobalObject(ctx), cast(rawptr)state)
	defer lava.destroy_runtime_state(ctx, state)
	lava.capture_error_intrinsics(ctx, state)
	jsc.prime_view_probe(ctx)
	lava.setup_module_environment(ctx, "<lazy-builtins-test>", nil)
	defer free_all(context.temp_allocator)

	embedded := 0
	for dir in lava.EMBEDDED_JS_DIRS {
		for file in dir.files {
			if strings.has_suffix(file.name, ".js") do embedded += 1
		}
	}

	// The eager closure (primordials, buffer, stream/web, fetch, …, plus stdio and
	// stream from installStdio) is well under the whole table. Eager compilation
	// compiles every file and fails the upper bound.
	at_init := state.builtin_compiles
	testing.expectf(t, at_init > 0, "nothing compiled at init — the eager list did not run")
	testing.expectf(
		t,
		at_init < embedded,
		"init compiled %d of %d embedded modules — factories are still compiled eagerly",
		at_init,
		embedded,
	)

	// node:os is outside the eager closure and its only requires (primordials,
	// buffer through require.pristineBuffer) are eager, so its first require
	// compiles exactly one factory: its own.
	testing.expect(t, run_bool(ctx, "typeof require('node:os').platform() === 'string'"), "node:os did not load")
	testing.expect_value(t, state.builtin_compiles, at_init + 1)

	// Cached by the loader: a second require compiles nothing.
	testing.expect(t, run_bool(ctx, "require('os') === require('node:os')"), "node:os was re-instantiated")
	testing.expect_value(t, state.builtin_compiles, at_init + 1)

	// Ids outside the embedded set stay unknown, compile nothing, and never reach
	// an inherited property or a path outside js/.
	UNKNOWN :: `(function () {
  var ids = ['node:constructor', 'node:__proto__', 'node:', 'node:../globals', 'node:internal/primordials', 'node:node/os'];
  for (var i = 0; i < ids.length; i++) {
    try { require(ids[i]); return false; } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') return false; }
  }
  return true;
})()`
	testing.expect(t, run_bool(ctx, UNKNOWN), "an id outside the embedded set resolved")
	testing.expect_value(t, state.builtin_compiles, at_init + 1)
}

@(private = "file")
run_bool :: proc(ctx: jsc.JSContextRef, src: string) -> bool {
	c_src := strings.clone_to_cstring(src, context.temp_allocator)
	script := jsc.JSStringCreateWithUTF8CString(c_src)
	defer jsc.JSStringRelease(script)
	exception: jsc.JSValueRef
	value := jsc.JSEvaluateScript(ctx, script, nil, nil, 1, &exception)
	if exception != nil do return false
	return jsc.JSValueToBoolean(ctx, value)
}
