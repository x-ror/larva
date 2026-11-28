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
//   document_path  The document's file, which a script's `src` naming a local file
//                resolves against and is read beside; "" for none.
//   origin       The page's origin or URL (`location`). When it is an http(s) URL, a
//                `src` that names no local file is resolved against it and fetched over
//                the network on `loop` (page_script.odin); otherwise such a script fails
//                its fetch (its `error`).
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
//   Module scripts never run, and a local `src` is read from disk (page_script.odin says
//   what that changes). The document is parsed whole by
//   lexbor with scripting off, so `<noscript>` content parses as markup, where a
//   scripted Chrome page parses it as text. `load` fires once the loop has idled after
//   DOMContentLoaded (scripts are the only subresources waited for), so a timer set
//   before it runs first, where Chrome's order with one is a race.
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
		output = html_page_run(&page, data, source_name, document_path, origin, view)
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
// script, DOMContentLoaded, the loop, `load`, the loop again, the view.
@(private = "file")
html_page_run :: proc(
	page: ^Page,
	data: []byte,
	source_name, document_path, document_url: string,
	view: Html_View,
) -> string {
	if !html_page_begin(page, data, source_name, document_path, document_url) {
		return ""
	}

	page_run_idle(page)

	// Then the loop again, for what the load listeners queued.
	if !html_page_fire_load(page) {
		return ""
	}

	page_run_idle(page)
	return html_page_view(page, view)
}

// html_page_begin is the HTML page's start, up to and including DOMContentLoaded: the
// DOM installed, `data` parsed with its classic scripts run as the parser reaches each,
// `interactive`, the defer scripts, then DOMContentLoaded (html_page_continue). Shared
// by run_html_page and the crawl driver (page_crawl.odin), which tick the loop between
// the steps themselves.
//
// A script fetched over the network pauses that sequence instead of blocking the
// thread: html_page_begin returns with the parse (or the defer scripts) waiting, and
// the fetch's completion, a task on the page's loop, carries it on. Either way the
// caller's next step is to tick the loop until it idles — an in-flight fetch keeps it
// busy — so DOMContentLoaded has fired by the time it does.
//
// Returns:
//   false when the page has ended (a limit, a failed install, a failed parse; its Result
//   is recorded) and there is nothing more to run.
@(private)
html_page_begin :: proc(page: ^Page, data: []byte, source_name, document_path, document_url: string) -> bool {
	ctx := cast(jsc.JSContextRef)page.ctx

	vm_cpu_enter(page.vm)
	install_err := dom_install(ctx, page.state)
	vm_cpu_exit(page.vm)

	if install_err != "" {
		page_fail(page, Result{status = .Native_Runtime_Unavailable, exit_code = 70, message = install_err})
		return false
	}

	scripts_attach(page, document_path, document_url, source_name)
	html.feed(&page.state.dom.parser, data)
	html.finish(&page.state.dom.parser)
	return html_page_continue(page)
}

// html_page_continue runs the page's load sequence from where it stands until it waits
// on a fetch or is done: the parser, pumped until a parser-blocking script is still in
// flight or the document ends; then `interactive` and the defer scripts, until one is
// still in flight; then DOMContentLoaded. Called by html_page_begin, and by a script
// fetch's completion (page_script.odin scripts_fetched) to go on. A call made while one
// is running (a fetch completing under a script) returns at once: the running one
// sees what completed when its script returns.
//
// Returns:
//   false when the page has ended; its Result is recorded.
@(private)
html_page_continue :: proc(page: ^Page) -> bool {
	if !page_dom_live(page) {
		return false
	}

	dom := page.state.dom
	s := &dom.scripts

	if s.continuing {
		return true
	}

	s.continuing = true
	defer if page_dom_live(page) && page.state.dom == dom {
		s.continuing = false
	}

	ctx := cast(jsc.JSContextRef)page.ctx

	for s.parse_state == .Parsing {
		// What a script wrote first, and what a previous step left pending.
		scripts_run_pending(page)

		if !page_dom_live(page) {
			return false
		}

		if s.has_pending {
			return true
		}

		script, status := html.pump(&dom.parser)

		switch status {
		case .Script:
			scripts_parser_reached(page, script)
		case .Need_Input:
			// Everything was fed and finished before the first pump; never reached.
			html.finish(&dom.parser)
		case .Done:
			s.parse_state = .Deferred
			dom_advance(ctx, page, .Interactive)
		case .Failed:
			page_fail(
				page,
				Result {
					status = .Execution_Error,
					exit_code = 1,
					message = strings.clone(html.error_message(&dom.parser)),
					is_allocated = true,
				},
			)
			return false
		}

		if !page_dom_live(page) {
			return false
		}
	}

	if s.parse_state == .Deferred {
		if !scripts_run_deferred(page) {
			return page_dom_live(page)
		}

		s.parse_state = .Loaded
		dom_advance(ctx, page, .Content_Loaded)
	}

	return page_dom_live(page)
}

// html_page_fire_load is the page's `load`, to be called once its loop has idled after
// DOMContentLoaded: the async and inserted scripts it ran, fetches and all, were the
// page's only subresources (a page with no loop runs them here), then `complete` (readystatechange,
// the window's `load`). Returns false when the page has ended.
@(private)
html_page_fire_load :: proc(page: ^Page) -> bool {
	if page_dom_live(page) {
		scripts_run_ready(page)
	}

	if page_dom_live(page) {
		dom_advance(cast(jsc.JSContextRef)page.ctx, page, .Complete)
	}

	return page_dom_live(page)
}

// html_page_view is the document as it now is, allocated with context.allocator; "" when
// the page has ended — a page a limit or a stop ended reports that, not its document — or
// the view could not be made.
@(private)
html_page_view :: proc(page: ^Page, view: Html_View) -> string {
	if !page_dom_live(page) {
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
@(private)
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
