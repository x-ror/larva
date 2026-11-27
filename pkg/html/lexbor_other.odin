#+build !linux
#+private
package larva_html

import "core:c"

// No lexbor build exists off Linux yet (lexbor.odin). These stand in for the bindings
// with the same names, so the package compiles on every target and `init` reports the
// truth there: lxb_html_document_create returns nil, and init fails.

lxb_status_t :: c.uint
LXB_STATUS_OK :: lxb_status_t(0)
LXB_STATUS_ERROR :: lxb_status_t(1)

lxb_document :: distinct rawptr
larva_hook :: distinct rawptr
css_engine :: distinct rawptr
css_list :: distinct rawptr
encoding_data :: distinct rawptr

css_found_cb :: #type proc "c" (node: Node, ctx: rawptr) -> bool
decode_write_cb :: #type proc "c" (ctx: rawptr, data: [^]u8, len: c.size_t) -> bool

lxb_html_document_create :: proc() -> lxb_document {return nil}
lxb_html_document_destroy :: proc(doc: lxb_document) -> lxb_document {return nil}
lxb_html_document_parse_chunk :: proc(doc: lxb_document, data: [^]u8, len: c.size_t) -> lxb_status_t {return(
		LXB_STATUS_ERROR \
	)}
lxb_html_document_parse_chunk_end :: proc(doc: lxb_document) -> lxb_status_t {return LXB_STATUS_ERROR}
larva_html_begin :: proc(doc: lxb_document) -> larva_hook {return nil}
larva_html_take_script :: proc(h: larva_hook, closed: ^c.size_t) -> Node {closed^ = 0; return nil}
larva_html_hook_free :: proc(h: larva_hook) {}
larva_html_document_node :: proc(doc: lxb_document) -> Node {return nil}
lxb_dom_node_text_content :: proc(node: Node, len: ^c.size_t) -> [^]u8 {return nil}
larva_html_text_free :: proc(node: Node, text: [^]u8) {}
larva_html_attr :: proc(node: Node, name: [^]u8, name_len: c.size_t, len: ^c.size_t) -> [^]u8 {return nil}
lxb_dom_element_qualified_name :: proc(element: Node, len: ^c.size_t) -> [^]u8 {len^ = 0; return nil}
lxb_dom_attr_qualified_name :: proc(attr: Attr, len: ^c.size_t) -> [^]u8 {len^ = 0; return nil}
lxb_dom_attr_local_name :: proc(attr: Attr, len: ^c.size_t) -> [^]u8 {len^ = 0; return nil}
lxb_dom_processing_instruction_target_noi :: proc(pi: Node, len: ^c.size_t) -> [^]u8 {len^ = 0; return nil}
larva_html_layout :: proc(count: ^c.size_t) -> [^]Layout_Entry {count^ = 0; return nil}
larva_html_template_content :: proc(node: Node) -> Node {return nil}
larva_html_doctype_part :: proc(node: Node, part: c.int, len: ^c.size_t) -> [^]u8 {len^ = 0; return nil}
larva_html_parse_fragment :: proc(doc: lxb_document, ctx: [^]u8, ctx_len: c.size_t, html: [^]u8, len: c.size_t) -> Node {
	return nil
}
larva_html_sniff :: proc(
	data: [^]u8,
	len: c.size_t,
	label: [^]u8,
	label_len: c.size_t,
	skip: ^c.size_t,
	source: ^c.int,
) -> encoding_data {
	skip^ = 0
	return nil
}
larva_html_encoding_name :: proc(enc: encoding_data, len: ^c.size_t) -> [^]u8 {len^ = 0; return nil}
larva_html_decode :: proc(enc: encoding_data, data: [^]u8, len: c.size_t, write: decode_write_cb, ctx: rawptr) -> bool {
	return false
}
// The mutation shim: no document exists off Linux, so no node ever reaches these; each
// still answers failure rather than pretending to succeed.
larva_html_insert_before :: proc(parent, node, child: Node) -> c.int {return 4}
larva_html_remove_child :: proc(parent, child: Node) -> c.int {return 4}
larva_html_replace_child :: proc(parent, node, child: Node) -> c.int {return 4}
larva_html_detach :: proc(node: Node) {}
larva_html_tag_known :: proc(node: Node) -> bool {return false}
larva_html_create_element :: proc(doc: Node, name: [^]u8, len: c.size_t) -> Node {return nil}
larva_html_create_node :: proc(doc: Node, kind: c.int, data: [^]u8, len: c.size_t) -> Node {return nil}
larva_html_clone :: proc(node: Node, deep: bool) -> Node {return nil}
larva_html_node_name :: proc(node: Node, len: ^c.size_t) -> [^]u8 {len^ = 0; return nil}
larva_html_set_attr :: proc(node: Node, name: [^]u8, name_len: c.size_t, value: [^]u8, value_len: c.size_t) -> bool {
	return false
}
larva_html_remove_attr :: proc(node: Node, name: [^]u8, name_len: c.size_t) {}
larva_html_set_data :: proc(node: Node, data: [^]u8, len: c.size_t) -> bool {return false}
larva_html_set_text_content :: proc(node: Node, data: [^]u8, len: c.size_t) -> bool {return false}
larva_html_set_inner_html :: proc(node: Node, html: [^]u8, len: c.size_t) -> bool {return false}
larva_css_create :: proc() -> css_engine {return nil}
larva_css_destroy :: proc(e: css_engine) {}
larva_css_compile :: proc(e: css_engine, css: [^]u8, len: c.size_t) -> css_list {return nil}
lxb_css_selector_list_destroy_memory :: proc(list: css_list) {}
larva_css_find :: proc(e: css_engine, root: Node, list: css_list, found: css_found_cb, ctx: rawptr) -> bool {return(
		false \
	)}
