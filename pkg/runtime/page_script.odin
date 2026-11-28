package lava_runtime

import "base:runtime"
import "core:net"
import "core:os"
import "core:strings"
import html "lava:pkg/html"
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
// Fetching is a file read: `lava page` documents are files, so a `src` resolves against
// the document's path and is read from disk when the script is prepared (script_fetch).
// A URL that names no local file (http:, https:, data:, another host) fails the fetch:
// the element gets `error`, as an unreachable URL would in Chrome. A network page
// loader, which would fetch over pkg/http, is not there yet.
//
// Module scripts (`type=module`, page_module.odin) are prepared here like a classic
// external script with `defer`, inline or not: parser-inserted ones run in document order
// with the `defer` scripts, an `async` or inserted one as a task of its own. They do not
// set document.currentScript, and an inline one fires no `load`.
//
// Deviations, each pinned by a tests/dom case or noted as unrecorded:
//   - an external script is decoded as UTF-8 (a UTF-8 BOM is dropped); a `charset`
//     attribute, another BOM and the document's encoding are not consulted.
//     Unrecorded: every case's script is UTF-8.
//   - a fetch is synchronous and has no latency, so an async script never runs during
//     the parse; Chrome's timing is a race (the cases pin only order-free facts).

// SCRIPT_MAX_BYTES bounds one external script read from disk; a bigger file fails its
// fetch. Not a Chrome limit: a page must not make Lava read a disk image into memory.
SCRIPT_MAX_BYTES :: 64 * 1024 * 1024

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
	// A module script (page_module.odin).
	module: bool,
}

// Page_Scripts is a page's script state, held by its Dom_Page (dom.odin) and released
// with it. Bound to the page's allocator at creation (CLAUDE.md §4): it grows from
// `proc "c"` natives.
Page_Scripts :: struct {
	allocator:     runtime.Allocator,
	// The document's file path, which a `src` resolves against; "" for a page with no
	// file, whose every external script then fails its fetch. Owned.
	document_path: string,
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
	delete(s.source_name, s.allocator)
	s^ = {}
}

// scripts_attach ties a page to its DOM's scripts: the page that runs them, the file a
// `src` resolves against, and the name inline scripts run under. Called by the page
// loader once dom_install succeeded, before the parse.
scripts_attach :: proc(page: ^Page, document_path, source_name: string) {
	dom := page.state.dom
	dom.page = page
	s := &dom.scripts
	s.document_path = strings.clone(document_path, s.allocator)
	s.source_name = strings.clone(source_name, s.allocator)
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
		if s.nesting > 0 {
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
		job := s.pending
		s.pending = {}
		s.has_pending = false
		script_execute(page, &job, parser = true)
	}
}

// scripts_run_deferred runs the `defer` scripts in document order, each with its load
// or error: HTML's "the end" step 3, after the `interactive` readystatechange and
// before DOMContentLoaded.
//
// Chrome:
//   Chrome 158, tests/dom/cases/dom-script-defer.page.
scripts_run_deferred :: proc(page: ^Page) {
	for i := 0;; i += 1 {
		if page.finished || page.state == nil || page.state.dom == nil {
			return
		}

		s := &page.state.dom.scripts

		if i >= len(s.deferred) {
			clear(&s.deferred)
			return
		}

		job := s.deferred[i]
		s.deferred[i] = {}
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

	// A nomodule classic script is for browsers without modules, which Chrome is not.
	if kind == .Module {
		script_prepare_module(dom, node, src, has_src, parser_inserted)
		return .None, {}
	}

	if _, nomodule := html.attr_view(node, "nomodule"); nomodule {
		return .None, {}
	}

	if !has_src {
		return .Inline, Script_Job{node = node, source = html.text(node, s.allocator)}
	}

	job, empty := script_fetch(s, node, src)
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

// script_prepare_module queues a module script: HTML's "prepare the script element" for
// type=module. Inline or external, a parser-inserted module without `async` waits with
// the `defer` scripts; any other one runs as a task of its own.
@(private = "file")
script_prepare_module :: proc(dom: ^Dom_Page, node: html.Node, src: string, has_src: bool, parser_inserted: bool) {
	s := &dom.scripts
	job: Script_Job
	empty := false

	if has_src {
		job, empty = script_fetch(s, node, src)
	} else {
		job = Script_Job{node = node, source = html.text(node, s.allocator)}
	}

	job.module = true
	_, async := html.attr_view(node, "async")

	if parser_inserted && !async && !empty {
		append(&s.deferred, job)
		return
	}

	append(&s.ready, job)
	scripts_schedule(dom)
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

	if job.failed {
		script_fire(page, job.node, "error")
		return
	}

	source := job.source

	if strings.has_prefix(source, "\xef\xbb\xbf") {
		source = source[3:]
	}

	if job.module {
		script_execute_module(page, job, source)
		return
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

// script_execute_module runs a module script's job: document.currentScript stays null
// and the script nesting level is untouched (HTML sets neither for a module). An
// external one gets `load` once it ran, or `error` when a module of its graph could not
// be fetched; an inline one gets only that `error`.
@(private = "file")
script_execute_module :: proc(page: ^Page, job: ^Script_Job, source: string) {
	dom := page.state.dom
	url := job.name == "" ? "" : module_file_url(job.name, context.temp_allocator)
	name := url if url != "" else dom.scripts.source_name
	ok, ended := page_run_module_script(page, source, url, name)

	if ended || page.finished || page.state == nil || page.state.dom != dom {
		return
	}

	if !ok {
		script_fire(page, job.node, "error")
	} else if job.name != "" {
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

	if len(s.ready) == 0 {
		return false
	}

	job := s.ready[0]
	ordered_remove(&s.ready, 0)
	script_execute(page, &job, parser = false)
	return true
}

// script_fetch fetches a script's `src`: resolved against the document's path, read
// from disk. `empty` is a src that is empty after stripping whitespace, which fails
// without a fetch.
@(private = "file")
script_fetch :: proc(s: ^Page_Scripts, node: html.Node, src: string) -> (job: Script_Job, empty: bool) {
	job.node = node
	job.failed = true
	url := strings.trim(src, " \t\n\f\r")

	if url == "" {
		return job, true
	}

	path, resolved := script_resolve(s.document_path, url)

	if !resolved {
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
@(private)
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

@(private = "file")
script_job_free :: proc(s: ^Page_Scripts, job: ^Script_Job) {
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
