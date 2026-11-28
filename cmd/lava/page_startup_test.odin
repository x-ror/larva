// Linux-only: both start-up hooks resolve private JSC entry points (pkg/jsc
// private_script.odin, private_optimize.odin), and are honest no-ops elsewhere.
#+build linux
package main

import "core:strings"
import "core:sys/posix"
import "core:testing"
import "core:time"
import jsc "lava:pkg/jsc"
import lava "lava:pkg/runtime"

// What the page start-up caches must not change, which no oracle can see (CLAUDE.md §6):
// the per-VM scripts of the embedded runtime JS are made once and reused by every later
// page on the VM, yet a second page sees nothing of what the first did to the objects
// those scripts built; the scripts go with their VM, retired or destroyed; and the
// install-time helpers kept out of the DFG really are, while a function nobody marked
// is not.

@(private = "file")
LIMITS :: lava.Page_Limits {
	cpu_budget = 30,
}

// What the first page does to objects the embedded scripts built, and the second page's
// check that it finds none of it: interface prototypes and statics, a replaced
// operation, a replaced global, a navigator expando.
@(private = "file")
FIRST_PAGE :: `
URL.prototype.leak = 1;
TextDecoder.leak = 1;
Headers.prototype.get = function () { return 'first'; };
globalThis.fetch = 1;
Object.defineProperty(navigator, 'leak', { value: 1 });
'polluted'`

@(private = "file")
SECOND_PAGE :: `
const seen = [];
if ('leak' in URL.prototype) seen.push('URL.prototype');
if ('leak' in TextDecoder) seen.push('TextDecoder');
if (new Headers([['a', '1']]).get('a') !== '1') seen.push('Headers.prototype.get');
if (typeof fetch !== 'function') seen.push('fetch');
if ('leak' in navigator) seen.push('navigator');
seen.join(',')`

// page_eval_text runs `source` on `page` and returns its completion as text ("" on a
// throw, with the test failed).
@(private = "file")
page_eval_text :: proc(t: ^testing.T, page: ^lava.Page, source: string, loc := #caller_location) -> string {
	value, ok := lava.page_eval(page, source)

	if !testing.expect(t, ok, "page_eval threw", loc = loc) {
		return ""
	}

	text, allocated := lava.value_to_string(cast(jsc.JSContextRef)page.ctx, value)
	out := strings.clone(text, context.temp_allocator)

	if allocated {
		delete(text)
	}

	return out
}

@(private = "file")
close_page :: proc(page: ^lava.Page) {
	result, _ := lava.page_close(page)
	lava.result_destroy(&result)
}

// Two pages through one pooled VM. The first makes the VM's scripts (one per embedded
// source it evaluates) and pollutes what they built; the second must find every object
// pristine — each evaluation of a cached script makes the page's own realm objects, as
// JSEvaluateScript did — and must reuse every script the first made rather than make
// another. Then the pool goes, and every script with it.
@(test)
vm_script_cache_isolates_pages_and_is_reused :: proc(t: ^testing.T) {
	live_before := jsc.script_live_count()
	pool: lava.VM_Pool
	lava.vm_pool_init(&pool, 1, context.allocator)
	made: map[string]jsc.JSScriptRef
	defer delete(made)

	{
		page: lava.Page

		if !testing.expect(t, lava.page_create(&page, "<first>", limits = LIMITS, pool = &pool), "page_create failed") {
			close_page(&page)
			lava.vm_pool_destroy(&pool)
			return
		}

		testing.expect_value(t, page_eval_text(t, &page, FIRST_PAGE), "polluted")
		vm := page.vm
		testing.expectf(t, len(vm.scripts) > 0, "the first page made no script on its VM")
		testing.expect_value(t, jsc.script_live_count() - live_before, len(vm.scripts))
		for name, entry in vm.scripts {
			made[name] = entry.script
		}
		close_page(&page)
	}

	{
		page: lava.Page

		if !testing.expect(t, lava.page_create(&page, "<second>", limits = LIMITS, pool = &pool), "page_create failed") {
			close_page(&page)
			lava.vm_pool_destroy(&pool)
			return
		}

		testing.expect_value(t, page_eval_text(t, &page, SECOND_PAGE), "")
		vm := page.vm
		testing.expect_value(t, len(vm.scripts), len(made))
		for name, entry in vm.scripts {
			testing.expectf(t, made[name] == entry.script, "%s: the second page made its own script", name)
		}
		close_page(&page)
	}

	_, created, _ := lava.vm_pool_stats(&pool)
	testing.expect_value(t, created, 1)
	lava.vm_pool_destroy(&pool)
	testing.expect_value(t, jsc.script_live_count(), live_before)
}

