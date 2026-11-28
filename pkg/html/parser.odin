package larva_html

import "core:c"
import "core:strings"

// Parser is an incremental HTML parser that hands control back to the caller at every
// parser-blocking script, the way a browser's parser does (#10).
//
// The caller owns the input and decides when parsing moves on. lexbor has no pause and
// no document.write (its tree builder leaves both as TODO at `</script>`,
// html/tree/insertion_mode/text.c) and needs neither: we feed it slices that never run
// past a script's end tag (cut.odin). So when `pump` returns a script, the tree holds
// exactly what precedes it — what the script would see in a browser. Text the script
// writes (`write`) is parsed next, before the rest of the input.
//
//     p: Parser
//     init(&p) or_return
//     defer destroy(&p)
//     feed(&p, bytes)                    // as they arrive; finish(&p) after the last
//     for {
//         script, status := pump(&p)
//         switch status {
//         case .Script:     run it; write(&p, ...) for each document.write
//         case .Need_Input: feed(&p, ...) or finish(&p)
//         case .Done:       // the document is complete
//         case .Failed:     // error_message(&p) says why
//         }
//     }
//
// parse_all wraps that loop for input already in memory.
//
// Known limits:
//   - Input is taken as UTF-8. A navigation's bytes go through decode_document
//     (encoding.odin) first, whole: there is no streaming decoder yet.
//   - Script nesting level and document.open (a write after the parse ended) are not
//     modelled; write is refused once the document is done.
//   - A `</script` split between written text and the input that follows it is not
//     seen as one candidate.
//
// The fields are internal; use the procedures.
Parser :: struct {
	doc:     lxb_document,
	hook:    larva_hook,
	input:   Source, // network bytes
	written: Source, // document.write text, parsed before the rest of `input`
	ins:     int, // where the next write goes in `written`
	eof:     bool, // finish was called
	ended:   bool, // lexbor has ended the document
	err:     string, // why the parser failed; "" while it has not
}

Pump_Status :: enum {
	Need_Input, // everything fed so far is parsed; feed more or finish
	Script, // parsing stopped right after this script's end tag
	Done, // finish was called and the document is complete
	Failed, // see error_message; the tree is whatever was built
}

// Script_Proc runs at each parser-blocking script during parse_all. It may call write.
Script_Proc :: #type proc(p: ^Parser, script: Node, user_data: rawptr)

// init creates an empty document and starts parsing it.
//
// Returns:
//   false when lexbor could not create the document, or off Linux, where no lexbor
//   build exists yet (error_message says which). destroy is safe either way.
init :: proc(p: ^Parser, allocator := context.allocator) -> bool {
	p^ = {}
	source_init(&p.input, allocator)
	source_init(&p.written, allocator)
	when ODIN_OS != .Linux {
		p.err = "pkg/html: no lexbor build for this target (Linux only)"
		return false
	}
	p.doc = lxb_html_document_create()

	if p.doc == nil {
		p.err = "pkg/html: lexbor could not create a document"
		return false
	}

	p.hook = larva_html_begin(p.doc)

	if p.hook == nil {
		p.err = "pkg/html: lexbor could not start parsing"
		return false
	}

	return true
}

// destroy frees the document and everything in it. Nodes from this parser are
// dangling afterwards.
destroy :: proc(p: ^Parser) {
	// The document first: the hook is lexbor's tokenizer callback context until then.
	if p.doc != nil {
		lxb_html_document_destroy(p.doc)
	}

	if p.hook != nil {
		larva_html_hook_free(p.hook)
	}

	delete(p.input.buf)
	delete(p.written.buf)
	p^ = {}
}

// feed appends network bytes; nothing is parsed until pump.
feed :: proc(p: ^Parser, data: []byte) {
	append(&p.input.buf, ..data)
}

// finish marks the end of the input; the pump that runs out of input then ends the
// document.
finish :: proc(p: ^Parser) {
	p.eof = true
}

