package main

import "core:fmt"
import "core:os"
import "core:strconv"
import "core:strings"
import html "lava:pkg/html"
import http "lava:pkg/http"
import lava_runtime "lava:pkg/runtime"
import eventloop "lava:pkg/runtime/eventloop"

VERSION :: "0.1.0-dev"

main :: proc() {
	args := os.args

	if len(args) < 2 {
		print_help()
		return
	}

	switch args[1] {
	case "--help", "-h", "help":
		print_help()
	case "--version", "-v":
		fmt.println("lava", VERSION)
	case "eval":
		eval_command(args[2:])
	case "run":
		run_command(args[2:])
	case "html":
		html_command(args[2:])
	case "fetch":
		fetch_command(args[2:])
	case:
		fmt.eprintfln("unknown command: %s", args[1])
		fmt.eprintln("try `lava --help`")
		os.exit(2)
	}
}

print_help :: proc() {
	fmt.println(
		`Lava - an Odin and JavaScriptCore runtime toolkit

Usage:
  lava eval <source>    Evaluate JavaScript source
  lava run [--surface=web] <file>
                        Run a JavaScript file; --surface=web exposes only the
                        Window-profile globals (no require/process/Buffer)
  lava html [--scripts] [--chunk N] [--select CSS] <file|->
                        Parse HTML and print the serialized document
  lava fetch <url>      Fetch a page without JS; status and headers on stderr,
                        the serialized HTML on stdout
  lava --version        Print version
  lava --help           Print help

The CLI is initialized. JSC evaluation will be wired in once the local
JavaScriptCore development package is available.`,
	)
}

eval_command :: proc(args: []string) {
	if len(args) < 1 {
		fmt.eprintln("usage: lava eval <source>")
		os.exit(2)
	}

	loop := eventloop.init(real_time = true)
	// eval tears the loop down before its JS context is released (it owns both); see
	// the destroy call there. Calling destroy here instead would run the handles'
	// dispose hooks against an already-freed context. print_result is eval's report
	// hook rather than a call after it returns: the teardown joins the loop's pool
	// workers, and a worker blocked without bound would otherwise hold back the report
	// of a top-level throw (see lava_runtime.Result_Hook).
	result := lava_runtime.eval(args[0], "<eval>", &loop, true, report = print_result)
	exit_code := result.exit_code
	lava_runtime.result_destroy(&result)
	os.exit(exit_code)
}

// parse_run_args splits `lava run`'s argv into the global surface and
// [scriptPath, ...userArgs].
//
// Returns:
//   `.Node` unless a leading `--surface=web` selects `.Web`; `rest` aliases `args`.
//   A non-empty `err` is a usage error (exit 2): an unknown `--surface=` value, or
//   no script path after the flag.
// Node:
//   No counterpart. Options are read only BEFORE the script path; everything after
//   it reaches the script untouched, as `node file --x` hands `--x` to the script.
// Deviates:
//   Lava-only, and temporary: it lets `make test-web` (tests/web) run a case with
//   exactly the Window-profile globals until the Node surface is deleted, at which
//   point the flag goes with it. `--surface=node` is accepted as the explicit form
//   of the default. Pinned by cmd/lava/run_surface_flag_test.odin and, against
//   Chrome, by tests/web/cases/globals-window.js.
parse_run_args :: proc(args: []string) -> (surface: lava_runtime.Global_Surface, rest: []string, err: string) {
	rest = args

	if len(rest) > 0 && strings.has_prefix(rest[0], "--surface=") {
		switch rest[0][len("--surface="):] {
		case "web":
			surface = .Web
		case "node":
			surface = .Node
		case:
			return .Node, nil, "unknown --surface value (expected web or node)"
		}

		rest = rest[1:]
	}

	if len(rest) < 1 {
		return .Node, nil, "usage: lava run [--surface=web] <file>"
	}

	return surface, rest, ""
}

// run_surface_error refuses a surface the chosen run mode cannot honour: the worker
// supervisor (LAVA_WORKERS>1) builds its pages on the Node surface, so running a file
// there under `--surface=web` would leave require/process/Buffer reachable behind a
// flag that promised to hide them. Returns "" when the combination is allowed.
// Pinned by cmd/lava/run_surface_flag_test.odin.
run_surface_error :: proc(surface: lava_runtime.Global_Surface, worker_count: int) -> string {
	if worker_count > 1 && surface != .Node {
		return "--surface=web does not support LAVA_WORKERS>1"
	}

	return ""
}

