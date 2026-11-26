// Serializer benchmark for stage 3b (docs/LARVA.md D7): pkg/html's Odin serializer
// (html.serialize) against lexbor's (lxb_html_serialize_deep_cb, which it replaced),
// on the same parsed trees, in ns per KB of input.
//
// Run:   make bench-html   (LAUNCHES=7 launches; each prints one line per input)
// One:   odin build bench/html -collection:lava=. -o:speed -out:<bin>; <bin> [rounds]
//
// Inputs:
//   page    a synthetic 1.2 MB page — 12000 `<li>` and 6000 `<a href>` with text and
//           attribute values that need escaping — the page the earlier serializer
//           measurements in pkg/html were taken on.
//   corpus  every document case of tests/dom (the hand cases and the html5lib corpus),
//           each parsed once and serialized whole; time summed over the cases.
//
// Within a launch the two arms alternate round by round (lexbor, odin, lexbor, …), so
// drift hits both alike; each arm reports the median of its rounds. run.sh takes the
// median of those over the launches. Both arms write into a fresh builder each round
// and free it, as `lava html` does. The output of the two is compared once per input:
// a launch that finds them different on the page exits 1 (it should measure the same
// work), and on the corpus reports how many cases differ — those are cases where
// lexbor's serializer does not match Chrome (tests/dom). pkg/html/serialize.odin's
// header carries the result that decided the replacement, with its method.
package bench_html

import "base:runtime"
import "core:c"
import "core:fmt"
import "core:os"
import "core:slice"
import "core:strconv"
import "core:strings"
import "core:time"

import html "lava:pkg/html"

// lexbor's own serializer, bound here and nowhere else: pkg/html no longer uses it.
foreign import lexbor "../../.deps/lexbor/lib/liblexbor_static.a"

lxb_serialize_cb :: #type proc "c" (data: [^]u8, len: c.size_t, ctx: rawptr) -> c.uint

@(default_calling_convention = "c")
foreign lexbor {
	lxb_html_serialize_deep_cb :: proc(node: html.Node, cb: lxb_serialize_cb, ctx: rawptr) -> c.uint ---
}

Input :: struct {
	name:  string,
	docs:  [dynamic]html.Parser,
	bytes: int,
}

main :: proc() {
	rounds := 25

	if len(os.args) > 1 {
		n, ok := strconv.parse_int(os.args[1])

		if !ok || n < 1 {
			fmt.eprintln("usage: bench_html [rounds]")
			os.exit(2)
		}

		rounds = n
	}

	inputs := [2]Input{page_input(), corpus_input()}

	for &in_ in inputs {
		differ := 0

		for &p in in_.docs {
			a := lexbor_serialize(&p)
			b, _ := html.serialize(&p)

			if a != b {
				differ += 1
			}

			delete(a)
			delete(b)
		}

		if in_.name == "page" && differ != 0 {
			fmt.eprintln("bench_html: the two serializers disagree on the page")
			os.exit(1)
		}

		lex := make([]f64, rounds)
		odn := make([]f64, rounds)

		for r in 0 ..< rounds {
			lex[r] = time_arm(&in_, true)
			odn[r] = time_arm(&in_, false)
		}

		kb := f64(in_.bytes) / 1024
		fmt.printfln(
			"input=%s kb=%.0f docs=%d lexbor_ns_per_kb=%.0f odin_ns_per_kb=%.0f differ=%d",
			in_.name,
			kb,
			len(in_.docs),
			median(lex) / kb,
			median(odn) / kb,
			differ,
		)
	}
}

time_arm :: proc(in_: ^Input, lexbor: bool) -> f64 {
	start := time.tick_now()

	for &p in in_.docs {
		if lexbor {
			s := lexbor_serialize(&p)
			delete(s)
		} else {
			s, _ := html.serialize(&p)
			delete(s)
		}
	}

	return f64(time.tick_since(start))
}

lexbor_serialize :: proc(p: ^html.Parser) -> string {
	b := strings.builder_make()
	lxb_html_serialize_deep_cb(html.document(p), collect, &b)
	return strings.to_string(b)
}

collect :: proc "c" (data: [^]u8, n: c.size_t, raw: rawptr) -> c.uint {
	context = runtime.default_context()
	strings.write_bytes(cast(^strings.Builder)raw, data[:n])
	return 0
}

page_input :: proc() -> Input {
	b := strings.builder_make()
	strings.write_string(&b, "<!DOCTYPE html><html><head><title>bench</title></head><body>")

	for i in 0 ..< 6000 {
		fmt.sbprintf(
			&b,
			"<ul class=\"list\"><li data-i=\"%d\">Item %d &amp; more text, quoted \"so\"</li>" +
			"<li>Second &lt;x&gt; item with a little body copy<a href=\"/p?id=%d&amp;q=1\" " +
			"title=\"a &quot;t&quot; &lt;b&gt;\">link %d</a></li></ul>\n",
			i,
			i,
			i,
			i,
		)
	}

	strings.write_string(&b, "</body></html>")
	data := b.buf[:]
	in_ := Input {
		name  = "page",
		bytes = len(data),
	}
	append(&in_.docs, parse(data))
	return in_
}

corpus_input :: proc() -> Input {
	in_ := Input {
		name = "corpus",
	}
	dir := "tests/dom/cases"
	entries, err := os.read_all_directory_by_path(dir, context.allocator)

	if err != nil {
		fmt.eprintfln("bench_html: cannot read %s (run from the repository root): %v", dir, err)
		os.exit(1)
	}

	names: [dynamic]string

	for e in entries {
		if strings.has_suffix(e.name, ".html") && !strings.contains(e.name, ".frag-") {
			append(&names, e.fullpath)
		}
	}

	slice.sort(names[:])

	for path in names {
		data, rerr := os.read_entire_file(path, context.allocator)

		if rerr != nil {
			fmt.eprintfln("bench_html: cannot read %s: %v", path, rerr)
			os.exit(1)
		}

		in_.bytes += len(data)
		append(&in_.docs, parse(data))
	}

	return in_
}

parse :: proc(data: []byte) -> html.Parser {
	p: html.Parser

	if !html.init(&p) || !html.parse_all(&p, data) {
		fmt.eprintfln("bench_html: parse failed: %s", html.error_message(&p))
		os.exit(1)
	}

	return p
}

median :: proc(v: []f64) -> f64 {
	slice.sort(v)
	return v[len(v) / 2]
}