// write inserts `text` at the insertion point: right after the script pump last
// returned, after any text earlier writes put there, before the rest of the input.
// Scripts in `text` pause in turn.
//
// Returns:
//   false, and nothing is inserted, once the document is done, the parser failed, or
//   the text could not be stored.
// Chrome:
//   document.write is the model; Chrome 158, tests/dom/cases/dom-script-write.page,
//   with pump_written parsing the text before the write returns.
write :: proc(p: ^Parser, text: string) -> bool {
	if p.ended || p.err != "" {
		return false
	}

	if len(text) == 0 {
		return true
	}

	// Reserve first, so a refused write leaves nothing behind: append stores as much as
	// fits before it reports the failure, and that prefix would be parsed. The growth is
	// geometric because inject_at resizes to the exact length — a script calling
	// document.write in a loop would otherwise reallocate on every call.
	need := len(p.written.buf) + len(text)

	if need > cap(p.written.buf) && non_zero_reserve(&p.written.buf, max(2 * cap(p.written.buf), need)) != nil {
		return false
	}

	if p.ins == len(p.written.buf) {
		non_zero_append(&p.written.buf, text)
	} else {
		inject_at(&p.written.buf, p.ins, text)
	}

	p.ins += len(text)
	return true
}

// pump parses until the next parser-blocking script, the end of what has been fed, or
// the end of the document.
pump :: proc(p: ^Parser) -> (script: Node, status: Pump_Status) {
	return pump_from(p, written_only = false)
}

// pump_written parses only what write inserted, until the next script in it or its end
// (.Need_Input), never reaching into the rest of the input: document.write's own parse,
// which runs before write returns.
//
// Chrome:
//   HTML's document.write steps 6-7: the inserted characters are tokenized at once,
//   stopping at the insertion point or at a script end tag; Chrome 158,
//   tests/dom/cases/dom-script-write.page (an element written by a script is in the
//   tree when write returns, and a written inline script runs inside the write).
pump_written :: proc(p: ^Parser) -> (script: Node, status: Pump_Status) {
	return pump_from(p, written_only = true)
}

@(private = "file")
pump_from :: proc(p: ^Parser, written_only: bool) -> (script: Node, status: Pump_Status) {
	if p.err != "" {
		return nil, .Failed
	}

	if p.ended {
		return nil, .Done
	}

	for {
		src, src_eof := &p.input, p.eof

		if source_pending(&p.written) > 0 {
			src, src_eof = &p.written, true
		} else {
			if len(p.written.buf) > 0 {
				source_reset(&p.written)
				p.ins = 0
			}

			if written_only {
				return nil, .Need_Input
			}
		}

		if source_pending(src) == 0 {
			if !p.eof {
				source_compact(&p.input)
				return nil, .Need_Input
			}

			p.ended = true

			if larva_html_parse_end(p.hook, p.doc) != LXB_STATUS_OK {
				return nil, fail(p, "pkg/html: lexbor failed to end the document")
			}

			return nil, .Done
		}

		n := next_cut(src, src_eof)

		if n == 0 {
			source_compact(&p.input)
			return nil, .Need_Input
		}

		if larva_html_parse_chunk(p.hook, p.doc, raw_data(src.buf[src.off:]), c.size_t(n)) != LXB_STATUS_OK {
			return nil, fail(p, "pkg/html: lexbor failed to parse")
		}

		src.off += n

		closed: c.size_t
		s := larva_html_take_script(p.hook, &closed)

		if closed > 1 {
			// A slice closed two scripts: the first was never handed out. cut.odin keeps
			// this from happening; failing beats losing a script quietly.
			return nil, fail(p, "pkg/html: two scripts closed in one slice")
		}

		if s != nil {
			p.ins = p.written.off
			return s, .Script
		}
	}
}

// parse_all parses `data` as the whole document, calling `on_script` at each pause.
// `chunk` > 0 feeds the input that many bytes at a time, as network reads would; 0
// feeds it at once.
parse_all :: proc(
	p: ^Parser,
	data: []byte,
	on_script: Script_Proc = nil,
	user_data: rawptr = nil,
	chunk := 0,
) -> bool {
	off := 0
	for {
		script, status := pump(p)
		switch status {
		case .Script:
			if on_script != nil {
				on_script(p, script, user_data)
			}
		case .Need_Input:
			if off == len(data) {
				finish(p)
				continue
			}

			end := len(data) if chunk <= 0 else min(off + chunk, len(data))
			feed(p, data[off:end])
			off = end
		case .Done:
			return true
		case .Failed:
			return false
		}
	}
}

