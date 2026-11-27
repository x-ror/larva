package lava_runtime

import "core:strings"
import html "lava:pkg/html"
import jsc "lava:pkg/jsc"
import eventloop "lava:pkg/runtime/eventloop"

// Html_View is what run_html_page hands back of the document once the page is idle.
Html_View :: enum {
	// The HTML serialization of the document, as `lava html --serialize` prints it.
	Serialize,
	// The html5lib-format tree, as `lava html --tree` prints it.
	Tree,
}

// run_html_page runs an HTML page end to end (docs/LARVA.md roadmap stage 4a): it creates
// the page (page_create: VM, context, Window globals), installs its DOM (dom_install),
// parses `data` as the document with its classic inline scripts run in document order
// as the parser reaches each one, moves the document to `interactive` (readystatechange,
// DOMContentLoaded), runs the page's event loop until it idles, moves it to `complete`
// (readystatechange, the window's `load`), runs the loop to idle again, and returns a
// view of the document as it then is.
//
// Params:
//   data         The document, UTF-8 (a caller with other bytes decodes first,
//                html.decode_document).
//   source_name  The page's name, under which its scripts run (stack traces show it).
//   loop         Consumed on every path, as by eval.
//   report       eval's Result_Hook, fired by page_close.
// Returns:
//   result  The page's Result: .Ok and exit code 0, or 1 when a script threw (each throw
//           is reported to stderr as it happens and the page goes on, as a browser's
//           does), or the failure that ended it.
//   output  The view, allocated with context.allocator (the caller deletes it); "" when
//           the page ended before it could be read.
// Chrome:
//   A page navigated to with scripting on; tests/dom's `*.page.html` cases compare the
//   tree and serialization after its scripts with Chrome 158's, read once the frame
//   holding the page has loaded.
// Deviates:
//   External scripts (`src`), module scripts and `defer`/`async` are skipped (stage 4b):
//   only parser-inserted inline classic scripts run. The document is parsed whole by
//   lexbor with scripting off, so `<noscript>` content parses as markup, where a
//   scripted Chrome page parses it as text. `load` fires once the loop has idled after
//   DOMContentLoaded (there are no subresources to wait for), so a timer set before it
//   runs first, where Chrome's order with one is a race.
run_html_page :: proc(
	data: []byte,
	source_name: string,
	loop: ^eventloop.Loop = nil,
	view: Html_View = .Serialize,
	report: Result_Hook = nil,
	report_data: rawptr = nil,
	origin := "",
) -> (
	result: Result,
	output: string,
) {
	// The per-run temp boundary eval has: the install's scratch and the scripts' natives
	// would otherwise wait for the next tick, forever for a page with no loop.
	defer free_all(context.temp_allocator)

	page: Page

	if page_create(&page, source_name, loop, origin = origin) {
		output = html_page_run(&page, data, source_name, view)
	}

	busy_loop: ^eventloop.Loop
	result, busy_loop = page_close(&page, report = report, report_data = report_data)

	// One page on its own thread, as eval: it waits for blocking pool work.
	if busy_loop != nil {
		eventloop.close_finish(busy_loop)
	}

	return result, output
}

// html_page_run is run_html_page on a page page_create made live: install, parse and
// script, DOMContentLoaded, the loop, the view.
@(private = "file")
html_page_run :: proc(page: ^Page, data: []byte, source_name: string, view: Html_View) -> string {
	ctx := cast(jsc.JSContextRef)page.ctx

	vm_cpu_enter(page.vm)
	install_err := dom_install(ctx, page.state)
	vm_cpu_exit(page.vm)

	if install_err != "" {
		page_fail(page, Result{status = .Native_Runtime_Unavailable, exit_code = 70, message = install_err})
		return ""
	}

	Script_Run :: struct {
		page:        ^Page,
		source_name: string,
	}

	on_script :: proc(p: ^html.Parser, script: html.Node, user_data: rawptr) {
		run := cast(^Script_Run)user_data

		// A page a limit ended runs nothing more; the parse still finishes, cheaply.
		if run.page.finished {
			return
		}

		if source, runs := element_script_source(script); runs {
			defer delete(source)
			page_run_element_script(run.page, source, run.source_name)
		}
	}

	run := Script_Run{page, source_name}

	if !html.parse_all(&page.state.dom.parser, data, on_script, &run) {
		page_fail(
			page,
			Result {
				status = .Execution_Error,
				exit_code = 1,
				message = strings.clone(html.error_message(&page.state.dom.parser)),
				is_allocated = true,
			},
		)
		return ""
	}

	if page.finished {
		return ""
	}

	dom_advance(ctx, page, .Interactive)
	page_run_idle(page)

	// `load` once the loop idled: a Larva page has no subresources to wait for. Then the
	// loop again, for what the load listeners queued.
	if !page.finished && page.state != nil && page.state.dom != nil {
		dom_advance(ctx, page, .Complete)
		page_run_idle(page)
	}

	// A page a limit or a stop ended reports that, not its document.
	if page.finished || page.state == nil || page.state.dom == nil {
		return ""
	}

	out: string
	ok: bool

	switch view {
	case .Serialize:
		out, ok = html.serialize(&page.state.dom.parser)
	case .Tree:
		out, ok = html.dump_tree(html.document(&page.state.dom.parser))
	}

	return out if ok else ""
}

// page_run_idle ticks the page until its loop idles or the page ends.
@(private = "file")
page_run_idle :: proc(page: ^Page) {
	for {
		alive, _ := page_tick(page)

		if !alive {
			break
		}
	}
}

// element_script_source returns the text of a parser-inserted `<script>` the page runs —
// an HTML script element with no `src`, no `nomodule`, and a classic script type —
// copied with context.allocator.
//
// Returns:
//   runs false for every other script: an external one (stage 4b fetches it), a module,
//   a data block (`type="text/plain"`, JSON), or an empty one.
// Chrome:
//   HTML's "prepare the script element": an absent or empty `type`, or a JavaScript MIME
//   type essence match, is a classic script.
@(private = "file")
element_script_source :: proc(script: html.Node) -> (source: string, runs: bool) {
	if html.namespace_of(script) != .HTML {
		return "", false
	}

	if _, has := html.attr_view(script, "src"); has {
		return "", false
	}

	if _, has := html.attr_view(script, "nomodule"); has {
		return "", false
	}

	if type, has := html.attr_view(script, "type"); has && !is_classic_script_type(type) {
		return "", false
	}

	source = html.text(script, context.allocator)
	return source, source != ""
}

// is_classic_script_type reports whether a script's `type` makes it a classic script:
// the empty string, or a JavaScript MIME type essence (ASCII case-insensitive, after
// stripping ASCII whitespace — so an all-whitespace type is no script), per the HTML
// standard's list.
@(private = "file")
is_classic_script_type :: proc(type: string) -> bool {
	if type == "" {
		return true
	}

	t := strings.trim(type, " \t\n\f\r")

	JS_TYPES :: [?]string {
		"application/ecmascript",
		"application/javascript",
		"application/x-ecmascript",
		"application/x-javascript",
		"text/ecmascript",
		"text/javascript",
		"text/javascript1.0",
		"text/javascript1.1",
		"text/javascript1.2",
		"text/javascript1.3",
		"text/javascript1.4",
		"text/javascript1.5",
		"text/jscript",
		"text/livescript",
		"text/x-ecmascript",
		"text/x-javascript",
	}

	for known in JS_TYPES {
		if strings.equal_fold(t, known) {
			return true
		}
	}

	return false
}
