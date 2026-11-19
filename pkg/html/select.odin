package larva_html

import "base:runtime"
import "core:c"

// CSS selectors over lexbor's selector engine (#11): querySelector and
// querySelectorAll semantics — descendants of the root only, tree order, each node
// once however many selectors of a list (`a, a.x`) it matches.

// Selectors is the matching engine. lexbor keeps per-search state in it, so it is not
// shared between threads: one per thread, reused across documents.
Selectors :: struct {
	engine: css_engine,
}

// Selector is a compiled selector list. It belongs to no document and no engine: one
// compile serves any number of searches, until selector_destroy.
Selector :: struct {
	list: css_list,
}

// selectors_init creates the engine. false off Linux (no lexbor build) or when lexbor
// could not allocate.
selectors_init :: proc(s: ^Selectors) -> bool {
	s.engine = larva_css_create()
	return s.engine != nil
}

selectors_destroy :: proc(s: ^Selectors) {
	larva_css_destroy(s.engine)
	s^ = {}
}

// compile parses a selector list such as `div.item > a[href], #main`.
//
// Returns:
//   ok false when `css` is not a valid selector list (querySelector would throw a
//   SyntaxError), or the engine was never initialized.
compile :: proc(s: ^Selectors, css: string) -> (sel: Selector, ok: bool) {
	if s == nil || s.engine == nil {
		return {}, false
	}

	list := larva_css_compile(s.engine, raw_data(css), c.size_t(len(css)))
	return Selector{list}, list != nil
}

selector_destroy :: proc(sel: ^Selector) {
	lxb_css_selector_list_destroy_memory(sel.list)
	sel^ = {}
}

// query_all appends to `out` every descendant of `root` that `sel` matches, in tree
// order, as querySelectorAll. `root` is a document or element node.
//
// Returns:
//   false on a bad argument, a failed search, or when `out` could not grow; `out` then
//   holds the matches found so far.
query_all :: proc(s: ^Selectors, root: Node, sel: Selector, out: ^[dynamic]Node) -> bool {
	if s == nil || s.engine == nil || root == nil || sel.list == nil || out == nil {
		return false
	}

	// A zero-value array binds its allocator on the first append, which runs inside the
	// C callback; bind it here to the caller's.
	if out.allocator.procedure == nil {
		out.allocator = context.allocator
	}

	Find_Ctx :: struct {
		out: ^[dynamic]Node,
		ctx: runtime.Context,
		err: runtime.Allocator_Error,
	}

	found :: proc "c" (node: Node, raw: rawptr) -> bool {
		fc := cast(^Find_Ctx)raw
		context = fc.ctx

		if _, err := non_zero_append(fc.out, node); err != nil {
			fc.err = err
			return true
		}

		return false
	}

	fc := Find_Ctx {
		out = out,
		ctx = context,
	}
	return larva_css_find(s.engine, root, sel.list, found, &fc) && fc.err == nil
}

// query_first returns the first descendant of `root`, in tree order, that `sel`
// matches, as querySelector; nil when none does.
query_first :: proc(s: ^Selectors, root: Node, sel: Selector) -> (node: Node, ok: bool) {
	if s == nil || s.engine == nil || root == nil || sel.list == nil {
		return nil, false
	}

	found :: proc "c" (n: Node, ctx: rawptr) -> bool {
		(cast(^Node)ctx)^ = n
		return true
	}

	ok = larva_css_find(s.engine, root, sel.list, found, &node)
	return
}
