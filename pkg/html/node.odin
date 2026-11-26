package larva_html

import "core:c"
import "core:strings"

// OUTER_HTML_RESERVE is the first capacity outer_html gives its builder, so a typical
// element is one allocation instead of the 8 -> 24 -> 56 -> 120 growth of an empty one.
// Measured 0.65x: 2.17 -> 1.41 ms for outer_html over 18000 nodes (12000 `<li>` and
// 6000 `<a href>`) of a 1.2 MB page, -o:speed, medians of 7 interleaved launches. That
// was lexbor's serializer appending into a strings.Builder; serialize.odin keeps the
// reserve for its own buffer without a measurement of its own.
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

	return serialize_markup(node, false, OUTER_HTML_RESERVE, allocator)
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

	return serialize_markup(node, true, 0, allocator)
}

// The tree read API: what walking a parsed tree, dumping it (dump.odin) and serializing
// it (serialize.odin) need, and what stage 4's bindings will read. Relatives, the node
// type, namespaces and attribute values are plain loads through the layout mirror
// (layout.odin, docs/LARVA.md D5); names go through lexbor's own lookups, doctypes and
// templates through the shim. Every proc answers its zero value for nil or for a node
// of the wrong kind, never a read through the wrong struct. Strings are views into the
// document: valid until the node changes or the Parser is destroyed.

// node_type returns `node`'s DOM nodeType; .Undefined for nil.
node_type :: #force_inline proc(node: Node) -> Node_Type {
	return mirror(node).type if node != nil else .Undefined
}

// parent returns `node`'s parent; nil for the Document, a detached node or nil. The
// children of a template's content have the content fragment as their parent, not the
// template.
parent :: #force_inline proc(node: Node) -> Node {
	return Node(mirror(node).parent) if node != nil else nil
}

// first_child returns `node`'s first child; nil when it has none. A template's parsed
// content is not among its children: see template_content.
first_child :: #force_inline proc(node: Node) -> Node {
	return Node(mirror(node).first_child) if node != nil else nil
}

// last_child returns `node`'s last child; nil when it has none.
last_child :: #force_inline proc(node: Node) -> Node {
	return Node(mirror(node).last_child) if node != nil else nil
}

// next_sibling returns the node after `node` under the same parent; nil at the end.
next_sibling :: #force_inline proc(node: Node) -> Node {
	return Node(mirror(node).next) if node != nil else nil
}

// prev_sibling returns the node before `node` under the same parent; nil at the start.
prev_sibling :: #force_inline proc(node: Node) -> Node {
	return Node(mirror(node).prev) if node != nil else nil
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

	return namespace_from_id(mirror(node).ns)
}

// qualified_name returns an element's qualified name without copying it — its prefix,
// a colon and its local name, or the local name when it has no prefix, which is always
// the case for an element the HTML parser made; "" for any other node.
//
// Chrome:
//   Element.localName for a parsed element: lowercase for HTML, the parser-adjusted
//   case in SVG (`foreignObject`); tests/dom compares it with Chrome's through
//   `lava html --tree`.
//
// lexbor's qualified name, not lxb_dom_element_local_name: lexbor folds that one to
// lowercase even where the parser adjusts the case of an SVG name, and DOM's
// localName keeps the adjusted case.
qualified_name :: proc(node: Node) -> string {
	if node_type(node) != .Element {
		return ""
	}

	n: c.size_t
	s := lxb_dom_element_qualified_name(node, &n)
	return string(s[:n]) if s != nil else ""
}

// local_name returns an element's localName without copying it: its qualified name
// after the prefix; "" for any other node.
local_name :: proc(node: Node) -> string {
	q := qualified_name(node)

	if q == "" || mirror(node).prefix == 0 {
		return q
	}

	_, _, local := strings.partition(q, ":")
	return local
}

// element_prefix returns an element's namespace prefix without copying it; "" when it
// has none (every element the HTML parser makes) or `node` is not an element.
element_prefix :: proc(node: Node) -> string {
	q := qualified_name(node)

	if q == "" || mirror(node).prefix == 0 {
		return ""
	}

	prefix, _, _ := strings.partition(q, ":")
	return prefix
}

// char_data returns the data of a text, comment, CDATA section or processing
// instruction without copying it; ok false for any other node.
char_data :: proc(node: Node) -> (data: string, ok: bool) {
	#partial switch node_type(node) {
	case .Text, .Comment, .CDATA_Section, .Processing_Instruction:
		return lxb_string((cast(^Lxb_Character_Data)node).data), true
	}

	return "", false
}

