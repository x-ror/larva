#+build linux
package larva_html

import "base:runtime"
import "core:strings"
import "core:testing"

// What no oracle can see (CLAUDE.md §6): which allocator a callback grows through, and
// what a refused allocation leaves behind. The attribute cases are here too until a
// recorded Chrome oracle exists for the DOM (#2).

// Capped is an allocator that refuses any single request above `limit` bytes.
@(private)
Capped :: struct {
	backing: runtime.Allocator,
	limit:   int,
}

@(private = "file")
Nested :: struct {
	seen: int,
}

// `<script src>` has a src attribute: a browser treats the script as external (and
// fails to fetch it), it does not run the element's text. lexbor's own getter answers
// NULL for a valueless attribute, the same as for an absent one.
@(test)
attr_without_a_value_is_present :: proc(t: ^testing.T) {
	p: Parser
	defer destroy(&p)
	parse(t, &p, `<script id=a src></script><script id=b async src="a.js"></script><p id=c title="">x</p>`)
	s: Selectors
	testing.expect(t, selectors_init(&s), "no selector engine")
	defer selectors_destroy(&s)

	a := first(t, &s, &p, "#a")
	v, ok := attr_view(a, "src")
	testing.expectf(t, ok && v == "", "valueless src: want (\"\", true) got (%q, %v)", v, ok)
	_, ok = attr_view(a, "async")
	testing.expect(t, !ok, "absent attribute reported present")

	b := first(t, &s, &p, "#b")
	v, ok = attr_view(b, "async")
	testing.expectf(t, ok && v == "", "valueless async: want (\"\", true) got (%q, %v)", v, ok)
	v, ok = attr_view(b, "src")
	testing.expectf(t, ok && v == "a.js", "src with a value: got (%q, %v)", v, ok)

	v, ok = attr_view(first(t, &s, &p, "#c"), "title")
	testing.expectf(t, ok && v == "", "empty-string title: got (%q, %v)", v, ok)
}

// A Node is any node — document(p) hands out the Document — and only an element has an
// attribute list. Reading one off anything else is a wild read: attr on the Document
// segfaulted before the shim checked the node type.
@(test)
attr_on_a_non_element_is_absent :: proc(t: ^testing.T) {
	p: Parser
	defer destroy(&p)
	parse(t, &p, `<p id=c>text</p>`)

	_, ok := attr_view(document(&p), "id")
	testing.expect(t, !ok, "the Document node answered an attribute lookup")
	_, ok = attr_view(nil, "id")
	testing.expect(t, !ok, "a nil node answered an attribute lookup")
	testing.expect(t, text(nil) == "", "text(nil) is not empty")
	_, ok = outer_html(nil)
	testing.expect(t, !ok, "outer_html(nil) succeeded")
}

// The second script arrives through write, so its own writes land in the middle of
// what the first one wrote — before `<b>4</b>`, which was written earlier.
@(test)
write_from_a_written_script_goes_before_the_rest :: proc(t: ^testing.T) {
	on_script :: proc(p: ^Parser, script: Node, user: rawptr) {
		n := cast(^Nested)user
		n.seen += 1
		switch n.seen {
		case 1:
			write(p, "<b>1</b><script>inner</script>")
			write(p, "<b>4</b>")
		case 2:
			write(p, "<b>2</b>")
			write(p, "<b>3</b>")
		}
	}

	p: Parser
	defer destroy(&p)
	n: Nested
	parse(t, &p, `<body><script>outer</script><p>tail</p>`, on_script, &n)
	markup, ok := serialize(&p)
	defer delete(markup)
	want :=
		`<html><head></head><body><script>outer</script>` +
		`<b>1</b><script>inner</script><b>2</b><b>3</b><b>4</b>` +
		`<p>tail</p></body></html>`
	testing.expectf(t, ok && markup == want, "write order: got %s", markup)
}

// append stores as much as fits before reporting that it could not grow; write must not
// let that prefix through, or the parser sees text the caller was told was refused.
@(test)
refused_write_leaves_nothing_behind :: proc(t: ^testing.T) {
	lim := Capped {
		backing = context.allocator,
		limit   = 64,
	}
	p: Parser
	testing.expect(t, init(&p, capped(&lim)), "init failed")
	defer destroy(&p)
	feed(&p, transmute([]byte)string("<body><script>s</script><p>tail</p>"))
	finish(&p)
	_, status := pump(&p)
	testing.expectf(t, status == .Script, "want .Script got %v", status)

	// Four bytes in a buffer of eight: room for a prefix of the next write.
	testing.expect(t, write(&p, "abcd"), "a write that fits was refused")
	before := len(p.written.buf)
	big := strings.repeat("Z", 500, context.temp_allocator)
	refused := !write(&p, big)
	// The bytes first: this is the assertion the test is named for, and the runner's
	// summary line carries only the first failure.
	testing.expectf(t, len(p.written.buf) == before, "refused write left %d bytes behind", len(p.written.buf) - before)
	testing.expect(t, refused, "a write the allocator refused reported success")
	testing.expectf(t, p.ins == before, "refused write moved the insertion point to %d", p.ins)
}

