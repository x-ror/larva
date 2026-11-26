#+private
package larva_html

import "core:c"

// An Odin mirror of the lexbor structs the tree is walked through (docs/LARVA.md D5),
// so that a walk — dump_tree, the serializer, stage 4's bindings — reads `next`, `type`
// or an attribute's value with a plain load instead of a call into the shim per field.
// Everything else (names, which live in lexbor's hash tables; doctypes; templates)
// still goes through lexbor's exported functions or the shim.
//
// The layout is lexbor's at the commit scripts/build-lexbor.sh pins, and nothing in
// Odin can see it: layout_mirror_matches_the_shim compares every size, offset and
// constant here with the table the shim builds with sizeof/offsetof from lexbor's own
// headers (larva_html_layout). A lexbor bump that moves a field fails that test before
// anything reads through the stale mirror. A field added here needs its line in both
// tables.
//
// Mirrors are prefixes where only a prefix is read: Lxb_Element stops at last_attr, and
// a pointer to one is never dereferenced past it. Off Linux there is no lexbor and no
// node to read; the declarations compile there and are never used.

// lexbor/dom/interfaces/node.h: struct lxb_dom_node (event_target is one pointer).
Lxb_Node :: struct {
	events:         rawptr,
	local_name:     uintptr, // tag id (LXB_TAG_*), or an attribute id for an attr node
	prefix:         uintptr, // prefix id; 0 for none
	ns:             uintptr, // namespace id (LXB_NS_*)
	owner_document: rawptr,
	next:           ^Lxb_Node,
	prev:           ^Lxb_Node,
	parent:         ^Lxb_Node,
	first_child:    ^Lxb_Node,
	last_child:     ^Lxb_Node,
	user:           rawptr, // reserved for the Odin side data of decision D1 (stage 3e)
	type:           Node_Type, // lxb_dom_node_type_t, a C enum
}

// lexbor/core/str.h: lexbor_str_t.
Lxb_Str :: struct {
	data:   [^]u8,
	length: c.size_t,
}

// lexbor/dom/interfaces/element.h: struct lxb_dom_element, up to last_attr.
Lxb_Element :: struct {
	node:           Lxb_Node,
	upper_name:     uintptr,
	qualified_name: uintptr,
	is_value:       ^Lxb_Str,
	first_attr:     ^Lxb_Attr,
	last_attr:      ^Lxb_Attr,
}

// lexbor/dom/interfaces/attr.h: struct lxb_dom_attr.
Lxb_Attr :: struct {
	node:           Lxb_Node,
	upper_name:     uintptr,
	qualified_name: uintptr,
	value:          ^Lxb_Str, // nil for a valueless attribute (`<input disabled>`)
	owner:          rawptr,
	next:           ^Lxb_Attr,
	prev:           ^Lxb_Attr,
}

// lexbor/dom/interfaces/character_data.h: text, comment, CDATA section and (with a
// target after it) processing instruction.
Lxb_Character_Data :: struct {
	node: Lxb_Node,
	data: Lxb_Str,
}

// lexbor's namespace ids (lexbor/ns/const.h). Any other id is a hash entry's address.
NS_UNDEF :: uintptr(0x00)
NS_HTML :: uintptr(0x02)
NS_MATH :: uintptr(0x03)
NS_SVG :: uintptr(0x04)
NS_XLINK :: uintptr(0x05)
NS_XML :: uintptr(0x06)
NS_XMLNS :: uintptr(0x07)

// The tag ids the serializer branches on (lexbor/tag/const.h). Ids of names lexbor
// does not know are allocated above these per document, so a comparison with one of
// these is exact; the namespace still has to be checked (an SVG <script> shares the id).
TAG_AREA :: uintptr(0x13)
TAG_BASE :: uintptr(0x18)
TAG_BASEFONT :: uintptr(0x19)
TAG_BGSOUND :: uintptr(0x1c)
TAG_BR :: uintptr(0x21)
TAG_COL :: uintptr(0x29)
TAG_EMBED :: uintptr(0x38)
TAG_FRAME :: uintptr(0x59)
TAG_HR :: uintptr(0x65)
TAG_IFRAME :: uintptr(0x68)
TAG_IMG :: uintptr(0x6a)
TAG_INPUT :: uintptr(0x6b)
TAG_KEYGEN :: uintptr(0x6f)
TAG_LINK :: uintptr(0x74)
TAG_META :: uintptr(0x7d)
TAG_NOEMBED :: uintptr(0x8a)
TAG_NOFRAMES :: uintptr(0x8b)
TAG_PARAM :: uintptr(0x93)
TAG_PLAINTEXT :: uintptr(0x96)
TAG_SCRIPT :: uintptr(0xa2)
TAG_SOURCE :: uintptr(0xa9)
TAG_STYLE :: uintptr(0xae)
TAG_TEMPLATE :: uintptr(0xb6)
TAG_TRACK :: uintptr(0xbf)
TAG_WBR :: uintptr(0xc5)
TAG_XMP :: uintptr(0xc6)