// pi_target returns a processing instruction's target without copying it; "" for any
// other node.
pi_target :: proc(node: Node) -> string {
	if node_type(node) != .Processing_Instruction {
		return ""
	}

	n: c.size_t
	s := lxb_dom_processing_instruction_target_noi(node, &n)
	return string(s[:n]) if s != nil else ""
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
first_attr :: #force_inline proc(node: Node) -> Attr {
	if node_type(node) != .Element {
		return nil
	}

	return Attr((cast(^Lxb_Element)node).first_attr)
}

// next_attr returns the attribute after `attr` on the same element; nil at the end.
next_attr :: #force_inline proc(attr: Attr) -> Attr {
	return Attr((cast(^Lxb_Attr)attr).next) if attr != nil else nil
}

// attr_namespace returns the attribute's namespace: .None for an ordinary attribute,
// .XLink/.XML/.XMLNS for the ones foreign content adjusts.
//
// The tree builder gives an attribute its element's namespace (lexbor html/tree.c,
// lxb_html_tree_append_attributes) and replaces it only for the ones foreign content
// adjusts (xlink:href, xml:lang, xmlns…). DOM puts every other attribute in no
// namespace, so an element namespace here means none.
attr_namespace :: proc(attr: Attr) -> Namespace {
	if attr == nil {
		return .None
	}

	switch ns := (cast(^Lxb_Node)attr).ns; ns {
	case NS_UNDEF, NS_HTML, NS_SVG, NS_MATH:
		return .None
	case:
		return namespace_from_id(ns)
	}
}

// attr_qualified_name returns the attribute's qualified name without copying it:
// `xlink:href` for the adjusted XLink attribute, and the parser-adjusted case in SVG
// and MathML (`viewBox`, `definitionURL`), which lexbor's local name folds.
attr_qualified_name :: proc(attr: Attr) -> string {
	if attr == nil {
		return ""
	}

	n: c.size_t
	s := lxb_dom_attr_qualified_name(attr, &n)
	return string(s[:n]) if s != nil else ""
}

// attr_local_name returns the attribute's localName without copying it: `href` for
// `xlink:href`. Without a namespace that is the whole qualified name, prefix-looking
// part and case adjustment included (an unadjusted `xlink:href` on an HTML element is
// one name); with one, lexbor's local name, the part after the prefix.
attr_local_name :: proc(attr: Attr) -> string {
	if attr_namespace(attr) == .None {
		return attr_qualified_name(attr)
	}

	n: c.size_t
	s := lxb_dom_attr_local_name(attr, &n)
	return string(s[:n]) if s != nil else ""
}

// attr_prefix returns the attribute's namespace prefix without copying it: `xlink` for
// `xlink:href`, `xmlns` for `xmlns:xlink`; "" for `xmlns` itself and for every
// attribute in no namespace.
attr_prefix :: proc(attr: Attr) -> string {
	if attr_namespace(attr) == .None {
		return ""
	}

	prefix, colon, _ := strings.partition(attr_qualified_name(attr), ":")
	return prefix if colon != "" else ""
}

// attr_value returns the attribute's value without copying it; "" for a valueless
// attribute (`<input disabled>`), as in DOM, where lexbor's value is nil.
attr_value :: #force_inline proc(attr: Attr) -> string {
	if attr == nil {
		return ""
	}

	v := (cast(^Lxb_Attr)attr).value
	return lxb_string(v^) if v != nil else ""
}

@(private = "file")
mirror :: #force_inline proc "contextless" (node: Node) -> ^Lxb_Node {
	return cast(^Lxb_Node)node
}

@(private)
lxb_string :: #force_inline proc "contextless" (s: Lxb_Str) -> string {
	return string(s.data[:s.length]) if s.data != nil else ""
}

@(private = "file")
doctype_part :: proc(node: Node, which: c.int) -> string {
	n: c.size_t
	s := larva_html_doctype_part(node, which, &n)
	return string(s[:n]) if s != nil else ""
}

@(private = "file")
namespace_from_id :: proc(id: uintptr) -> Namespace {
	switch id {
	case NS_UNDEF:
		return .None
	case NS_HTML:
		return .HTML
	case NS_MATH:
		return .MathML
	case NS_SVG:
		return .SVG
	case NS_XLINK:
		return .XLink
	case NS_XML:
		return .XML
	case NS_XMLNS:
		return .XMLNS
	}

	return .Other
}
