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

// run_html_page runs an HTML page end to end (docs/LARVA.md roadmap stage 4): it creates
// the page (page_create: VM, context, Window globals), installs its DOM (dom_install),
// parses `data` as the document with its classic scripts run as HTML runs them
// (page_script.odin): inline and parser-blocking external ones as the parser reaches
// each, the parser paused; then it moves the document to `interactive`
// (readystatechange), runs the `defer` scripts, fires DOMContentLoaded, runs the page's
// event loop until it idles (async and inserted external scripts are tasks on it), moves
// the document to `complete` (readystatechange, the window's `load`), runs the loop to
// idle again, and returns a view of the document as it then is.
//
// Params:
//   data         The document, UTF-8 (a caller with other bytes decodes first,
//                html.decode_document).
//   source_name  The page's name, under which its inline scripts run (stack traces show
//                it).
//   document_path  The document's file, which a script's `src` resolves against and is
//                read beside; "" fails every external script's fetch (its `error`).
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
//   Module scripts never run, and a `src` is read from disk (page_script.odin says what
//   that changes). The document is parsed whole by
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
	document_path := "",
) -> (
	result: Result,
	output: string,
) {
	// The per-run temp boundary eval has: the install's scratch and the scripts' natives
	// would otherwise wait for the next tick, forever for a page with no loop.
	defer free_all(context.temp_allocator)

	page: Page

	if page_create(&page, source_name, loop, origin = origin) {
		output = html_page_run(&page, data, source_name, document_path, view)
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
html_page_run :: proc(page: ^Page, data: []byte, source_name, document_path: string, view: Html_View) -> string {
	ctx := cast(jsc.JSContextRef)page.ctx

	vm_cpu_enter(page.vm)
	install_err := dom_install(ctx, page.state)
	vm_cpu_exit(page.vm)

	if install_err != "" {
		page_fail(page, Result{status = .Native_Runtime_Unavailable, exit_code = 70, message = install_err})
		return ""
	}

	scripts_attach(page, document_path, source_name)

	on_script :: proc(p: ^html.Parser, script: html.Node, user_data: rawptr) {
		page := cast(^Page)user_data

		// A page a limit ended runs nothing more; the parse still finishes, cheaply.
		if page.finished || page.state == nil || page.state.dom == nil {
			return
		}

		scripts_parser_reached(page, script)
		scripts_run_pending(page)
	}

	if !html.parse_all(&page.state.dom.parser, data, on_script, page) {
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
	scripts_run_deferred(page)

	if page_dom_live(page) {
		dom_advance(ctx, page, .Content_Loaded)
	}

	page_run_idle(page)

	// `load` once the loop idled: the async and inserted scripts it ran were the page's
	// only subresources (a page with no loop runs them here). Then the loop again, for
	// what the load listeners queued.
	if page_dom_live(page) {
		scripts_run_ready(page)
	}

	if page_dom_live(page) {
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

// page_dom_live reports whether the page is still running with its DOM.
@(private = "file")
page_dom_live :: proc(page: ^Page) -> bool {
	return !page.finished && page.state != nil && page.state.dom != nil
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
