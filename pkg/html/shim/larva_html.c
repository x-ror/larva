// The C side of pkg/html: the few lexbor calls that are inline functions, macros or
// struct reads, which Odin cannot bind directly, plus the one hook the incremental
// parser needs (see larva_html_begin). Everything else is bound from Odin
// (pkg/html/lexbor.odin). Built by scripts/build-lexbor.sh.

#include <lexbor/html/html.h>
#include <lexbor/dom/dom.h>
#include <stdlib.h>

// One per document being parsed. The tree builder installs its own token callback on
// the tokenizer when chunk parsing begins; we wrap it so we see every token first.
typedef struct {
    lxb_html_tokenizer_token_f orig;
    void *orig_ctx;
    lxb_html_tree_t *tree;
    lxb_dom_node_t *script; // the <script> whose end tag was just tokenized, else NULL
} larva_html_hook;

// Runs BEFORE the tree builder handles the token. For a script end tag in the text
// insertion mode the tree's current node is that <script> element; the tree pops it
// right after, so this is the one moment it can be captured. A `</script>` that is not
// closing a script element (inside a comment, in plain text) never reaches here as an
// end tag with that current node, so it is ignored.
static lxb_html_token_t *
larva_hook_cb(lxb_html_tokenizer_t *tkz, lxb_html_token_t *token, void *ctx)
{
    larva_html_hook *h = ctx;
    if (token->tag_id == LXB_TAG_SCRIPT && (token->type & LXB_HTML_TOKEN_TYPE_CLOSE)) {
        lxb_dom_node_t *cur = lxb_html_tree_current_node(h->tree);
        if (cur != NULL && cur->local_name == LXB_TAG_SCRIPT) {
            h->script = cur;
        }
    }
    return h->orig(tkz, token, h->orig_ctx);
}

// Starts chunked parsing of `doc` and installs the hook. NULL on failure; free with
// larva_html_hook_free after the document's parse has ended.
larva_html_hook *
larva_html_begin(lxb_html_document_t *doc)
{
    if (lxb_html_document_parse_chunk_begin(doc) != LXB_STATUS_OK) return NULL;
    lxb_html_parser_t *parser = doc->dom_document.parser;
    if (parser == NULL || parser->tkz == NULL || parser->tree == NULL) return NULL;
    larva_html_hook *h = calloc(1, sizeof(*h));
    if (h == NULL) return NULL;
    h->orig = parser->tkz->callback_token_done;
    h->orig_ctx = parser->tkz->callback_token_ctx;
    h->tree = parser->tree;
    lxb_html_tokenizer_callback_token_done_set(parser->tkz, larva_hook_cb, h);
    return h;
}

// Returns the script element closed since the last call, and clears it.
lxb_dom_node_t *
larva_html_take_script(larva_html_hook *h)
{
    lxb_dom_node_t *s = h->script;
    h->script = NULL;
    return s;
}

void
larva_html_hook_free(larva_html_hook *h)
{
    free(h);
}

lxb_dom_node_t *
larva_html_document_node(lxb_html_document_t *doc)
{
    return lxb_dom_interface_node(doc);
}

// textContent of `node`. The bytes belong to the document; release them with
// larva_html_text_free.
lxb_char_t *
larva_html_text(lxb_dom_node_t *node, size_t *len)
{
    return lxb_dom_node_text_content(node, len);
}

void
larva_html_text_free(lxb_dom_node_t *node, lxb_char_t *text)
{
    if (text != NULL) lxb_dom_document_destroy_text(node->owner_document, text);
}

// The value of attribute `name` on element `node`, or NULL when absent. Owned by the
// element; valid until the element changes.
const lxb_char_t *
larva_html_attr(lxb_dom_node_t *node, const lxb_char_t *name, size_t name_len, size_t *len)
{
    return lxb_dom_element_get_attribute(lxb_dom_interface_element(node), name, name_len, len);
}
