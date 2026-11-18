package larva_html

import "base:runtime"
import "core:c"
import "core:strings"

// Parser is an incremental HTML parser over lexbor that hands control back to the
// caller at every parser-blocking script, the way a browser's parser does.
//
// The caller owns the input and decides when parsing moves on. lexbor itself has no
// pause and no document.write (its tree builder leaves both as TODO at `</script>`,
// html/tree/insertion_mode/text.c), and needs neither: we feed it slices, and a slice
// never runs past the end tag of a script. So when `pump` returns a script, the tree
// holds exactly what precedes that script and nothing after it — what the script
// would see in a browser. Text the script writes (`write`) goes in front of the rest
// of the input, i.e. at the insertion point, and is parsed before it.
//
//     p: Parser
//     init(&p)
//     feed(&p, chunk)                  // as bytes arrive; finish(&p) at the end
//     for {
//         script, st := pump(&p)
//         switch st {
//         case .Script:     run it; write(&p, ...) for each document.write
//         case .Need_Input: feed(&p, next chunk) or finish(&p)
//         case .Done, .Failed: break
//         }
//     }
//     serialize(&p, ...)
//     destroy(&p)
//
// Limits, known:
//   - Input is taken as UTF-8. Charset sniffing (BOM, <meta charset>, Content-Type)
//     is not done yet.
//   - A slice is cut after the first `>` that follows a `</script` (any case). An end
//     tag that carries a quoted `>` in an attribute (`</script x=">">`) is legal HTML
//     and is cut too early; the script then closes inside the next, larger slice and
//     the pause lands late. No real page is known to do this.
//   - Script execution and document.write semantics beyond "insert at the insertion
//     point" (script nesting level, document.open after load) are the caller's.
Parser :: struct {
	doc:       Document,
	hook:      Hook,
	input:     [dynamic]byte, // unparsed input, from `off`
	off:       int,
	eof:       bool,
	ended:     bool,
	failed:    bool,
	allocator: runtime.Allocator,
}

Pump_Status :: enum {
	Need_Input, // every byte fed so far is parsed; feed more or finish
	Script, // parsing stopped right after this script's end tag
	Done, // finish was called and the document is complete
	Failed, // lexbor reported an error; the tree is whatever was built
}

// init creates the document and starts chunked parsing. false when lexbor could not
// allocate; the parser is then unusable and destroy is still safe.
init :: proc(p: ^Parser, allocator := context.allocator) -> bool {
	p^ = {}
	p.allocator = allocator
	p.input = make([dynamic]byte, 0, 0, allocator)
	p.doc = lxb_html_document_create()
	if p.doc == nil do return false
	p.hook = larva_html_begin(p.doc)
	if p.hook == nil {
		p.failed = true
		return false
	}
	return true
}

destroy :: proc(p: ^Parser) {
	if p.doc != nil do lxb_html_document_destroy(p.doc)
	if p.hook != nil do larva_html_hook_free(p.hook)
	delete(p.input)
	p^ = {}
}

// feed appends network bytes. Nothing is parsed until pump.
feed :: proc(p: ^Parser, data: []byte) {
	append(&p.input, ..data)
}

// finish marks the end of the input; the next pump that runs out of input completes
// the document.
finish :: proc(p: ^Parser) {
	p.eof = true
}

// write inserts `text` at the insertion point — right after the script pump returned,
// before the rest of the input — as document.write does. Meant to be called while
// paused on a script; scripts it contains pause in turn.
write :: proc(p: ^Parser, text: string) {
	inject_at(&p.input, p.off, ..transmute([]byte)text)
}

