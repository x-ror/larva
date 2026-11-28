package lava_runtime

import "base:runtime"
import "core:c"
import "core:os"
import "core:strings"
import jsc "lava:pkg/jsc"

// Module scripts (`<script type=module>`) and `import()` inside them (#13, docs/LARVA.md
// roadmap blocker 4): the Odin side of internal/module_loader.js, which does the work.
//
// Why a source transform and not JSC's own module records. Evidence from the linked
// libjavascriptcoregtk-6.0 (2.52.6, `nm -D --defined-only`), the time-boxed survey #13
// asked for:
//   - The C API has no module entry: JSScriptRefPrivate.h's JSScriptCreateFromString/
//     JSScriptEvaluate (private_script.odin) parse Program source only; there is no
//     kJSScriptType (that is the Objective-C JSScript), and the GLib API's
//     jsc_context_check_syntax knows a module mode but no jsc_context_evaluate does.
//   - The C++ entry points are exported (JSC::loadAndEvaluateModule, JSC::importModule,
//     JSModuleRecord::evaluate) but useless without the host hooks: the module loader asks
//     the global object's GlobalObjectMethodTable for moduleLoaderFetch/ImportModule, and
//     a C API global (JSAPIGlobalObject) fills them only in the Objective-C build. Probed
//     on this build: `import('./x.js')` in a classic page script rejects with JSC's
//     "Could not import the module './x.js'.". Installing hooks would mean patching a
//     method-table pointer at an unexported, version-specific offset of JSGlobalObject
//     and building WTF::String/SourceCode/JSInternalPromise values by C++ ABI — a
//     private-ABI probe far past CLAUDE.md §4's latch-and-fall-back kind.
//   - So the module is rewritten to a classic script (module_loader.js's file comment
//     says how live bindings, cycles and top-level await survive that), and compiled here.
//
// Fetching is a file read, as for a classic script's `src` (page_script.odin): an
// absolute `file:` URL is read from disk, anything else fails the fetch. module_fetch is
// the one place a network page loader plugs into: answer a URL's source text from the
// page's own fetch, and every static import, `src` and `import()` follows.

// make_module_bindings is internal/module_loader's natives (its factory's fourth
// argument): `fetch(url)` and `compile(source, name)`.
make_module_bindings :: proc(ctx: jsc.JSContextRef) -> jsc.JSObjectRef {
	bindings := jsc.JSObjectMake(ctx, nil, nil)
	inject_native_function(ctx, bindings, "fetch", module_fetch_cb, arity = 1, constructible = false)
	inject_native_function(ctx, bindings, "compile", module_compile_cb, arity = 2, constructible = false)
	return bindings
}

// page_run_module_script runs one module script of an HTML page: its graph fetched,
// linked and evaluated by internal/module_loader's run (bootstrap/loader.js runModule).
//
// Params:
//   source  The script's text: inline, or what its `src` fetched.
//   url     The script's URL, its key in the module map; "" for an inline script.
//   name    The name it runs under in a stack.
// Returns:
//   ok false when a module of the graph could not be fetched: the caller fires `error`
//   at the element. A throw (a syntax, resolution or link error, or the evaluation's)
//   is reported as the page's uncaught error, as for a classic script, and is ok.
//   ended true when the page ended during the run.
// Chrome:
//   Chrome 158, tests/dom/cases/dom-script-module.page.
page_run_module_script :: proc(page: ^Page, source, url, name: string) -> (ok: bool, ended: bool) {
	if page.finished || page.ctx == nil || page.state == nil || page.state.loader == nil {
		return false, true
	}

	ctx := cast(jsc.JSContextRef)page.ctx
	run := get_named(ctx, cast(jsc.JSObjectRef)page.state.loader, "runModule")

	if run == nil || !jsc.JSValueIsObject(ctx, run) {
		return false, false
	}

	base := url

	if base == "" {
		base = module_document_url(page.state.dom.scripts.document_path, context.temp_allocator)
	}

	args := [4]jsc.JSValueRef {
		js_string_value(ctx, source),
		url == "" ? jsc.JSValueMakeNull(ctx) : js_string_value(ctx, url),
		js_string_value(ctx, base),
		js_string_value(ctx, name),
	}
	exception: jsc.JSValueRef
	vm_cpu_enter(page.vm)
	result := jsc.JSObjectCallAsFunction(ctx, cast(jsc.JSObjectRef)run, nil, 4, raw_data(args[:]), &exception)
	vm_cpu_exit(page.vm)

	if ended, end := page_ended(page); ended {
		page_fail(page, end)
		return false, true
	}

	ok = true

	if exception != nil {
		report_uncaught(ctx, exception)
		mark_async_failed(ctx)
	} else {
		ok = result != nil && jsc.JSValueToBoolean(ctx, result)
	}

	return ok, false
}