// A zero-value `out` has no allocator yet, and its first append runs inside lexbor's
// callback: it must still end up in the caller's allocator, not whatever the callback's
// context carries.
@(test)
query_all_grows_out_in_the_callers_allocator :: proc(t: ^testing.T) {
	p: Parser
	defer destroy(&p)
	parse(t, &p, `<p>1</p><p>2</p><p>3</p>`)
	s: Selectors
	testing.expect(t, selectors_init(&s), "no selector engine")
	defer selectors_destroy(&s)
	sel, _ := compile(&s, "p")
	defer selector_destroy(&sel)

	lim := Capped {
		backing = context.allocator,
		limit   = 1 << 20,
	}
	context.allocator = capped(&lim)
	out: [dynamic]Node
	defer delete(out)
	testing.expect(t, query_all(&s, document(&p), sel, &out), "query_all failed")
	testing.expectf(t, len(out) == 3, "want 3 matches got %d", len(out))
	testing.expect(t, out.allocator.data == rawptr(&lim), "out is not bound to the caller's allocator")
}

@(test)
query_all_reports_a_refused_allocation :: proc(t: ^testing.T) {
	p: Parser
	defer destroy(&p)
	parse(t, &p, strings.repeat("<p>x</p>", 500, context.temp_allocator))
	s: Selectors
	testing.expect(t, selectors_init(&s), "no selector engine")
	defer selectors_destroy(&s)
	sel, _ := compile(&s, "p")
	defer selector_destroy(&sel)

	lim := Capped {
		backing = context.allocator,
		limit   = 256, // 32 nodes
	}
	out := make([dynamic]Node, capped(&lim))
	defer delete(out)
	ok := query_all(&s, document(&p), sel, &out)
	testing.expectf(t, !ok, "query_all reported success with %d of 500 matches", len(out))
}

// Truncated markup with ok true is worse than a failure: the caller cannot tell.
@(test)
outer_html_reports_a_refused_allocation :: proc(t: ^testing.T) {
	p: Parser
	defer destroy(&p)
	parse(t, &p, strings.repeat("<p>x</p>", 500, context.temp_allocator))
	s: Selectors
	testing.expect(t, selectors_init(&s), "no selector engine")
	defer selectors_destroy(&s)
	body := first(t, &s, &p, "body")

	lim := Capped {
		backing = context.allocator,
		limit   = 2048,
	}
	markup, ok := outer_html(body, capped(&lim))
	testing.expectf(
		t,
		!ok && markup == "",
		"outer_html returned %d bytes, ok=%v, from an allocator capped at 2048",
		len(markup),
		ok,
	)

	whole, whole_ok := outer_html(body)
	defer delete(whole)
	testing.expectf(
		t,
		whole_ok && len(whole) == 500 * len("<p>x</p>") + len("<body></body>"),
		"uncapped outer_html: %d bytes",
		len(whole),
	)
}

// The tree read API answers its zero value for a node of the wrong kind instead of
// reading it through the wrong lexbor struct: a text node has no attribute list, and
// the Document no name. The oracle (tests/dom) only ever asks the right node.
@(test)
tree_read_on_the_wrong_node_kind_is_empty :: proc(t: ^testing.T) {
	p: Parser
	defer destroy(&p)
	parse(t, &p, `<!DOCTYPE html><p a=1>text<!--c--></p>`)
	s: Selectors
	testing.expect(t, selectors_init(&s), "no selector engine")
	defer selectors_destroy(&s)

	para := first(t, &s, &p, "p")
	txt := first_child(para)
	testing.expectf(t, node_type(txt) == .Text, "first child of <p> is %v", node_type(txt))
	testing.expect(t, first_attr(txt) == nil, "a text node answered an attribute list")
	testing.expect(t, local_name(txt) == "", "a text node answered a name")
	testing.expect(t, namespace_of(txt) == .None, "a text node answered a namespace")
	_, _, _, is_doctype := doctype(txt)
	testing.expect(t, !is_doctype, "a text node answered as a doctype")
	data, ok := char_data(txt)
	testing.expectf(t, ok && data == "text", "text data: (%q, %v)", data, ok)

	_, ok = char_data(para)
	testing.expect(t, !ok, "an element answered character data")
	testing.expect(t, template_content(para) == nil, "<p> answered template content")
	testing.expect(t, local_name(document(&p)) == "", "the Document answered a name")
	testing.expect(t, first_attr(document(&p)) == nil, "the Document answered an attribute list")

	testing.expect(t, node_type(nil) == .Undefined, "nil has a node type")
	testing.expect(t, first_child(nil) == nil && next_sibling(nil) == nil, "nil has relatives")
	testing.expect(t, next_attr(nil) == nil && attr_value(nil) == "", "a nil attribute has a value")
	testing.expect(t, attr_namespace(nil) == .None && attr_local_name(nil) == "", "a nil attribute has a name")
}

