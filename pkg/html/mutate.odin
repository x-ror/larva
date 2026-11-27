package larva_html

import "core:c"

// The tree write API: what the DOM bindings (pkg/runtime/dom.odin, docs/LARVA.md
// roadmap stage 4) mutate a document through, so the serializer (serialize.odin) and
// the selector engine see every change. Each proc goes through lexbor's own DOM, via
// the shim (shim/larva_html.c), never through the layout mirror: the mirror is read-only.
//
// One rule for all of it: a node is detached, never destroyed, until the Parser that
// owns the document is destroyed. A JS wrapper may point at any node a script ever
// touched, so freeing one on removal would leave the wrapper dangling; the document's
// memory is the page's arena (docs/LARVA.md decision 4) and is freed whole with it.

// Mutation_Error is what a spec mutation (appendChild, insertBefore, removeChild,
// replaceChild) refused with, as the DOMException name it maps to. Failed is anything
// else lexbor reported, an allocation failure included.
Mutation_Error :: enum c.int {
	None              = 0,
	Hierarchy_Request = 1,
	Not_Found         = 2,
	Not_Supported     = 3,
	Failed            = 4,
}

// insert_before inserts `node` into `parent` before `child`, or last when `child` is nil,
// after the DOM Standard's pre-insertion validity checks. A document fragment inserts
// its children. `node` is first removed from wherever it was.
//
// Chrome:
//   Node.insertBefore / appendChild are the model; tests/dom `*.page` cases record them.
insert_before :: proc(parent, node, child: Node) -> Mutation_Error {
	if parent == nil || node == nil {
		return .Failed
	}

	return Mutation_Error(larva_html_insert_before(parent, node, child))
}

// append_child is insert_before with no reference child.
append_child :: proc(parent, node: Node) -> Mutation_Error {
	return insert_before(parent, node, nil)
}

// remove_child detaches `child` from `parent`; .Not_Found when it is not its child.
remove_child :: proc(parent, child: Node) -> Mutation_Error {
	if parent == nil || child == nil {
		return .Failed
	}

	return Mutation_Error(larva_html_remove_child(parent, child))
}

// replace_child puts `node` where `child` is under `parent`, detaching `child`.
replace_child :: proc(parent, node, child: Node) -> Mutation_Error {
	if parent == nil || node == nil || child == nil {
		return .Failed
	}

	return Mutation_Error(larva_html_replace_child(parent, node, child))
}

// detach removes `node` from its parent, if it has one.
detach :: proc(node: Node) {
	if node != nil {
		larva_html_detach(node)
	}
}

// create_element creates an element named `local_name` in `doc`'s namespace (HTML for
// an HTML document). The caller lowercases the name, as createElement does for an HTML
// document; nil when lexbor could not allocate it or `doc` is not a document.
create_element :: proc(doc: Node, local_name: string) -> Node {
	if node_type(doc) != .Document || local_name == "" {
		return nil
	}

	return larva_html_create_element(doc, raw_data(local_name), c.size_t(len(local_name)))
}

// create_text creates a detached text node holding `data`.
create_text :: proc(doc: Node, data: string) -> Node {
	return create_node(doc, .Text, data)
}

// create_comment creates a detached comment holding `data`.
create_comment :: proc(doc: Node, data: string) -> Node {
	return create_node(doc, .Comment, data)
}

// create_fragment creates an empty document fragment.
create_fragment :: proc(doc: Node) -> Node {
	return create_node(doc, .Document_Fragment, "")
}

// clone copies `node`, and its descendants when `deep`, into a detached node of the
// same document; nil when lexbor could not allocate it.
clone :: proc(node: Node, deep: bool) -> Node {
	if node == nil {
		return nil
	}

	return larva_html_clone(node, deep)
}

// node_name returns Node.nodeName without copying it: the tag name (uppercase for an
// HTML element), `#text`, `#comment`, `#document`, `#document-fragment`, a doctype's
// name. "" for nil.
node_name :: proc(node: Node) -> string {
	if node == nil {
		return ""
	}

	n: c.size_t
	s := larva_html_node_name(node, &n)
	return string(s[:n]) if s != nil else ""
}

// tag_is_known reports whether element `node`'s name is one lexbor's tag table knows
// (every HTML element, obsolete ones included) rather than a name first seen in this
// document; false for any other node.
tag_is_known :: proc(node: Node) -> bool {
	return node != nil && larva_html_tag_known(node)
}

// set_attr sets attribute `name` of element `node` to `value`, adding it last when
// absent. The caller lowercases `name` for an HTML element. false when `node` is not an
// element or lexbor could not allocate.
set_attr :: proc(node: Node, name, value: string) -> bool {
	if node_type(node) != .Element || name == "" {
		return false
	}

	return larva_html_set_attr(node, raw_data(name), c.size_t(len(name)), bytes_of(value), c.size_t(len(value)))
}

// remove_attr removes attribute `name` from element `node`, if present.
remove_attr :: proc(node: Node, name: string) {
	if node_type(node) == .Element && name != "" {
		larva_html_remove_attr(node, raw_data(name), c.size_t(len(name)))
	}
}

// set_data replaces the data of a text, comment, CDATA section or processing
// instruction; false for any other node or a failed allocation.
set_data :: proc(node: Node, data: string) -> bool {
	if node == nil {
		return false
	}

	return larva_html_set_data(node, bytes_of(data), c.size_t(len(data)))
}

// set_text_content is Node.textContent's setter: an element or fragment has its
// children detached and replaced by one text node (none for ""); character data has its
// data replaced; anything else is left alone and answers true, as the setter does
// nothing there.
set_text_content :: proc(node: Node, data: string) -> bool {
	#partial switch node_type(node) {
	case .Element, .Document_Fragment, .Text, .Comment, .CDATA_Section, .Processing_Instruction:
		return larva_html_set_text_content(node, bytes_of(data), c.size_t(len(data)))
	case .Undefined:
		return false
	}

	return true
}

// set_inner_html parses `markup` with `node` as the fragment parsing context and
// replaces `node`'s children (a template's content) with the result. Safe while the
// page's own parse is paused at a script: the fragment gets a parser of its own.
//
// Returns:
//   false when `node` is not an element or lexbor failed; the children are then those
//   it had.
// Chrome:
//   Element.innerHTML's setter is the model; tests/dom `*.page` cases record it.
set_inner_html :: proc(node: Node, markup: string) -> bool {
	if node_type(node) != .Element {
		return false
	}

	return larva_html_set_inner_html(node, bytes_of(markup), c.size_t(len(markup)))
}

@(private = "file", rodata)
EMPTY_BYTE := [1]u8{0}

// bytes_of hands lexbor a non-nil pointer for an empty string: a nil data pointer with
// a zero length is legal C for memcpy but not every lexbor path checks the length first.
@(private = "file")
bytes_of :: proc(s: string) -> [^]u8 {
	return raw_data(s) if len(s) > 0 else raw_data(EMPTY_BYTE[:])
}

@(private = "file")
create_node :: proc(doc: Node, kind: Node_Type, data: string) -> Node {
	if node_type(doc) != .Document {
		return nil
	}

	return larva_html_create_node(doc, c.int(kind), bytes_of(data), c.size_t(len(data)))
}