run_command :: proc(raw_args: []string) {
	surface, args, usage_err := parse_run_args(raw_args)

	if usage_err != "" {
		fmt.eprintln(usage_err)
		os.exit(2)
	}

	// LAVA_WORKERS>1 runs the file on N shared-nothing worker loops (Slice 3a). Resolved fail-fast:
	// an invalid value or an unsupported platform exits non-zero rather than silently degrading.
	worker_count, count_ok, count_msg := lava_runtime.lava_resolve_worker_count()

	if !count_ok {
		fmt.eprintfln("lava: %s", count_msg)
		os.exit(2)
	}

	if refusal := run_surface_error(surface, worker_count); refusal != "" {
		fmt.eprintfln("lava: %s", refusal)
		os.exit(2)
	}

	if worker_count > 1 {
		// args is [scriptPath, ...userArgs]; the supervisor reads the file once and runs N workers.
		os.exit(lava_runtime.lava_run_workers(args[0], worker_count, args[1:]))
	}

	loop := eventloop.init(real_time = true)
	// args is [scriptPath, ...userArgs]; everything after the script is forwarded to
	// process.argv.slice(2) (Node parity).
	// run_file forwards to eval, which tears the loop down before releasing its JS
	// context and reports through print_result before that teardown (see eval_command).
	result := lava_runtime.run_file(args[0], &loop, args[1:], report = print_result, surface = surface)
	exit_code := result.exit_code
	lava_runtime.result_destroy(&result)
	os.exit(exit_code)
}

// print_result routes through lava_runtime.process_write rather than fmt.println for the
// reason globals.odin states about itself: fmt goes to core:os directly, which abandons
// its write loop on the first errno, so `lava eval` output and the synchronous throw
// report truncated to one pipe buffer and exited 0 on a non-blocking stdout. Measured
// before this change: `lava eval "'x'.repeat(300000)"` delivered 65536 bytes where node -p
// delivered 300001. The async report already went through process_write and was fine,
// which is what made the two error paths disagree on the same input.
//
// It is eval's report hook (lava_runtime.Result_Hook), so it runs inside eval with the
// loop and JS context still alive: it writes through process_write and touches nothing
// else.
print_result :: proc(result: lava_runtime.Result, user_data: rawptr) {
	if lava_runtime.is_success(result) {
		if len(result.message) > 0 {
			lava_runtime.process_write(os.stdout, result.message, "\n")
		}

		return
	}

	lava_runtime.process_write(os.stderr, result.message, "\n")
}

// html_command parses an HTML file (or stdin, `-`) and prints the serialized
// document. No script runs: --scripts reports each parser-blocking script on stderr
// at the moment the parser pauses for it, where a page loader would execute it.
// --chunk N feeds the input N bytes at a time, as network reads would, to exercise
// the incremental path; by default it is fed at once. --select CSS prints the
// outerHTML of each match, one per line, instead of the whole document.
html_command :: proc(args: []string) {
	usage :: proc() -> ! {
		fmt.eprintln("usage: lava html [--scripts] [--chunk N] [--select CSS] <file|->")
		os.exit(2)
	}
	Html_Options :: struct {
		list_scripts: bool,
		scripts:      int,
	}
	opts: Html_Options
	chunk := 0
	path, css := "", ""
	for i := 0; i < len(args); i += 1 {
		switch a := args[i]; {
		case a == "--scripts":
			opts.list_scripts = true
		case a == "--chunk":
			i += 1

			if i == len(args) {
				usage()
			}

			n, ok := strconv.parse_int(args[i])

			if !ok || n <= 0 {
				usage()
			}

			chunk = n
		case a == "--select":
			i += 1

			if i == len(args) {
				usage()
			}

			css = args[i]
		case len(a) > 1 && a[0] == '-', path != "":
			usage()
		case:
			path = a
		}
	}

	if path == "" {
		usage()
	}

	data: []byte
	err: os.Error

	if path ==
	   "-" {data, err = os.read_entire_file_from_file(os.stdin, context.allocator)} else {data, err = os.read_entire_file(path, context.allocator)}

	if err != nil {
		fmt.eprintfln("lava html: cannot read %s: %v", path, err)
		os.exit(1)
	}

	report :: proc(p: ^html.Parser, script: html.Node, user_data: rawptr) {
		o := cast(^Html_Options)user_data
		o.scripts += 1

		if !o.list_scripts {
			return
		}

		// An SVG <script> names its file with href, an HTML one with src.
		src, ok := html.attr(script, "src", context.temp_allocator)

		if !ok {
			src, ok = html.attr(script, "href", context.temp_allocator)
		}

		if ok {
			fmt.eprintfln("[script %d] src=%s", o.scripts, src)
		} else {
			fmt.eprintfln("[script %d] inline, %d bytes", o.scripts, len(html.text(script, context.temp_allocator)))
		}
	}

	p: html.Parser
	ok := html.init(&p) && html.parse_all(&p, data, report, &opts, chunk)

	if ok && css != "" {
		select_and_print(&p, css)
		html.destroy(&p)
		return
	}

	markup: string

	if ok {
		markup, ok = html.serialize(&p)
	}

	if !ok {
		msg := html.error_message(&p)
		fmt.eprintfln("lava html: %s", msg if msg != "" else "serialization failed")
		html.destroy(&p)
		os.exit(1)
	}

	fmt.println(markup)
	html.destroy(&p)
}

