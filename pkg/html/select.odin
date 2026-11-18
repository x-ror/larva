package larva_html

import "base:runtime"
import "core:c"

// CSS selectors over lexbor's selector engine (#11): querySelector and
// querySelectorAll semantics — descendants of the root only, tree order, each node
// once however many selectors of a list (`a, a.x`) it matches.

// Selectors is the matching engine. lexbor keeps per-search state in it, so it is not
// shared between threads: one per thread, reused across documents.
Selectors :: struct {
	engine: larva_css_engine,
}

// Selector is a compiled selector list. It belongs to no document and no engine: one
// compile serves any number of searches, until selector_destroy.
Selector :: struct {
	list: lxb_selector_list,
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
//   SyntaxError).
compile :: proc(s: ^Selectors, css: string) -> (sel: Selector, ok: bool) {
	list := larva_css_compile(s.engine, raw_data(css), c.size_t(len(css)))
	return Selector{list}, list != nil
}

selector_destroy :: proc(sel: ^Selector) {
	larva_css_free(sel.list)
	sel^ = {}
}

// query_all appends to `out` every descendant of `root` that `sel` matches, in tree
// order, as querySelectorAll. `root` is a document or element node.
query_all :: proc(s: ^Selectors, root: Node, sel: Selector, out: ^[dynamic]Node) -> bool {
	found :: proc "c" (node: Node, ctx: rawptr) -> bool {
		// `out` grows through its own allocator; the context is only for append itself.
		context = runtime.default_context()
		append(cast(^[dynamic]Node)ctx, node)
		return false
	}
	return larva_css_find(s.engine, root, sel.list, found, out)
}

// query_first returns the first descendant of `root`, in tree order, that `sel`
// matches, as querySelector; nil when none does.
query_first :: proc(s: ^Selectors, root: Node, sel: Selector) -> (node: Node, ok: bool) {
	found :: proc "c" (n: Node, ctx: rawptr) -> bool {
		(cast(^Node)ctx)^ = n
		return true
	}
	ok = larva_css_find(s.engine, root, sel.list, found, &node)
	return
}
