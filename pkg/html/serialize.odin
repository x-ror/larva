package larva_html

// The HTML fragment serialization algorithm (WHATWG HTML, "Serializing HTML
// fragments"), as Chrome 158 runs it on a document with scripting disabled — what
// serialize, inner_html and outer_html print. It replaced lexbor's serializer
// (lxb_html_serialize_*_cb) in stage 3b, which docs/LARVA.md D7 asks of us for two
// reasons: Chrome's escaping and its processing-instruction form are Chrome's, not
// lexbor's, and the shadow-root and frame modes of stages 3f/3h need a serializer we
// can extend. tests/dom compares every byte with Chrome's, over the hand cases and the
// html5lib corpus.
//
// It replaced lexbor's only once it matched every tests/dom recording and was no
// slower: 0.70x lexbor's time on a 1.2 MB page of 18000 elements (1304 against 1873 ns
// per KB of input) and 0.83x over the 1648 tests/dom documents (6746 against 8136 ns
// per KB) — `make bench-html`: medians of 7 launches, each the median of 25 rounds
// alternating the two serializers on the same parsed trees, -o:speed, Ryzen 7 7700X.
//
// The walk keeps no stack: it descends through first_child and climbs back through
// parent, both plain loads through the layout mirror, closing a tag on each step up. A
// template's content is a separate tree (its fragment's parent is nil, not the
// template), so that one case recurses, once per nesting level of templates.

// Chrome's escaping, recorded in tests/dom/cases/attr-escaping and attr-text-escaping
// (Chrome 158): text escapes `&`, U+00A0, `<` and `>`; an attribute value escapes `"`
// too. Chrome escapes `<` and `>` in attribute values since the spec change of 2025,
// which is the escaping lexbor already shipped; `'`, tabs and newlines are never
// escaped.
@(private = "file")
Escape :: enum u8 {
	None,
	Amp,
	Lt,
	Gt,
	Quot,
	Nbsp_Lead, // 0xC2, the first byte of U+00A0 when 0xA0 follows
}

@(private = "file")
ESCAPE_TEXT := #partial [256]Escape {
	'&'  = .Amp,
	'<'  = .Lt,
	'>'  = .Gt,
	0xC2 = .Nbsp_Lead,
}

@(private = "file")
ESCAPE_ATTR := #partial [256]Escape {
	'&'  = .Amp,
	'<'  = .Lt,
	'>'  = .Gt,
	'"'  = .Quot,
	0xC2 = .Nbsp_Lead,
}

@(private = "file")
REPLACEMENT := [Escape]string {
	.None      = "",
	.Amp       = "&amp;",
	.Lt        = "&lt;",
	.Gt        = "&gt;",
	.Quot      = "&quot;",
	.Nbsp_Lead = "&nbsp;",
}

// The output buffer, bound to the caller's allocator. A refused grow sets `failed`
// and every later write is dropped, so the walk checks it once per node instead of
// after every write.
@(private = "file")
Out :: struct {
	buf:    [dynamic]u8,
	failed: bool,
}

// serialize_markup serializes `node` into a string of `allocator`: its children only
// when `children_only` (innerHTML, and a document), the node itself too otherwise
// (outerHTML). `reserve` > 0 is the buffer's first capacity.
//
// Returns:
//   ok false when the markup cannot be allocated — nothing is left allocated then,
//   and no truncated string is returned.
@(private)
serialize_markup :: proc(
	node: Node,
	children_only: bool,
	reserve: int,
	allocator := context.allocator,
) -> (
	markup: string,
	ok: bool,
) {
	o := Out {
		buf = make([dynamic]u8, 0, reserve, allocator),
	}

	if reserve > 0 && cap(o.buf) < reserve {
		return "", false
	}

	if children_only {
		write_children(&o, node)
	} else {
		write_node(&o, node)
	}

	if o.failed {
		delete(o.buf)
		return "", false
	}

	return string(o.buf[:]), true
}

// The node itself: an element with its subtree, or one leaf.
@(private = "file")
write_node :: proc(o: ^Out, node: Node) {
	if node_type(node) != .Element {
		write_leaf(o, node)
		return
	}

	write_start_tag(o, node)

	if !is_void(node) {
		write_children(o, node)
		write_end_tag(o, node)
	}
}

// The children of `root` — of its content, for a template — in tree order.
@(private = "file")
write_children :: proc(o: ^Out, root: Node) {
	container := root

	if is_html(root, TAG_TEMPLATE) {
		container = template_content(root)
	}

	n := first_child(container)

	for n != nil && !o.failed {
		if node_type(n) == .Element {
			write_start_tag(o, n)

			if is_html(n, TAG_TEMPLATE) {
				write_children(o, n)
				write_end_tag(o, n)
			} else if !is_void(n) {
				if child := first_child(n); child != nil {
					n = child
					continue
				}

				write_end_tag(o, n)
			}
		} else {
			write_leaf(o, n)
		}

		// Next in tree order: the next sibling, or up to the first ancestor that has
		// one, closing each element on the way. Reaching the container ends the walk.
		for {
			if next := next_sibling(n); next != nil {
				n = next
				break
			}

			n = parent(n)

			if n == container || n == nil {
				return
			}

			write_end_tag(o, n)
		}
	}
}