// A VM retired at release takes its scripts with it: with retirement after every page,
// no script is left alive between pages.
@(test)
vm_scripts_go_with_a_retired_vm :: proc(t: ^testing.T) {
	live_before := jsc.script_live_count()
	pool: lava.VM_Pool
	lava.vm_pool_init(&pool, 1, context.allocator)
	pool.retire_after_pages = 1
	defer lava.vm_pool_destroy(&pool)

	for i in 0 ..< 3 {
		page: lava.Page

		if !testing.expect(t, lava.page_create(&page, "<retired>", limits = LIMITS, pool = &pool), "page_create failed") {
			close_page(&page)
			return
		}

		testing.expectf(t, jsc.script_live_count() > live_before, "page %d made no script", i)
		close_page(&page)
		testing.expectf(
			t,
			jsc.script_live_count() == live_before,
			"page %d: %d scripts outlived their retired VM",
			i,
			jsc.script_live_count() - live_before,
		)
	}

	_, created, retired := lava.vm_pool_stats(&pool)
	testing.expect_value(t, created, 3)
	testing.expect_value(t, retired, 3)
}

// A name is cached with the text it was made from: asked again with that text it is
// the same script, asked with another it is refused (the caller then evaluates that
// text uncached), so a name can never run a different source than the one requested.
@(test)
vm_script_refuses_another_text_under_a_cached_name :: proc(t: ^testing.T) {
	pool: lava.VM_Pool
	lava.vm_pool_init(&pool, 1, context.allocator)
	defer lava.vm_pool_destroy(&pool)
	vm, err := lava.vm_acquire(&pool)

	if !testing.expect_value(t, err, lava.VM_Pool_Error.None) {
		return
	}

	defer lava.vm_release(vm)
	first_text := "1 + 1"
	other_text := "2 + 2"
	first := lava.vm_script(vm, "<named>", first_text)
	testing.expect(t, first != nil, "no script was made")
	testing.expect(t, lava.vm_script(vm, "<named>", first_text) == first, "the same text made a second script")
	testing.expect(t, lava.vm_script(vm, "<named>", other_text) == nil, "another text ran under a cached name")
}

// JSC::numberOfDFGCompiles(JSContextRef, JSValueRef), the C-API twin of the jsc shell's
// numberOfDFGCompiles (TestRunnerUtils), resolved as the hook itself is: 1000000 when
// the DFG is off for the process.
@(private = "file")
Dfg_Compiles_Proc :: #type proc "c" (ctx: jsc.JSContextRef, fn: jsc.JSValueRef) -> jsc.JSValueRef

@(private = "file")
dfg_compiles :: proc(ctx: jsc.JSContextRef, fn: jsc.JSValueRef) -> (f64, bool) {
	p := posix.dlsym(nil, "_ZN3JSC19numberOfDFGCompilesEPK15OpaqueJSContextPK13OpaqueJSValue")

	if p == nil {
		return 0, false
	}

	return jsc.JSValueToNumber(ctx, (transmute(Dfg_Compiles_Proc)p)(ctx, fn), nil), true
}

