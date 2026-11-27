#+build linux
#+private
package larva_html

import "core:c"

// Bindings to lexbor (https://github.com/lexbor/lexbor, Apache-2.0) and to the C shim
// beside it (shim/larva_html.c). Private to the package: callers see Parser and Node
// only, so lexbor stays replaceable behind them (docs/LARVA.md, decision 4).
//
// Hand-written, not generated with odin-c-bindgen: the surface is a dozen procs, and
// everything lexbor exposes as an inline function, a macro or a struct field goes
// through the shim, which a generator could not bind anyway. The few struct fields a
// walk reads are mirrored in layout.odin, checked against the shim's sizeof/offsetof
// table; every other struct stays opaque. Revisit if the declared surface grows to
// dozens of procs.
//
// Linux only for now: scripts/build-lexbor.sh builds for the host, and only Linux is
// built and run (CLAUDE.md, "Linux-first"). lexbor_other.odin answers elsewhere.

// The paths are relative to this file and must match OUT/LIB/SHIM_LIB in
// scripts/build-lexbor.sh; `foreign import` takes only literals. The shim comes first:
// it references lexbor, and a static link resolves left to right.
foreign import lexbor {"../../.deps/lexbor/lib/liblarva_html_shim.a", "../../.deps/lexbor/lib/liblexbor_static.a"}

// lexbor/core/base.h: `typedef unsigned int lxb_status_t`; LXB_STATUS_OK = 0x0000.
lxb_status_t :: c.uint
LXB_STATUS_OK :: lxb_status_t(0)

lxb_document :: distinct rawptr // lxb_html_document_t *
larva_hook :: distinct rawptr // larva_html_hook * (shim)
css_engine :: distinct rawptr // larva_css * (shim)
css_list :: distinct rawptr // lxb_css_selector_list_t *
encoding_data :: distinct rawptr // const lxb_encoding_data_t * (lexbor's static table)

// Returns true to stop the search. C `bool`, so Odin `bool`, never b32 (CLAUDE.md §4).
css_found_cb :: #type proc "c" (node: Node, ctx: rawptr) -> bool

// Receives a piece of decoded UTF-8; false stops the decode. C `bool`, so Odin `bool`.
decode_write_cb :: #type proc "c" (ctx: rawptr, data: [^]u8, len: c.size_t) -> bool

@(default_calling_convention = "c")
foreign lexbor {
	lxb_html_document_create :: proc() -> lxb_document ---
	lxb_html_document_destroy :: proc(doc: lxb_document) -> lxb_document ---
	lxb_html_document_parse_chunk :: proc(doc: lxb_document, data: [^]u8, len: c.size_t) -> lxb_status_t ---
	lxb_html_document_parse_chunk_end :: proc(doc: lxb_document) -> lxb_status_t ---
	lxb_dom_node_text_content :: proc(node: Node, len: ^c.size_t) -> [^]u8 ---
	lxb_css_selector_list_destroy_memory :: proc(list: css_list) ---
	// Names live in lexbor's hash tables, behind ids in the mirrored structs; these are
	// lexbor's exported lookups. Callers check the node kind first (node.odin).
	lxb_dom_element_qualified_name :: proc(element: Node, len: ^c.size_t) -> [^]u8 ---
	lxb_dom_attr_qualified_name :: proc(attr: Attr, len: ^c.size_t) -> [^]u8 ---
	lxb_dom_attr_local_name :: proc(attr: Attr, len: ^c.size_t) -> [^]u8 ---
	lxb_dom_processing_instruction_target_noi :: proc(pi: Node, len: ^c.size_t) -> [^]u8 ---

	larva_html_begin :: proc(doc: lxb_document) -> larva_hook ---
	larva_html_take_script :: proc(h: larva_hook, closed: ^c.size_t) -> Node ---
	larva_html_hook_free :: proc(h: larva_hook) ---
	larva_html_document_node :: proc(doc: lxb_document) -> Node ---
	larva_html_text_free :: proc(node: Node, text: [^]u8) ---
	larva_html_attr :: proc(node: Node, name: [^]u8, name_len: c.size_t, len: ^c.size_t) -> [^]u8 ---

	larva_html_layout :: proc(count: ^c.size_t) -> [^]Layout_Entry ---
	larva_html_template_content :: proc(node: Node) -> Node ---
	larva_html_doctype_part :: proc(node: Node, part: c.int, len: ^c.size_t) -> [^]u8 ---
	larva_html_parse_fragment :: proc(doc: lxb_document, ctx: [^]u8, ctx_len: c.size_t, html: [^]u8, len: c.size_t) -> Node ---

	larva_html_sniff :: proc(data: [^]u8, len: c.size_t, label: [^]u8, label_len: c.size_t, skip: ^c.size_t, source: ^c.int) -> encoding_data ---
	larva_html_encoding_name :: proc(enc: encoding_data, len: ^c.size_t) -> [^]u8 ---
	larva_html_decode :: proc(enc: encoding_data, data: [^]u8, len: c.size_t, write: decode_write_cb, ctx: rawptr) -> bool ---

	larva_css_create :: proc() -> css_engine ---
	larva_css_destroy :: proc(e: css_engine) ---
	larva_css_compile :: proc(e: css_engine, css: [^]u8, len: c.size_t) -> css_list ---
	larva_css_find :: proc(e: css_engine, root: Node, list: css_list, found: css_found_cb, ctx: rawptr) -> bool ---
}