// One row of the shim's table: a name such as "node.next" and its value.
Layout_Entry :: struct {
	name:  cstring,
	value: c.size_t,
}

// layout_entries is the mirror's side of the table, under the names the shim uses.
layout_entries :: proc(allocator := context.temp_allocator) -> map[string]uintptr {
	m := make(map[string]uintptr, allocator)
	m["node.size"] = uintptr(size_of(Lxb_Node))
	m["node.local_name"] = offset_of(Lxb_Node, local_name)
	m["node.prefix"] = offset_of(Lxb_Node, prefix)
	m["node.ns"] = offset_of(Lxb_Node, ns)
	m["node.next"] = offset_of(Lxb_Node, next)
	m["node.prev"] = offset_of(Lxb_Node, prev)
	m["node.parent"] = offset_of(Lxb_Node, parent)
	m["node.first_child"] = offset_of(Lxb_Node, first_child)
	m["node.last_child"] = offset_of(Lxb_Node, last_child)
	m["node.user"] = offset_of(Lxb_Node, user)
	m["node.type"] = offset_of(Lxb_Node, type)
	m["node.type.size"] = uintptr(size_of(Node_Type))
	m["str.size"] = uintptr(size_of(Lxb_Str))
	m["str.data"] = offset_of(Lxb_Str, data)
	m["str.length"] = offset_of(Lxb_Str, length)
	m["element.first_attr"] = offset_of(Lxb_Element, first_attr)
	m["element.last_attr"] = offset_of(Lxb_Element, last_attr)
	m["attr.size"] = uintptr(size_of(Lxb_Attr))
	m["attr.value"] = offset_of(Lxb_Attr, value)
	m["attr.next"] = offset_of(Lxb_Attr, next)
	m["attr.prev"] = offset_of(Lxb_Attr, prev)
	m["character_data.size"] = uintptr(size_of(Lxb_Character_Data))
	m["character_data.data"] = offset_of(Lxb_Character_Data, data)
	m["ns.html"] = NS_HTML
	m["ns.math"] = NS_MATH
	m["ns.svg"] = NS_SVG
	m["ns.xlink"] = NS_XLINK
	m["ns.xml"] = NS_XML
	m["ns.xmlns"] = NS_XMLNS
	m["tag.area"] = TAG_AREA
	m["tag.base"] = TAG_BASE
	m["tag.basefont"] = TAG_BASEFONT
	m["tag.bgsound"] = TAG_BGSOUND
	m["tag.br"] = TAG_BR
	m["tag.col"] = TAG_COL
	m["tag.embed"] = TAG_EMBED
	m["tag.frame"] = TAG_FRAME
	m["tag.hr"] = TAG_HR
	m["tag.iframe"] = TAG_IFRAME
	m["tag.img"] = TAG_IMG
	m["tag.input"] = TAG_INPUT
	m["tag.keygen"] = TAG_KEYGEN
	m["tag.link"] = TAG_LINK
	m["tag.meta"] = TAG_META
	m["tag.noembed"] = TAG_NOEMBED
	m["tag.noframes"] = TAG_NOFRAMES
	m["tag.param"] = TAG_PARAM
	m["tag.plaintext"] = TAG_PLAINTEXT
	m["tag.script"] = TAG_SCRIPT
	m["tag.source"] = TAG_SOURCE
	m["tag.style"] = TAG_STYLE
	m["tag.template"] = TAG_TEMPLATE
	m["tag.track"] = TAG_TRACK
	m["tag.wbr"] = TAG_WBR
	m["tag.xmp"] = TAG_XMP
	for t in Node_Type {
		m[node_type_key(t)] = uintptr(t)
	}
	return m
}

@(private = "file")
node_type_key :: proc(t: Node_Type) -> string {
	switch t {
	case .Undefined:
		return "type.undef"
	case .Element:
		return "type.element"
	case .Attribute:
		return "type.attribute"
	case .Text:
		return "type.text"
	case .CDATA_Section:
		return "type.cdata_section"
	case .Processing_Instruction:
		return "type.processing_instruction"
	case .Comment:
		return "type.comment"
	case .Document:
		return "type.document"
	case .Document_Type:
		return "type.document_type"
	case .Document_Fragment:
		return "type.document_fragment"
	}
	return ""
}
