#include <lexbor/css/css.h>
#include <lexbor/dom/dom.h>
#include <lexbor/html/html.h>
#include <lexbor/selectors/selectors.h>
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

// The tree read accessors behind node.odin (stage 3a). Each is a field read or a lexbor
// inline, which Odin cannot call; each answers NULL/0 for a node of the wrong kind
// rather than reading through the wrong struct. Strings are owned by the document.

int larva_html_node_type(lxb_dom_node_t *node) {
	return node != NULL ? (int)node->type : LXB_DOM_NODE_TYPE_UNDEF;
}

lxb_dom_node_t *larva_html_first_child(lxb_dom_node_t *node) {
	return node != NULL ? node->first_child : NULL;
}

lxb_dom_node_t *larva_html_next_sibling(lxb_dom_node_t *node) {
	return node != NULL ? node->next : NULL;
}

// lexbor's namespace id: LXB_NS_* for the namespaces the parser knows (ns/const.h),
// a hash entry's address for any other.
uintptr_t larva_html_ns(lxb_dom_node_t *node) {
	return node != NULL ? node->ns : LXB_NS__UNDEF;
}

// The element's name as the tree builder wrote it. Not lxb_dom_element_local_name:
// lexbor folds that one to lowercase even where the parser adjusts the case of an SVG
// name (`foreignObject`), and DOM's localName keeps the adjusted case. The qualified
// name is the same string with any prefix, and the HTML parser never gives an element
// a prefix.
const lxb_char_t *larva_html_element_name(lxb_dom_node_t *node, size_t *len) {
	*len = 0;
	if (node == NULL || node->type != LXB_DOM_NODE_TYPE_ELEMENT) {
		return NULL;
	}

	return lxb_dom_element_qualified_name(lxb_dom_interface_element(node), len);
}

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

// The data of a text, comment, CDATA section or processing instruction.
const lxb_char_t *larva_html_char_data(lxb_dom_node_t *node, size_t *len) {
	*len = 0;
	if (node == NULL) {
		return NULL;
	}

	switch (node->type) {
	case LXB_DOM_NODE_TYPE_TEXT:
	case LXB_DOM_NODE_TYPE_CDATA_SECTION:
	case LXB_DOM_NODE_TYPE_COMMENT:
	case LXB_DOM_NODE_TYPE_PROCESSING_INSTRUCTION: {
		lxb_dom_character_data_t *cd = lxb_dom_interface_character_data(node);
		*len = cd->data.length;
		return cd->data.data != NULL ? cd->data.data : (const lxb_char_t *)"";
	}
	default:
		return NULL;
	}
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

lxb_dom_attr_t *larva_html_first_attr(lxb_dom_node_t *node) {
	if (node == NULL || node->type != LXB_DOM_NODE_TYPE_ELEMENT) {
		return NULL;
	}

	return lxb_dom_interface_element(node)->first_attr;
}

lxb_dom_attr_t *larva_html_next_attr(lxb_dom_attr_t *attr) {
	return attr != NULL ? attr->next : NULL;
}

// The tree builder gives an attribute its element's namespace (html/tree.c,
// lxb_html_tree_append_attributes) and replaces it only for the ones foreign content
// adjusts (xlink:href, xml:lang, xmlns…). DOM puts every other attribute in no
// namespace, so an element namespace here means none.
static bool larva_attr_in_no_ns(const lxb_dom_attr_t *attr) {
	uintptr_t ns = attr->node.ns;
	return ns == LXB_NS__UNDEF || ns == LXB_NS_HTML || ns == LXB_NS_SVG || ns == LXB_NS_MATH;
}

// The attribute's DOM namespace: LXB_NS__UNDEF for none.
uintptr_t larva_html_attr_ns(lxb_dom_attr_t *attr) {
	if (attr == NULL || larva_attr_in_no_ns(attr)) {
		return LXB_NS__UNDEF;
	}

	return attr->node.ns;
}

// The attribute's DOM localName. Without a namespace that is the qualified name, which
// keeps the case the parser adjusted for SVG and MathML (`viewBox`, `definitionURL`)
// where lexbor's local name is folded; with one (`xlink:href`) it is the part after
// the prefix, lexbor's local name.
const lxb_char_t *larva_html_attr_local_name(lxb_dom_attr_t *attr, size_t *len) {
	*len = 0;
	if (attr == NULL) {
		return NULL;
	}

	return larva_attr_in_no_ns(attr) ? lxb_dom_attr_qualified_name(attr, len) : lxb_dom_attr_local_name(attr, len);
}

// The attribute's value; "" for a valueless one, for which lexbor answers NULL (see
// larva_html_attr).
const lxb_char_t *larva_html_attr_value_of(lxb_dom_attr_t *attr, size_t *len) {
	*len = 0;
	if (attr == NULL) {
		return NULL;
	}

	const lxb_char_t *value = lxb_dom_attr_value(attr, len);
	return value != NULL ? value : (const lxb_char_t *)"";
}

// Parses `html` as the children of an HTML `context` element (the fragment parsing
// algorithm, as innerHTML runs it) into `doc`, a fresh document no chunked parse has
// begun on. Returns the html element the fragment's nodes are children of, owned by
// `doc`; NULL on failure.
lxb_dom_node_t *larva_html_parse_fragment(lxb_html_document_t *doc, const lxb_char_t *context, size_t context_len,
										  const lxb_char_t *html, size_t len) {
	lxb_dom_element_t *ctx =
		lxb_dom_document_create_element(lxb_dom_interface_document(doc), context, context_len, NULL);

	if (ctx == NULL) {
		return NULL;
	}

	return lxb_html_document_parse_fragment(doc, ctx, html, len);
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
