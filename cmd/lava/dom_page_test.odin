// Linux-only: the DOM is lexbor's, and pkg/html has a lexbor build on Linux alone.
#+build linux
package main

import "core:mem"
import "core:strings"
import "core:testing"
import html "lava:pkg/html"
import jsc "lava:pkg/jsc"
import lava "lava:pkg/runtime"

// The DOM bindings' wrapper rule (docs/LARVA.md decision 4; pkg/runtime/dom.odin), which
// no oracle can see: what a wrapper holds once its page's DOM is gone, and what a second
// page in the same VM sees of the first. Chrome's side of the same surface is
// tests/dom/cases/*.page.html.

// The teardown order: dom_release clears every wrapper's private slot before it frees
// the document, so a wrapper JS still holds afterwards — a pooled VM keeps them until its
// next collection — points at nothing, and a native called on it refuses with `Illegal
// invocation` instead of reading the freed tree. Its expandos are plain JS and stay. Run
// under a tracking allocator: the Dom_Page, its wrapper map and the parser's buffers are
// the page's (Runtime_State.allocator) and must all be back once the page closes.
@(test)
dom_teardown_clears_wrappers_before_the_document_goes :: proc(t: ^testing.T) {
	track: mem.Tracking_Allocator
	mem.tracking_allocator_init(&track, context.allocator)
	defer mem.tracking_allocator_destroy(&track)
	track.bad_free_callback = mem.tracking_allocator_bad_free_callback_add_to_array

	{
		context.allocator = mem.tracking_allocator(&track)
		page: lava.Page

		if !testing.expect(t, lava.page_create(&page, "<dom-teardown>"), "page_create failed") {
			result, _ := lava.page_close(&page)
			lava.result_destroy(&result)
			return
		}

		ctx := cast(jsc.JSContextRef)page.ctx
		testing.expect_value(t, lava.dom_install(ctx, page.state), "")
		markup := "<div id=a><b>x</b></div>"
		testing.expect(t, html.parse_all(&page.state.dom.parser, transmute([]byte)markup), "parse failed")

		kept, ok := lava.page_eval(&page, `globalThis.keep = document.getElementById('a'); keep.expando = 7; keep`)
		testing.expect(t, ok && jsc.JSValueIsObject(ctx, kept), "the page could not read its element")

		// Our own root: the next page_eval releases the one page_eval took.
		jsc.JSValueProtect(ctx, kept)
		kept_obj := cast(jsc.JSObjectRef)kept
		testing.expect(t, jsc.JSObjectGetPrivate(kept_obj) != nil, "a live wrapper has no node")

		lava.dom_release(ctx, page.state)
		testing.expect(t, jsc.JSObjectGetPrivate(kept_obj) == nil, "dom_release left a wrapper pointing at its node")

		late, late_ok := lava.page_eval(
			&page,
			`var r = [];
			try { keep.firstChild; r.push('read'); } catch (e) { r.push(e.constructor.name + ':' + e.message); }
			try { keep.addEventListener('x', function () {}); r.push('listened'); } catch (e) { r.push(e.constructor.name); }
			try { document; r.push('document'); } catch (e) { r.push(e.constructor.name); }
			r.push(keep.expando);
			r.join('|')`,
		)
		testing.expect(t, late_ok, "the late calls threw past their own catch")
		text, allocated := lava.value_to_string(ctx, late)
		testing.expect_value(t, text, "TypeError:Illegal invocation|TypeError|TypeError|7")

		if allocated {
			delete(text)
		}

		jsc.JSValueUnprotect(ctx, kept)
		jsc.collect_garbage_now(ctx)
		result, _ := lava.page_close(&page)
		lava.result_destroy(&result)
	}

	testing.expectf(t, len(track.allocation_map) == 0, "%d allocations outlived the page", len(track.allocation_map))
	testing.expectf(t, len(track.bad_free_array) == 0, "%d frees of memory the page never allocated", len(track.bad_free_array))
}

