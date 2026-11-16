#!/usr/bin/env sh
set -eu

# Runs every SQLite std test under tests/std/sqlite/cases. With RUN_LAVA=1 each
# case is compared against Node (exit status, stdout, stderr); otherwise it is a
# Node-only smoke run. New cases are picked up automatically by the glob.
ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
NODE_BIN=${NODE_BIN:-node}
LAVA_BIN=${LAVA_BIN:-"$ROOT_DIR/bin/lava"}
RUN_LAVA=${RUN_LAVA:-0}
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/lava-sqlite-oracle.XXXXXX")

# Older Node (e.g. the Node 22 line) flags node:sqlite as experimental and prints
# an ExperimentalWarning to stderr; the Node 26 CI baseline and Lava do not.
# Suppress Node's warnings here so the stderr comparison reflects behavior, not
# version noise, regardless of which Node the run happens to use.
export NODE_OPTIONS="${NODE_OPTIONS:-} --no-warnings"

. "$ROOT_DIR/scripts/lib/compare.sh"

trap 'rm -rf "$TMP_DIR"' EXIT

"$NODE_BIN" --version >/dev/null
node "$ROOT_DIR/runtime/gates/assert-case-counts.mjs" tests/std/sqlite/cases

for case_file in "$ROOT_DIR"/tests/std/sqlite/cases/*.js; do
	[ -f "$case_file" ] || continue
	run_case "$case_file"
done

printf '%s\n' 'sqlite oracle passed'
