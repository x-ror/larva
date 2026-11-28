package main

import "core:fmt"
import "core:os"
import "core:strconv"
import "core:strings"
import adapters "lava:pkg/adapters"
import html "lava:pkg/html"
import http "lava:pkg/http"
import cookie "lava:pkg/http/cookie"
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
	case "page":
		page_command(args[2:])
	case "fetch":
		fetch_command(args[2:])
	case "serve":
		serve_command(args[2:])
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
                        --origin sets the page's URL (location) and the origin
                        object URLs are minted under (default: about:blank,
                        opaque, blob:null/<uuid>)
  lava html [--scripts] [--chunk N] [--select CSS] [--tree|--serialize]
            [--fragment CTX] [--sniff|--charset LABEL] <file|->
                        Parse HTML and print the serialized document (or its
                        html5lib-format tree, or a CTX element's innerHTML parse);
                        input is UTF-8 unless --sniff determines its encoding as
                        a navigation does (--charset: as served with that charset)
  lava page [--tree|--serialize] [--origin=<origin>] <file.html>
                        Run an HTML page: parse it with its inline classic scripts
                        run as the parser reaches them (document/window exposed),
                        run the event loop to idle, then print the document's
                        serialization (or its html5lib-format tree); input is UTF-8
  lava fetch <url>      Fetch a page without JS; status and headers on stderr,
                        the serialized HTML on stdout, decoded per its charset
  lava serve [--listen ip:port] [--threads N] [--pages-per-thread N]
             [--cpu-budget-ms N] [--token T]
                        Serve the HTTP crawling API (GET /render?url=...): fetch the
                        page, run it with its scripts until load (then an optional
                        selector wait and script), answer with its serialized HTML;
                        SIGTERM/SIGINT stop it gracefully (default 127.0.0.1:8080)
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
//
// The input is taken as UTF-8, as DOMParser takes a string — what tests/dom's DOMParser
// cases compare against. --sniff decodes it as a navigation would instead
// (html.decode_document: BOM, <meta> prescan, windows-1252), and --charset LABEL as if
// it had been served with `Content-Type: text/html; charset=LABEL`; tests/dom's `.nav`
// cases run with them. Neither applies to a fragment, which is a string in Chrome too.
html_command :: proc(args: []string) {
	usage :: proc() -> ! {
		fmt.eprintln(
			"usage: lava html [--scripts] [--chunk N] [--select CSS] [--tree|--serialize] [--fragment CTX] [--sniff|--charset LABEL] <file|->",
		)
		os.exit(2)
	}
	Html_Options :: struct {
		list_scripts: bool,
		scripts:      int,
	}
	opts: Html_Options
	chunk := 0
	path, css, fragment, charset := "", "", "", ""
	tree, serialize, sniff := false, false, false
	for i := 0; i < len(args); i += 1 {
		switch a := args[i]; {
		case a == "--scripts":
			opts.list_scripts = true
		case a == "--tree":
			tree = true
		case a == "--serialize":
			serialize = true
		case a == "--sniff":
			sniff = true
		case a == "--charset":
			i += 1

			if i == len(args) || args[i] == "" {
				usage()
			}

			charset = args[i]
			sniff = true
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

	if fragment != "" && (opts.list_scripts || chunk > 0 || sniff) {
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

	if sniff {
		text, _, decoded := html.decode_document(data, charset)

		if !decoded {
			fmt.eprintln("lava html: the input could not be decoded")
			os.exit(1)
		}

		delete(data)
		data = text
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

// page_command runs an HTML file as a page (lava_runtime.run_html_page): its inline
// classic scripts run as the parser reaches them, with `document` and `window` in scope,
// the event loop runs until it idles, and the document is printed — serialized, or as
// the html5lib-format tree with --tree — the two views tests/dom's `*.page.html` cases
// compare with Chrome. What scripts write with console goes to stdout first. A script's
// throw is reported on stderr and the page goes on; the exit code is then 1.
//
// The input is taken as UTF-8, as tests/dom serves its page cases (`text/html;
// charset=utf-8`); `--origin` is `lava run`'s.
page_command :: proc(args: []string) {
	usage :: proc() -> ! {
		fmt.eprintln("usage: lava page [--tree|--serialize] [--origin=<origin>] <file.html>")
		os.exit(2)
	}

	view := lava_runtime.Html_View.Serialize
	path, origin := "", ""
	tree, serialize := false, false
	for a in args {
		switch {
		case a == "--tree":
			tree = true
		case a == "--serialize":
			serialize = true
		case strings.has_prefix(a, "--origin="):
			origin = a[len("--origin="):]

			if origin == "" {
				usage()
			}
		case len(a) > 1 && a[0] == '-', path != "":
			usage()
		case:
			path = a
		}
	}

	if path == "" || (tree && serialize) {
		usage()
	}

	if tree {
		view = .Tree
	}

	data, err := os.read_entire_file(path, context.allocator)

	if err != nil {
		fmt.eprintfln("lava page: cannot read %s: %v", path, err)
		os.exit(1)
	}

	loop := eventloop.init(real_time = true)
	result, output := lava_runtime.run_html_page(
		data,
		path,
		&loop,
		view,
		report = print_result,
		origin = origin,
		document_path = path,
	)
	delete(data)

	// The dump ends every line itself; the markup gets one newline, as `lava html`'s.
	if output != "" {
		if tree {
			lava_runtime.process_write(os.stdout, output)
		} else {
			lava_runtime.process_write(os.stdout, output, "\n")
		}
	}

	delete(output)
	exit_code := result.exit_code
	lava_runtime.result_destroy(&result)
	os.exit(exit_code)
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
//
// pkg/http follows redirects and undoes the Content-Encoding (gzip, deflate, br, zstd);
// an HTML body is then decoded per the sniffing algorithm with Content-Type's charset as
// the transport label (html.decode_document), and the encoding chosen is reported on
// stderr as `charset: <name> (<step>)`. The markup on stdout is always UTF-8, as
// Chrome's serialization of the DOM is.
//
// The run is one session with a cookie jar of its own (pkg/http/cookie), empty at the
// start and gone at exit: a redirect's Set-Cookie is sent on the hops after it, as a
// browser navigation does. Pinned by `make test-fetch-html-smoke` (a redirect that
// answers 403 unless its cookie comes back).
fetch_command :: proc(args: []string) {
	if len(args) != 1 || (len(args[0]) > 0 && args[0][0] == '-') {
		fmt.eprintln("usage: lava fetch <url>")
		os.exit(EXIT_USAGE)
	}

	on_done :: proc(resp: http.Response, user_data: rawptr) {
		(cast(^http.Response)user_data)^ = resp
	}

	resp: http.Response
	jar: cookie.Jar
	cookie.jar_init(&jar)
	loop := eventloop.init(real_time = true)

	if err := http.fetch(&loop, {url = args[0], cookie_jar = &jar}, on_done, &resp); err != .None {
		fmt.eprintfln("lava fetch: %v", err)
		eventloop.destroy(&loop)
		os.exit(EXIT_USAGE)
	}

	eventloop.run(&loop)
	eventloop.destroy(&loop)
	cookie.jar_destroy(&jar)
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

	text, enc, decoded := html.decode_document(resp.body[:], http.charset(resp))
	defer delete(text)

	if !decoded {
		fmt.eprintln("lava fetch: the body could not be decoded")
		return EXIT_FETCH_FAILED
	}

	fmt.eprintfln("charset: %s (%v)", enc.name, enc.source)
	p: html.Parser
	defer html.destroy(&p)
	markup: string
	ok := html.init(&p) && html.parse_all(&p, text)

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

// serve_command runs `lava serve` until SIGTERM or SIGINT: the HTTP crawling adapter
// (pkg/adapters serve.odin; its wire contract is serve_contract.odin's header). Exits 0
// after a graceful stop, 1 when the server cannot start, 2 on a usage error.
serve_command :: proc(args: []string) {
	cfg, ok := parse_serve_args(args)

	if !ok {
		fmt.eprintln(
			"usage: lava serve [--listen ip:port] [--threads N] [--pages-per-thread N] [--cpu-budget-ms N] [--token T]",
		)
		os.exit(2)
	}

	server: adapters.Server

	if err := adapters.server_init(&server, cfg); err != "" {
		fmt.eprintfln("lava serve: %s", err)
		os.exit(1)
	}

	if !adapters.serve_stop_on_signals(&server) {
		fmt.eprintln("lava serve: cannot install the SIGTERM/SIGINT handlers")
		adapters.server_destroy(&server)
		os.exit(1)
	}

	fmt.eprintfln("lava serve: listening on port %d", server.port)
	adapters.server_run(&server)
	adapters.server_destroy(&server)
	fmt.eprintln("lava serve: stopped")
}

// parse_serve_args reads `lava serve`'s flags; ok false is a usage error (an unknown
// flag, a missing value, a number that is not positive).
parse_serve_args :: proc(args: []string) -> (cfg: adapters.Server_Config, ok: bool) {
	for i := 0; i < len(args); i += 1 {
		flag := args[i]
		i += 1

		if i >= len(args) || args[i] == "" {
			return {}, false
		}

		value := args[i]
		n, is_number := strconv.parse_int(value, 10)
		is_number = is_number && n > 0
		switch flag {
		case "--listen":
			cfg.listen = value
		case "--token":
			cfg.token = value
		case "--threads":
			cfg.threads = n
		case "--pages-per-thread":
			cfg.pages_per_thread = n
		case "--cpu-budget-ms":
			cfg.cpu_budget_ms = n
		case:
			return {}, false
		}

		if flag != "--listen" && flag != "--token" && !is_number {
			return {}, false
		}
	}
	return cfg, true
}
