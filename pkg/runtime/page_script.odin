package lava_runtime

import "base:runtime"
import "core:net"
import "core:os"
import "core:strings"
import html "lava:pkg/html"
import http "lava:pkg/http"
import jsc "lava:pkg/jsc"
import eventloop "lava:pkg/runtime/eventloop"

// The script elements of an HTML page (docs/LARVA.md roadmap stage 4, #13): HTML's
// "prepare the script element" and "execute the script element" for classic scripts,
// parser-inserted (inline and parser-blocking external, deferred, async) and inserted by
// a script (createElement + appendChild), with document.currentScript and
// document.write's insertion point.
//
// Where each kind runs:
//   - parser-inserted inline, and external without async/defer: at once, the parser
//     paused at its end tag (page_html.odin on_script); a parser-blocking script a
//     document.write produced waits for the writing script to return (`pending`);
//   - `defer` (external, not async): in document order once the parse is done, between
//     the `interactive` readystatechange and DOMContentLoaded (scripts_run_deferred);
//   - `async`, and every external script a script inserted: one task each on the page's
//     loop (set_immediate), in the order they were prepared — HTML runs them as each
//     fetch completes, in any order, and an inserted script with async=false in
//     insertion order, which a FIFO satisfies for both. `load` waits for them.
//   - inline, inserted by a script: during the insertion, before appendChild returns.
//
// Fetching (script_fetch) is a file read or a network fetch, decided when the script is
// prepared:
//   - a page with a document file (`lava page`): a `src` that names a local file — a
//     relative reference, or a `file:` URL with no host — is resolved against the
//     file's path and read from disk at once;
//   - a page with an http(s) URL (`lava serve`'s documents, `lava page --origin=<url>`):
//     a `src` that names no local file is resolved against that URL (http.resolve) and
//     fetched over pkg/http on the page's own loop, with the page's cookie jar and a
//     script request's headers (script_fetch_start). The fetch is asynchronous: the job
//     waits, not ready, until it completes (script_fetch_done) — a parser-blocking one
//     as the pending parsing-blocking script, with the parser paused (page_html.odin
//     html_page_continue) while the loop goes on with the page's other tasks;
//   - anything else (data:, blob:, another scheme, a page with neither) fails: the
//     element gets `error`, as an unreachable URL would in Chrome. So does a non-2xx
//     answer or a network error.
// A killed or closed page's loop is destroyed under its fetches, which then finish
// .Cancelled and are freed without running anything.
//
// Deviations, each pinned by a tests/dom case or noted as unrecorded:
//   - module scripts (`type=module`) never run: the JavaScriptCore C API has no module
//     loader (JSContext's module loader delegate is Objective-C only), so they are
//     marked started and skipped; tests/dom/known-gaps.txt pins
//     dom-script-module.page, where Chrome runs them.
//   - an external script is decoded as UTF-8 (a UTF-8 BOM is dropped); a `charset`
//     attribute, another BOM and the document's encoding are not consulted.
//     Unrecorded: every case's script is UTF-8.
//   - a file fetch is synchronous and has no latency, so an async script never runs
//     during the parse; Chrome's timing is a race (the cases pin only order-free facts).
//   - async and inserted external scripts run in the order they were prepared, a ready
//     one waiting behind an earlier one still in flight; Chrome runs each as its fetch
//     completes. Order-free in every recorded case.
//   - a network script is decoded as UTF-8 unless a UTF-16 BOM or Content-Type's
//     charset says otherwise; the `charset` attribute and the document's encoding (the
//     fallback HTML names) are not consulted. `<base href>` does not change the URL a
//     `src` resolves against. Unrecorded: network scripts are pinned by Lava-only tests
//     (cmd/lava/page_network_script_test.odin), not a Chrome recording.

// SCRIPT_MAX_BYTES bounds one external script read from disk; a bigger file fails its
// fetch. Not a Chrome limit: a page must not make Lava read a disk image into memory.
SCRIPT_MAX_BYTES :: 64 * 1024 * 1024

// SCRIPT_PAGE_MAX_BYTES bounds the bytes of all a page's network scripts together: a
// fetch is started only while the page is under it, and asks for no more than is left
// (counted as each completes, so fetches in flight together can overshoot by one
// response each). Not a Chrome limit: a page must not make Lava buffer without bound.
SCRIPT_PAGE_MAX_BYTES :: 128 * 1024 * 1024

