package larva_html

import "core:strings"

// The builder is bound to its allocator, so a write can fail by running out; every
// write goes through `put`, which records the first failure instead of leaving a
// dump with a line missing.
@(private = "file")
Dump :: struct {
	b:      ^strings.Builder,
	failed: bool,
}

// dump_tree returns the html5lib-format dump of `node`'s children: the tree view of
// the tests/dom oracle, which Chrome produces with dumpTree in
// scripts/lib/dom-oracle.mjs. That function's comment is the format's definition; the
// two must print the same bytes for the same tree, and the suite checks that they do.
//
// Returns:
//   ok false when a node cannot be dumped (one an HTML parser does not produce) or
//   the dump cannot be allocated — never a truncated dump.
// Chrome:
//   recorded per case in tests/dom/cases/*.expected (`#tree`); verified there.
// Deviates:
//   From html5lib's own format, not from Chrome: attributes print in the element's
//   order instead of sorted, because the order is observable and the parser must
//   reproduce it. tests/dom/cases/attr-order-duplicates.html pins it.
dump_tree :: proc(node: Node, allocator := context.allocator) -> (dump: string, ok: bool) {
	b := strings.builder_make(allocator)
	d := Dump {
		b = &b,
	}

	for child := first_child(node); child != nil; child = next_sibling(child) {
		if !walk(&d, child, 0) || d.failed {
			strings.builder_destroy(&b)
			return "", false
		}
	}

	return strings.to_string(b), true
}

@(private = "file")
walk :: proc(d: ^Dump, node: Node, depth: int) -> bool {
	#partial switch node_type(node) {
	case .Element:
		ns := namespace_of(node)
		prefix: string
		#partial switch ns {
		case .HTML:
			prefix = ""
		case .SVG:
			prefix = "svg "
		case .MathML:
			prefix = "math "
		case:
			return false
		}
		line(d, depth, "<", prefix, local_name(node), ">")

		for a := first_attr(node); a != nil; a = next_attr(a) {
			attr_prefix: string
			#partial switch attr_namespace(a) {
			case .None:
				attr_prefix = ""
			case .XLink:
				attr_prefix = "xlink "
			case .XML:
				attr_prefix = "xml "
			case .XMLNS:
				attr_prefix = "xmlns "
			case:
				return false
			}
			line(d, depth + 1, attr_prefix, attr_local_name(a), "=\"", attr_value(a), "\"")
		}

		if content := template_content(node); content != nil {
			line(d, depth + 1, "content")

			for c := first_child(content); c != nil; c = next_sibling(c) {
				walk(d, c, depth + 2) or_return
			}
		}

		for c := first_child(node); c != nil; c = next_sibling(c) {
			walk(d, c, depth + 1) or_return
		}
	case .Text:
		data, _ := char_data(node)
		line(d, depth, "\"", data, "\"")
	case .Comment:
		data, _ := char_data(node)
		line(d, depth, "<!-- ", data, " -->")
	case .CDATA_Section:
		// Not in html5lib's format: Chrome's parser makes a CDATA section in foreign
		// content a Text node. Printed rather than refused, so a parser that keeps the
		// section shows as a one-line difference instead of a failed dump.
		data, _ := char_data(node)
		line(d, depth, "<![CDATA[", data, "]]>")
	case .Document_Type:
		name, public_id, system_id, _ := doctype(node)

		if public_id != "" || system_id != "" {
			line(d, depth, "<!DOCTYPE ", name, " \"", public_id, "\" \"", system_id, "\">")
		} else {
			line(d, depth, "<!DOCTYPE ", name, ">")
		}
	case:
		return false
	}

	return true
}

// `| `, two spaces per level, the parts, a newline.
@(private = "file")
line :: proc(d: ^Dump, depth: int, parts: ..string) {
	put(d, "| ")

	for _ in 0 ..< depth {
		put(d, "  ")
	}

	for s in parts {
		put(d, s)
	}

	put(d, "\n")
}

@(private = "file")
put :: proc(d: ^Dump, s: string) {
	if d.failed {
		return
	}

	if n, err := strings.write_string(d.b, s); err != nil || n != len(s) {
		d.failed = true
	}
}