// pump parses until the next parser-blocking script, the end of the available input,
// or the end of the document.
pump :: proc(p: ^Parser) -> (script: Node, status: Pump_Status) {
	if p.failed do return nil, .Failed
	for {
		rest := p.input[p.off:]
		if len(rest) == 0 {
			if p.ended do return nil, .Done
			if p.eof {
				p.ended = true
				if lxb_html_document_parse_chunk_end(p.doc) != LXB_STATUS_OK {
					p.failed = true
					return nil, .Failed
				}
				return nil, .Done
			}
			compact(p)
			return nil, .Need_Input
		}
		n := next_cut(rest, p.eof)
		if n == 0 {
			compact(p)
			return nil, .Need_Input
		}
		if lxb_html_document_parse_chunk(p.doc, raw_data(rest), c.size_t(n)) != LXB_STATUS_OK {
			p.failed = true
			return nil, .Failed
		}
		p.off += n
		if s := larva_html_take_script(p.hook); s != nil do return s, .Script
	}
}

// document_node is the Document node, for serialization or a walk.
document_node :: proc(p: ^Parser) -> Node {
	return larva_html_document_node(p.doc)
}

// serialize appends the document's markup — the doctype, then the html element — to
// `out`. Comparing it with Chrome's output is the oracle's job (#2); not done yet.
serialize :: proc(p: ^Parser, out: ^strings.Builder) -> bool {
	cb :: proc "c" (data: [^]u8, len: c.size_t, ctx: rawptr) -> lxb_status_t {
		context = runtime.default_context()
		b := cast(^strings.Builder)ctx
		strings.write_bytes(b, data[:len])
		return LXB_STATUS_OK
	}
	return lxb_html_serialize_deep_cb(document_node(p), cb, out) == LXB_STATUS_OK
}

// text returns `node`'s textContent, copied into `allocator`.
text :: proc(node: Node, allocator := context.allocator) -> string {
	n: c.size_t
	t := larva_html_text(node, &n)
	if t == nil do return ""
	defer larva_html_text_free(node, t)
	return strings.clone(string(t[:n]), allocator)
}

// attr returns attribute `name` of element `node`. The string points into the
// document; copy it to keep it past the next change to that element.
attr :: proc(node: Node, name: string) -> (value: string, ok: bool) {
	n: c.size_t
	v := larva_html_attr(node, raw_data(name), c.size_t(len(name)), &n)
	if v == nil do return "", false
	return string(v[:n]), true
}

@(private = "file")
compact :: proc(p: ^Parser) {
	if p.off == 0 do return
	remove_range(&p.input, 0, p.off)
	p.off = 0
}

@(private = "file")
SCRIPT_END :: "</script"

// next_cut picks how many bytes of `rest` to hand lexbor now: up to and including the
// first `>` after a `</script`, so a script's end tag is always the last thing in its
// slice. Whether it really closes a script is lexbor's call (the shim's hook); this
// only places the cut. Without a candidate, everything goes except a tail that could
// be the start of one split across network chunks. 0 means wait for more input.
@(private = "file")
next_cut :: proc(rest: []byte, eof: bool) -> int {
	if i := index_ci(rest, SCRIPT_END); i >= 0 {
		for j in i + len(SCRIPT_END) ..< len(rest) {
			if rest[j] == '>' do return j + 1
		}
		return eof ? len(rest) : i
	}
	if eof do return len(rest)
	return len(rest) - partial_tail(rest)
}

// index_ci finds `needle` (lower-case ASCII) in `hay`, ASCII case-insensitively.
@(private = "file")
index_ci :: proc(hay: []byte, needle: string) -> int {
	if len(hay) < len(needle) do return -1
	outer: for i in 0 ..= len(hay) - len(needle) {
		if hay[i] != '<' do continue
		for k in 1 ..< len(needle) {
			if hay[i + k] | 0x20 != needle[k] && hay[i + k] != needle[k] do continue outer
		}
		return i
	}
	return -1
}

// partial_tail is the length of the longest suffix of `b` that is a proper prefix of
// SCRIPT_END, case-insensitively.
@(private = "file")
partial_tail :: proc(b: []byte) -> int {
	needle := SCRIPT_END
	for n := min(len(needle) - 1, len(b)); n > 0; n -= 1 {
		tail := b[len(b) - n:]
		if tail[0] != '<' do continue
		match := true
		for k in 1 ..< n {
			if tail[k] | 0x20 != needle[k] && tail[k] != needle[k] {
				match = false
				break
			}
		}
		if match do return n
	}
	return 0
}