// select_and_print prints the outerHTML of every match of `css` in the document, one
// per line, in tree order. Exits 2 on an invalid selector, as a usage error.
select_and_print :: proc(p: ^html.Parser, css: string) {
	engine: html.Selectors

	if !html.selectors_init(&engine) {
		fmt.eprintln("lava html: lexbor could not create the selector engine")
		os.exit(1)
	}

	defer html.selectors_destroy(&engine)
	sel, ok := html.compile(&engine, css)

	if !ok {
		fmt.eprintfln("lava html: not a valid selector: %s", css)
		os.exit(2)
	}

	defer html.selector_destroy(&sel)
	matches: [dynamic]html.Node
	defer delete(matches)

	if !html.query_all(&engine, html.document(p), sel, &matches) {
		fmt.eprintln("lava html: selector search failed")
		os.exit(1)
	}

	for node in matches {
		markup, _ := html.outer_html(node, context.temp_allocator)
		fmt.println(markup)
	}
}

// Exit codes of `lava fetch`: any HTTP status is a success.
EXIT_FETCH_FAILED :: 1
EXIT_USAGE :: 2

// fetch_command loads a page over pkg/http with no JS engine involved, prints the
// status line, final URL and headers on stderr, and the document re-serialized by
// pkg/html on stdout. A body that is not HTML is written out as it came.
fetch_command :: proc(args: []string) {
	if len(args) != 1 || (len(args[0]) > 0 && args[0][0] == '-') {
		fmt.eprintln("usage: lava fetch <url>")
		os.exit(EXIT_USAGE)
	}

	on_done :: proc(resp: http.Response, user_data: rawptr) {
		(cast(^http.Response)user_data)^ = resp
	}

	resp: http.Response
	loop := eventloop.init(real_time = true)

	if err := http.fetch(&loop, {url = args[0]}, on_done, &resp); err != .None {
		fmt.eprintfln("lava fetch: %v", err)
		eventloop.destroy(&loop)
		os.exit(EXIT_USAGE)
	}

	eventloop.run(&loop)
	eventloop.destroy(&loop)
	exit_code := print_fetched(&resp)
	http.response_destroy(&resp)
	os.exit(exit_code)
}

@(private = "file")
print_fetched :: proc(resp: ^http.Response) -> int {
	if resp.error != .None {
		fmt.eprintfln("lava fetch: %v", resp.error)
		return EXIT_FETCH_FAILED
	}

	fmt.eprintfln("HTTP %d %s", resp.status, resp.reason)
	fmt.eprintfln("url: %s (%d redirects)", resp.url, resp.redirects)
	for h in resp.headers {
		fmt.eprintfln("%s: %s", h.name, h.value)
	}

	if !http.is_html(resp) {
		os.write(os.stdout, resp.body[:])
		return 0
	}

	p: html.Parser
	defer html.destroy(&p)
	markup: string
	ok := html.init(&p) && html.parse_all(&p, resp.body[:])

	if ok {
		markup, ok = html.serialize(&p)
	}

	if !ok {
		fmt.eprintfln("lava fetch: %s", html.error_message(&p))
		return EXIT_FETCH_FAILED
	}

	fmt.println(markup)
	return 0
}