// Script_Job is one prepared script waiting to run, or its fetch's failure.
Script_Job :: struct {
	node:   html.Node,
	// The script's text, owned (Page_Scripts.allocator); "" once failed.
	source: string,
	// The name it runs under: the file it was read from, owned; "" for an inline
	// script, which runs under the page's name.
	name:   string,
	// The fetch failed: running the job fires `error` at the element.
	failed: bool,
	// A network fetch: the job is ready once it is no longer in flight, and takes its
	// outcome from it then (script_job_settle). nil for a file or an inline script.
	fetch:  ^Script_Fetch,
}

// Script_Fetch is one script's network fetch, allocated with the page's script
// allocator. The job holding it owns it; a job freed while its fetch is in flight
// detaches it (owner nil) and script_fetch_done frees it.
Script_Fetch :: struct {
	owner:     ^Page_Scripts,
	page:      ^Page,
	allocator: runtime.Allocator,
	in_flight: bool,
	failed:    bool,
	// The decoded script, owned; "" until it completes, or on a failure.
	source:    string,
	// The URL it was fetched from, owned: the name the script runs under.
	url:       string,
}

// Parse_State is how far the page's parse has come (page_html.odin html_page_continue).
Parse_State :: enum {
	// The parser runs, or waits on a parser-blocking script's fetch.
	Parsing,
	// The document is parsed and `interactive`; the defer scripts run, or wait on a fetch.
	Deferred,
	// DOMContentLoaded has fired.
	Loaded,
}

// Page_Scripts is a page's script state, held by its Dom_Page (dom.odin) and released
// with it. Bound to the page's allocator at creation (CLAUDE.md §4): it grows from
// `proc "c"` natives.
Page_Scripts :: struct {
	allocator:     runtime.Allocator,
	// The document's file path, which a `src` naming a local file resolves against; ""
	// for a page with no file. Owned.
	document_path: string,
	// The document's URL when it is an http(s) one, which any other `src` resolves
	// against and is fetched from over the network; "" for none. Owned.
	document_url:  string,
	// How far the parse has come, and whether html_page_continue is running (a fetch
	// completing under it leaves the work to it).
	parse_state:   Parse_State,
	continuing:    bool,
	// Bytes of network script fetched so far (SCRIPT_PAGE_MAX_BYTES).
	script_bytes:  int,
	// The page's own name, under which its inline scripts run. Owned.
	source_name:   string,
	// HTML's "already started" flag: a script element in here never runs again.
	started:       map[html.Node]struct{},
	// The element whose script is running (document.currentScript); nil between them.
	current:       html.Node,
	// HTML's script nesting level: parser-inserted scripts running right now. While it
	// is above 0 the insertion point is defined and document.write parses there.
	nesting:       int,
	// A parser-blocking script a document.write produced, run once the script that
	// wrote it returns (HTML's "pending parsing-blocking script").
	pending:       Script_Job,
	has_pending:   bool,
	// `defer` scripts, in document order, run when the parse is done.
	deferred:      [dynamic]Script_Job,
	// Async and inserted external scripts, oldest first, one per loop task.
	ready:         [dynamic]Script_Job,
	// A loop task to run `ready`'s head is queued.
	scheduled:     bool,
}

// Script_Action is what preparing a script element asks of its caller.
@(private = "file")
Script_Action :: enum {
	// Nothing runs: not a script, already started, not connected, empty, a data block,
	// a module, nomodule, or queued (deferred or async) to run later.
	None,
	// An inline script: run the job now.
	Inline,
	// A parser-blocking external script: run the job before the parser goes on.
	Blocking,
}

// Script_Kind is what a script element's `type` makes it (HTML's "the script's type").
@(private = "file")
Script_Kind :: enum {
	None, // a data block, or no script at all
	Classic,
	Module,
}

// scripts_init binds a page's script state to `allocator`, before any native can grow it.
scripts_init :: proc(s: ^Page_Scripts, allocator: runtime.Allocator) {
	s.allocator = allocator
	s.started = make(map[html.Node]struct{}, allocator)
	s.deferred = make([dynamic]Script_Job, 0, 0, allocator)
	s.ready = make([dynamic]Script_Job, 0, 0, allocator)
}

