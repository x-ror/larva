#include <lexbor/css/css.h>
#include <lexbor/dom/dom.h>
#include <lexbor/html/html.h>
#include <lexbor/selectors/selectors.h>
#include <stddef.h>
#include <stdlib.h>

typedef struct {
	lxb_html_tokenizer_token_f orig;
	void *orig_ctx;
	lxb_html_tree_t *tree;
	lxb_dom_node_t *script;
	size_t closed;
} larva_html_hook;

typedef struct {
	lxb_css_parser_t *parser;
	lxb_selectors_t *selectors;
} larva_css;

typedef bool (*larva_css_found_f)(lxb_dom_node_t *node, void *ctx);

typedef struct {
	larva_css_found_f found;
	void *ctx;
} larva_css_find_ctx;

static lxb_html_token_t *larva_hook_cb(lxb_html_tokenizer_t *tkz, lxb_html_token_t *token, void *ctx) {
	larva_html_hook *h = ctx;

	if (token->tag_id == LXB_TAG_SCRIPT && (token->type & LXB_HTML_TOKEN_TYPE_CLOSE)) {
		lxb_dom_node_t *cur = lxb_html_tree_current_node(h->tree);

		if (cur != NULL && cur->local_name == LXB_TAG_SCRIPT) {
			h->script = cur;
			h->closed++;
		}
	}

	return h->orig(tkz, token, h->orig_ctx);
}

larva_html_hook *larva_html_begin(lxb_html_document_t *doc) {
	if (lxb_html_document_parse_chunk_begin(doc) != LXB_STATUS_OK) {
		return NULL;
	}

	lxb_html_parser_t *parser = doc->dom_document.parser;

	if (parser == NULL || parser->tkz == NULL || parser->tree == NULL) {
		return NULL;
	}

	larva_html_hook *h = calloc(1, sizeof(*h));

	if (h == NULL) {
		return NULL;
	}

	h->orig = parser->tkz->callback_token_done;
	h->orig_ctx = parser->tkz->callback_token_ctx;
	h->tree = parser->tree;
	lxb_html_tokenizer_callback_token_done_set(parser->tkz, larva_hook_cb, h);
	return h;
}

lxb_dom_node_t *larva_html_take_script(larva_html_hook *h, size_t *closed) {
	lxb_dom_node_t *s = h->script;
	*closed = h->closed;
	h->script = NULL;
	h->closed = 0;
	return s;
}

void larva_html_hook_free(larva_html_hook *h) {
	free(h);
}

lxb_dom_node_t *larva_html_document_node(lxb_html_document_t *doc) {
	return lxb_dom_interface_node(doc);
}

void larva_html_text_free(lxb_dom_node_t *node, lxb_char_t *text) {
	if (text != NULL) {
		lxb_dom_document_destroy_text(node->owner_document, text);
	}
}

// The value of attribute `name` on element `node`, or NULL when `node` is not an element
// or has no such attribute. An attribute without a value (`<script async>`) is present
// with an empty value: lexbor's own getter returns NULL for it. Owned by the element.
const lxb_char_t *larva_html_attr(lxb_dom_node_t *node, const lxb_char_t *name, size_t name_len, size_t *len) {
	static const lxb_char_t empty = '\0';

	*len = 0;
	if (node == NULL || node->type != LXB_DOM_NODE_TYPE_ELEMENT) {
		return NULL;
	}

	lxb_dom_attr_t *a = lxb_dom_element_attr_by_name(lxb_dom_interface_element(node), name, name_len);

	if (a == NULL) {
		return NULL;
	}

	const lxb_char_t *v = lxb_dom_attr_value(a, len);
	return v != NULL ? v : &empty;
}

// The layout of the lexbor structs pkg/html/layout.odin mirrors, as this compiler lays
// them out from lexbor's own headers, plus the constants the mirror compares against.
// Odin reads the hot fields (next, parent, type, an attribute's value…) with plain
// loads through that mirror; its test compares every entry here with the mirror's,
// both ways, so a lexbor bump that moves a field fails there rather than in a walk.
typedef struct {
	const char *name;
	size_t value;
} larva_html_layout_entry;

#define LARVA_OFF(key, type, field) {key, offsetof(type, field)}
#define LARVA_VAL(key, v) {key, (size_t)(v)}

