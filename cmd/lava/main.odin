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

// Run_Options are what `lava run` reads before the script path.
Run_Options :: struct {
	// The page's origin, as `--origin=` gave it; "" when absent (an opaque origin).
	// Aliases `args`.
	origin: string,
}

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
  lava eval <source>    Evaluate a classic script with the Window globals
  lava run [--origin=<origin>] <file>
                        Run a classic script file with the Window globals;
                        --origin sets the page origin object URLs are minted
                        under (default: opaque, blob:null/<uuid>)
  lava html [--scripts] [--chunk N] [--select CSS] [--tree|--serialize]
            [--fragment CTX] <file|->
                        Parse HTML and print the serialized document (or its
                        html5lib-format tree, or a CTX element's innerHTML parse)
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

// parse_run_args splits `lava run`'s argv into its options and [scriptPath, ...].
//
// Returns:
//   The `--origin=` value, or "". The flag may come at most once, before the script
//   path. `rest` aliases `args`. A non-empty `err` is a usage error (exit 2): an empty
//   or repeated flag, or no script path after the flags.
// Deviates:
//   Lava-only. `--origin` stands in for the page URL a page will have from stage 4
//   (location): object URLs are minted as `blob:<origin>/<uuid>`, and without it as
//   Chrome does for an opaque origin, `blob:null/<uuid>`. Anything after the script
//   path is ignored: a page has no argv. Pinned by cmd/lava/run_surface_flag_test.odin
//   and, against Chrome, by tests/web/cases blob-object-url.js.
parse_run_args :: proc(args: []string) -> (opts: Run_Options, rest: []string, err: string) {
	rest = args
	seen_origin := false

	for len(rest) > 0 {
		arg := rest[0]

		if !strings.has_prefix(arg, "--origin=") {
			break
		}

		if seen_origin {
			return {}, nil, "lava run: a flag was given twice"
		}

		opts.origin = arg[len("--origin="):]

		if opts.origin == "" {
			return {}, nil, "--origin wants a value (an origin or a URL)"
		}

		seen_origin = true
		rest = rest[1:]
	}

	if len(rest) < 1 {
		return {}, nil, "usage: lava run [--origin=<origin>] <file>"
	}

	return opts, rest, ""
}

run_command :: proc(raw_args: []string) {
	opts, args, usage_err := parse_run_args(raw_args)

	if usage_err != "" {
		fmt.eprintln(usage_err)
		os.exit(2)
	}

	workers_raw, workers_set := os.lookup_env("LAVA_WORKERS", context.temp_allocator)

	if refusal := workers_env_error(workers_raw, workers_set); refusal != "" {
		fmt.eprintfln("lava: %s", refusal)
		os.exit(2)
	}

	loop := eventloop.init(real_time = true)
	// run_file forwards to eval, which tears the loop down before releasing its JS
	// context and reports through print_result before that teardown (see eval_command).
	result := lava_runtime.run_file(args[0], &loop, report = print_result, origin = opts.origin)
	exit_code := result.exit_code
	lava_runtime.result_destroy(&result)
	os.exit(exit_code)
}

// workers_env_error refuses a LAVA_WORKERS value that asks for more than the one page
// `lava run` runs. The variable selected Lava's multi-worker supervisor, deleted with
// the Node profile (S3); ignoring it would silently run one page where N were asked for,
// so anything but unset, empty or "1" — what it always meant by the single-page run — is
// a usage error (exit 2), as an invalid value was before. Returns "" when allowed.
// Pinned by cmd/lava/run_surface_flag_test.odin.
workers_env_error :: proc(raw: string, set: bool) -> string {
	if !set || raw == "" || raw == "1" {
		return ""
	}

	return "LAVA_WORKERS is no longer supported (the multi-worker supervisor was removed); unset it"
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
//
// --tree prints the parsed tree in html5lib's format instead (html.dump_tree), and
// --serialize names the default; they are the two views tests/dom compares with
// Chrome. --fragment CTX parses the input as the innerHTML of a CTX element
// (html.parse_fragment) and prints the views of its children; no script pauses there,
// so it takes neither --scripts nor --chunk.
html_command :: proc(args: []string) {
	usage :: proc() -> ! {
		fmt.eprintln(
			"usage: lava html [--scripts] [--chunk N] [--select CSS] [--tree|--serialize] [--fragment CTX] <file|->",
		)
		os.exit(2)
	}
	Html_Options :: struct {
		list_scripts: bool,
		scripts:      int,
	}
	opts: Html_Options
	chunk := 0
	path, css, fragment := "", "", ""
	tree, serialize := false, false
	for i := 0; i < len(args); i += 1 {
		switch a := args[i]; {
		case a == "--scripts":
			opts.list_scripts = true
		case a == "--tree":
			tree = true
		case a == "--serialize":
			serialize = true
		case a == "--fragment":
			i += 1

			if i == len(args) || args[i] == "" {
				usage()
			}

			fragment = args[i]
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

	if path == "" || (tree && serialize) || (css != "" && (tree || serialize)) {
		usage()
	}

	if fragment != "" && (opts.list_scripts || chunk > 0) {
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
	ok: bool
	// The node whose children the views print: the Document, or the element a fragment
	// was parsed into.
	root: html.Node

	if fragment != "" {
		root, ok = html.parse_fragment(&p, fragment, data)
	} else {
		ok = html.init(&p) && html.parse_all(&p, data, report, &opts, chunk)
		root = html.document(&p)
	}

	if ok && css != "" {
		select_and_print(root, css)
		html.destroy(&p)
		return
	}

	out: string

	if ok {
		switch {
		case tree:
			out, ok = html.dump_tree(root)
		case fragment != "":
			out, ok = html.inner_html(root)
		case:
			out, ok = html.serialize(&p)
		}
	}

	if !ok {
		msg := html.error_message(&p)
		fmt.eprintfln("lava html: %s", msg if msg != "" else "serialization failed")
		html.destroy(&p)
		os.exit(1)
	}

	// The dump ends every line itself; the markup gets the one newline it always had.
	if tree {
		fmt.print(out)
	} else {
		fmt.println(out)
	}

	html.destroy(&p)
}

// select_and_print prints the outerHTML of every match of `css` under `root`, one
// per line, in tree order. Exits 2 on an invalid selector, as a usage error.
select_and_print :: proc(root: html.Node, css: string) {
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

	if !html.query_all(&engine, root, sel, &matches) {
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