// scripts_destroy frees what a page's script state holds: the jobs that never ran (the
// page ended first) and the tables. Nodes are the document's and freed with it.
scripts_destroy :: proc(s: ^Page_Scripts) {
	for &job in s.deferred {
		script_job_free(s, &job)
	}

	for &job in s.ready {
		script_job_free(s, &job)
	}

	if s.has_pending {
		script_job_free(s, &s.pending)
		s.has_pending = false
	}

	delete(s.deferred)
	delete(s.ready)
	delete(s.started)
	delete(s.document_path, s.allocator)
	delete(s.document_url, s.allocator)
	delete(s.source_name, s.allocator)
	s^ = {}
}

// scripts_attach ties a page to its DOM's scripts: the page that runs them, the file and
// the URL a `src` resolves against, and the name inline scripts run under. Called by the
// page loader once dom_install succeeded, before the parse. `document_url` is kept only
// when it is an http(s) URL pkg/http can fetch from.
scripts_attach :: proc(page: ^Page, document_path, document_url, source_name: string) {
	dom := page.state.dom
	dom.page = page
	s := &dom.scripts
	s.document_path = strings.clone(document_path, s.allocator)
	s.source_name = strings.clone(source_name, s.allocator)

	if _, ok := http.resolve(document_url, "", context.temp_allocator); ok {
		s.document_url = strings.clone(document_url, s.allocator)
	}
}

// scripts_parser_reached runs the step the parser takes at a script's end tag (HTML's
// "an end tag whose tag name is script" in the text insertion mode): prepare it, then run
// it if it is inline or parser-blocking. Called by the page loader at each pause, and by
// document.write's own parse for a script in written text — which, when parser-blocking,
// waits in `pending` for the writing script to return.
//
// Chrome:
//   Chrome 158, tests/dom/cases/dom-script-external.page (order, currentScript, the
//   element's load/error before the parser goes on), dom-script-write.page (a written
//   external script runs after the script that wrote it).
scripts_parser_reached :: proc(page: ^Page, node: html.Node) {
	dom := page.state.dom
	s := &dom.scripts
	action, job := script_prepare(dom, node, parser_inserted = true)

	switch action {
	case .None:
	case .Inline:
		script_execute(page, &job, parser = true)
	case .Blocking:
		if s.nesting > 0 || !script_job_ready(&job) {
			s.pending = job
			s.has_pending = true
		} else {
			script_execute(page, &job, parser = true)
		}
	}
}

// scripts_run_pending runs the parser-blocking scripts document.write produced, once the
// script that wrote them has returned: each may write another.
scripts_run_pending :: proc(page: ^Page) {
	for !page.finished && page.state != nil && page.state.dom != nil && page.state.dom.scripts.has_pending {
		s := &page.state.dom.scripts

		// Still in flight: the parser stays paused until script_fetch_done.
		if !script_job_ready(&s.pending) {
			return
		}

		job := s.pending
		s.pending = {}
		s.has_pending = false
		script_execute(page, &job, parser = true)
	}
}

// scripts_run_deferred runs the `defer` scripts in document order, each with its load
// or error: HTML's "the end" step 3, after the `interactive` readystatechange and
// before DOMContentLoaded. Returns false while one is still being fetched — the rest
// wait behind it, and script_fetch_done calls again — or once the page has ended.
//
// Chrome:
//   Chrome 158, tests/dom/cases/dom-script-defer.page.
scripts_run_deferred :: proc(page: ^Page) -> bool {
	for {
		if page.finished || page.state == nil || page.state.dom == nil {
			return false
		}

		s := &page.state.dom.scripts

		if len(s.deferred) == 0 {
			return true
		}

		if !script_job_ready(&s.deferred[0]) {
			return false
		}

		job := s.deferred[0]
		ordered_remove(&s.deferred, 0)
		script_execute(page, &job, parser = false)
	}
}

// scripts_run_ready runs every async or inserted external script still queued, oldest
// first: what the page loader does before `load` on a page with no loop, whose tasks
// would never run. A page with a loop has run them all by the time its loop idles.
scripts_run_ready :: proc(page: ^Page) {
	for scripts_run_one(page) {}
}