// observe_inserted starts (or stops) recording the nodes the parser inserts, for a
// MutationObserver: a page's DOM turns it on while any observer is registered, and
// take_inserted hands the record out at each microtask checkpoint. Stopping drops what
// was recorded. Insertions a script makes through the DOM are never recorded: only
// those made inside pump's calls into lexbor are.
//
// Chrome:
//   Nodes the parser inserts under an observed node are reported as childList records,
//   one per node, delivered at the checkpoint before the next script runs; Chrome 158,
//   tests/dom/cases/dom-mutation-observer-parser.page.
// Deviates:
//   A node lexbor inserts without its mutation steps — foster-parented before a table,
//   or moved by the adoption agency algorithm — is not recorded (lexbor's tree builder
//   inserts those with lxb_dom_node_insert_*_wo_events). Text the parser appends to an
//   existing text node is not a record in Chrome either.
observe_inserted :: proc(p: ^Parser, on: bool) {
	if p.hook != nil {
		larva_html_observe(p.hook, on)
	}
}

// take_inserted returns the nodes recorded since the last call, oldest first, and
// empties the record. The slice is the shim's and is valid until the parser runs again.
take_inserted :: proc(p: ^Parser) -> []Node {
	if p.hook == nil {
		return nil
	}

	n: c.size_t
	nodes := larva_html_take_inserted(p.hook, &n)

	if n == 0 || nodes == nil {
		return nil
	}

	return nodes[:n]
}

// parse_fragment parses `data` as the children of an HTML element named `context`
// (the fragment parsing algorithm, as innerHTML runs it), into a document of its own
// that `p` owns: destroy frees it, as it frees a parsed document. `p` must not have
// been init'ed. No script pauses and nothing can be written: the document is done.
//
// Returns:
//   The context element, which holds the fragment's nodes as its children — as its
//   template content when `context` is `template` — so inner_html serializes them;
//   ok false when lexbor could not create the document or parse into it, for a
//   foreign context (`svg desc`, stage 3e), or off Linux (error_message says which).
// Chrome:
//   `doc.createElement(context).innerHTML = data` in a no-quirks document with
//   scripting off; tests/dom's `*.frag-<context>` cases compare it with Chrome's.
//
// The context is always an HTML element in a no-quirks document: a fragment for an
// SVG/MathML context or a quirks-mode page waits for stage 3e, which parses fragments
// into a live tree with a real context element.
parse_fragment :: proc(
	p: ^Parser,
	context_name: string,
	data: []byte,
	allocator := context.allocator,
) -> (
	root: Node,
	ok: bool,
) {
	p^ = {}
	source_init(&p.input, allocator)
	source_init(&p.written, allocator)
	// The parse is over before this returns: pump answers .Done and write refuses.
	p.ended = true

	if strings.contains_rune(context_name, ' ') {
		// html5lib's `svg desc` / `math mi` notation, in which tests/dom's corpus cases
		// name a foreign context: refused rather than taken for an HTML element with a
		// space in its name.
		p.err = "pkg/html: a fragment context in the SVG or MathML namespace waits for stage 3e"
		return nil, false
	}

	when ODIN_OS != .Linux {
		p.err = "pkg/html: no lexbor build for this target (Linux only)"
		return nil, false
	}
	p.doc = lxb_html_document_create()

	if p.doc == nil {
		p.err = "pkg/html: lexbor could not create a document"
		return nil, false
	}

	root = larva_html_parse_fragment(
		p.doc,
		raw_data(context_name),
		c.size_t(len(context_name)),
		raw_data(data),
		c.size_t(len(data)),
	)

	if root == nil {
		p.err = "pkg/html: lexbor failed to parse the fragment"
		return nil, false
	}

	return root, true
}

// document returns the Document node: the root for a walk or a selector search over
// the whole page. nil when init failed.
document :: proc(p: ^Parser) -> Node {
	return larva_html_document_node(p.doc) if p.doc != nil else nil
}

// error_message says why the parser failed; "" when it has not.
error_message :: proc(p: ^Parser) -> string {
	return p.err
}

// serialize returns the document's markup — the doctype, then the html element.
//
// Returns:
//   ok false when init failed or the markup cannot be allocated — never a truncated
//   string.
// Chrome:
//   the page's serialized DOM is the model; unverified — no recording exists yet (#2).
serialize :: proc(p: ^Parser, allocator := context.allocator) -> (markup: string, ok: bool) {
	if p.doc == nil {
		return "", false
	}

	return serialize_markup(larva_html_document_node(p.doc), true, 0, allocator)
}

@(private = "file")
fail :: proc(p: ^Parser, why: string) -> Pump_Status {
	p.err = why
	return .Failed
}
