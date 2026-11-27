package lava_runtime

import "base:runtime"
import "core:c"
import jsc "lava:pkg/jsc"
import profile "lava:pkg/profile"

// make_location_bindings returns internal/location's natives: `url`, the page's URL as
// the embedder gave it (`lava run --origin=`, a URL or an origin; "" when none was
// given). internal/location parses it, so a value that is not a URL makes the page
// about:blank there rather than here.
//
// And `loading()`, true while the page's top-level script runs (Runtime_State
// top_script_running): HTML's "not completely loaded", during which a fragment
// navigation replaces the session entry rather than adding one. Larva fires no load
// event, so the end of the top-level script stands in for it. A microtask queued from
// the module would not do: JSC drains it when the loader's call returns, before the
// page's script starts. Cold: one call per Location-object navigation, so the generic
// host path.
make_location_bindings :: proc(ctx: jsc.JSContextRef, page_url: string) -> jsc.JSObjectRef {
	bindings := jsc.JSObjectMake(ctx, nil, nil)
	set_named(ctx, bindings, "url", js_string_value(ctx, page_url))
	inject_native_function(ctx, bindings, "loading", location_loading_cb, arity = 0, constructible = false)
	return bindings
}

// make_navigator_bindings returns internal/navigator's natives: the client profile's
// JS-visible values (pkg/profile), flattened to plain data. The same table supplies the
// User-Agent pkg/http sends, so the header and navigator.userAgent cannot disagree.
// Copied into JS values once per page; nothing here outlives the call.
make_navigator_bindings :: proc(ctx: jsc.JSContextRef, p: ^profile.Client_Profile) -> jsc.JSObjectRef {
	bindings := jsc.JSObjectMake(ctx, nil, nil)
	set_named(ctx, bindings, "userAgent", js_string_value(ctx, p.user_agent))
	set_named(ctx, bindings, "platform", js_string_value(ctx, p.platform))
	set_named(ctx, bindings, "vendor", js_string_value(ctx, p.vendor))

	// A handful of short strings: a fixed buffer rather than an allocation.
	langs: [8]jsc.JSValueRef
	n := min(len(p.languages), len(langs))

	for i in 0 ..< n {
		langs[i] = js_string_value(ctx, p.languages[i])
	}

	set_named(ctx, bindings, "languages", cast(jsc.JSValueRef)jsc.JSObjectMakeArray(ctx, c.size_t(n), &langs[0], nil))

	set_number(ctx, bindings, "hardwareConcurrency", f64(p.hardware_concurrency))
	set_number(ctx, bindings, "deviceMemory", p.device_memory)
	set_number(ctx, bindings, "maxTouchPoints", f64(p.max_touch_points))
	set_number(ctx, bindings, "screenWidth", f64(p.screen.width))
	set_number(ctx, bindings, "screenHeight", f64(p.screen.height))
	set_number(ctx, bindings, "availWidth", f64(p.screen.avail_width))
	set_number(ctx, bindings, "availHeight", f64(p.screen.avail_height))
	set_number(ctx, bindings, "availLeft", f64(p.screen.avail_left))
	set_number(ctx, bindings, "availTop", f64(p.screen.avail_top))
	set_number(ctx, bindings, "colorDepth", f64(p.screen.color_depth))
	set_number(ctx, bindings, "devicePixelRatio", p.screen.device_pixel_ratio)
	set_number(ctx, bindings, "innerWidth", f64(p.window.inner_width))
	set_number(ctx, bindings, "innerHeight", f64(p.window.inner_height))
	set_number(ctx, bindings, "outerWidth", f64(p.window.outer_width))
	set_number(ctx, bindings, "outerHeight", f64(p.window.outer_height))
	set_number(ctx, bindings, "screenX", f64(p.window.screen_x))
	set_number(ctx, bindings, "screenY", f64(p.window.screen_y))
	return bindings
}

@(private = "file")
location_loading_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	state := get_state_from_ctx(ctx)
	return jsc.JSValueMakeBoolean(ctx, b32(state != nil && state.top_script_running))
}

@(private = "file")
set_number :: proc(ctx: jsc.JSContextRef, object: jsc.JSObjectRef, name: string, value: f64) {
	set_named(ctx, object, name, jsc.JSValueMakeNumber(ctx, value))
}
