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

// Node_Type is DOM's nodeType: lexbor's lxb_dom_node_type_t uses the same numbers.
Node_Type :: enum c.int {
	Undefined              = 0, // nil, or a node lexbor has not typed
	Element                = 1,
	Attribute              = 2,
	Text                   = 3,
	CDATA_Section          = 4,
	Processing_Instruction = 7,
	Comment                = 8,
	Document               = 9,
	Document_Type          = 10,
	Document_Fragment      = 11,
}

// Namespace is an element's or an attribute's namespace, as far as the HTML parser
// puts one there. Other is any other namespace (a DOM API can set one, stage 3e);
// None is no namespace.
Namespace :: enum u8 {
	None,
	HTML,
	MathML,
	SVG,
	XLink,
	XML,
	XMLNS,
	Other,
}

// Attr is one attribute of an element, owned by the element's document and valid as
// long as a Node is. first_attr/next_attr walk them in the element's attribute order.
Attr :: distinct rawptr

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

// inner_html returns the markup of `node`'s children, the node itself excluded.
//
// Returns:
//   ok false when the node is nil or the markup cannot be allocated — never a
//   truncated string.
// Chrome:
//   Element.innerHTML is the model; the tests/dom fragment cases compare it with
//   Chrome's through `lava html --serialize --fragment`.
inner_html :: proc(node: Node, allocator := context.allocator) -> (markup: string, ok: bool) {
	if node == nil {
		return "", false
	}

	return serialize_with(node, true, 0, allocator)
}

// The tree read API (stage 3a): what walking a parsed tree and dumping it (dump.odin)
// needs. One shim call each; the layout mirror that makes the hot ones plain loads is
// stage 3b (docs/LARVA.md D5). Every proc answers its zero value for nil or for a node
// of the wrong kind, never a read through the wrong struct.

// node_type returns `node`'s DOM nodeType; .Undefined for nil.
node_type :: proc(node: Node) -> Node_Type {
	return Node_Type(larva_html_node_type(node))
}

// first_child returns `node`'s first child; nil when it has none. A template's parsed
// content is not among its children: see template_content.
first_child :: proc(node: Node) -> Node {
	return larva_html_first_child(node)
}

// next_sibling returns the node after `node` under the same parent; nil at the end.
next_sibling :: proc(node: Node) -> Node {
	return larva_html_next_sibling(node)
}

// template_content returns an HTML `<template>`'s content fragment, which holds what
// the parser put inside it; nil for any other node.
template_content :: proc(node: Node) -> Node {
	return larva_html_template_content(node)
}

// namespace_of returns an element's namespace; .None for any other node.
namespace_of :: proc(node: Node) -> Namespace {
	if node_type(node) != .Element {
		return .None
	}

	return namespace_from_id(larva_html_ns(node))
}

// local_name returns an element's localName without copying it; "" for any other node.
//
// Chrome:
//   Element.localName: lowercase for HTML, the parser-adjusted case in SVG
//   (`foreignObject`); tests/dom compares it with Chrome's through `lava html --tree`.
local_name :: proc(node: Node) -> string {
	n: c.size_t
	s := larva_html_element_name(node, &n)
	return string(s[:n]) if s != nil else ""
}

// char_data returns the data of a text, comment, CDATA section or processing
// instruction without copying it; ok false for any other node. Valid until the node
// changes or the Parser is destroyed.
char_data :: proc(node: Node) -> (data: string, ok: bool) {
	n: c.size_t
	s := larva_html_char_data(node, &n)

	if s == nil {
		return "", false
	}

	return string(s[:n]), true
}

// doctype returns a doctype's name and ids without copying them; ok false for any
// other node. An id the doctype did not give is "", as in DOM.
doctype :: proc(node: Node) -> (name, public_id, system_id: string, ok: bool) {
	if node_type(node) != .Document_Type {
		return "", "", "", false
	}

	return doctype_part(node, 0), doctype_part(node, 1), doctype_part(node, 2), true
}

// first_attr returns an element's first attribute; nil when it has none or `node` is
// not an element.
first_attr :: proc(node: Node) -> Attr {
	return larva_html_first_attr(node)
}

// next_attr returns the attribute after `attr` on the same element; nil at the end.
next_attr :: proc(attr: Attr) -> Attr {
	return larva_html_next_attr(attr)
}

// attr_local_name returns the attribute's localName without copying it: `href` for
// `xlink:href`, and the parser-adjusted case in SVG and MathML (`viewBox`).
attr_local_name :: proc(attr: Attr) -> string {
	n: c.size_t
	s := larva_html_attr_local_name(attr, &n)
	return string(s[:n]) if s != nil else ""
}

// attr_namespace returns the attribute's namespace: .None for an ordinary attribute,
// .XLink/.XML/.XMLNS for the ones foreign content adjusts.
attr_namespace :: proc(attr: Attr) -> Namespace {
	if attr == nil {
		return .None
	}

	return namespace_from_id(larva_html_attr_ns(attr))
}

// attr_value returns the attribute's value without copying it; "" for a valueless
// attribute (`<input disabled>`), as in DOM.
attr_value :: proc(attr: Attr) -> string {
	n: c.size_t
	s := larva_html_attr_value_of(attr, &n)
	return string(s[:n]) if s != nil else ""
}

@(private = "file")
doctype_part :: proc(node: Node, which: c.int) -> string {
	n: c.size_t
	s := larva_html_doctype_part(node, which, &n)
	return string(s[:n]) if s != nil else ""
}

// lexbor's ids for the namespaces it knows (lexbor/ns/const.h, LXB_NS_*); any other id
// is a hash entry's address.
@(private = "file")
namespace_from_id :: proc(id: uintptr) -> Namespace {
	switch id {
	case 0:
		return .None
	case 2:
		return .HTML
	case 3:
		return .MathML
	case 4:
		return .SVG
	case 5:
		return .XLink
	case 6:
		return .XML
	case 7:
		return .XMLNS
	}

	return .Other
}
