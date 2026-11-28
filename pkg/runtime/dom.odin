package lava_runtime

import "base:runtime"
import "core:c"
import "core:strings"
import "core:sync"
import html "lava:pkg/html"
import jsc "lava:pkg/jsc"

// The DOM bindings' native half (docs/LARVA.md decision 4, roadmap stage 4a): the
// page's document, the node -> wrapper map, and the natives internal/dom's interfaces
// call. The spec surface — conversions, error text, the interface objects — is
// js/internal/dom.js; the tree and its mutation are pkg/html's (lexbor).
//
// The wrapper rule, which is memory safety rather than polish:
//   - a node's wrapper is made on first use (dom_wrap), recorded in Dom_Page.wrappers
//     and JSValueProtect'ed until the page closes, so identity (`a.firstChild ===
//     a.firstChild`) and expandos hold for the page's life;
//   - its private slot is the lexbor node. Its JSClass is its interface's — one per
//     WebIDL interface, made per page, each a child of the page's root class — which is
//     what supplies the slot, and what JSC answers Symbol.toStringTag with for a
//     JSCallbackObject (it reports the class name whatever the prototype holds, so a
//     single shared class read `[object LarvaNode]` for every node). The root class is
//     the natives' brand check (JSValueIsObjectOfClass walks the parent chain), so a
//     wrapper of another page — or any other object, the global included, whose slot
//     holds a Runtime_State — is never read as a node;
//   - teardown (dom_release) is, for every wrapper, JSObjectSetPrivate(nil) then
//     JSValueUnprotect, and only after all of them the document's memory is freed
//     (html.destroy, the page arena). A pooled VM keeps unreachable wrappers until its
//     next collection, so every native treats a nil private pointer as "page gone" and
//     throws `Illegal invocation`; the class has no finalizer, as nothing a wrapper holds
//     is freed per wrapper.
//
// Nodes are only ever detached, never freed, before the page closes (pkg/html
// mutate.odin), which is what makes a wrapper of a removed node safe to keep.
//
// Hand-written natives, not generated from WebIDL: stage 4a's interfaces are few, and the
// natives are deliberately coarse (one per DOM operation, the receiver first) so a later
// generator emits calls to them rather than replacing them.

// Dom_Interface is the interface a wrapper's prototype comes from. internal/dom.js
// defines each under the same name (DOM_INTERFACE_NAMES) and its install answers their
// prototypes in this order.
Dom_Interface :: enum u8 {
	HTML_Document,
	Document_Type,
	Document_Fragment,
	Text,
	Comment,
	Processing_Instruction,
	Element,
	HTML_Element,
	HTML_Unknown_Element,
	HTML_Html_Element,
	HTML_Head_Element,
	HTML_Body_Element,
	HTML_Title_Element,
	HTML_Meta_Element,
	HTML_Link_Element,
	HTML_Style_Element,
	HTML_Script_Element,
	HTML_Div_Element,
	HTML_Span_Element,
	HTML_Paragraph_Element,
	HTML_Heading_Element,
	HTML_Anchor_Element,
	HTML_UList_Element,
	HTML_OList_Element,
	HTML_LI_Element,
	HTML_DList_Element,
	HTML_Pre_Element,
	HTML_Quote_Element,
	HTML_BR_Element,
	HTML_HR_Element,
	HTML_Image_Element,
	HTML_Form_Element,
	HTML_Input_Element,
	HTML_Button_Element,
	HTML_Label_Element,
	HTML_Select_Element,
	HTML_Option_Element,
	HTML_Text_Area_Element,
	HTML_Table_Element,
	HTML_Table_Section_Element,
	HTML_Table_Row_Element,
	HTML_Table_Cell_Element,
	HTML_Template_Element,
	HTML_IFrame_Element,
}

// The WebIDL name of each Dom_Interface, as internal/dom.js defines it.
DOM_INTERFACE_NAMES :: [Dom_Interface]string {
	.HTML_Document              = "HTMLDocument",
	.Document_Type              = "DocumentType",
	.Document_Fragment          = "DocumentFragment",
	.Text                       = "Text",
	.Comment                    = "Comment",
	.Processing_Instruction     = "ProcessingInstruction",
	.Element                    = "Element",
	.HTML_Element               = "HTMLElement",
	.HTML_Unknown_Element       = "HTMLUnknownElement",
	.HTML_Html_Element          = "HTMLHtmlElement",
	.HTML_Head_Element          = "HTMLHeadElement",
	.HTML_Body_Element          = "HTMLBodyElement",
	.HTML_Title_Element         = "HTMLTitleElement",
	.HTML_Meta_Element          = "HTMLMetaElement",
	.HTML_Link_Element          = "HTMLLinkElement",
	.HTML_Style_Element         = "HTMLStyleElement",
	.HTML_Script_Element        = "HTMLScriptElement",
	.HTML_Div_Element           = "HTMLDivElement",
	.HTML_Span_Element          = "HTMLSpanElement",
	.HTML_Paragraph_Element     = "HTMLParagraphElement",
	.HTML_Heading_Element       = "HTMLHeadingElement",
	.HTML_Anchor_Element        = "HTMLAnchorElement",
	.HTML_UList_Element         = "HTMLUListElement",
	.HTML_OList_Element         = "HTMLOListElement",
	.HTML_LI_Element            = "HTMLLIElement",
	.HTML_DList_Element         = "HTMLDListElement",
	.HTML_Pre_Element           = "HTMLPreElement",
	.HTML_Quote_Element         = "HTMLQuoteElement",
	.HTML_BR_Element            = "HTMLBRElement",
	.HTML_HR_Element            = "HTMLHRElement",
	.HTML_Image_Element         = "HTMLImageElement",
	.HTML_Form_Element          = "HTMLFormElement",
	.HTML_Input_Element         = "HTMLInputElement",
	.HTML_Button_Element        = "HTMLButtonElement",
	.HTML_Label_Element         = "HTMLLabelElement",
	.HTML_Select_Element        = "HTMLSelectElement",
	.HTML_Option_Element        = "HTMLOptionElement",
	.HTML_Text_Area_Element     = "HTMLTextAreaElement",
	.HTML_Table_Element         = "HTMLTableElement",
	.HTML_Table_Section_Element = "HTMLTableSectionElement",
	.HTML_Table_Row_Element     = "HTMLTableRowElement",
	.HTML_Table_Cell_Element    = "HTMLTableCellElement",
	.HTML_Template_Element      = "HTMLTemplateElement",
	.HTML_IFrame_Element        = "HTMLIFrameElement",
}