// scripts_inserted runs HTML's insertion steps for the script elements a script put in
// the tree: each inserted root's subtree, in tree order, is prepared — an inline script
// runs before this returns — and `parent`'s children changed (a script that got its
// first text). Called by the insertion natives (dom.odin) after the tree holds them.
//
// Chrome:
//   Chrome 158, tests/dom/cases/dom-script-dynamic.page.
scripts_inserted :: proc(dom: ^Dom_Page, parent: html.Node, roots: []html.Node) {
	if dom == nil || dom.page == nil {
		return
	}

	// The scripts first, then their runs: a running script may move or remove the rest.
	found := make([dynamic]html.Node, 0, 0, context.temp_allocator)

	for root in roots {
		if !dom_connected(root) {
			continue
		}

		for n := root; n != nil; n = dom_walk_next(n, root) {
			if is_html_script(n) {
				append(&found, n)
			}
		}
	}

	for n in found {
		scripts_prepare_inserted(dom, n)
	}

	scripts_children_changed(dom, parent)
}

// scripts_children_changed is a script element's "children changed steps": an inserted
// script that was empty when it was connected starts once it gets its text.
scripts_children_changed :: proc(dom: ^Dom_Page, node: html.Node) {
	if dom != nil && dom.page != nil && is_html_script(node) {
		scripts_prepare_inserted(dom, node)
	}
}

// scripts_src_set is HTML's step for a `src` set on a connected script element that had
// none: it is prepared (async, for a script the parser did not insert).
scripts_src_set :: proc(dom: ^Dom_Page, node: html.Node) {
	scripts_children_changed(dom, node)
}

// scripts_parsed_inert marks the script elements under `root` started: what innerHTML's
// fragment parser made never runs, even when moved into the document later.
scripts_parsed_inert :: proc(dom: ^Dom_Page, root: html.Node) {
	if dom == nil {
		return
	}

	for n := html.first_child(root); n != nil; n = dom_walk_next(n, root) {
		if is_html_script(n) {
			dom.scripts.started[n] = {}
		}
	}
}

// scripts_cloned carries "already started" over to a clone, as HTML's cloning steps for
// a script element do: a started script's copy never runs. `deep` walks both subtrees
// side by side; they have the same shape.
scripts_cloned :: proc(dom: ^Dom_Page, original, copy: html.Node, deep: bool) {
	if dom == nil || len(dom.scripts.started) == 0 {
		return
	}

	a, b := original, copy

	for a != nil && b != nil {
		if _, started := dom.scripts.started[a]; started {
			dom.scripts.started[b] = {}
		}

		if !deep {
			return
		}

		a, b = dom_walk_next(a, original), dom_walk_next(b, copy)
	}
}

// scripts_write is document.write: `text` goes in at the insertion point and, unless a
// parser-blocking script is pending, is parsed at once — a written inline script runs
// inside the call, a written external one becomes the pending script.
//
// Deviates:
//   With no parser-inserted script running (nesting 0: a deferred or async script, a
//   listener, a timer, or once the parse is done) the text is dropped. Chrome drops it
//   too from an async or deferred script, but from a listener or a timer it reopens the
//   document (document.open), which Lava does not model. Unrecorded.
scripts_write :: proc(dom: ^Dom_Page, text: string) {
	if dom == nil || dom.page == nil || dom.page.finished || dom.scripts.nesting == 0 {
		return
	}

	if !html.write(&dom.parser, text) || dom.scripts.has_pending {
		return
	}

	page := dom.page

	for !page.finished && page.state != nil && page.state.dom == dom && !dom.scripts.has_pending {
		script, status := html.pump_written(&dom.parser)

		if status != .Script {
			return
		}

		scripts_parser_reached(page, script)
	}
}

// is_html_script reports whether `node` is an HTML `script` element (an SVG script is
// not one HTML runs).
is_html_script :: proc(node: html.Node) -> bool {
	return(
		node != nil &&
		html.node_type(node) == .Element &&
		html.namespace_of(node) == .HTML &&
		html.local_name(node) == "script" \
	)
}

// dom_connected reports whether `node` is in a document (its root is a Document).
dom_connected :: proc(node: html.Node) -> bool {
	root := node

	for p := html.parent(root); p != nil; p = html.parent(p) {
		root = p
	}

	return root != nil && html.node_type(root) == .Document
}

// is_classic_script_type reports whether a script's `type` makes it a classic script:
// the empty string, or a JavaScript MIME type essence (ASCII case-insensitive, after
// stripping ASCII whitespace — so an all-whitespace type is no script), per the HTML
// standard's list.
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

