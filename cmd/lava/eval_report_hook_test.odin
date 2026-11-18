#+build linux, darwin
package main

import "core:strings"
import "core:testing"
import lava "lava:pkg/runtime"
import eventloop "lava:pkg/runtime/eventloop"

// Pins eval's `report` hook (runtime.odin, Result_Hook): it fires exactly once per eval,
// with the Result eval returns, and BEFORE eval's deferred teardown — the loop is not
// yet destroyed when it runs. That ordering is the whole point: the deferred
// eventloop.destroy joins the loop's pool workers, and a worker blocked without bound
// (fs.readFile on a FIFO nobody writes) would otherwise hold a top-level throw's report
// until it returned (tests/stdio/uncaught-before-teardown.test.mjs is the Node-side
// differential). Lava-only: Node has no embedding API to compare against. Scoped
// linux+darwin, where eval links JSC.

@(private = "file")
Seen :: struct {
	loop:          ^eventloop.Loop,
	calls:         int,
	status:        lava.Status,
	exit_code:     int,
	message:       string, // cloned: the Result's message belongs to eval's caller
	loop_was_live: bool,
}

@(private = "file")
record_report :: proc(result: lava.Result, user_data: rawptr) {
	seen := cast(^Seen)user_data
	seen.calls += 1
	seen.status = result.status
	seen.exit_code = result.exit_code
	delete(seen.message)
	seen.message = strings.clone(result.message)
	seen.loop_was_live = !seen.loop.destroyed
}

@(private = "file")
eval_reported :: proc(t: ^testing.T, src: string, echo: bool, seen: ^Seen) -> lava.Result {
	loop := eventloop.init()
	seen.loop = &loop
	defer seen.loop = nil
	return lava.eval(src, "<report-hook-test>", &loop, echo, nil, nil, nil, record_report, seen)
}

@(test)
eval_reports_a_top_level_throw_before_teardown :: proc(t: ^testing.T) {
	seen: Seen
	defer delete(seen.message)
	result := eval_reported(t, "setTimeout(() => {}, 0); throw new Error('reported-early')", false, &seen)
	defer lava.result_destroy(&result)
	testing.expect_value(t, seen.calls, 1)
	testing.expect(t, seen.loop_was_live, "the report hook ran after eval had destroyed its loop")
	testing.expect_value(t, seen.status, lava.Status.Execution_Error)
	testing.expect_value(t, seen.exit_code, 1)
	testing.expect_value(t, seen.message, "Error: reported-early")
	testing.expect_value(t, result.message, seen.message)
}

@(test)
eval_reports_an_echoed_result_once_before_teardown :: proc(t: ^testing.T) {
	seen: Seen
	defer delete(seen.message)
	result := eval_reported(t, "setTimeout(() => {}, 0); 6 * 7", true, &seen)
	defer lava.result_destroy(&result)
	testing.expect_value(t, seen.calls, 1)
	testing.expect(t, seen.loop_was_live, "the report hook ran after eval had destroyed its loop")
	testing.expect_value(t, seen.status, lava.Status.Ok)
	testing.expect_value(t, seen.message, "42")
}

// A pre-flight rejection returns before any context or teardown exists; it is still
// reported, so a CLI that prints only through the hook prints it too.
@(test)
eval_reports_a_preflight_rejection :: proc(t: ^testing.T) {
	seen: Seen
	defer delete(seen.message)
	result := eval_reported(t, "", false, &seen)
	defer lava.result_destroy(&result)
	testing.expect_value(t, seen.calls, 1)
	testing.expect_value(t, seen.status, lava.Status.Invalid_Input)
	testing.expect_value(t, seen.exit_code, 2)
}
