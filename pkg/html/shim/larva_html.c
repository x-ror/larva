// The C side of pkg/html: the few lexbor calls that are inline functions, macros or
// struct reads, which Odin cannot bind directly, plus the one hook the incremental
// parser needs (see larva_html_begin). Everything else is bound from Odin
// (pkg/html/lexbor.odin). Built by scripts/build-lexbor.sh.

#include <lexbor/css/css.h>
#include <lexbor/dom/dom.h>
#include <lexbor/html/html.h>
#include <lexbor/selectors/selectors.h>
#include <stdlib.h>

// One per document being parsed. The tree builder installs its own token callback on
// the tokenizer when chunk parsing begins; we wrap it so we see every token first.
typedef struct {
	lxb_html_tokenizer_token_f orig;
	void *orig_ctx;
	lxb_html_tree_t *tree;
	lxb_dom_node_t *script; // the <script> whose end tag was just tokenized, else NULL
	size_t closed;			// script end tags seen since the last take; > 1 means one was lost
} larva_html_hook;

// --- CSS selectors ---------------------------------------------------------------
//
// A compiled selector list owns its memory: the CSS parser starts with none
// (lxb_css_parser_init leaves parser->memory NULL), so each lxb_css_selectors_parse
// creates a fresh one and hands it to the list it returns. Lists therefore outlive the
// engine that compiled them and are freed one by one with larva_css_free.

typedef struct {
	lxb_css_parser_t *parser;
	lxb_selectors_t *selectors;
} larva_css;

// Called per match in tree order; return true to stop the search.
typedef bool (*larva_css_found_f)(lxb_dom_node_t *node, void *ctx);

typedef struct {
	larva_css_found_f found;
	void *ctx;
} larva_css_find_ctx;

// Runs BEFORE the tree builder handles the token. For a script end tag in the text
// insertion mode the tree's current node is that <script> element; the tree pops it
// right after, so this is the one moment it can be captured. A `</script>` that is not
// closing a script element (inside a comment, in plain text) never reaches here as an
// end tag with that current node, so it is ignored.
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

// Starts chunked parsing of `doc` and installs the hook. NULL on failure; free with
// larva_html_hook_free after the document's parse has ended.
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

// Returns the script element closed since the last call, and clears it. *closed is
// how many script end tags were seen in that time: the parser cuts its slices so that
// it is never more than 1, and treats more as a failure rather than lose a script.
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

// textContent of `node`. The bytes belong to the document; release them with
// larva_html_text_free.
lxb_char_t *larva_html_text(lxb_dom_node_t *node, size_t *len) {
	return lxb_dom_node_text_content(node, len);
}

void larva_html_text_free(lxb_dom_node_t *node, lxb_char_t *text) {
	if (text != NULL) {
		lxb_dom_document_destroy_text(node->owner_document, text);
	}
}

// The value of attribute `name` on element `node`, or NULL when absent. Owned by the
// element; valid until the element changes.
const lxb_char_t *larva_html_attr(lxb_dom_node_t *node, const lxb_char_t *name, size_t name_len, size_t *len) {
	return lxb_dom_element_get_attribute(lxb_dom_interface_element(node), name, name_len, len);
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

	// querySelectorAll reports a node once, however many selectors of a list
	// (`a, a.x`) it matches; lexbor's default reports it once per selector.
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

// NULL when `css` is not a valid selector list.
lxb_css_selector_list_t *larva_css_compile(larva_css *e, const lxb_char_t *css, size_t len) {
	lxb_css_selector_list_t *list = lxb_css_selectors_parse(e->parser, css, len);

	if (e->parser->status != LXB_STATUS_OK) {
		lxb_css_selector_list_destroy_memory(list);
		return NULL;
	}

	return list;
}

void larva_css_free(lxb_css_selector_list_t *list) {
	lxb_css_selector_list_destroy_memory(list);
}

static lxb_status_t larva_css_found(lxb_dom_node_t *node, lxb_css_selector_specificity_t spec, void *ctx) {
	larva_css_find_ctx *f = ctx;
	return f->found(node, f->ctx) ? LXB_STATUS_STOP : LXB_STATUS_OK;
}

// Matches the descendants of `root` (not `root` itself), in tree order. A stop from
// `found` is success, not an error.
bool larva_css_find(larva_css *e, lxb_dom_node_t *root, const lxb_css_selector_list_t *list, larva_css_found_f found,
					void *ctx) {
	larva_css_find_ctx f = {found, ctx};
	lxb_status_t st = lxb_selectors_find(e->selectors, root, list, larva_css_found, &f);
	return st == LXB_STATUS_OK || st == LXB_STATUS_STOP || st == LXB_STATUS_STOPPED;
}

// outerHTML of `node`.
lxb_status_t larva_html_serialize_node(lxb_dom_node_t *node, lxb_html_serialize_cb_f cb, void *ctx) {
	return lxb_html_serialize_tree_cb(node, cb, ctx);
}