// script_prepare is HTML's "prepare the script element" for a classic script, up to
// where it is either run by the caller, queued, or dropped.
//
// Returns:
//   The action, and for .Inline/.Blocking the job the caller runs (and frees by running).
//   A deferred or async job is queued here, and .None returned.
@(private = "file")
script_prepare :: proc(dom: ^Dom_Page, node: html.Node, parser_inserted: bool) -> (Script_Action, Script_Job) {
	s := &dom.scripts

	if !is_html_script(node) || node in s.started {
		return .None, {}
	}

	src, has_src := html.attr_view(node, "src")

	// An empty script waits: text or a src it gets later prepares it again.
	if !has_src && !script_has_text(node) {
		return .None, {}
	}

	if !dom_connected(node) {
		return .None, {}
	}

	kind := script_kind(node)

	if kind == .None {
		return .None, {}
	}

	s.started[node] = {}

	// A module never runs (see the file comment); a nomodule classic script is for
	// browsers without modules, which Chrome is not.
	if kind == .Module {
		return .None, {}
	}

	if _, nomodule := html.attr_view(node, "nomodule"); nomodule {
		return .None, {}
	}

	if !has_src {
		return .Inline, Script_Job{node = node, source = html.text(node, s.allocator)}
	}

	job, empty := script_fetch(dom, node, src)
	_, async := html.attr_view(node, "async")
	_, deferred := html.attr_view(node, "defer")

	// An empty src fails in a task of its own (HTML's "queue an element task ... fire
	// error"), parser-inserted or not.
	if parser_inserted && !async && !empty {
		if deferred {
			append(&s.deferred, job)
			return .None, {}
		}

		return .Blocking, job
	}

	append(&s.ready, job)
	scripts_schedule(dom)
	return .None, {}
}

// scripts_prepare_inserted prepares a script a script inserted, and runs it when inline.
@(private = "file")
scripts_prepare_inserted :: proc(dom: ^Dom_Page, node: html.Node) {
	action, job := script_prepare(dom, node, parser_inserted = false)

	if action == .Inline {
		script_execute(dom.page, &job, parser = false)
	}
}

// script_execute is HTML's "execute the script element": a failed fetch fires `error`;
// otherwise the source runs as a classic script with document.currentScript set to the
// element (and put back after), then an external script's element gets `load`. A throw
// is the page's uncaught error and does not stop `load` (page_run_element_script).
// `parser` counts the run in the script nesting level: document.write parses during it.
// The job is freed.
@(private = "file")
script_execute :: proc(page: ^Page, job: ^Script_Job, parser: bool) {
	if page.state == nil || page.state.dom == nil {
		return
	}

	dom := page.state.dom
	s := &dom.scripts
	defer script_job_free(s, job)

	if page.finished {
		return
	}

	script_job_settle(job)

	if job.failed {
		script_fire(page, job.node, "error")
		return
	}

	source := job.source

	if strings.has_prefix(source, "\xef\xbb\xbf") {
		source = source[3:]
	}

	previous := s.current
	s.current = job.node

	if parser {
		s.nesting += 1
	}

	page_run_element_script(page, source, job.name if job.name != "" else s.source_name)

	// The page may have ended in the run, its DOM with it.
	if page.state == nil || page.state.dom != dom {
		return
	}

	if parser {
		s.nesting -= 1
	}

	s.current = previous

	if job.name != "" && !page.finished {
		script_fire(page, job.node, "load")
	}
}

// script_fire fires `type` (load or error) at a script element: internal/dom's fireAt,
// one listener a step (dom_run_steps).
@(private = "file")
script_fire :: proc(page: ^Page, node: html.Node, type: string) {
	dom := page.state.dom

	if dom == nil || dom.fire_at == nil || page.ctx == nil {
		return
	}

	ctx := cast(jsc.JSContextRef)page.ctx
	args := [2]jsc.JSValueRef{dom_wrap(ctx, dom, node), js_string_value(ctx, type)}
	exception: jsc.JSValueRef
	vm_cpu_enter(page.vm)
	step := jsc.JSObjectCallAsFunction(ctx, cast(jsc.JSObjectRef)dom.fire_at, nil, 2, raw_data(args[:]), &exception)
	vm_cpu_exit(page.vm)

	if exception == nil && step != nil && jsc.JSValueIsObject(ctx, step) {
		dom_run_steps(ctx, page, step)
	}
}