// call_until calls each of `fns` (with `args`) in turn, from native code so no JS
// caller can inline them, until `control` has been DFG-compiled or `budget` calls each
// have been made. Returns whether the control got there.
@(private = "file")
call_until_compiled :: proc(
	ctx: jsc.JSContextRef,
	control: jsc.JSObjectRef,
	fns: []jsc.JSObjectRef,
	args: []jsc.JSValueRef,
	budget: int,
) -> bool {
	start := time.tick_now()
	for i in 0 ..< budget {
		for fn in fns {
			jsc.JSObjectCallAsFunction(ctx, fn, nil, len(args), raw_data(args), nil)
		}

		if i % 256 == 0 {
			if n, ok := dfg_compiles(ctx, cast(jsc.JSValueRef)control); ok && n > 0 {
				return true
			}

			if time.duration_seconds(time.tick_since(start)) > 20 {
				return false
			}
		}
	}

	return false
}

// A function handed to jsc.never_optimize is never DFG-compiled however hot it runs,
// while its unmarked twin — same text, called as often — is. And on a real page the
// install-time helpers of internal/native_shape are marked: wrapOperation, called from
// native code until a control has tiered up, has no DFG compile either.
@(test)
never_optimize_keeps_install_helpers_out_of_the_dfg :: proc(t: ^testing.T) {
	pool: lava.VM_Pool
	lava.vm_pool_init(&pool, 1, context.allocator)
	defer lava.vm_pool_destroy(&pool)
	page: lava.Page
	defer close_page(&page)

	if !testing.expect(t, lava.page_create(&page, "<never-optimize>", limits = {}, pool = &pool), "page_create failed") {
		return
	}

	ctx := cast(jsc.JSContextRef)page.ctx
	_, ok := lava.page_eval(
		&page,
		`globalThis.marked = function (x) { return x * 2 + 1; };
		globalThis.control = function (x) { return x * 2 + 1; };`,
	)

	if !testing.expect(t, ok, "page_eval threw") {
		return
	}

	global := jsc.JSContextGetGlobalObject(ctx)
	marked := cast(jsc.JSObjectRef)lava.get_named(ctx, global, "marked")
	control := cast(jsc.JSObjectRef)lava.get_named(ctx, global, "control")
	testing.expect(t, jsc.never_optimize(ctx, cast(jsc.JSValueRef)marked), "this JSC has no setNeverOptimize")
	number := [1]jsc.JSValueRef{jsc.JSValueMakeNumber(ctx, 3)}

	if !testing.expect(
		t,
		call_until_compiled(ctx, control, {marked, control}, number[:], 2_000_000),
		"the control never reached the DFG (or numberOfDFGCompiles is missing)",
	) {
		return
	}

	n, _ := dfg_compiles(ctx, cast(jsc.JSValueRef)marked)
	testing.expectf(t, n == 0, "a function marked never-optimize was DFG-compiled %v times", n)

	// The page's own helper, reached through the loader's handle (never page code).
	shape := lava.get_named(ctx, cast(jsc.JSObjectRef)page.state.loader, "nativeShape")
	wrap := cast(jsc.JSObjectRef)lava.get_named(ctx, cast(jsc.JSObjectRef)shape, "wrapOperation")
	fresh := cast(jsc.JSObjectRef)lava.get_named(ctx, global, "control")
	_, ok = lava.page_eval(&page, `globalThis.control2 = function (x) { return x * 3 + 1; };`)
	control2 := cast(jsc.JSObjectRef)lava.get_named(ctx, global, "control2")
	wrap_args := [3]jsc.JSValueRef {
		lava.js_string_value(ctx, "op"),
		cast(jsc.JSValueRef)fresh,
		jsc.JSValueMakeNumber(ctx, 0),
	}

	if !testing.expect(
		t,
		call_until_compiled(ctx, control2, {wrap, control2}, wrap_args[:], 400_000),
		"the second control never reached the DFG",
	) {
		return
	}

	n, _ = dfg_compiles(ctx, cast(jsc.JSValueRef)wrap)
	testing.expectf(t, n == 0, "internal/native_shape's wrapOperation was DFG-compiled %v times", n)
}
