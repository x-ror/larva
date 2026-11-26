#+build linux
package larva_html

import "core:c"
import "core:mem"
import "core:strings"
import "core:testing"

// What the tests/dom oracle cannot see about the tree read API and the serializer
// (CLAUDE.md §6): that the Odin mirror of lexbor's structs still has lexbor's layout,
// that a read never goes through the wrong struct, and which allocator the markup
// lands in. Every assertion on the markup's bytes lives in tests/dom, against Chrome.

// The mirror (layout.odin) is only as good as its agreement with the lexbor that was
// compiled: a field lexbor adds or moves turns every plain load into a read of the
// wrong word. The numbers come from the C compiler through the shim, never from a copy
// here, and the check runs both ways — an entry either side lacks fails too.
@(test)
layout_mirror_matches_the_shim :: proc(t: ^testing.T) {
	n: c.size_t
	table := larva_html_layout(&n)
	testing.expect(t, table != nil && n > 0, "the shim exported no layout table")

	ours := layout_entries()
	seen := make(map[string]bool, context.temp_allocator)

	for e in table[:n] {
		name := string(e.name)
		seen[name] = true
		value, found := ours[name]

		if !found {
			testing.expectf(t, false, "%s: the shim lays it out, the mirror has no entry", name)
			continue
		}

		testing.expectf(t, value == uintptr(e.value), "%s: lexbor %d, mirror %d", name, e.value, value)
	}

	for name in ours {
		testing.expectf(t, seen[name], "%s: the mirror has it, the shim does not check it", name)
	}
}

// parent/prev/last are the walk's other half: the serializer climbs with parent and
// next only, and a mirror field swapped with its neighbour reads the other relative.
@(test)
tree_read_walks_in_every_direction :: proc(t: ^testing.T) {
	p: Parser
	defer destroy(&p)
	parse(t, &p, `<p>a<b>b</b>c</p>`)
	s: Selectors
	testing.expect(t, selectors_init(&s), "no selector engine")
	defer selectors_destroy(&s)

	para := first(t, &s, &p, "p")
	a, c := first_child(para), last_child(para)
	b := next_sibling(a)
	da, _ := char_data(a)
	dc, _ := char_data(c)
	testing.expectf(t, da == "a" && dc == "c", "first/last child of <p>: %q, %q", da, dc)
	testing.expectf(t, local_name(b) == "b", "next of the first child is %q", local_name(b))
	testing.expect(t, prev_sibling(b) == a && next_sibling(b) == c, "<b>'s siblings")
	testing.expect(t, prev_sibling(a) == nil && next_sibling(c) == nil, "the ends have siblings")
	testing.expect(t, parent(a) == para && parent(b) == para && parent(c) == para, "children of <p> have another parent")
	testing.expect(t, parent(document(&p)) == nil, "the Document has a parent")
	testing.expect(t, parent(nil) == nil && prev_sibling(nil) == nil && last_child(nil) == nil, "nil has relatives")
	testing.expect(t, last_child(a) == nil, "a text node has a last child")
}

// The parts of a name a namespaced attribute has: DOM's prefix and localName, and the
// qualified name serialization writes. An unadjusted `xlink:href` on an HTML element is
// one name in no namespace, prefix and all.
@(test)
attribute_names_split_only_when_namespaced :: proc(t: ^testing.T) {
	p: Parser
	defer destroy(&p)
	parse(t, &p, `<p xlink:href=1></p><svg xlink:href=2 xmlns=3 xmlns:xlink=4 xml:lang=5></svg>`)
	s: Selectors
	testing.expect(t, selectors_init(&s), "no selector engine")
	defer selectors_destroy(&s)

	a := first_attr(first(t, &s, &p, "p"))
	testing.expectf(
		t,
		attr_namespace(a) == .None && attr_prefix(a) == "" && attr_local_name(a) == "xlink:href",
		"xlink:href on <p>: %v %q %q",
		attr_namespace(a),
		attr_prefix(a),
		attr_local_name(a),
	)

	Want :: struct {
		ns:                   Namespace,
		prefix, local, qname: string,
	}
	want := [?]Want {
		{.XLink, "xlink", "href", "xlink:href"},
		{.XMLNS, "", "xmlns", "xmlns"},
		{.XMLNS, "xmlns", "xlink", "xmlns:xlink"},
		{.XML, "xml", "lang", "xml:lang"},
	}
	a = first_attr(first(t, &s, &p, "svg"))

	for w in want {
		got := Want{attr_namespace(a), attr_prefix(a), attr_local_name(a), attr_qualified_name(a)}
		testing.expectf(t, got == w, "want %v got %v", w, got)
		a = next_attr(a)
	}

	testing.expect(t, a == nil, "a fifth attribute on <svg>")
	testing.expect(t, attr_prefix(nil) == "" && attr_qualified_name(nil) == "", "a nil attribute has a name")
}