// Dom_Page is one page's DOM: its document (the parser owns it, and its memory is the
// page's arena), the wrappers made for its nodes, and what the natives need. Owned by
// the page's Runtime_State (Runtime_State.dom), allocated and freed through its
// allocator, released by dom_release from destroy_runtime_state while the context is
// still alive.
Dom_Page :: struct {
	allocator: runtime.Allocator,
	// The page's document and its parse; html.destroy frees every node at once.
	parser:    html.Parser,
	selectors: html.Selectors,
	// The wrapper classes: the root (the parent of every interface class, and the brand)
	// and one per interface. Process-wide, never released: dom_create_classes says why.
	class:     jsc.JSClassRef,
	classes:   ^[Dom_Interface]jsc.JSClassRef,
	// node -> its wrapper, each JSValueProtect'ed until dom_release. Bound to `allocator`
	// at creation (CLAUDE.md §4): natives insert from `proc "c"` callbacks.
	wrappers:  map[html.Node]jsc.JSObjectRef,
	// Each interface's prototype, from internal/dom's install; protected.
	protos:    [Dom_Interface]jsc.JSObjectRef,
	// internal/dom's advance, which moves the document's readiness on and fires its
	// events (dom_advance); protected.
	advance:   jsc.JSValueRef,
	// internal/mutation_observer's `parsed`, which queues the records of the nodes the
	// parser inserted (dom_parser_checkpoint); protected.
	parsed:    jsc.JSValueRef,
	// internal/dom's fireAt, which fires a script element's load or error
	// (page_script.odin script_fire); protected.
	fire_at:   jsc.JSValueRef,
	// The page this DOM is the document of, for the natives that run a script (an
	// inserted one, document.write's): set by the page loader once the DOM is installed,
	// nil until then. The Page outlives the DOM (page_close releases the DOM first).
	page:      ^Page,
	// The page's script elements: what has started, what waits to run (page_script.odin).
	scripts:   Page_Scripts,
}

// The wrapper classes, created once per process by dom_create_classes and never
// released. Process-global and shared-safe like fetch.odin's classes: a JSClassRef
// belongs to no context group, and these hold no callbacks or data, only names and the
// parent link — a wrapper's node sits in its own private slot.
@(private = "file")
g_dom_classes_once: sync.Once
@(private = "file")
g_dom_root_class: jsc.JSClassRef
@(private = "file")
g_dom_classes: [Dom_Interface]jsc.JSClassRef
@(private = "file")
g_dom_classes_error: string

// dom_install creates the page's document and installs the DOM on the page's realm —
// `document`, `window` and the node interfaces — before any of the page's scripts run.
//
// Returns:
//   "" on success, with state.dom set; otherwise why not (no lexbor build on this
//   target, an allocation failure, or internal/dom refusing). state.dom may still be set
//   on a failure, and dom_release then frees what was made.
// Chrome:
//   `window === globalThis` and `document` as a page's realm has them; the interfaces are
//   internal/dom.js's.
dom_install :: proc(ctx: jsc.JSContextRef, state: ^Runtime_State) -> string {
	if state == nil || state.loader == nil {
		return "the page has no runtime to install a DOM into"
	}

	dom, alloc_err := new(Dom_Page, state.allocator)

	if alloc_err != nil {
		return "could not allocate the page's DOM"
	}

	dom.allocator = state.allocator
	dom.wrappers = make(map[html.Node]jsc.JSObjectRef, state.allocator)
	scripts_init(&dom.scripts, state.allocator)
	state.dom = dom

	if !html.init(&dom.parser, dom.allocator) {
		return html.error_message(&dom.parser)
	}

	if !html.selectors_init(&dom.selectors) {
		return "lexbor could not create the selector engine"
	}

	sync.once_do(&g_dom_classes_once, dom_create_classes)

	if g_dom_classes_error != "" {
		return g_dom_classes_error
	}

	dom.class = g_dom_root_class
	dom.classes = &g_dom_classes

	install := get_named(ctx, cast(jsc.JSObjectRef)state.loader, "installDom")

	if install == nil || !jsc.JSValueIsObject(ctx, install) {
		return "the module loader has no installDom"
	}

	names := jsc.JSObjectMakeArray(ctx, 0, nil, nil)

	for name, iface in DOM_INTERFACE_NAMES {
		jsc.JSObjectSetPropertyAtIndex(ctx, names, c.uint(iface), js_string_value(ctx, name), nil)
	}

	args := [2]jsc.JSValueRef{cast(jsc.JSValueRef)make_dom_bindings(ctx), cast(jsc.JSValueRef)names}
	exception: jsc.JSValueRef
	installed := jsc.JSObjectCallAsFunction(ctx, cast(jsc.JSObjectRef)install, nil, 2, raw_data(args[:]), &exception)

	if exception != nil || installed == nil || !jsc.JSValueIsObject(ctx, installed) {
		if exception != nil {
			report_internal_exception(ctx, "internal:dom", exception)
		}

		return "internal/dom failed to install"
	}

	protos := get_named(ctx, cast(jsc.JSObjectRef)installed, "protos")

	if protos == nil || !jsc.JSValueIsObject(ctx, protos) {
		return "internal/dom answered no prototypes"
	}

	for iface in Dom_Interface {
		proto := jsc.JSObjectGetPropertyAtIndex(ctx, cast(jsc.JSObjectRef)protos, c.uint(iface), nil)

		if proto == nil || !jsc.JSValueIsObject(ctx, proto) {
			return "internal/dom answered no prototype for an interface"
		}

		jsc.JSValueProtect(ctx, proto)
		dom.protos[iface] = cast(jsc.JSObjectRef)proto
	}

	advance := get_named(ctx, cast(jsc.JSObjectRef)installed, "advance")

	if advance == nil || !jsc.JSValueIsObject(ctx, advance) {
		return "internal/dom answered no readiness step"
	}

	jsc.JSValueProtect(ctx, advance)
	dom.advance = advance

	parsed := get_named(ctx, cast(jsc.JSObjectRef)installed, "parsed")

	if parsed == nil || !jsc.JSValueIsObject(ctx, parsed) {
		return "internal/dom answered no parser record step"
	}

	jsc.JSValueProtect(ctx, parsed)
	dom.parsed = parsed

	fire_at := get_named(ctx, cast(jsc.JSObjectRef)installed, "fireAt")

	if fire_at == nil || !jsc.JSValueIsObject(ctx, fire_at) {
		return "internal/dom answered no element event step"
	}

	jsc.JSValueProtect(ctx, fire_at)
	dom.fire_at = fire_at
	return ""
}

