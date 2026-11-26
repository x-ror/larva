#+build linux, darwin
package main

import "core:fmt"
import "core:os"
import "core:testing"
import lava "lava:pkg/runtime"

// Pins `lava run --surface=web` (parse_run_args, main.odin), the temporary flag
// the Chrome-recorded oracle suite (tests/web, `make test-web`) runs its cases
// under until the Node surface is deleted. A Lava-only CLI seam: neither node
// nor Chrome has a `run` command, so it is pinned here rather than by an oracle.
// The suite's own globals-window case pins the same names against Chrome.

@(test)
run_args_surface_flag :: proc(t: ^testing.T) {
	web, web_rest, web_err := parse_run_args({"--surface=web", "a.js", "x"})
	testing.expect_value(t, web_err, "")
	testing.expect_value(t, web, lava.Global_Surface.Web)
	testing.expect_value(t, len(web_rest), 2)

	if len(web_rest) == 2 {
		testing.expect_value(t, web_rest[0], "a.js")
		testing.expect_value(t, web_rest[1], "x")
	}

	// No flag keeps the default every other caller gets.
	node, node_rest, node_err := parse_run_args({"a.js"})
	testing.expect_value(t, node_err, "")
	testing.expect_value(t, node, lava.Global_Surface.Node)
	testing.expect_value(t, len(node_rest), 1)

	// After the script path the flag belongs to the script (process.argv), as every
	// option after the entry does under node.
	late, late_rest, late_err := parse_run_args({"a.js", "--surface=web"})
	testing.expect_value(t, late_err, "")
	testing.expect_value(t, late, lava.Global_Surface.Node)
	testing.expect_value(t, len(late_rest), 2)

	// A misspelt surface or a flag with no file is a usage error, never a silent
	// fallback to the Node surface.
	_, _, bogus_err := parse_run_args({"--surface=window", "a.js"})
	testing.expect(t, bogus_err != "", "--surface=window must be refused")
	_, _, alone_err := parse_run_args({"--surface=web"})
	testing.expect(t, alone_err != "", "--surface=web without a file must be refused")
}

// run_file must hand the surface to eval: with `.Web` the Node names are gone, and
// without it (the default) they are all there. The script throws from the top level
// on a mismatch, so a lost parameter is an Execution_Error naming the names.
@(test)
run_file_threads_surface :: proc(t: ^testing.T) {
	// typeof in the entry's own scope: `require` and `module` are bindings of the
	// CommonJS wrapper, not global properties, so a fresh Function would miss them.
	SCRIPT :: `const types = [typeof process, typeof require, typeof Buffer, typeof module, typeof setImmediate, typeof global];
const want = typeof WANT_WEB !== 'undefined';
let seen = 0;
for (const ty of types) if (ty !== 'undefined') seen++;
if (want ? seen !== 0 : seen !== types.length) throw new Error((want ? 'web sees ' : 'node sees ') + types.join(','));
`

	check :: proc(t: ^testing.T, name: string, source: string, surface: lava.Global_Surface) {
		path := fmt.aprintf("/tmp/lava-run-surface-%d-%s.js", os.get_pid(), name)
		defer delete(path)

		if err := os.write_entire_file(path, transmute([]u8)source); err != nil {
			testing.expectf(t, false, "%s: cannot write %s: %v", name, path, err)
			return
		}

		defer os.remove(path)
		result := lava.run_file(path, surface = surface)
		defer lava.result_destroy(&result)
		testing.expectf(t, result.status == .Ok, "%s: status=%v message=%q", name, result.status, result.message)
	}

	check(t, "web", "var WANT_WEB = 1;\n" + SCRIPT, .Web)
	check(t, "node", SCRIPT, .Node)
}

// LAVA_WORKERS selected Lava's multi-worker supervisor, deleted with the Node profile.
// A script started with LAVA_WORKERS=4 must be refused rather than silently run on one
// page, which is what an ignored variable would do; unset, empty and "1" (the
// single-page run it always meant) stay accepted.
@(test)
run_refuses_lava_workers :: proc(t: ^testing.T) {
	testing.expect_value(t, workers_env_error("", false), "")
	testing.expect_value(t, workers_env_error("", true), "")
	testing.expect_value(t, workers_env_error("1", true), "")

	for v in ([]string{"2", "auto", "0", "1 ", "x"}) {
		testing.expectf(t, workers_env_error(v, true) != "", "LAVA_WORKERS=%q must be refused", v)
	}
}
