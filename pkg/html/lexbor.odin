package larva_html

import "core:c"

// Bindings to lexbor (https://github.com/lexbor/lexbor, Apache-2.0) and to the small C
// shim beside it (shim/larva_html.c). Only what pkg/html uses is declared; lexbor's
// structs stay opaque to Odin — anything that needs a field read, a macro or an inline
// function goes through the shim instead, so this file never mirrors a struct layout.
//
// Both archives are built by scripts/build-lexbor.sh into the gitignored .deps/
// (pinned lexbor commit, sha256-checked). The shim comes first: it references lexbor,
// and a static link resolves left to right.

when ODIN_OS == .Linux || ODIN_OS == .Darwin {
	foreign import lexbor {
		"../../.deps/lexbor/lib/liblarva_html_shim.a",
		"../../.deps/lexbor/lib/liblexbor_static.a",
	}
} else {
	// No build of lexbor exists for this target yet (Linux-first). Declared against the
	// same names so the package type-checks everywhere; linking it here fails loudly.
	foreign import lexbor "system:lexbor"
}

lxb_status_t :: c.uint
LXB_STATUS_OK :: lxb_status_t(0)

Document :: distinct rawptr // lxb_html_document_t *
Hook :: distinct rawptr // larva_html_hook * (shim)

// Node is a DOM node owned by its document; it is valid until the document is
// destroyed (or the node is removed — nothing in pkg/html removes one yet).
Node :: distinct rawptr // lxb_dom_node_t *

serialize_cb :: #type proc "c" (data: [^]u8, len: c.size_t, ctx: rawptr) -> lxb_status_t

@(default_calling_convention = "c")
foreign lexbor {
	lxb_html_document_create :: proc() -> Document ---
	lxb_html_document_destroy :: proc(doc: Document) -> Document ---
	lxb_html_document_parse_chunk :: proc(doc: Document, data: [^]u8, len: c.size_t) -> lxb_status_t ---
	lxb_html_document_parse_chunk_end :: proc(doc: Document) -> lxb_status_t ---
	lxb_html_serialize_deep_cb :: proc(node: Node, cb: serialize_cb, ctx: rawptr) -> lxb_status_t ---

	larva_html_begin :: proc(doc: Document) -> Hook ---
	larva_html_take_script :: proc(h: Hook) -> Node ---
	larva_html_hook_free :: proc(h: Hook) ---
	larva_html_document_node :: proc(doc: Document) -> Node ---
	larva_html_text :: proc(node: Node, len: ^c.size_t) -> [^]u8 ---
	larva_html_text_free :: proc(node: Node, text: [^]u8) ---
	larva_html_attr :: proc(node: Node, name: [^]u8, name_len: c.size_t, len: ^c.size_t) -> [^]u8 ---
}