// dom_release tears the page's DOM down: every wrapper's private slot is cleared and
// the wrapper unprotected, and only then is the document freed (docs/LARVA.md decision
// 4's order). Safe on a partial dom_install and on a state with no DOM. Called by
// destroy_runtime_state with the context still alive.
dom_release :: proc(ctx: jsc.JSContextRef, state: ^Runtime_State) {
	dom := state.dom

	if dom == nil {
		return
	}

	// First, so a native the teardown could still reach finds no page.
	state.dom = nil

	for _, wrapper in dom.wrappers {
		jsc.JSObjectSetPrivate(wrapper, nil)
		unprotect_before_eval_exit(ctx, cast(jsc.JSValueRef)wrapper)
	}

	delete(dom.wrappers)

	for proto in dom.protos {
		unprotect_before_eval_exit(ctx, cast(jsc.JSValueRef)proto)
	}

	unprotect_before_eval_exit(ctx, dom.advance)
	unprotect_before_eval_exit(ctx, dom.fire_at)
	scripts_destroy(&dom.scripts)

	if dom.parsed != nil {
		unprotect_before_eval_exit(ctx, dom.parsed)
	}

	html.selectors_destroy(&dom.selectors)
	html.destroy(&dom.parser)

	// The wrapper classes are not the page's to release (dom_create_classes).
	free(dom, dom.allocator)
}

// dom_document returns the page's Document node; nil without a DOM.
dom_document :: proc(state: ^Runtime_State) -> html.Node {
	if state == nil || state.dom == nil {
		return nil
	}

	return html.document(&state.dom.parser)
}

// Dom_Readiness is a document readiness the page loader moves the document to
// (HTML's "current document readiness"; it starts `loading`).
Dom_Readiness :: enum {
	// The parse is done: readystatechange at the document. The deferred scripts run next.
	Interactive,
	// The deferred scripts ran: DOMContentLoaded at the document (readyState stays).
	Content_Loaded,
	// The page's loop idled: readystatechange at the document, then `load` at the window.
	Complete,
}

// dom_advance moves the document to `stage` and fires that change's events, one listener
// per call into JS (internal/dom advance), so that JSC's microtask drain at the end of
// each call is the checkpoint after each listener a browser has.
//
// Returns:
//   false when the page has no DOM, or a step threw past the dispatch (a listener's
//   throw is reported by the dispatch itself and does not count), or the page ended.
// Chrome:
//   Chrome 158, tests/dom/cases/dom-load.page: readyState and the order of
//   readystatechange, DOMContentLoaded, load, and the microtasks between listeners;
//   tests/dom/cases/dom-script-defer.page: the deferred scripts between the
//   `interactive` readystatechange and DOMContentLoaded.
dom_advance :: proc(ctx: jsc.JSContextRef, page: ^Page, stage: Dom_Readiness) -> bool {
	state := page.state

	if state == nil || state.dom == nil || state.dom.advance == nil {
		return false
	}

	// The parse is over: what it inserted since the last script is reported before
	// DOMContentLoaded, at the checkpoint that ends the parser's task.
	if stage == .Interactive && !dom_parser_checkpoint(ctx, page) {
		return false
	}

	NAMES :: [Dom_Readiness]string {
		.Interactive    = "interactive",
		.Content_Loaded = "contentloaded",
		.Complete       = "complete",
	}
	names := NAMES
	args := [1]jsc.JSValueRef{js_string_value(ctx, names[stage])}
	exception: jsc.JSValueRef
	vm_cpu_enter(page.vm)
	step := jsc.JSObjectCallAsFunction(ctx, cast(jsc.JSObjectRef)state.dom.advance, nil, 1, raw_data(args[:]), &exception)
	vm_cpu_exit(page.vm)

	if exception != nil || step == nil || !jsc.JSValueIsObject(ctx, step) {
		return false
	}

	return dom_run_steps(ctx, page, step)
}

// dom_run_steps calls a step function internal/dom answered (advance's, fireAt's) until
// it answers false: one listener a call, so JSC's microtask drain as each call leaves the
// VM is the checkpoint after each listener.
//
// Returns:
//   false when the page ended, its DOM went, or a step threw past the dispatch.
dom_run_steps :: proc(ctx: jsc.JSContextRef, page: ^Page, step: jsc.JSValueRef) -> bool {
	exception: jsc.JSValueRef

	// Our own root across the steps: each one can allocate, and so collect.
	jsc.JSValueProtect(ctx, step)
	defer jsc.JSValueUnprotect(ctx, step)

	for {
		if page.finished || page.state == nil || page.state.dom == nil {
			return false
		}

		vm_cpu_enter(page.vm)
		more := jsc.JSObjectCallAsFunction(ctx, cast(jsc.JSObjectRef)step, nil, 0, nil, &exception)
		vm_cpu_exit(page.vm)

		if ended, end := page_ended(page); ended {
			page_fail(page, end)
			return false
		}

		if exception != nil {
			return false
		}

		if !jsc.JSValueToBoolean(ctx, more) {
			return true
		}
	}
}

// dom_parser_checkpoint queues the MutationObserver records of the nodes the parser
// inserted since the last checkpoint (html.take_inserted; recorded only while an
// observer is registered) — one JS call, so JSC's microtask drain as it returns
// delivers them: HTML's microtask checkpoint before a parser-inserted script runs, and
// at the end of the parse.
//
// Returns:
//   false when the page ended in the call (a limit, a stop); true otherwise, including
//   when there was nothing to report.
// Chrome:
//   Chrome 158, tests/dom/cases/dom-mutation-observer-parser.page: the nodes parsed
//   between two scripts reach the observer's callback before the second script runs.
dom_parser_checkpoint :: proc(ctx: jsc.JSContextRef, page: ^Page) -> bool {
	state := page.state

	if state == nil || state.dom == nil || state.dom.parsed == nil {
		return true
	}

	dom := state.dom
	nodes := html.take_inserted(&dom.parser)

	if len(nodes) == 0 {
		return true
	}

	exception: jsc.JSValueRef
	vm_cpu_enter(page.vm)
	args := [1]jsc.JSValueRef{dom_nodes_array(ctx, dom, nodes)}
	jsc.JSObjectCallAsFunction(ctx, cast(jsc.JSObjectRef)dom.parsed, nil, 1, raw_data(args[:]), &exception)
	vm_cpu_exit(page.vm)

	if ended, end := page_ended(page); ended {
		page_fail(page, end)
		return false
	}

	if exception != nil {
		report_internal_exception(ctx, "internal:dom", exception)
	}

	return true
}

// dom_wrap returns `node`'s wrapper, making, recording and protecting it on first use;
// null for a nil node. The wrapper's prototype is its interface's (dom_interface_of).
dom_wrap :: proc(ctx: jsc.JSContextRef, dom: ^Dom_Page, node: html.Node) -> jsc.JSValueRef {
	if node == nil {
		return jsc.JSValueMakeNull(ctx)
	}

	if wrapper, hit := dom.wrappers[node]; hit {
		return cast(jsc.JSValueRef)wrapper
	}

	iface := dom_interface_of(node)
	wrapper := jsc.JSObjectMake(ctx, dom.classes[iface], rawptr(node))

	if wrapper == nil {
		return jsc.JSValueMakeNull(ctx)
	}

	// Rooted before anything else can allocate.
	jsc.JSValueProtect(ctx, cast(jsc.JSValueRef)wrapper)
	jsc.JSObjectSetPrototype(ctx, wrapper, cast(jsc.JSValueRef)dom.protos[iface])
	dom.wrappers[node] = wrapper
	return cast(jsc.JSValueRef)wrapper
}