static const larva_html_layout_entry larva_layout[] = {
	LARVA_VAL("node.size", sizeof(lxb_dom_node_t)),
	LARVA_OFF("node.local_name", lxb_dom_node_t, local_name),
	LARVA_OFF("node.prefix", lxb_dom_node_t, prefix),
	LARVA_OFF("node.ns", lxb_dom_node_t, ns),
	LARVA_OFF("node.next", lxb_dom_node_t, next),
	LARVA_OFF("node.prev", lxb_dom_node_t, prev),
	LARVA_OFF("node.parent", lxb_dom_node_t, parent),
	LARVA_OFF("node.first_child", lxb_dom_node_t, first_child),
	LARVA_OFF("node.last_child", lxb_dom_node_t, last_child),
	LARVA_OFF("node.user", lxb_dom_node_t, user),
	LARVA_OFF("node.type", lxb_dom_node_t, type),
	LARVA_VAL("node.type.size", sizeof(lxb_dom_node_type_t)),
	LARVA_VAL("str.size", sizeof(lexbor_str_t)),
	LARVA_OFF("str.data", lexbor_str_t, data),
	LARVA_OFF("str.length", lexbor_str_t, length),
	LARVA_OFF("element.first_attr", lxb_dom_element_t, first_attr),
	LARVA_OFF("element.last_attr", lxb_dom_element_t, last_attr),
	LARVA_VAL("attr.size", sizeof(lxb_dom_attr_t)),
	LARVA_OFF("attr.value", lxb_dom_attr_t, value),
	LARVA_OFF("attr.next", lxb_dom_attr_t, next),
	LARVA_OFF("attr.prev", lxb_dom_attr_t, prev),
	LARVA_VAL("character_data.size", sizeof(lxb_dom_character_data_t)),
	LARVA_OFF("character_data.data", lxb_dom_character_data_t, data),
	LARVA_VAL("ns.html", LXB_NS_HTML),
	LARVA_VAL("ns.math", LXB_NS_MATH),
	LARVA_VAL("ns.svg", LXB_NS_SVG),
	LARVA_VAL("ns.xlink", LXB_NS_XLINK),
	LARVA_VAL("ns.xml", LXB_NS_XML),
	LARVA_VAL("ns.xmlns", LXB_NS_XMLNS),
	LARVA_VAL("tag.area", LXB_TAG_AREA),
	LARVA_VAL("tag.base", LXB_TAG_BASE),
	LARVA_VAL("tag.basefont", LXB_TAG_BASEFONT),
	LARVA_VAL("tag.bgsound", LXB_TAG_BGSOUND),
	LARVA_VAL("tag.br", LXB_TAG_BR),
	LARVA_VAL("tag.col", LXB_TAG_COL),
	LARVA_VAL("tag.embed", LXB_TAG_EMBED),
	LARVA_VAL("tag.frame", LXB_TAG_FRAME),
	LARVA_VAL("tag.hr", LXB_TAG_HR),
	LARVA_VAL("tag.iframe", LXB_TAG_IFRAME),
	LARVA_VAL("tag.img", LXB_TAG_IMG),
	LARVA_VAL("tag.input", LXB_TAG_INPUT),
	LARVA_VAL("tag.keygen", LXB_TAG_KEYGEN),
	LARVA_VAL("tag.link", LXB_TAG_LINK),
	LARVA_VAL("tag.meta", LXB_TAG_META),
	LARVA_VAL("tag.noembed", LXB_TAG_NOEMBED),
	LARVA_VAL("tag.noframes", LXB_TAG_NOFRAMES),
	LARVA_VAL("tag.param", LXB_TAG_PARAM),
	LARVA_VAL("tag.plaintext", LXB_TAG_PLAINTEXT),
	LARVA_VAL("tag.script", LXB_TAG_SCRIPT),
	LARVA_VAL("tag.source", LXB_TAG_SOURCE),
	LARVA_VAL("tag.style", LXB_TAG_STYLE),
	LARVA_VAL("tag.template", LXB_TAG_TEMPLATE),
	LARVA_VAL("tag.track", LXB_TAG_TRACK),
	LARVA_VAL("tag.wbr", LXB_TAG_WBR),
	LARVA_VAL("tag.xmp", LXB_TAG_XMP),
	LARVA_VAL("type.undef", LXB_DOM_NODE_TYPE_UNDEF),
	LARVA_VAL("type.element", LXB_DOM_NODE_TYPE_ELEMENT),
	LARVA_VAL("type.attribute", LXB_DOM_NODE_TYPE_ATTRIBUTE),
	LARVA_VAL("type.text", LXB_DOM_NODE_TYPE_TEXT),
	LARVA_VAL("type.cdata_section", LXB_DOM_NODE_TYPE_CDATA_SECTION),
	LARVA_VAL("type.processing_instruction", LXB_DOM_NODE_TYPE_PROCESSING_INSTRUCTION),
	LARVA_VAL("type.comment", LXB_DOM_NODE_TYPE_COMMENT),
	LARVA_VAL("type.document", LXB_DOM_NODE_TYPE_DOCUMENT),
	LARVA_VAL("type.document_type", LXB_DOM_NODE_TYPE_DOCUMENT_TYPE),
	LARVA_VAL("type.document_fragment", LXB_DOM_NODE_TYPE_DOCUMENT_FRAGMENT),
};

const larva_html_layout_entry *larva_html_layout(size_t *count) {
	*count = sizeof(larva_layout) / sizeof(larva_layout[0]);
	return larva_layout;
}

// The accessors behind node.odin that are not a mirrored field: each answers NULL for
// a node of the wrong kind rather than reading through the wrong struct. Strings are
// owned by the document.

