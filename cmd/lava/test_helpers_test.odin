package main

import "core:fmt"
import lava "lava:pkg/runtime"

// Helpers shared by the page-runner tests. Each of page_runner_test, page_runner_reap_test
// and page_lifecycle_test used to declare its own file-private copy of the outcome
// recorder, differing only in whether it kept the Result's message.

// Page_Outcome is what a test keeps of a page's Result once the runner delivers it.
Page_Outcome :: struct {
	done:    bool,
	status:  lava.Status,
	kill:    lava.Kill_Reason,
	exit:    int,
	// The start of the Result's message: the one place a page that threw says what it
	// saw. Copied into a fixed buffer, not cloned: on_done runs under the runner's
	// allocator, which the churn and reaping tests audit, and the copy is the test's,
	// not the runner's.
	message: [160]u8,
}

// record_page_outcome is a Page_Runner on_done callback: `user_data` is the page's
// ^Page_Outcome. It takes ownership of `result` and destroys it, as on_done must.
record_page_outcome :: proc(runner: ^lava.Page_Runner, user_data: rawptr, result: lava.Result) {
	result := result
	o := cast(^Page_Outcome)user_data
	o^ = {
		done   = true,
		status = result.status,
		kill   = result.kill,
		exit   = result.exit_code,
	}
	copy(o.message[:len(o.message) - 1], result.message)
	lava.result_destroy(&result)
}

// Finished is one page's outcome plus its place in the order the runner reported the
// test's pages in; `reported` is shared by them. Ordering against a sibling is how the
// runner tests measure "not held up" without a wall-clock bound.
Finished :: struct {
	outcome:  Page_Outcome,
	at:       int,
	reported: ^int,
}

// record_finished is a Page_Runner on_done callback: `user_data` is the page's
// ^Finished.
record_finished :: proc(runner: ^lava.Page_Runner, user_data: rawptr, result: lava.Result) {
	f := cast(^Finished)user_data
	f.reported^ += 1
	f.at = f.reported^
	record_page_outcome(runner, &f.outcome, result)
}

// describe_outcome renders a Page_Outcome for a failure message, the message as text
// (`%v` would print the buffer as 160 numbers).
describe_outcome :: proc(o: Page_Outcome) -> string {
	msg := o.message
	return fmt.tprintf(
		"{{done=%v status=%v kill=%v exit=%d message=%q}}",
		o.done,
		o.status,
		o.kill,
		o.exit,
		string(cstring(&msg[0])),
	)
}