// module_document_url is the URL an inline module's specifiers resolve against: the
// document's `file:` URL, or about:blank for a page with no file (a served page, until
// a network page loader gives it its own URL), where only absolute specifiers resolve.
module_document_url :: proc(document_path: string, allocator: runtime.Allocator) -> string {
	if document_path == "" {
		return "about:blank"
	}

	return module_file_url(document_path, allocator)
}

// module_file_url is the `file:` URL of the file at `path`, made absolute (a `lava page`
// argument is usually relative to the working directory). The URL parser on the JS side
// percent-encodes what needs it.
module_file_url :: proc(path: string, allocator: runtime.Allocator) -> string {
	absolute, err := os.get_absolute_path(path, context.temp_allocator)

	if err != nil {
		absolute = path
	}

	return strings.concatenate({"file://", absolute}, allocator)
}

// module_fetch reads the module at `url` (absolute, from the module loader's
// resolution): a `file:` URL is resolved as a classic script's `src` is and read from
// disk, under SCRIPT_MAX_BYTES. The seam for a network page loader.
//
// Returns:
//   The source, in `allocator`; ok false when it cannot be fetched.
@(private = "file")
module_fetch :: proc(s: ^Page_Scripts, url: string, allocator: runtime.Allocator) -> (source: string, ok: bool) {
	// Any absolute file: URL is the page's to read, as an external classic script's is;
	// script_resolve wants a document path only to join relative references.
	path, resolved := script_resolve(s.document_path if s.document_path != "" else "/", url)

	if !resolved {
		return "", false
	}

	info, stat_err := os.stat(path, context.temp_allocator)

	if stat_err != nil || info.type != .Regular || info.size > SCRIPT_MAX_BYTES {
		return "", false
	}

	data, read_err := os.read_entire_file(path, allocator)

	if read_err != nil {
		return "", false
	}

	return string(data), true
}

// module_fetch_cb is the module loader's `fetch(url)`: the module's text, or undefined
// when it cannot be fetched (the loader's fetch error).
@(private = "file")
module_fetch_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	state := get_state_from_ctx(ctx)

	if argument_count < 1 || state == nil || state.dom == nil {
		return jsc.JSValueMakeUndefined(ctx)
	}

	url, allocated := value_to_string(ctx, arguments[0])
	defer if allocated {
		delete(url)
	}

	source, ok := module_fetch(&state.dom.scripts, url, context.allocator)

	if !ok {
		return jsc.JSValueMakeUndefined(ctx)
	}

	defer delete(source)
	text := source

	if strings.has_prefix(text, "\xef\xbb\xbf") {
		text = text[3:]
	}

	return js_string_value(ctx, text)
}

// module_compile_cb is the module loader's `compile(source, name)`: evaluates the
// transformed module as a classic script named `name` and returns its completion value
// (the module's function), throwing what the evaluation throws (a SyntaxError).
@(private = "file")
module_compile_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()

	if argument_count < 2 {
		return jsc.JSValueMakeUndefined(ctx)
	}

	// The JS strings as they are: no UTF-8 round trip of the module's text.
	source := jsc.JSValueToStringCopy(ctx, arguments[0], exception)

	if source == nil {
		return jsc.JSValueMakeUndefined(ctx)
	}

	defer jsc.JSStringRelease(source)
	name := jsc.JSValueToStringCopy(ctx, arguments[1], exception)

	if name == nil {
		return jsc.JSValueMakeUndefined(ctx)
	}

	defer jsc.JSStringRelease(name)
	value := jsc.JSEvaluateScript(ctx, source, nil, name, 1, exception)

	if value == nil {
		return jsc.JSValueMakeUndefined(ctx)
	}

	return value
}
