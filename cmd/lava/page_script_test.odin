// Linux-only: the DOM is lexbor's, and pkg/html has a lexbor build on Linux alone.
#+build linux
package main

import "core:mem"
import "core:os"
import "core:strings"
import "core:testing"
import html "lava:pkg/html"
import jsc "lava:pkg/jsc"
import lava "lava:pkg/runtime"

// A page's script elements (pkg/runtime/page_script.odin) where no oracle can see: what
// the page holds for scripts that never ran, and what a `src` may read from disk. Chrome's
// side of the same surface is tests/dom/cases/dom-script-*.page.html.

// A page that ends before its deferred and async scripts run — the parse queued them,
// with the bytes each read from disk — gives every byte back: scripts_destroy frees the
// queued jobs with the page's DOM. Under a tracking allocator, as the Dom_Page itself is.
@(test)
page_scripts_free_the_jobs_that_never_ran :: proc(t: ^testing.T) {
	dir, dir_err := os.make_directory_temp("", "lava-page-script-*", context.allocator)

	if !testing.expect(t, dir_err == nil, "no temp directory") {
		return
	}

	defer {
		os.remove_all(dir)
		delete(dir)
	}

	document := write_beside(t, dir, "page.html", "")
	defer delete(document)
	delete(write_beside(t, dir, "d.js", "globalThis.deferred = 1;"))
	delete(write_beside(t, dir, "a.js", "globalThis.async = 1;"))
	delete(write_beside(t, dir, "b.js", "globalThis.blocking = 1;"))

	track: mem.Tracking_Allocator
	mem.tracking_allocator_init(&track, context.allocator)
	defer mem.tracking_allocator_destroy(&track)
	track.bad_free_callback = mem.tracking_allocator_bad_free_callback_add_to_array

	{
		context.allocator = mem.tracking_allocator(&track)
		page: lava.Page

		if !testing.expect(t, lava.page_create(&page, "<page-script>"), "page_create failed") {
			result, _ := lava.page_close(&page)
			lava.result_destroy(&result)
			return
		}

		ctx := cast(jsc.JSContextRef)page.ctx
		testing.expect_value(t, lava.dom_install(ctx, page.state), "")
		lava.scripts_attach(&page, document, "<page-script>")

		on_script :: proc(p: ^html.Parser, script: html.Node, user_data: rawptr) {
			lava.scripts_parser_reached(cast(^lava.Page)user_data, script)
		}

		markup := `<script defer src="d.js"></script><script async src="a.js"></script><script src="b.js"></script>`
		testing.expect(
			t,
			html.parse_all(&page.state.dom.parser, transmute([]byte)markup, on_script, &page),
			"parse failed",
		)

		scripts := &page.state.dom.scripts
		testing.expect_value(t, len(scripts.deferred), 1)
		testing.expect_value(t, len(scripts.ready), 1)
		ran, ok := lava.page_eval(&page, `[typeof deferred, typeof async, blocking].join(',')`)
		testing.expect(t, ok, "the page could not read its globals")
		text, allocated := lava.value_to_string(ctx, ran)
		testing.expect_value(t, text, "undefined,undefined,1")

		if allocated {
			delete(text)
		}

		result, _ := lava.page_close(&page)
		lava.result_destroy(&result)
	}

	testing.expectf(t, len(track.allocation_map) == 0, "%d allocations outlived the page", len(track.allocation_map))
	testing.expectf(
		t,
		len(track.bad_free_array) == 0,
		"%d frees of memory the page never allocated",
		len(track.bad_free_array),
	)
}

// A `src` reads a regular file only: a device or a FIFO fails the fetch (`error` at the
// element), so a page cannot make Lava read /dev/zero forever or block on a pipe — the
// test uses /dev/null, which a read would answer at once with an empty, `load`ing script.
// A URL that names no local file (http:) fails the same way. Not a Chrome behaviour: a
// file page in Chrome cannot name a device, and its http: fetch would go to the network.
@(test)
page_script_src_reads_regular_files_only :: proc(t: ^testing.T) {
	dir, dir_err := os.make_directory_temp("", "lava-page-script-*", context.allocator)

	if !testing.expect(t, dir_err == nil, "no temp directory") {
		return
	}

	defer {
		os.remove_all(dir)
		delete(dir)
	}

	delete(write_beside(t, dir, "ok.js", "r.push('ran');"))
	markup := `<body><script>var r = [];
document.addEventListener('error', function (e) { r.push('error ' + e.target.id); }, true);
document.addEventListener('load', function (e) { if (e.target !== document) r.push('load ' + e.target.id); }, true);
</script><script id=dev src="/dev/null"></script><script id=ok src="ok.js"></script>
<script id=net src="http://127.0.0.1:9/x.js"></script>
<script>document.body.setAttribute('data-r', r.join(','));</script>`
	document := write_beside(t, dir, "page.html", markup)
	defer delete(document)

	result, output := lava.run_html_page(transmute([]byte)markup, document, document_path = document)
	defer delete(output)
	lava.result_destroy(&result)
	testing.expectf(
		t,
		strings.contains(output, `data-r="error dev,ran,load ok,error net"`),
		"the page saw: %s",
		output,
	)
}

// write_beside writes `data` to `name` in `dir` and returns the file's path.
@(private = "file")
write_beside :: proc(t: ^testing.T, dir, name, data: string) -> string {
	path, _ := os.join_path({dir, name}, context.allocator)
	testing.expectf(t, os.write_entire_file(path, transmute([]byte)data) == nil, "could not write %s", path)
	return path
}