// dom_interface_of names the interface `node` is wrapped as. An HTML element maps by
// its local name (element_interface); an element in another namespace is a plain
// Element (Chrome's SVGElement and MathMLElement families are stage 4b).
dom_interface_of :: proc(node: html.Node) -> Dom_Interface {
	#partial switch html.node_type(node) {
	case .Document:
		return .HTML_Document
	case .Document_Type:
		return .Document_Type
	case .Document_Fragment:
		return .Document_Fragment
	case .Text, .CDATA_Section:
		return .Text
	case .Comment:
		return .Comment
	case .Processing_Instruction:
		return .Processing_Instruction
	case .Element:
		if html.namespace_of(node) == .HTML {
			return element_interface(node)
		}
	}

	return .Element
}

// element_interface maps an HTML element to its interface by local name, per the HTML
// standard's element index for the elements Larva names, HTMLElement for the ones whose
// interface is HTMLElement itself (and for every element Larva has no subclass for
// yet), HTMLUnknownElement for a name that is no HTML element.
//
// Deviates:
//   An HTML element Larva has no subclass for (canvas, video, …) is a plain HTMLElement,
//   where Chrome makes it its own interface; its prototype chain is short by one link.
element_interface :: proc(node: html.Node) -> Dom_Interface {
	switch html.local_name(node) {
	case "html":
		return .HTML_Html_Element
	case "head":
		return .HTML_Head_Element
	case "body":
		return .HTML_Body_Element
	case "title":
		return .HTML_Title_Element
	case "meta":
		return .HTML_Meta_Element
	case "link":
		return .HTML_Link_Element
	case "style":
		return .HTML_Style_Element
	case "script":
		return .HTML_Script_Element
	case "div":
		return .HTML_Div_Element
	case "span":
		return .HTML_Span_Element
	case "p":
		return .HTML_Paragraph_Element
	case "h1", "h2", "h3", "h4", "h5", "h6":
		return .HTML_Heading_Element
	case "a":
		return .HTML_Anchor_Element
	case "ul":
		return .HTML_UList_Element
	case "ol":
		return .HTML_OList_Element
	case "li":
		return .HTML_LI_Element
	case "dl":
		return .HTML_DList_Element
	case "pre", "listing", "xmp":
		return .HTML_Pre_Element
	case "blockquote", "q":
		return .HTML_Quote_Element
	case "br":
		return .HTML_BR_Element
	case "hr":
		return .HTML_HR_Element
	case "img":
		return .HTML_Image_Element
	case "form":
		return .HTML_Form_Element
	case "input":
		return .HTML_Input_Element
	case "button":
		return .HTML_Button_Element
	case "label":
		return .HTML_Label_Element
	case "select":
		return .HTML_Select_Element
	case "option":
		return .HTML_Option_Element
	case "textarea":
		return .HTML_Text_Area_Element
	case "table":
		return .HTML_Table_Element
	case "thead", "tbody", "tfoot":
		return .HTML_Table_Section_Element
	case "tr":
		return .HTML_Table_Row_Element
	case "td", "th":
		return .HTML_Table_Cell_Element
	case "template":
		return .HTML_Template_Element
	case "iframe":
		return .HTML_IFrame_Element
	}

	// A custom element name, or any element lexbor's tag table knows (every HTML element,
	// so the unmapped ones above), is an HTMLElement; a name first seen in this document
	// is no HTML element.
	if html.tag_is_known(node) || strings.contains_rune(html.local_name(node), '-') {
		return .HTML_Element
	}

	return .HTML_Unknown_Element
}

// --- natives ---------------------------------------------------------------------

// make_dom_bindings builds internal/dom's natives, reachable only from its install.
//
// Plain C-API functions, not host_native_create's, for the reason deferred.odin's are: a
// wrapper outlives its page in a pooled VM, and a late call must reach a native that
// finds no page and refuses, not the fail-closed host dispatcher of a context whose
// registry was swept. Cold: created once per HTML page.
@(private = "file")
make_dom_bindings :: proc(ctx: jsc.JSContextRef) -> jsc.JSObjectRef {
	Binding :: struct {
		name: string,
		cb:   jsc.JSObjectCallAsFunctionCallback,
	}
	bindings := [?]Binding {
		{"isNode", dom_is_node_cb},
		{"document", dom_document_cb},
		{"nodeType", dom_node_type_cb},
		{"interface", dom_interface_cb},
		{"nodeName", dom_node_name_cb},
		{"parent", dom_parent_cb},
		{"firstChild", dom_first_child_cb},
		{"lastChild", dom_last_child_cb},
		{"nextSibling", dom_next_sibling_cb},
		{"previousSibling", dom_previous_sibling_cb},
		{"childNodes", dom_child_nodes_cb},
		{"textContent", dom_text_content_cb},
		{"setTextContent", dom_set_text_content_cb},
		{"data", dom_data_cb},
		{"setData", dom_set_data_cb},
		{"insertBefore", dom_insert_before_cb},
		{"removeChild", dom_remove_child_cb},
		{"replaceChild", dom_replace_child_cb},
		{"remove", dom_remove_cb},
		{"contains", dom_contains_cb},
		{"clone", dom_clone_cb},
		{"localName", dom_local_name_cb},
		{"getAttribute", dom_get_attribute_cb},
		{"setAttribute", dom_set_attribute_cb},
		{"removeAttribute", dom_remove_attribute_cb},
		{"hasAttribute", dom_has_attribute_cb},
		{"innerHTML", dom_inner_html_cb},
		{"setInnerHTML", dom_set_inner_html_cb},
		{"outerHTML", dom_outer_html_cb},
		{"query", dom_query_cb},
		{"byTagName", dom_by_tag_name_cb},
		{"byClassName", dom_by_class_name_cb},
		{"byId", dom_by_id_cb},
		{"createElement", dom_create_element_cb},
		{"createText", dom_create_text_cb},
		{"createComment", dom_create_comment_cb},
		{"createFragment", dom_create_fragment_cb},
		{"observeParser", dom_observe_parser_cb},
		{"currentScript", dom_current_script_cb},
		{"write", dom_write_cb},
	}

	object := jsc.JSObjectMake(ctx, nil, nil)

	for b in bindings {
		set_named(ctx, object, b.name, cast(jsc.JSValueRef)make_native_function(ctx, b.name, b.cb))
	}

	return object
}

// Dom_Call is one native call's receiver and arguments, as dom_enter reads them.
@(private = "file")
Dom_Call :: struct {
	ctx:  jsc.JSContextRef,
	dom:  ^Dom_Page,
	node: html.Node,
	args: []jsc.JSValueRef,
}