// scripts_schedule queues the loop task that runs `ready`'s head, unless one is queued
// or the page has no loop (scripts_run_ready then runs them before `load`).
@(private = "file")
scripts_schedule :: proc(dom: ^Dom_Page) {
	page := dom.page

	if page == nil || page.loop == nil || dom.scripts.scheduled || len(dom.scripts.ready) == 0 {
		return
	}

	// The head is still in flight: script_fetch_done schedules once it is not.
	if !script_job_ready(&dom.scripts.ready[0]) {
		return
	}

	dom.scripts.scheduled = true
	eventloop.set_immediate(page.loop, scripts_task, page)
}

// scripts_task is one loop task: the oldest async or inserted external script, then the
// next task for the rest. A task each, so timers and microtasks interleave as between
// two of Chrome's script tasks. The Page outlives its loop's tasks: page_close closes
// the loop, which drops any still queued, before the Page goes.
@(private = "file")
scripts_task :: proc(loop: ^eventloop.Loop, user_data: rawptr) {
	page := cast(^Page)user_data

	if page.finished || page.state == nil || page.state.dom == nil {
		return
	}

	dom := page.state.dom
	dom.scripts.scheduled = false
	scripts_run_one(page)

	if page.state != nil && page.state.dom == dom {
		scripts_schedule(dom)
	}
}

// scripts_run_one runs the oldest queued async or inserted script; false when none is.
@(private = "file")
scripts_run_one :: proc(page: ^Page) -> bool {
	if page.finished || page.state == nil || page.state.dom == nil {
		return false
	}

	s := &page.state.dom.scripts

	if len(s.ready) == 0 || !script_job_ready(&s.ready[0]) {
		return false
	}

	job := s.ready[0]
	ordered_remove(&s.ready, 0)
	script_execute(page, &job, parser = false)
	return true
}

// script_fetch fetches a script's `src`: a local file is resolved against the
// document's path and read from disk; anything else, on a page with an http(s) URL, is
// resolved against that URL and its network fetch started (the job comes back not ready).
// `empty` is a src that is empty after stripping whitespace, which fails without a fetch.
@(private = "file")
script_fetch :: proc(dom: ^Dom_Page, node: html.Node, src: string) -> (job: Script_Job, empty: bool) {
	s := &dom.scripts
	job.node = node
	job.failed = true
	url := strings.trim(src, " \t\n\f\r")

	if url == "" {
		return job, true
	}

	path, resolved := script_resolve(s.document_path, url)

	if !resolved {
		if absolute, ok := http.resolve(s.document_url, url, context.temp_allocator); ok {
			script_fetch_start(dom, &job, absolute)
		}

		return job, false
	}

	info, stat_err := os.stat(path, context.temp_allocator)

	// Not a FIFO or a device: a read must end, and not block the page's thread.
	if stat_err != nil || info.type != .Regular || info.size > SCRIPT_MAX_BYTES {
		return job, false
	}

	data, read_err := os.read_entire_file(path, s.allocator)

	if read_err != nil {
		return job, false
	}

	job.source = string(data)
	job.name = strings.clone(path, s.allocator)
	job.failed = false
	return job, false
}

// script_resolve resolves a script URL against the document's file path, to the file it
// names: a relative reference (`a.js`, `../a.js`, `/abs/a.js`) or a `file:` URL with no
// host. The query and fragment are dropped and percent-escapes decoded; `\` reads as `/`,
// as the URL parser does for file URLs. In the temp arena.
//
// Returns:
//   ok false for a URL that names no local file — another scheme (http:, data:, …) or a
//   host — or a page with no document path.
@(private = "file")
script_resolve :: proc(document_path, url: string) -> (path: string, ok: bool) {
	if document_path == "" {
		return "", false
	}

	rest := url

	if scheme_end := url_scheme_end(url); scheme_end > 0 {
		if !strings.equal_fold(url[:scheme_end], "file") {
			return "", false
		}

		rest = url[scheme_end + 1:]

		if !strings.has_prefix(rest, "//") {
			return "", false
		}

		rest = rest[2:]
		host_end := strings.index_byte(rest, '/')
		host := rest if host_end < 0 else rest[:host_end]

		if host != "" && !strings.equal_fold(host, "localhost") {
			return "", false
		}

		rest = "/" if host_end < 0 else rest[host_end:]
	} else if strings.has_prefix(url, "//") || strings.has_prefix(url, "\\\\") {
		return "", false
	}

	if cut := strings.index_any(rest, "?#"); cut >= 0 {
		rest = rest[:cut]
	}

	slashed, _ := strings.replace_all(rest, "\\", "/", context.temp_allocator)
	decoded, decoded_ok := net.percent_decode(slashed, context.temp_allocator)

	if !decoded_ok || decoded == "" {
		return "", false
	}

	if decoded[0] == '/' {
		cleaned, err := os.clean_path(decoded, context.temp_allocator)
		return cleaned, err == nil
	}

	joined, err := os.join_path({os.dir(document_path), decoded}, context.temp_allocator)
	return joined, err == nil
}

