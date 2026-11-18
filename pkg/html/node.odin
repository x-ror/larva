package larva_html

import "core:c"
import "core:strings"

// Node is a DOM node owned by its Parser's document. It stays valid until destroy:
// lexbor detaches nodes from the tree but frees them only with the document.
Node :: distinct rawptr

// text returns `node`'s textContent, copied into `allocator`; "" for none.
text :: proc(node: Node, allocator := context.allocator) -> string {
	n: c.size_t
	t := larva_html_text(node, &n)
	if t == nil do return ""
	defer larva_html_text_free(node, t)
	return strings.clone(string(t[:n]), allocator)
}

// attr returns the value of attribute `name` on element `node`, copied into
// `allocator`.
//
// Returns:
//   ok false when the attribute is absent (an empty value is ok true).
attr :: proc(node: Node, name: string, allocator := context.allocator) -> (value: string, ok: bool) {
	n: c.size_t
	v := larva_html_attr(node, raw_data(name), c.size_t(len(name)), &n)
	if v == nil do return "", false
	return strings.clone(string(v[:n]), allocator), true
}