// dom_node_of reads `value` as a live node of this page: an object of the page's
// wrapper class whose private slot is still set.
@(private = "file")
dom_node_of :: proc(ctx: jsc.JSContextRef, value: jsc.JSValueRef) -> (dom: ^Dom_Page, node: html.Node, ok: bool) {
	state := get_state_from_ctx(ctx)

	if state == nil || state.dom == nil || value == nil {
		return nil, nil, false
	}

	dom = state.dom

	if !jsc.JSValueIsObjectOfClass(ctx, value, dom.class) {
		return nil, nil, false
	}

	node = html.Node(jsc.JSObjectGetPrivate(cast(jsc.JSObjectRef)value))
	return dom, node, node != nil
}

// dom_enter reads a native's receiver (its first argument) and throws `Illegal
// invocation` when it is not a live node of this page — a foreign object, or a wrapper
// whose page is gone.
@(private = "file")
dom_enter :: proc(
	ctx: jsc.JSContextRef,
	argc: c.size_t,
	argv: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> (
	call: Dom_Call,
	ok: bool,
) {
	if argc >= 1 {
		if dom, node, live := dom_node_of(ctx, argv[0]); live {
			return Dom_Call{ctx = ctx, dom = dom, node = node, args = argv[1:argc]}, true
		}
	}

	exception^ = make_native_error(ctx, "TypeError", "Illegal invocation")
	return {}, false
}

// dom_arg_node reads argument `i` as a live node of this page; nil otherwise (null and
// undefined included). internal/dom has checked the type already.
@(private = "file")
dom_arg_node :: proc(call: Dom_Call, i: int) -> html.Node {
	if i >= len(call.args) {
		return nil
	}

	_, node, _ := dom_node_of(call.ctx, call.args[i])
	return node
}

// dom_arg_string reads argument `i`, a string internal/dom converted, as UTF-8 in the
// temp arena (the caller's guard frees it).
@(private = "file")
dom_arg_string :: proc(call: Dom_Call, i: int) -> string {
	if i >= len(call.args) || !jsc.JSValueIsString(call.ctx, call.args[i]) {
		return ""
	}

	js := jsc.JSValueToStringCopy(call.ctx, call.args[i], nil)

	if js == nil {
		return ""
	}

	defer jsc.JSStringRelease(js)
	context.allocator = context.temp_allocator
	s, _ := js_string_ref_to_utf8_owned(js)
	return s
}

// dom_attr_name folds an attribute name to ASCII lowercase on an HTML element, as the
// DOM's attribute methods do in an HTML document.
@(private = "file")
dom_attr_name :: proc(node: html.Node, name: string) -> string {
	if html.namespace_of(node) != .HTML {
		return name
	}

	return strings.to_lower(name, context.temp_allocator)
}

@(private = "file")
dom_undefined :: proc(ctx: jsc.JSContextRef) -> jsc.JSValueRef {
	return jsc.JSValueMakeUndefined(ctx)
}

@(private = "file")
dom_nodes_array :: proc(ctx: jsc.JSContextRef, dom: ^Dom_Page, nodes: []html.Node) -> jsc.JSValueRef {
	array := jsc.JSObjectMakeArray(ctx, 0, nil, nil)

	// Each wrapper goes into the array as it is made, so it is rooted by it.
	for node, i in nodes {
		jsc.JSObjectSetPropertyAtIndex(ctx, array, c.uint(i), dom_wrap(ctx, dom, node), nil)
	}

	return cast(jsc.JSValueRef)array
}

// dom_walk_next is the node after `n` in tree order within `root`'s subtree; nil past
// its end.
dom_walk_next :: proc(n, root: html.Node) -> html.Node {
	if first := html.first_child(n); first != nil {
		return first
	}

	for x := n; x != nil && x != root; x = html.parent(x) {
		if next := html.next_sibling(x); next != nil {
			return next
		}
	}

	return nil
}

dom_is_node_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argc: c.size_t,
	argv: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	_, _, live := dom_node_of(ctx, argv[0] if argc >= 1 else nil)
	return jsc.JSValueMakeBoolean(ctx, b32(live))
}

dom_document_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argc: c.size_t,
	argv: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	state := get_state_from_ctx(ctx)

	if state == nil || state.dom == nil {
		exception^ = make_native_error(ctx, "TypeError", "Illegal invocation")
		return dom_undefined(ctx)
	}

	return dom_wrap(ctx, state.dom, dom_document(state))
}

dom_node_type_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argc: c.size_t,
	argv: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	call, ok := dom_enter(ctx, argc, argv, exception)

	if !ok {
		return dom_undefined(ctx)
	}

	return jsc.JSValueMakeNumber(ctx, f64(html.node_type(call.node)))
}

// interface(node): the index, in the names install was given, of the interface the
// node is wrapped as (dom_interface_of) — the brand internal/dom_reflect checks a
// reflected attribute's receiver against, since a wrapper's [[Prototype]] is the page's
// to change.
dom_interface_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argc: c.size_t,
	argv: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	call, ok := dom_enter(ctx, argc, argv, exception)

	if !ok {
		return dom_undefined(ctx)
	}

	return jsc.JSValueMakeNumber(ctx, f64(dom_interface_of(call.node)))
}

dom_node_name_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argc: c.size_t,
	argv: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	runtime.DEFAULT_TEMP_ALLOCATOR_TEMP_GUARD()
	call, ok := dom_enter(ctx, argc, argv, exception)

	if !ok {
		return dom_undefined(ctx)
	}

	// A processing instruction's nodeName is its target; lexbor's node name answers the
	// generic one for it.
	if html.node_type(call.node) == .Processing_Instruction {
		return js_string_value(ctx, html.pi_target(call.node))
	}

	return js_string_value(ctx, html.node_name(call.node))
}

// The relatives share one shape; `which` picks the field.
@(private = "file")
Dom_Relative :: enum {
	Parent,
	First_Child,
	Last_Child,
	Next_Sibling,
	Previous_Sibling,
}

@(private = "file")
dom_relative :: proc(
	ctx: jsc.JSContextRef,
	argc: c.size_t,
	argv: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
	which: Dom_Relative,
) -> jsc.JSValueRef {
	call, ok := dom_enter(ctx, argc, argv, exception)

	if !ok {
		return dom_undefined(ctx)
	}

	n: html.Node

	switch which {
	case .Parent:
		n = html.parent(call.node)
	case .First_Child:
		n = html.first_child(call.node)
	case .Last_Child:
		n = html.last_child(call.node)
	case .Next_Sibling:
		n = html.next_sibling(call.node)
	case .Previous_Sibling:
		n = html.prev_sibling(call.node)
	}

	return dom_wrap(ctx, call.dom, n)
}

dom_parent_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argc: c.size_t,
	argv: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	return dom_relative(ctx, argc, argv, exception, .Parent)
}

