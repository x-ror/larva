#+build linux, darwin
package main

import "core:fmt"
import "core:os"
import "core:testing"
import lava "lava:pkg/runtime"

// Pins `lava run`'s options (parse_run_args, main.odin). A Lava-only CLI seam: neither
// node nor Chrome has a `run` command, so it is pinned here rather than by an oracle.

@(test)
run_args_origin_flag :: proc(t: ^testing.T) {
	// No flag: an opaque origin, and the script path first in `rest`.
	plain, plain_rest, plain_err := parse_run_args({"a.js", "x"})
	testing.expect_value(t, plain_err, "")
	testing.expect_value(t, plain.origin, "")
	testing.expect_value(t, len(plain_rest), 2)

	if len(plain_rest) == 2 {
		testing.expect_value(t, plain_rest[0], "a.js")
	}

	// After the script path a flag is not read: it is the script's (and ignored).
	late, late_rest, late_err := parse_run_args({"a.js", "--origin=http://a.test"})
	testing.expect_value(t, late_err, "")
	testing.expect_value(t, late.origin, "")
	testing.expect_value(t, len(late_rest), 2)

	// The removed --surface flag is not an option any more: it is read as the script.
	old, old_rest, old_err := parse_run_args({"--surface=web", "a.js"})
	testing.expect_value(t, old_err, "")
	testing.expect_value(t, old.origin, "")
	testing.expect_value(t, len(old_rest), 2)

	// A flag with no file is a usage error.
	_, _, alone_err := parse_run_args({"--origin=http://a.test"})
	testing.expect(t, alone_err != "", "--origin without a file must be refused")

	// The value is handed on as given.
	set, set_rest, set_err := parse_run_args({"--origin=http://a.test:8080", "a.js"})
	testing.expect_value(t, set_err, "")
	testing.expect_value(t, set.origin, "http://a.test:8080")
	testing.expect_value(t, len(set_rest), 1)

	// An empty or repeated flag is a usage error, not a silent opaque origin or a
	// last-one-wins.
	_, _, empty_err := parse_run_args({"--origin=", "a.js"})
	testing.expect(t, empty_err != "", "an empty --origin must be refused")
	_, _, twice_err := parse_run_args({"--origin=http://a.test", "--origin=http://b.test", "a.js"})
	testing.expect(t, twice_err != "", "a repeated --origin must be refused")
}

// run_file runs the script with the Window globals and none of Node's. The script
// throws from the top level on a mismatch, so a Node name back on the page is an
// Execution_Error naming it.
@(test)
run_file_has_no_node_names :: proc(t: ^testing.T) {
	SCRIPT :: `const types = [typeof process, typeof require, typeof Buffer, typeof module, typeof setImmediate, typeof global];
for (const ty of types) if (ty !== 'undefined') throw new Error('page sees ' + types.join(','));
`

	path := fmt.aprintf("/tmp/lava-run-surface-%d.js", os.get_pid())
	defer delete(path)

	if err := os.write_entire_file(path, transmute([]u8)string(SCRIPT)); err != nil {
		testing.expectf(t, false, "cannot write %s: %v", path, err)
		return
	}

	defer os.remove(path)
	result := lava.run_file(path)
	defer lava.result_destroy(&result)
	testing.expectf(t, result.status == .Ok, "status=%v message=%q", result.status, result.message)
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

// run_file must hand the origin on to the page: object URLs are minted under it, as the
// origin it serializes to (a URL's path dropped), and without one under Chrome's form
// for an opaque origin, `blob:null/`. The case behind `--origin` is
// tests/web/cases/blob-object-url.js; this pins the default and the serialization,
// which the oracle runner (it always passes the fixture origin) cannot see.
@(test)
run_file_threads_origin :: proc(t: ^testing.T) {
	check :: proc(t: ^testing.T, name: string, origin: string, want_prefix: string) {
		source := fmt.aprintf(
			"const u = URL.createObjectURL(new Blob(['x']));\nif (!u.startsWith(%q) || u.length !== %d + 36) throw new Error('minted ' + u);\n",
			want_prefix,
			len(want_prefix),
		)
		defer delete(source)
		path := fmt.aprintf("/tmp/lava-run-origin-%d-%s.js", os.get_pid(), name)
		defer delete(path)

		if err := os.write_entire_file(path, transmute([]u8)source); err != nil {
			testing.expectf(t, false, "%s: cannot write %s: %v", name, path, err)
			return
		}

		defer os.remove(path)
		result := lava.run_file(path, origin = origin)
		defer lava.result_destroy(&result)
		testing.expectf(t, result.status == .Ok, "%s: status=%v message=%q", name, result.status, result.message)
	}

	check(t, "opaque", "", "blob:null/")
	check(t, "url", "http://a.test:8080/some/page?q#f", "blob:http://a.test:8080/")
	check(t, "default-port", "https://b.test:443", "blob:https://b.test/")
	check(t, "unparsable", "not a url", "blob:null/")
}
