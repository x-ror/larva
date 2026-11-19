package larva_html

import "core:c"
import "core:strings"

// OUTER_HTML_RESERVE is the first capacity outer_html gives its builder, so a typical
// element is one allocation instead of the 8 -> 24 -> 56 -> 120 growth of an empty one.
// Measured 0.65x: 2.17 -> 1.41 ms for outer_html over 18000 nodes (12000 `<li>` and
// 6000 `<a href>`) of a 1.2 MB page, -o:speed, medians of 7 interleaved launches.
@(private = "file")
OUTER_HTML_RESERVE :: 128

// Node is a DOM node owned by its Parser's document. It stays valid until destroy:
// lexbor detaches nodes from the tree but frees them only with the document.
Node :: distinct rawptr

// text returns `node`'s text content, copied into `allocator`.
//
// Returns:
//   "" when the node is nil, has no text, or the copy cannot be allocated.
// Chrome:
//   Node.textContent is the model; unverified — no recording exists yet (#2).
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
// Chrome:
//   Element.getAttribute is the model, with ok false for its null; unverified — no recording exists yet (#2).
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

// outer_html returns `node`'s markup, the node itself included.
//
// Returns:
//   ok false when the node is nil or the markup cannot be allocated — never a
//   truncated string.
// Chrome:
//   Element.outerHTML is the model; unverified — no recording exists yet (#2).
outer_html :: proc(node: Node, allocator := context.allocator) -> (markup: string, ok: bool) {
	if node == nil {
		return "", false
	}

	return serialize_with(node, false, OUTER_HTML_RESERVE, allocator)
}