dom_first_child_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argc: c.size_t,
	argv: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	return dom_relative(ctx, argc, argv, exception, .First_Child)
}

dom_last_child_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argc: c.size_t,
	argv: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	return dom_relative(ctx, argc, argv, exception, .Last_Child)
}

dom_next_sibling_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argc: c.size_t,
	argv: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	return dom_relative(ctx, argc, argv, exception, .Next_Sibling)
}

dom_previous_sibling_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argc: c.size_t,
	argv: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	return dom_relative(ctx, argc, argv, exception, .Previous_Sibling)
}

dom_child_nodes_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argc: c.size_t,
	argv: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	call, ok := dom_enter(ctx, argc, argv, exception)

	if !ok {
		return dom_undefined(ctx)
	}

	array := jsc.JSObjectMakeArray(ctx, 0, nil, nil)
	i: c.uint

	for n := html.first_child(call.node); n != nil; n = html.next_sibling(n) {
		jsc.JSObjectSetPropertyAtIndex(ctx, array, i, dom_wrap(ctx, call.dom, n), nil)
		i += 1
	}

	return cast(jsc.JSValueRef)array
}

dom_text_content_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argc: c.size_t,
	argv: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	runtime.DEFAULT_TEMP_ALLOCATOR_TEMP_GUARD()
	call, ok := dom_enter(ctx, argc, argv, exception)

	if !ok {
		return dom_undefined(ctx)
	}

	#partial switch html.node_type(call.node) {
	case .Element, .Document_Fragment:
		return js_string_value(ctx, html.text(call.node, context.temp_allocator))
	case .Text, .Comment, .CDATA_Section, .Processing_Instruction:
		data, _ := html.char_data(call.node)
		return js_string_value(ctx, data)
	}

	return jsc.JSValueMakeNull(ctx)
}

dom_set_text_content_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argc: c.size_t,
	argv: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	runtime.DEFAULT_TEMP_ALLOCATOR_TEMP_GUARD()
	call, ok := dom_enter(ctx, argc, argv, exception)

	if !ok {
		return dom_undefined(ctx)
	}

	if !html.set_text_content(call.node, dom_arg_string(call, 0)) {
		exception^ = make_native_error(ctx, "RangeError", "Failed to set 'textContent': out of memory.")
		return dom_undefined(ctx)
	}

	scripts_children_changed(call.dom, call.node)
	return dom_undefined(ctx)
}

dom_data_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argc: c.size_t,
	argv: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	call, ok := dom_enter(ctx, argc, argv, exception)

	if !ok {
		return dom_undefined(ctx)
	}

	data, _ := html.char_data(call.node)
	return js_string_value(ctx, data)
}

dom_set_data_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argc: c.size_t,
	argv: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	runtime.DEFAULT_TEMP_ALLOCATOR_TEMP_GUARD()
	call, ok := dom_enter(ctx, argc, argv, exception)

	if ok {
		html.set_data(call.node, dom_arg_string(call, 0))
	}

	return dom_undefined(ctx)
}

// insertBefore(node, child-or-null) and appendChild (child null): the Mutation_Error,
// 0 for success, which internal/dom turns into its DOMException.
dom_insert_before_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argc: c.size_t,
	argv: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	call, ok := dom_enter(ctx, argc, argv, exception)

	if !ok {
		return dom_undefined(ctx)
	}

	node := dom_arg_node(call, 0)

	if node == nil {
		return jsc.JSValueMakeNumber(ctx, f64(html.Mutation_Error.Failed))
	}

	runtime.DEFAULT_TEMP_ALLOCATOR_TEMP_GUARD()
	inserted := dom_inserted_roots(node)
	code := html.insert_before(call.node, node, dom_arg_node(call, 1))

	// After the tree holds them: an inserted script runs now (or is queued), and the
	// parent's children changed (page_script.odin).
	if code == .None {
		scripts_inserted(call.dom, call.node, inserted)
	}

	return jsc.JSValueMakeNumber(ctx, f64(code))
}

// dom_inserted_roots lists what inserting `node` puts in the tree: its children for a
// document fragment (which empties), `node` itself otherwise. In the temp arena.
@(private = "file")
dom_inserted_roots :: proc(node: html.Node) -> []html.Node {
	if html.node_type(node) != .Document_Fragment {
		roots := make([]html.Node, 1, context.temp_allocator)
		roots[0] = node
		return roots
	}

	roots := make([dynamic]html.Node, 0, 4, context.temp_allocator)

	for child := html.first_child(node); child != nil; child = html.next_sibling(child) {
		append(&roots, child)
	}

	return roots[:]
}

dom_remove_child_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argc: c.size_t,
	argv: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	call, ok := dom_enter(ctx, argc, argv, exception)

	if !ok {
		return dom_undefined(ctx)
	}

	return jsc.JSValueMakeNumber(ctx, f64(html.remove_child(call.node, dom_arg_node(call, 0))))
}

dom_replace_child_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argc: c.size_t,
	argv: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	call, ok := dom_enter(ctx, argc, argv, exception)

	if !ok {
		return dom_undefined(ctx)
	}

	node := dom_arg_node(call, 0)

	if node == nil {
		return jsc.JSValueMakeNumber(ctx, f64(html.Mutation_Error.Failed))
	}

	runtime.DEFAULT_TEMP_ALLOCATOR_TEMP_GUARD()
	inserted := dom_inserted_roots(node)
	code := html.replace_child(call.node, node, dom_arg_node(call, 1))

	if code == .None {
		scripts_inserted(call.dom, call.node, inserted)
	}

	return jsc.JSValueMakeNumber(ctx, f64(code))
}

dom_remove_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argc: c.size_t,
	argv: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	call, ok := dom_enter(ctx, argc, argv, exception)

	if ok {
		html.detach(call.node)
	}

	return dom_undefined(ctx)
}

// observeParser(on): whether the parser records the nodes it inserts for
// MutationObserver (html.observe_inserted). No receiver: it is the page's parser.
dom_observe_parser_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argc: c.size_t,
	argv: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	state := get_state_from_ctx(ctx)

	if state != nil && state.dom != nil {
		html.observe_inserted(&state.dom.parser, argc >= 1 && jsc.JSValueToBoolean(ctx, argv[0]))
	}

	return dom_undefined(ctx)
}

// contains(other): whether `other` is the receiver or one of its descendants.
dom_contains_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argc: c.size_t,
	argv: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	call, ok := dom_enter(ctx, argc, argv, exception)

	if !ok {
		return dom_undefined(ctx)
	}

	for n := dom_arg_node(call, 0); n != nil; n = html.parent(n) {
		if n == call.node {
			return jsc.JSValueMakeBoolean(ctx, true)
		}
	}

	return jsc.JSValueMakeBoolean(ctx, false)
}

