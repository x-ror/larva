package main

import "core:fmt"
import "core:os"
import "core:strings"
import html "lava:pkg/html"
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
  lava run <file>       Run a JavaScript file
  lava html [--scripts] <file|->
                        Parse HTML and print the serialized document
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

run_command :: proc(args: []string) {
	if len(args) < 1 {
		fmt.eprintln("usage: lava run <file>")
		os.exit(2)
	}

	// LAVA_WORKERS>1 runs the file on N shared-nothing worker loops (Slice 3a). Resolved fail-fast:
	// an invalid value or an unsupported platform exits non-zero rather than silently degrading.
	worker_count, count_ok, count_msg := lava_runtime.lava_resolve_worker_count()
	if !count_ok {
		fmt.eprintfln("lava: %s", count_msg)
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
	result := lava_runtime.run_file(args[0], &loop, args[1:], report = print_result)
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

// html_command parses an HTML file (or stdin, `-`) with pkg/html and prints the
// serialized document. The input is fed in 16 KiB pieces, as a network read would
// deliver it, so the incremental path is the one exercised. Scripts are not run: with
// --scripts each parser-blocking script is reported on stderr at the moment the
// parser pauses for it, which is where a page loader would execute it.
html_command :: proc(args: []string) {
	list_scripts := false
	path := ""
	for a in args {
		if a == "--scripts" do list_scripts = true
		else do path = a
	}
	if path == "" {
		fmt.eprintln("usage: lava html [--scripts] <file|->")
		os.exit(2)
	}
	data: []byte
	err: os.Error
	if path == "-" do data, err = os.read_entire_file_from_file(os.stdin, context.allocator)
	else do data, err = os.read_entire_file(path, context.allocator)
	if err != nil {
		fmt.eprintfln("lava html: cannot read %s: %v", path, err)
		os.exit(1)
	}
	defer delete(data)

	p: html.Parser
	defer html.destroy(&p)
	if !html.init(&p) {
		fmt.eprintln("lava html: lexbor could not create a document")
		os.exit(1)
	}
	CHUNK :: 16 * 1024
	off, scripts := 0, 0
	loop: for {
		script, st := html.pump(&p)
		switch st {
		case .Script:
			scripts += 1
			if list_scripts {
				if src, ok := html.attr(script, "src"); ok {
					fmt.eprintfln("[script %d] src=%s", scripts, src)
				} else {
					body := html.text(script)
					fmt.eprintfln("[script %d] inline, %d bytes", scripts, len(body))
					delete(body)
				}
			}
		case .Need_Input:
			if off >= len(data) {
				html.finish(&p)
				continue
			}
			end := min(off + CHUNK, len(data))
			html.feed(&p, data[off:end])
			off = end
		case .Done:
			break loop
		case .Failed:
			fmt.eprintln("lava html: lexbor reported a parse failure")
			os.exit(1)
		}
	}
	b := strings.builder_make()
	defer strings.builder_destroy(&b)
	if !html.serialize(&p, &b) {
		fmt.eprintln("lava html: serialization failed")
		os.exit(1)
	}
	fmt.println(strings.to_string(b))
}
