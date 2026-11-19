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
LXB_STATUS_ERROR_MEMORY_ALLOCATION :: lxb_status_t(2)

lxb_document :: distinct rawptr
larva_hook :: distinct rawptr
css_engine :: distinct rawptr
css_list :: distinct rawptr

lxb_serialize_cb :: #type proc "c" (data: [^]u8, len: c.size_t, ctx: rawptr) -> lxb_status_t
css_found_cb :: #type proc "c" (node: Node, ctx: rawptr) -> bool

lxb_html_document_create :: proc() -> lxb_document {return nil}
lxb_html_document_destroy :: proc(doc: lxb_document) -> lxb_document {return nil}
lxb_html_document_parse_chunk :: proc(doc: lxb_document, data: [^]u8, len: c.size_t) -> lxb_status_t {return(
		LXB_STATUS_ERROR \
	)}
lxb_html_document_parse_chunk_end :: proc(doc: lxb_document) -> lxb_status_t {return LXB_STATUS_ERROR}
lxb_html_serialize_deep_cb :: proc(node: Node, cb: lxb_serialize_cb, ctx: rawptr) -> lxb_status_t {return(
		LXB_STATUS_ERROR \
	)}
larva_html_begin :: proc(doc: lxb_document) -> larva_hook {return nil}
larva_html_take_script :: proc(h: larva_hook, closed: ^c.size_t) -> Node {closed^ = 0; return nil}
larva_html_hook_free :: proc(h: larva_hook) {}
larva_html_document_node :: proc(doc: lxb_document) -> Node {return nil}
lxb_dom_node_text_content :: proc(node: Node, len: ^c.size_t) -> [^]u8 {return nil}
larva_html_text_free :: proc(node: Node, text: [^]u8) {}
larva_html_attr :: proc(node: Node, name: [^]u8, name_len: c.size_t, len: ^c.size_t) -> [^]u8 {return nil}
lxb_html_serialize_tree_cb :: proc(node: Node, cb: lxb_serialize_cb, ctx: rawptr) -> lxb_status_t {return(
		LXB_STATUS_ERROR \
	)}
larva_css_create :: proc() -> css_engine {return nil}
larva_css_destroy :: proc(e: css_engine) {}
larva_css_compile :: proc(e: css_engine, css: [^]u8, len: c.size_t) -> css_list {return nil}
lxb_css_selector_list_destroy_memory :: proc(list: css_list) {}
larva_css_find :: proc(e: css_engine, root: Node, list: css_list, found: css_found_cb, ctx: rawptr) -> bool {return(
		false \
	)}