dom_clone_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argc: c.size_t,
	argv: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	call, ok := dom_enter(ctx, argc, argv, exception)

	if !ok {
		return dom_undefined(ctx)
	}

	deep := len(call.args) > 0 && jsc.JSValueToBoolean(ctx, call.args[0])
	copied := html.clone(call.node, deep)

	if copied == nil {
		exception^ = make_native_error(ctx, "RangeError", "Failed to execute 'cloneNode' on 'Node': out of memory.")
		return dom_undefined(ctx)
	}

	scripts_cloned(call.dom, call.node, copied, deep)
	return dom_wrap(ctx, call.dom, copied)
}

dom_local_name_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argc: c.size_t,
	argv: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	call, ok := dom_enter(ctx, argc, argv, exception)

	if !ok {
		return dom_undefined(ctx)
	}

	return js_string_value(ctx, html.local_name(call.node))
}

// getAttribute(name): the value, or null when the element has no such attribute.
dom_get_attribute_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argc: c.size_t,
	argv: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	runtime.DEFAULT_TEMP_ALLOCATOR_TEMP_GUARD()
	call, ok := dom_enter(ctx, argc, argv, exception)

	if !ok {
		return dom_undefined(ctx)
	}

	value, present := html.attr_view(call.node, dom_attr_name(call.node, dom_arg_string(call, 0)))

	if !present {
		return jsc.JSValueMakeNull(ctx)
	}

	return js_string_value(ctx, value)
}

dom_set_attribute_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argc: c.size_t,
	argv: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	runtime.DEFAULT_TEMP_ALLOCATOR_TEMP_GUARD()
	call, ok := dom_enter(ctx, argc, argv, exception)

	if !ok {
		return dom_undefined(ctx)
	}

	name := dom_attr_name(call.node, dom_arg_string(call, 0))
	_, had_src := html.attr_view(call.node, "src")

	if !html.set_attr(call.node, name, dom_arg_string(call, 1)) {
		exception^ = make_native_error(ctx, "RangeError", "Failed to execute 'setAttribute' on 'Element': out of memory.")
		return dom_undefined(ctx)
	}

	// A src on a script that had none may start it (page_script.odin).
	if name == "src" && !had_src {
		scripts_src_set(call.dom, call.node)
	}

	return dom_undefined(ctx)
}

dom_remove_attribute_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argc: c.size_t,
	argv: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	runtime.DEFAULT_TEMP_ALLOCATOR_TEMP_GUARD()
	call, ok := dom_enter(ctx, argc, argv, exception)

	if ok {
		html.remove_attr(call.node, dom_attr_name(call.node, dom_arg_string(call, 0)))
	}

	return dom_undefined(ctx)
}

dom_has_attribute_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argc: c.size_t,
	argv: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	runtime.DEFAULT_TEMP_ALLOCATOR_TEMP_GUARD()
	call, ok := dom_enter(ctx, argc, argv, exception)

	if !ok {
		return dom_undefined(ctx)
	}

	_, present := html.attr_view(call.node, dom_attr_name(call.node, dom_arg_string(call, 0)))
	return jsc.JSValueMakeBoolean(ctx, b32(present))
}

dom_inner_html_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argc: c.size_t,
	argv: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	runtime.DEFAULT_TEMP_ALLOCATOR_TEMP_GUARD()
	call, ok := dom_enter(ctx, argc, argv, exception)

	if !ok {
		return dom_undefined(ctx)
	}

	markup, serialized := html.inner_html(call.node, context.temp_allocator)

	if !serialized {
		exception^ = make_native_error(ctx, "RangeError", "Failed to read 'innerHTML': out of memory.")
		return dom_undefined(ctx)
	}

	return js_string_value(ctx, markup)
}

dom_set_inner_html_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argc: c.size_t,
	argv: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	runtime.DEFAULT_TEMP_ALLOCATOR_TEMP_GUARD()
	call, ok := dom_enter(ctx, argc, argv, exception)

	if !ok {
		return dom_undefined(ctx)
	}

	if !html.set_inner_html(call.node, dom_arg_string(call, 0)) {
		exception^ = make_native_error(
			ctx,
			"RangeError",
			"Failed to set 'innerHTML': the fragment could not be parsed.",
		)
		return dom_undefined(ctx)
	}

	// The fragment parser's scripts never run; the element's own children changed.
	scripts_parsed_inert(call.dom, call.node)
	scripts_children_changed(call.dom, call.node)
	return dom_undefined(ctx)
}

dom_outer_html_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argc: c.size_t,
	argv: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	runtime.DEFAULT_TEMP_ALLOCATOR_TEMP_GUARD()
	call, ok := dom_enter(ctx, argc, argv, exception)

	if !ok {
		return dom_undefined(ctx)
	}

	markup, serialized := html.outer_html(call.node, context.temp_allocator)

	if !serialized {
		exception^ = make_native_error(ctx, "RangeError", "Failed to read 'outerHTML': out of memory.")
		return dom_undefined(ctx)
	}

	return js_string_value(ctx, markup)
}

// query(selectors, all): querySelector (the first match or null) or querySelectorAll (an
// array of matches); false for a selector list lexbor does not parse, which internal/dom
// throws as a SyntaxError. The same selector engine `lava html --select` uses.
dom_query_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argc: c.size_t,
	argv: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	runtime.DEFAULT_TEMP_ALLOCATOR_TEMP_GUARD()
	call, ok := dom_enter(ctx, argc, argv, exception)

	if !ok {
		return dom_undefined(ctx)
	}

	all := len(call.args) > 1 && jsc.JSValueToBoolean(ctx, call.args[1])
	sel, compiled := html.compile(&call.dom.selectors, dom_arg_string(call, 0))

	if !compiled {
		return jsc.JSValueMakeBoolean(ctx, false)
	}

	defer html.selector_destroy(&sel)

	if !all {
		found, searched := html.query_first(&call.dom.selectors, call.node, sel)

		if !searched {
			return jsc.JSValueMakeNull(ctx)
		}

		return dom_wrap(ctx, call.dom, found)
	}

	matches := make([dynamic]html.Node, context.temp_allocator)
	html.query_all(&call.dom.selectors, call.node, sel, &matches)
	return dom_nodes_array(ctx, call.dom, matches[:])
}

// byTagName(name): the descendant elements named `name` in tree order — every element
// for `*`; an HTML element compares its name with `name` in ASCII lowercase.
dom_by_tag_name_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argc: c.size_t,
	argv: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	runtime.DEFAULT_TEMP_ALLOCATOR_TEMP_GUARD()
	call, ok := dom_enter(ctx, argc, argv, exception)

	if !ok {
		return dom_undefined(ctx)
	}

	name := dom_arg_string(call, 0)
	lower := strings.to_lower(name, context.temp_allocator)
	found := make([dynamic]html.Node, context.temp_allocator)

	for n := dom_walk_next(call.node, call.node); n != nil; n = dom_walk_next(n, call.node) {
		if html.node_type(n) != .Element {
			continue
		}

		q := html.qualified_name(n)

		if name == "*" || (html.namespace_of(n) == .HTML ? q == lower : q == name) {
			append(&found, n)
		}
	}

	return dom_nodes_array(ctx, call.dom, found[:])
}