// A template's content fragment, which holds what the parser put "inside" it; the
// element itself has no children.
lxb_dom_node_t *larva_html_template_content(lxb_dom_node_t *node) {
	if (node == NULL || node->type != LXB_DOM_NODE_TYPE_ELEMENT || node->local_name != LXB_TAG_TEMPLATE ||
		node->ns != LXB_NS_HTML) {
		return NULL;
	}

	lxb_dom_document_fragment_t *content = lxb_html_interface_template(node)->content;
	return content != NULL ? lxb_dom_interface_node(content) : NULL;
}

// One part of a doctype: 0 its name, 1 its public id, 2 its system id. NULL when the
// node is not a doctype.
const lxb_char_t *larva_html_doctype_part(lxb_dom_node_t *node, int part, size_t *len) {
	*len = 0;
	if (node == NULL || node->type != LXB_DOM_NODE_TYPE_DOCUMENT_TYPE) {
		return NULL;
	}

	lxb_dom_document_type_t *dt = lxb_dom_interface_document_type(node);
	const lxb_char_t *s;

	switch (part) {
	case 0:
		s = lxb_dom_document_type_name(dt, len);
		break;
	case 1:
		s = lxb_dom_document_type_public_id(dt, len);
		break;
	default:
		s = lxb_dom_document_type_system_id(dt, len);
		break;
	}

	return s != NULL ? s : (const lxb_char_t *)"";
}

// Parses `html` as the children of an HTML `context` element (the fragment parsing
// algorithm, as innerHTML runs it) into `doc`, a fresh document no chunked parse has
// begun on. Returns the context element, owned by `doc`, holding the fragment's nodes
// as innerHTML leaves them: as its children, or as its content for a template; NULL on
// failure.
//
// lexbor parses under a root `html` element of its own and returns that. The nodes are
// moved to the context element because their parent is observable: the serializer
// writes a `<style>` or `<script>` context's text unescaped, as Chrome does, only when
// the text's parent is that element (tests/dom html5lib-tests4-004.frag-style). The
// moves go through lexbor's `_wo_events` list operations: this document has no
// mutation observers, and nothing is destroyed (docs/LARVA.md D2).
lxb_dom_node_t *larva_html_parse_fragment(lxb_html_document_t *doc, const lxb_char_t *context, size_t context_len,
										  const lxb_char_t *html, size_t len) {
	lxb_dom_element_t *ctx =
		lxb_dom_document_create_element(lxb_dom_interface_document(doc), context, context_len, NULL);

	if (ctx == NULL) {
		return NULL;
	}

	lxb_dom_node_t *root = lxb_html_document_parse_fragment(doc, ctx, html, len);

	if (root == NULL) {
		return NULL;
	}

	lxb_dom_node_t *to = lxb_dom_interface_node(ctx);
	lxb_dom_node_t *content = larva_html_template_content(to);

	if (content != NULL) {
		to = content;
	}

	while (root->first_child != NULL) {
		lxb_dom_node_t *n = root->first_child;
		lxb_dom_node_remove_wo_events(n);
		lxb_dom_node_insert_child_wo_events(to, n);
	}

	return lxb_dom_interface_node(ctx);
}

larva_css *larva_css_create(void) {
	larva_css *e = calloc(1, sizeof(*e));

	if (e == NULL) {
		return NULL;
	}

	e->parser = lxb_css_parser_create();
	e->selectors = lxb_selectors_create();

	if (e->parser == NULL || e->selectors == NULL || lxb_css_parser_init(e->parser, NULL) != LXB_STATUS_OK ||
		lxb_selectors_init(e->selectors) != LXB_STATUS_OK) {
		if (e->selectors != NULL) {
			lxb_selectors_destroy(e->selectors, true);
		}

		if (e->parser != NULL) {
			lxb_css_parser_destroy(e->parser, true);
		}

		free(e);
		return NULL;
	}

	lxb_selectors_opt_set(e->selectors, LXB_SELECTORS_OPT_MATCH_FIRST);
	return e;
}

void larva_css_destroy(larva_css *e) {
	if (e == NULL) {
		return;
	}

	lxb_selectors_destroy(e->selectors, true);
	lxb_css_parser_destroy(e->parser, true);
	free(e);
}

lxb_css_selector_list_t *larva_css_compile(larva_css *e, const lxb_char_t *css, size_t len) {
	lxb_css_selector_list_t *list = lxb_css_selectors_parse(e->parser, css, len);

	if (e->parser->status != LXB_STATUS_OK) {
		lxb_css_selector_list_destroy_memory(list);
		return NULL;
	}

	return list;
}

static lxb_status_t larva_css_found(lxb_dom_node_t *node, lxb_css_selector_specificity_t spec, void *ctx) {
	larva_css_find_ctx *f = ctx;
	return f->found(node, f->ctx) ? LXB_STATUS_STOP : LXB_STATUS_OK;
}

bool larva_css_find(larva_css *e, lxb_dom_node_t *root, const lxb_css_selector_list_t *list, larva_css_found_f found,
					void *ctx) {
	larva_css_find_ctx f = {found, ctx};
	lxb_status_t st = lxb_selectors_find(e->selectors, root, list, larva_css_found, &f);
	return st == LXB_STATUS_OK || st == LXB_STATUS_STOP || st == LXB_STATUS_STOPPED;
}