@(private = "file")
write_leaf :: proc(o: ^Out, n: Node) {
	data, _ := char_data(n)

	#partial switch node_type(n) {
	case .Text:
		if is_raw_text_parent(parent(n)) {
			put(o, data)
		} else {
			escape(o, data, &ESCAPE_TEXT)
		}
	case .Comment:
		put(o, "<!--")
		put(o, data)
		put(o, "-->")
	case .Processing_Instruction:
		// `<?target data?>`: Chrome 158's form, the closing `?` included, so that
		// `<?php echo 1 ?>` parsed into a body serializes back as it came.
		put(o, "<?")
		put(o, pi_target(n))
		put(o, " ")
		put(o, data)
		put(o, "?>")
	case .CDATA_Section:
		// An HTML parser makes text of a CDATA section; only a DOM call (stage 3e) can
		// put one in the tree.
		put(o, "<![CDATA[")
		put(o, data)
		put(o, "]]>")
	case .Document_Type:
		// The ids are never serialized.
		name, _, _, _ := doctype(n)
		put(o, "<!DOCTYPE ")
		put(o, name)
		put(o, ">")
	}
}

@(private = "file")
write_start_tag :: proc(o: ^Out, n: Node) {
	put(o, "<")
	put(o, tag_name(n))

	for a := first_attr(n); a != nil; a = next_attr(a) {
		put(o, " ")

		// The attribute's serialized name: its local name in no namespace, and a fixed
		// prefix for the three namespaces foreign content adjusts — whatever prefix the
		// attribute carries.
		switch attr_namespace(a) {
		case .None:
			put(o, attr_local_name(a))
		case .XML:
			put(o, "xml:")
			put(o, attr_local_name(a))
		case .XMLNS:
			local := attr_local_name(a)

			if local != "xmlns" {
				put(o, "xmlns:")
			}

			put(o, local)
		case .XLink:
			put(o, "xlink:")
			put(o, attr_local_name(a))
		case .HTML, .MathML, .SVG, .Other:
			put(o, attr_qualified_name(a))
		}

		put(o, "=\"")
		escape(o, attr_value(a), &ESCAPE_ATTR)
		put(o, "\"")
	}

	put(o, ">")
}

@(private = "file")
write_end_tag :: proc(o: ^Out, n: Node) {
	put(o, "</")
	put(o, tag_name(n))
	put(o, ">")
}

// The local name for an element in the HTML, SVG or MathML namespace, the qualified
// name for any other.
@(private = "file")
tag_name :: proc(n: Node) -> string {
	switch (cast(^Lxb_Node)n).ns {
	case NS_HTML, NS_SVG, NS_MATH:
		return local_name(n)
	}

	return qualified_name(n)
}

// "Serializes as void": no children and no end tag. The spec's list; Chrome's
// HTMLElement::ShouldSerializeEndTag answers the same set (void-elements and
// void-end-tags in tests/dom).
@(private = "file")
is_void :: proc(n: Node) -> bool {
	m := cast(^Lxb_Node)n

	if m.ns != NS_HTML {
		return false
	}

	switch m.local_name {
	case TAG_AREA, TAG_BASE, TAG_BASEFONT, TAG_BGSOUND, TAG_BR, TAG_COL, TAG_EMBED, TAG_FRAME, TAG_HR, TAG_IMG, TAG_INPUT, TAG_KEYGEN, TAG_LINK, TAG_META, TAG_PARAM, TAG_SOURCE, TAG_TRACK, TAG_WBR:
		return true
	}

	return false
}

// A text child of one of these is written as it is. `noscript` is among them only
// when scripting is enabled, and every document this package parses has it disabled
// (docs/LARVA.md stage 3, open question 6); stage 4 pages, which run with scripting,
// will pass that in.
@(private = "file")
is_raw_text_parent :: proc(p: Node) -> bool {
	if node_type(p) != .Element {
		return false
	}

	m := cast(^Lxb_Node)p

	if m.ns != NS_HTML {
		return false
	}

	switch m.local_name {
	case TAG_STYLE, TAG_SCRIPT, TAG_XMP, TAG_IFRAME, TAG_NOEMBED, TAG_NOFRAMES, TAG_PLAINTEXT:
		return true
	}

	return false
}

@(private = "file")
is_html :: #force_inline proc(n: Node, tag: uintptr) -> bool {
	m := cast(^Lxb_Node)n
	return m.type == .Element && m.local_name == tag && m.ns == NS_HTML
}

// Writes `s` with the bytes `table` marks replaced: the runs between them go out in
// one append each, so text with nothing to escape costs one scan and one copy.
@(private = "file")
escape :: proc(o: ^Out, s: string, table: ^[256]Escape) {
	start := 0

	for i := 0; i < len(s); i += 1 {
		e := table[s[i]]

		if e == .None {
			continue
		}

		if e == .Nbsp_Lead {
			if i + 1 >= len(s) || s[i + 1] != 0xA0 {
				continue
			}

			put(o, s[start:i])
			put(o, REPLACEMENT[e])
			i += 1
			start = i + 1
			continue
		}

		put(o, s[start:i])
		put(o, REPLACEMENT[e])
		start = i + 1
	}

	put(o, s[start:])
}

@(private = "file")
put :: #force_inline proc(o: ^Out, s: string) {
	if len(s) == 0 || o.failed {
		return
	}

	if _, err := append(&o.buf, s); err != nil {
		o.failed = true
	}
}