// byClassName(names): the descendant elements whose class list holds every class in the
// space-separated `names`; none for a `names` with no class in it.
dom_by_class_name_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argc: c.size_t,
	argv: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	runtime.DEFAULT_TEMP_ALLOCATOR_TEMP_GUARD()
	call, ok := dom_enter(ctx, argc, argv, exception)

	if !ok {
		return dom_undefined(ctx)
	}

	wanted := strings.fields(dom_arg_string(call, 0), context.temp_allocator)
	found := make([dynamic]html.Node, context.temp_allocator)

	if len(wanted) > 0 {
		for n := dom_walk_next(call.node, call.node); n != nil; n = dom_walk_next(n, call.node) {
			class, has := html.attr_view(n, "class")

			if !has {
				continue
			}

			have := strings.fields(class, context.temp_allocator)
			all := true

			for w in wanted {
				hit := false

				for h in have {
					if h == w {
						hit = true
						break
					}
				}

				if !hit {
					all = false
					break
				}
			}

			if all {
				append(&found, n)
			}
		}
	}

	return dom_nodes_array(ctx, call.dom, found[:])
}

// byId(id): the first descendant element in tree order whose id is `id`; null for none
// or for "".
dom_by_id_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argc: c.size_t,
	argv: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	runtime.DEFAULT_TEMP_ALLOCATOR_TEMP_GUARD()
	call, ok := dom_enter(ctx, argc, argv, exception)

	if !ok {
		return dom_undefined(ctx)
	}

	id := dom_arg_string(call, 0)

	if id != "" {
		for n := dom_walk_next(call.node, call.node); n != nil; n = dom_walk_next(n, call.node) {
			if value, has := html.attr_view(n, "id"); has && value == id {
				return dom_wrap(ctx, call.dom, n)
			}
		}
	}

	return jsc.JSValueMakeNull(ctx)
}

// createElement(localName), on the document: the name lowercased, as in an HTML
// document. internal/dom has validated it.
dom_create_element_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argc: c.size_t,
	argv: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	runtime.DEFAULT_TEMP_ALLOCATOR_TEMP_GUARD()
	call, ok := dom_enter(ctx, argc, argv, exception)

	if !ok {
		return dom_undefined(ctx)
	}

	name := strings.to_lower(dom_arg_string(call, 0), context.temp_allocator)
	return dom_created(call, exception, html.create_element(call.node, name), "createElement")
}

dom_create_text_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argc: c.size_t,
	argv: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	runtime.DEFAULT_TEMP_ALLOCATOR_TEMP_GUARD()
	call, ok := dom_enter(ctx, argc, argv, exception)

	if !ok {
		return dom_undefined(ctx)
	}

	return dom_created(call, exception, html.create_text(call.node, dom_arg_string(call, 0)), "createTextNode")
}

dom_create_comment_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argc: c.size_t,
	argv: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	runtime.DEFAULT_TEMP_ALLOCATOR_TEMP_GUARD()
	call, ok := dom_enter(ctx, argc, argv, exception)

	if !ok {
		return dom_undefined(ctx)
	}

	return dom_created(call, exception, html.create_comment(call.node, dom_arg_string(call, 0)), "createComment")
}

dom_create_fragment_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argc: c.size_t,
	argv: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	call, ok := dom_enter(ctx, argc, argv, exception)

	if !ok {
		return dom_undefined(ctx)
	}

	return dom_created(call, exception, html.create_fragment(call.node), "createDocumentFragment")
}

// document.currentScript: the script element page_script.odin is running, or null.
dom_current_script_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argc: c.size_t,
	argv: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	call, ok := dom_enter(ctx, argc, argv, exception)

	if !ok {
		return dom_undefined(ctx)
	}

	return dom_wrap(ctx, call.dom, call.dom.scripts.current)
}

// document.write(text): the text internal/dom joined, written at the insertion point
// and parsed there (page_script.odin scripts_write).
dom_write_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argc: c.size_t,
	argv: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	runtime.DEFAULT_TEMP_ALLOCATOR_TEMP_GUARD()
	call, ok := dom_enter(ctx, argc, argv, exception)

	if ok {
		scripts_write(call.dom, dom_arg_string(call, 0))
	}

	return dom_undefined(ctx)
}

// dom_created wraps a node a create* native made; a nil node is the receiver not being
// a document, or lexbor out of memory.
@(private = "file")
dom_created :: proc(call: Dom_Call, exception: ^jsc.JSValueRef, node: html.Node, op: string) -> jsc.JSValueRef {
	if node == nil {
		exception^ = make_native_error(call.ctx, "TypeError", "Illegal invocation")
		return dom_undefined(call.ctx)
	}

	return dom_wrap(call.ctx, call.dom, node)
}

// dom_create_classes makes the root wrapper class ("Node", the brand dom_node_of checks)
// and one class per interface under it, once per process.
//
// Why never per page, and never released: JSC's OpaqueJSClass holds `parentClass` as a
// raw pointer — its destructor releases only the automatic prototype class, never the
// parent (JSClassRelease's ~OpaqueJSClass in libjavascriptcoregtk-6.0) — yet each
// wrapper's finalization walks that chain to call every class's `finalize`. A wrapper
// retains its own class; nothing retains the root but the page and its global object's
// per-class context data, and JSC frees the global (a precise allocation, swept as the
// collection ends) before it lazily sweeps the wrappers' blocks on a later allocation.
// Per-page classes released at dom_release so left every closed page's wrappers walking
// a freed root: benign until something reused the block, then a call through garbage —
// the parallel test runner's segfault in a different test each run, where another
// thread's allocation did the reusing. Pinned by
// dom_wrapper_class_parent_outlives_its_page. Sharing them also spares each page
// 1 + len(Dom_Interface) class creations.
@(private = "file")
dom_create_classes :: proc() {
	root := jsc.JSClassDefinition {
		class_name = "Node",
		attributes = .NoAutomaticPrototype,
	}
	g_dom_root_class = jsc.JSClassCreate(&root)

	if g_dom_root_class == nil {
		g_dom_classes_error = "JavaScriptCore could not create the node class"
		return
	}

	for name, iface in DOM_INTERFACE_NAMES {
		def := jsc.JSClassDefinition {
			class_name   = strings.clone_to_cstring(name, context.temp_allocator),
			attributes   = .NoAutomaticPrototype,
			parent_class = g_dom_root_class,
		}
		g_dom_classes[iface] = jsc.JSClassCreate(&def)

		if g_dom_classes[iface] == nil {
			g_dom_classes_error = "JavaScriptCore could not create an interface class"
			return
		}
	}
}
