package larva_html

import "core:c"
import "core:strings"

// Node is a DOM node owned by its Parser's document. It stays valid until destroy:
// lexbor detaches nodes from the tree but frees them only with the document.
Node :: distinct rawptr

// OUTER_HTML_RESERVE is the first capacity outer_html gives its builder; most elements
// fit, so it rarely grows.
@(private = "file")
OUTER_HTML_RESERVE :: 128

// text returns `node`'s textContent, copied into `allocator`; "" for none.
text :: proc(node: Node, allocator := context.allocator) -> string {
	if node == nil {
		return ""
	}

	n: c.size_t
	t := lxb_dom_node_text_content(node, &n)

	if t == nil {
		return ""
	}

	defer larva_html_text_free(node, t)
	return strings.clone(string(t[:n]), allocator)
}

// attr_view returns attribute `name` of element `node` without copying it. The string
// points into the document: valid until the attribute changes or the Parser is
// destroyed.
//
// Returns:
//   ok false when `node` is not an element or has no such attribute. An attribute
//   without a value (`<script async>`) is ok true with "".
attr_view :: proc(node: Node, name: string) -> (value: string, ok: bool) {
	if node == nil {
		return "", false
	}

	n: c.size_t
	v := larva_html_attr(node, raw_data(name), c.size_t(len(name)), &n)

	if v == nil {
		return "", false
	}

	return string(v[:n]), true
}

// attr is attr_view copied into `allocator`.
//
// Returns:
//   ok false also when the copy cannot be allocated.
attr :: proc(node: Node, name: string, allocator := context.allocator) -> (value: string, ok: bool) {
	view := attr_view(node, name) or_return

	if len(view) == 0 {
		return "", true
	}

	copied, err := strings.clone(view, allocator)

	if err != nil {
		return "", false
	}

	return copied, true
}

// outer_html returns `node`'s markup, the node itself included, as outerHTML does.
outer_html :: proc(node: Node, allocator := context.allocator) -> (markup: string, ok: bool) {
	if node == nil {
		return "", false
	}

	return serialize_with(node, false, OUTER_HTML_RESERVE, allocator)
}