// Reads that only an element answers, asked of the other kinds. The char_data case is
// the one a missing kind check turns into a read through the wrong struct: an
// element's first words after the node are name ids, which read as a (pointer, length)
// pair.
@(test)
element_reads_on_other_kinds_are_empty :: proc(t: ^testing.T) {
	p: Parser
	defer destroy(&p)
	parse(t, &p, `<!DOCTYPE html><p>x<!--c--></p>`)
	s: Selectors
	testing.expect(t, selectors_init(&s), "no selector engine")
	defer selectors_destroy(&s)

	para := first(t, &s, &p, "p")
	txt := first_child(para)
	dt := first_child(document(&p))

	for n in ([?]Node{txt, next_sibling(txt), dt, document(&p), nil}) {
		testing.expectf(t, qualified_name(n) == "" && element_prefix(n) == "", "%v answered an element name", node_type(n))
		testing.expectf(t, first_attr(n) == nil, "%v answered an attribute list", node_type(n))
		testing.expectf(t, pi_target(n) == "", "%v answered a target", node_type(n))
	}

	data, ok := char_data(para)
	// The length only: a read through the wrong struct leaves `data` pointing nowhere.
	testing.expectf(t, !ok && len(data) == 0, "an element answered character data (%d bytes, %v)", len(data), ok)
	data, ok = char_data(dt)
	testing.expectf(t, !ok && len(data) == 0, "a doctype answered character data (%d bytes, %v)", len(data), ok)
	testing.expectf(t, qualified_name(para) == "p", "<p>'s qualified name is %q", qualified_name(para))
}

// The markup is the caller's: allocated in the allocator passed, every byte of it freed
// by deleting the string. A refused allocation answers ok false with nothing left
// behind, never a truncated string — the same contract outer_html had with lexbor's
// serializer, which outer_html_reports_a_refused_allocation pins for one element.
@(test)
serialize_allocates_only_through_the_callers_allocator :: proc(t: ^testing.T) {
	p: Parser
	defer destroy(&p)
	parse(t, &p, strings.repeat("<p title=\"a&b\">x&nbsp;y</p>", 300, context.temp_allocator))

	track: mem.Tracking_Allocator
	mem.tracking_allocator_init(&track, context.allocator)
	defer mem.tracking_allocator_destroy(&track)

	markup, ok := serialize(&p, mem.tracking_allocator(&track))
	testing.expect(t, ok, "serialize failed")
	testing.expectf(t, len(track.allocation_map) == 1, "%d live allocations behind one string", len(track.allocation_map))
	testing.expect(t, raw_data(markup) in track.allocation_map, "the markup is not the allocation the tracker saw")
	delete(markup, mem.tracking_allocator(&track))
	testing.expectf(t, len(track.allocation_map) == 0, "%d allocations left after delete", len(track.allocation_map))

	lim := Capped {
		backing = mem.tracking_allocator(&track),
		limit   = 1024,
	}
	markup, ok = serialize(&p, capped(&lim))
	testing.expectf(t, !ok && markup == "", "a refused allocation gave %d bytes, ok=%v", len(markup), ok)
	testing.expectf(t, len(track.allocation_map) == 0, "a refused serialize left %d allocations", len(track.allocation_map))
}

// innerHTML of a template is its content's markup (the fragment serialization
// algorithm's first step); the element's own child list is empty.
@(test)
inner_html_of_a_template_is_its_content :: proc(t: ^testing.T) {
	p: Parser
	defer destroy(&p)
	parse(t, &p, `<template><b>in</b><template>x</template></template>`)
	s: Selectors
	testing.expect(t, selectors_init(&s), "no selector engine")
	defer selectors_destroy(&s)

	tpl := first(t, &s, &p, "template")
	testing.expect(t, first_child(tpl) == nil, "the template has children of its own")
	inner, ok := inner_html(tpl, context.temp_allocator)
	testing.expectf(t, ok && inner == "<b>in</b><template>x</template>", "template innerHTML: %q", inner)
}
