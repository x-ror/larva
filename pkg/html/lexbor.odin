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
// through the shim, which a generator could not bind anyway. lexbor's structs stay
// opaque here. Revisit if the declared surface grows to dozens of procs.
//
// Linux only for now: scripts/build-lexbor.sh builds for the host, and only Linux is
// built and run (CLAUDE.md, "Linux-first"). lexbor_other.odin answers elsewhere.

// The paths are relative to this file and must match OUT/LIB/SHIM_LIB in
// scripts/build-lexbor.sh; `foreign import` takes only literals. The shim comes first:
// it references lexbor, and a static link resolves left to right.
foreign import lexbor {"../../.deps/lexbor/lib/liblarva_html_shim.a", "../../.deps/lexbor/lib/liblexbor_static.a"}

// lexbor/core/base.h: `typedef unsigned int lxb_status_t`, LXB_STATUS_OK = 0x0000.
lxb_status_t :: c.uint
LXB_STATUS_OK :: lxb_status_t(0)

lxb_document :: distinct rawptr // lxb_html_document_t *
larva_hook :: distinct rawptr // larva_html_hook * (shim)
larva_css_engine :: distinct rawptr // larva_css * (shim)
lxb_selector_list :: distinct rawptr // lxb_css_selector_list_t *

lxb_serialize_cb :: #type proc "c" (data: [^]u8, len: c.size_t, ctx: rawptr) -> lxb_status_t
// Returns true to stop the search. C `bool`, so Odin `bool`, never b32 (CLAUDE.md §4).
larva_css_found_cb :: #type proc "c" (node: Node, ctx: rawptr) -> bool

@(default_calling_convention = "c")
foreign lexbor {
	lxb_html_document_create :: proc() -> lxb_document ---
	lxb_html_document_destroy :: proc(doc: lxb_document) -> lxb_document ---
	lxb_html_document_parse_chunk :: proc(doc: lxb_document, data: [^]u8, len: c.size_t) -> lxb_status_t ---
	lxb_html_document_parse_chunk_end :: proc(doc: lxb_document) -> lxb_status_t ---
	lxb_html_serialize_deep_cb :: proc(node: Node, cb: lxb_serialize_cb, ctx: rawptr) -> lxb_status_t ---

	larva_html_begin :: proc(doc: lxb_document) -> larva_hook ---
	larva_html_take_script :: proc(h: larva_hook, closed: ^c.size_t) -> Node ---
	larva_html_hook_free :: proc(h: larva_hook) ---
	larva_html_document_node :: proc(doc: lxb_document) -> Node ---
	larva_html_text :: proc(node: Node, len: ^c.size_t) -> [^]u8 ---
	larva_html_text_free :: proc(node: Node, text: [^]u8) ---
	larva_html_attr :: proc(node: Node, name: [^]u8, name_len: c.size_t, len: ^c.size_t) -> [^]u8 ---
	larva_html_serialize_node :: proc(node: Node, cb: lxb_serialize_cb, ctx: rawptr) -> lxb_status_t ---

	larva_css_create :: proc() -> larva_css_engine ---
	larva_css_destroy :: proc(e: larva_css_engine) ---
	larva_css_compile :: proc(e: larva_css_engine, css: [^]u8, len: c.size_t) -> lxb_selector_list ---
	larva_css_free :: proc(list: lxb_selector_list) ---
	larva_css_find :: proc(e: larva_css_engine, root: Node, list: lxb_selector_list, found: larva_css_found_cb, ctx: rawptr) -> bool ---
}
