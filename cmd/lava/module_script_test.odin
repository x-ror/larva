// Linux-only: the DOM is lexbor's, and pkg/html has a lexbor build on Linux alone.
#+build linux
package main

import "core:os"
import "core:strings"
import "core:testing"
import lava "lava:pkg/runtime"

// Module scripts (pkg/runtime/page_module.odin, internal/module_loader.js) where the
// recorded case cannot reach: tests/dom/cases/dom-script-module-graph.page is read at
// Chrome's load event, and a dynamic import that resolves settles after it there, so
// only Lava can show that `import()` resolves to the namespace of a module already in
// the map. The graph: a.js imports b.js and c.js, b.js imports c.js — c.js must evaluate
// once — and a.js reads c's exported `let` live across a call that changes it.
@(test)
module_graph_evaluates_once_with_live_bindings_and_dynamic_import :: proc(t: ^testing.T) {
	dir, dir_err := os.make_directory_temp("", "lava-module-*", context.allocator)

	if !testing.expect(t, dir_err == nil, "no temp directory") {
		return
	}

	defer {
		os.remove_all(dir)
		delete(dir)
	}

	document := module_write(
		t,
		dir,
		"page.html",
		`<!DOCTYPE html><body><script type="module" src="a.js"></script>` +
		`<script type="module">import { n } from './c.js'; document.body.setAttribute('data-inline', 'n=' + n);</script>`,
	)
	defer delete(document)
	delete(module_write(t, dir, "c.js", "globalThis.cRuns = (globalThis.cRuns || 0) + 1;\nexport let n = 1;\nexport function bump() { n += 10; }\n"))
	delete(module_write(t, dir, "b.js", "import { n } from './c.js';\nexport const fromB = 'b' + n;\n"))
	delete(
		module_write(
			t,
			dir,
			"a.js",
			"import { fromB } from './b.js';\n" +
			"import { n, bump } from './c.js';\n" +
			"const before = n;\nbump();\n" +
			"document.body.setAttribute('data-a', [fromB, before, n, globalThis.cRuns].join(','));\n" +
			"import('./c.js').then((ns) => { ns.bump(); document.body.setAttribute('data-dynamic', [ns.n, n, globalThis.cRuns].join(',')); });\n",
		),
	)

	data, read_err := os.read_entire_file(document, context.allocator)

	if !testing.expect(t, read_err == nil, "could not read the page") {
		return
	}

	defer delete(data)
	result, output := lava.run_html_page(data, document, document_path = document)
	defer lava.result_destroy(&result)
	defer delete(output)

	testing.expectf(t, lava.is_success(result), "the page failed: %v", result)
	// fromB saw n=1; before=1, after bump 11; c ran once though both a and b import it.
	testing.expectf(t, strings.contains(output, `data-a="b1,1,11,1"`), "module graph: %s", output)
	// The inline module, after a.js in document order, reads the same live binding —
	// after a.js's import() settled too: Lava's fetch is a synchronous file read, so the
	// import settles in a.js's microtask checkpoint (a deviation in timing only; Chrome
	// fetches in a later task, module_loader.js's dynamicImport).
	testing.expectf(t, strings.contains(output, `data-inline="n=21"`), "inline module: %s", output)
	// import() resolves to the same module's namespace: bump through it is seen by a's
	// own import binding, and c still ran once.
	testing.expectf(t, strings.contains(output, `data-dynamic="21,21,1"`), "dynamic import: %s", output)
}

// module_write writes `data` to `name` in `dir` and returns the path (caller frees).
@(private = "file")
module_write :: proc(t: ^testing.T, dir, name, data: string) -> string {
	path, _ := os.join_path({dir, name}, context.allocator)
	testing.expectf(t, os.write_entire_file(path, transmute([]byte)data) == nil, "could not write %s", path)
	return path
}