// Identity, and a second page in a reused VM: the thread's implicit VM pool hands
// run_html_page's second page the VM its first page used. The first page sees one
// wrapper per node (`a.firstChild === a.firstChild`, through every route to it); the
// second sees nothing of the first — not its global, not the expando it set on the
// element at the same place in an identical document.
@(test)
dom_wrapper_identity_and_a_second_page_sees_nothing_of_the_first :: proc(t: ^testing.T) {
	first := run_page(
		`<div id=a><b>x</b></div><script>
		var a = document.getElementById('a');
		a.expando = 'first';
		globalThis.leak = a;
		document.body.setAttribute('data-r', [
			a.firstChild === a.firstChild,
			a.firstChild.parentNode === a,
			document.getElementById('a') === a,
			document.body.firstChild === a,
			document.querySelector('b') === a.firstChild,
			a.childNodes[0] === a.children[0],
		].join(','));
		</script>`,
	)
	defer delete(first)
	testing.expectf(t, strings.contains(first, `data-r="true,true,true,true,true,true"`), "first page: %s", first)

	second := run_page(
		`<div id=a><b>x</b></div><script>
		var a = document.getElementById('a');
		document.body.setAttribute('data-r', [typeof globalThis.leak, String(a.expando), a.firstChild === a.firstChild].join(','));
		</script>`,
	)
	defer delete(second)
	testing.expectf(t, strings.contains(second, `data-r="undefined,undefined,true"`), "second page: %s", second)
}

// run_page runs `markup` as a page and returns its serialization ("" when it failed).
@(private = "file")
run_page :: proc(markup: string) -> string {
	result, output := lava.run_html_page(transmute([]byte)markup, "<dom-page>")
	lava.result_destroy(&result)
	return output
}

// A JSClass does not keep its parent alive: JSC's OpaqueJSClass holds `parentClass` as a
// raw pointer — ~OpaqueJSClass in the shipped libjavascriptcoregtk-6.0 releases only
// prototypeClass — yet every wrapper's finalization walks that chain, calling each
// class's `finalize`. Besides the page's own reference, what retains a class is the
// per-class context data of the page's global object, and a collection frees the global
// as it ends while it leaves the wrappers' cells for a later, lazy sweep. A root class
// released at dom_release was then freed with the global, and each later wrapper
// finalization read freed memory: harmless while nothing reused the block, a call
// through garbage once another runner thread's allocation did — the parallel suite's
// segfault in a different test each run, from JSObjectMake's allocation slow path or
// ~VM, never on one runner thread.
//
// Reproduced on one thread by doing the reusing on purpose: page after page on the
// thread's pooled VM wraps its nodes and churns enough garbage for the heap to collect
// on its own, and between pages classes with a counting `finalize` are created, so one
// lands where a freed root was. A wrapper swept afterwards then calls it through its
// parent chain (counted) or walks into whatever else took the block (a segfault). On
// the pre-fix tree, 20 of 20 single-test runs went red.
@(thread_local, private = "file")
stale_parent_finalized: int

@(private = "file")
count_stale_parent_finalize :: proc "c" (object: jsc.JSObjectRef) {
	stale_parent_finalized += 1
}

@(test)
dom_wrapper_class_parent_outlives_its_page :: proc(t: ^testing.T) {
	ROUNDS :: 64
	SENTINELS_PER_ROUND :: 256
	sentinels := make([dynamic]jsc.JSClassRef, 0, ROUNDS * SENTINELS_PER_ROUND)
	defer delete(sentinels)
	stale_parent_finalized = 0

	for _ in 0 ..< ROUNDS {
		page: lava.Page

		if !testing.expect(t, lava.page_create(&page, "<dom-parent-class>"), "page_create failed") {
			result, _ := lava.page_close(&page)
			lava.result_destroy(&result)
			break
		}

		ctx := cast(jsc.JSContextRef)page.ctx
		testing.expect_value(t, lava.dom_install(ctx, page.state), "")
		markup := "<div id=a><b>x</b><i>y</i><p>z</p><span>w</span><a>v</a><u>u</u></div>"
		testing.expect(t, html.parse_all(&page.state.dom.parser, transmute([]byte)markup), "parse failed")
		// Wrappers for every node, then enough garbage to make the heap collect on its
		// own — a collection that destroys the previous page's global at once and leaves
		// its wrappers for a later lazy sweep.
		_, ok := lava.page_eval(
			&page,
			`var n = 0;
			for (var e of document.querySelectorAll('*')) n += e.firstChild ? 1 : 0;
			var junk = [];
			for (var i = 0; i < 20000; i++) junk.push({ i: i, s: 'x' + i });
			n`,
		)
		testing.expect(t, ok, "the page could not wrap its nodes")
		result, _ := lava.page_close(&page)
		lava.result_destroy(&result)

		for _ in 0 ..< SENTINELS_PER_ROUND {
			def := jsc.JSClassDefinition {
				class_name = "Sentinel",
				attributes = .NoAutomaticPrototype,
				finalize   = count_stale_parent_finalize,
			}
			append(&sentinels, jsc.JSClassCreate(&def))
		}
	}

	testing.expectf(
		t,
		stale_parent_finalized == 0,
		"collected wrappers' finalization reached %d classes they never had: their parent class was freed",
		stale_parent_finalized,
	)

	for class in sentinels {
		jsc.JSClassRelease(class)
	}
}
