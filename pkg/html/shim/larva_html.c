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