// url_scheme_end is the index of the `:` that ends a URL's scheme (an ASCII letter, then
// letters, digits, `+`, `-` or `.`); 0 when the URL has none.
@(private = "file")
url_scheme_end :: proc(url: string) -> int {
	for i in 0 ..< len(url) {
		b := url[i]

		switch {
		case (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z'):
		case i > 0 && ((b >= '0' && b <= '9') || b == '+' || b == '-' || b == '.'):
		case i > 0 && b == ':':
			return i
		case:
			return 0
		}
	}

	return 0
}

// script_fetch_start starts the network fetch of `url` for `job` on the page's loop:
// a GET with the page's cookie jar (Cookie sent, Set-Cookie stored, redirects
// included), the profile's User-Agent and Accept (pkg/http's defaults), and what a
// classic `<script src>` without `crossorigin` sends besides. On success the job holds
// the fetch and is not ready; otherwise it stays failed (no loop, the page's script
// bytes spent, a request pkg/http refuses).
//
// Chrome:
//   A no-cors script request: `Sec-Fetch-Dest: script`, `Sec-Fetch-Mode: no-cors`,
//   Sec-Fetch-Site and Referer per http.subresource_context. Unrecorded (no recording
//   captures request headers); pinned by cmd/lava/page_network_script_test.odin.
// Deviates:
//   No Accept-Language and no User-Agent Client Hints headers (`Sec-CH-UA*`), which
//   Chrome sends; cookies are stored and sent as same-site whatever the script's site.
@(private = "file")
script_fetch_start :: proc(dom: ^Dom_Page, job: ^Script_Job, url: string) {
	page := dom.page
	s := &dom.scripts
	budget := SCRIPT_PAGE_MAX_BYTES - s.script_bytes

	if page == nil || page.loop == nil || page.state == nil || budget <= 0 {
		return
	}

	from := http.subresource_context(s.document_url, url)
	headers := make([dynamic]http.Header, 0, 4, context.temp_allocator)
	append(&headers, http.Header{"Sec-Fetch-Site", from.site})
	append(&headers, http.Header{"Sec-Fetch-Mode", "no-cors"})
	append(&headers, http.Header{"Sec-Fetch-Dest", "script"})

	if from.referer != "" {
		append(&headers, http.Header{"Referer", from.referer})
	}

	f := new(Script_Fetch, s.allocator)
	f^ = {
		owner     = s,
		page      = page,
		allocator = s.allocator,
		in_flight = true,
		url       = strings.clone(url, s.allocator),
	}
	req := http.Request {
		url            = url,
		headers        = headers[:],
		max_body_bytes = min(SCRIPT_MAX_BYTES, budget),
		cookie_jar     = page.state.cookie_jar,
	}

	// The heap, not the page's allocator: pkg/http may decode a body on a pool worker
	// and free through the allocator after the loop is gone (http.fetch's contract).
	if http.fetch(page.loop, req, script_fetch_done, f, runtime.heap_allocator()) != .None {
		delete(f.url, f.allocator)
		free(f, f.allocator)
		return
	}

	// NETWORK-IDLE (feat/network-idle): page_net_begin(page.state) here, once per started
	// fetch, paired with the page_net_end in script_fetch_done. Wired at merge.
	job.fetch = f
	job.failed = false
}

// script_fetch_done is a script fetch's completion, on the page's loop thread: a 2xx
// body is decoded into the fetch, anything else fails it; then whatever waits on it
// goes on (scripts_fetched). A fetch the page dropped (owner nil) is only freed, and so
// is the outcome of one cancelled by the page's teardown, which runs nothing.
@(private = "file")
script_fetch_done :: proc(response: http.Response, user_data: rawptr) {
	f := cast(^Script_Fetch)user_data
	resp := response
	defer http.response_destroy(&resp)
	s := f.owner

	if s == nil {
		delete(f.source, f.allocator)
		delete(f.url, f.allocator)
		free(f, f.allocator)
		return
	}

	// NETWORK-IDLE (feat/network-idle): page_net_end(f.page.state) here — the one end for
	// script_fetch_start's begin, on the loop thread, cancelled fetches included (the state
	// is still alive during close_begin). A detached fetch (above) has no state left to count.
	f.in_flight = false
	f.failed = true

	if resp.error == .None && resp.status >= 200 && resp.status < 300 {
		s.script_bytes += len(resp.body)
		source, decoded := script_decode(&resp, f.allocator)
		f.source = source
		f.failed = !decoded
	}

	page := f.page

	if page_dom_live(page) && &page.state.dom.scripts == s {
		scripts_fetched(page)
	}
}

// script_decode turns a script response's body into the UTF-8 text JSC takes: as it
// is, unless a UTF-16 BOM or a non-UTF-8 Content-Type charset names another encoding,
// which pkg/html's decoders then undo (html.decode_document with the charset as the
// transport label; only its BOM or transport answer is taken, never its <meta> prescan).
@(private = "file")
script_decode :: proc(resp: ^http.Response, allocator: runtime.Allocator) -> (source: string, ok: bool) {
	body := resp.body[:]
	label := http.charset(resp)
	utf16_bom := len(body) >= 2 && ((body[0] == 0xfe && body[1] == 0xff) || (body[0] == 0xff && body[1] == 0xfe))
	labelled := label != "" && !strings.equal_fold(label, "utf-8") && !strings.equal_fold(label, "utf8")

	if utf16_bom || (labelled && !strings.has_prefix(string(body), "\xef\xbb\xbf")) {
		text, enc, decoded := html.decode_document(body, label, allocator)

		if decoded && (enc.source == .BOM || enc.source == .Transport) {
			return string(text), true
		}

		delete(text, allocator)
	}

	text, err := strings.clone(string(body), allocator)
	return text, err == nil
}

// scripts_fetched goes on with whatever a completed fetch let through: the parse or the
// defer scripts, then the head of the async queue.
@(private = "file")
scripts_fetched :: proc(page: ^Page) {
	dom := page.state.dom

	if dom.scripts.parse_state != .Loaded {
		html_page_continue(page)
	}

	if page_dom_live(page) && page.state.dom == dom {
		scripts_schedule(dom)
	}
}

// script_job_ready reports whether a job can run: it has no fetch in flight.
@(private = "file")
script_job_ready :: proc(job: ^Script_Job) -> bool {
	return job.fetch == nil || !job.fetch.in_flight
}

// script_job_settle moves a completed network fetch's outcome into its job — the source,
// the URL as the name, or the failure — and frees the fetch.
@(private = "file")
script_job_settle :: proc(job: ^Script_Job) {
	f := job.fetch

	if f == nil {
		return
	}

	job.fetch = nil
	job.failed = f.failed
	job.source = f.source
	job.name = f.url
	free(f, f.allocator)
}

@(private = "file")
script_job_free :: proc(s: ^Page_Scripts, job: ^Script_Job) {
	if f := job.fetch; f != nil {
		if f.in_flight {
			f.owner = nil
		} else {
			delete(f.source, f.allocator)
			delete(f.url, f.allocator)
			free(f, f.allocator)
		}
	}

	delete(job.source, s.allocator)
	delete(job.name, s.allocator)
	job^ = {}
}

// script_kind reads a script element's type: absent or a JavaScript MIME type is
// classic, `module` is a module, anything else a data block.
@(private = "file")
script_kind :: proc(node: html.Node) -> Script_Kind {
	type, has := html.attr_view(node, "type")

	if !has || is_classic_script_type(type) {
		return .Classic
	}

	if strings.equal_fold(strings.trim(type, " \t\n\f\r"), "module") {
		return .Module
	}

	return .None
}

@(private = "file")
script_has_text :: proc(node: html.Node) -> bool {
	for child := html.first_child(node); child != nil; child = html.next_sibling(child) {
		if html.node_type(child) == .Text {
			if data, _ := html.char_data(child); data != "" {
				return true
			}
		}
	}

	return false
}