// lexbor gives an attribute its element's namespace unless foreign content adjusted it;
// DOM puts every unadjusted attribute in no namespace. Names keep the case the parser
// adjusts in SVG (`viewBox`), which lexbor's own local name folds.
@(test)
attributes_are_in_no_namespace_unless_adjusted :: proc(t: ^testing.T) {
	p: Parser
	defer destroy(&p)
	parse(t, &p, `<p data-x=1></p><svg viewbox=0 xlink:href=#a></svg>`)
	s: Selectors
	testing.expect(t, selectors_init(&s), "no selector engine")
	defer selectors_destroy(&s)

	a := first_attr(first(t, &s, &p, "p"))
	testing.expectf(t, attr_namespace(a) == .None, "data-x on <p> is in %v", attr_namespace(a))
	testing.expectf(t, attr_local_name(a) == "data-x" && attr_value(a) == "1", "data-x reads %q", attr_local_name(a))

	svg := first(t, &s, &p, "svg")
	testing.expectf(t, namespace_of(svg) == .SVG, "<svg> is in %v", namespace_of(svg))
	a = first_attr(svg)
	testing.expectf(t, attr_namespace(a) == .None, "viewBox on <svg> is in %v", attr_namespace(a))
	testing.expectf(t, attr_local_name(a) == "viewBox", "viewbox adjusted to %q", attr_local_name(a))
	a = next_attr(a)
	testing.expectf(t, attr_namespace(a) == .XLink, "xlink:href is in %v", attr_namespace(a))
	testing.expectf(t, attr_local_name(a) == "href", "xlink:href local name %q", attr_local_name(a))
	testing.expect(t, next_attr(a) == nil, "a third attribute on <svg>")
}

// The context decides how a fragment parses: `<td>` is a cell under a `tr` and a parse
// error dropped under a `div`. The parse is over when parse_fragment returns.
@(test)
a_fragment_parses_in_its_context :: proc(t: ^testing.T) {
	src := transmute([]byte)string("<td>a")

	p: Parser
	defer destroy(&p)
	root, ok := parse_fragment(&p, "tr", src)
	testing.expectf(t, ok, "fragment parse failed: %s", error_message(&p))
	cell := first_child(root)
	testing.expectf(t, local_name(cell) == "td", "under a tr: first child %q", local_name(cell))
	inner, inner_ok := inner_html(root, context.temp_allocator)
	testing.expectf(t, inner_ok && inner == "<td>a</td>", "under a tr: %q", inner)
	testing.expect(t, !write(&p, "<b>"), "write accepted after a fragment parse")
	_, status := pump(&p)
	testing.expectf(t, status == .Done, "pump after a fragment parse: %v", status)

	q: Parser
	defer destroy(&q)
	root, ok = parse_fragment(&q, "div", src)
	testing.expect(t, ok, "fragment parse under a div failed")
	inner, inner_ok = inner_html(root, context.temp_allocator)
	testing.expectf(t, inner_ok && inner == "a", "under a div: %q", inner)
}

@(private)
capped :: proc(c: ^Capped) -> runtime.Allocator {
	return {capped_proc, c}
}

@(private = "file")
capped_proc :: proc(
	data: rawptr,
	mode: runtime.Allocator_Mode,
	size, alignment: int,
	old_memory: rawptr,
	old_size: int,
	loc := #caller_location,
) -> (
	[]byte,
	runtime.Allocator_Error,
) {
	c := cast(^Capped)data

	#partial switch mode {
	case .Alloc, .Alloc_Non_Zeroed, .Resize, .Resize_Non_Zeroed:
		if size > c.limit {
			return nil, .Out_Of_Memory
		}
	}

	return c.backing.procedure(c.backing.data, mode, size, alignment, old_memory, old_size, loc)
}

@(private)
parse :: proc(t: ^testing.T, p: ^Parser, src: string, on_script: Script_Proc = nil, user: rawptr = nil) {
	ok := init(p) && parse_all(p, transmute([]byte)src, on_script, user)
	testing.expectf(t, ok, "parse failed: %s", error_message(p))
}

@(private)
first :: proc(t: ^testing.T, s: ^Selectors, p: ^Parser, css: string) -> Node {
	sel, ok := compile(s, css)
	testing.expectf(t, ok, "selector %q did not compile", css)
	defer selector_destroy(&sel)
	node, _ := query_first(s, document(p), sel)
	testing.expectf(t, node != nil, "nothing matches %q", css)
	return node
}
