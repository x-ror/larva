#!/usr/bin/env sh
set -eu

# Run every node-vs-lava oracle suite this platform supports against LAVA_BIN.
# A single entry point so each CI job (and `make test-lava`) covers every module
# with one command; a new cross-platform suite added here is picked up everywhere.
#
# Platform coverage:
#   event-loop, node:fs : all platforms (pure-JS / cross-platform behavior).
#   node:sqlite         : all platforms — Linux/macOS link the system libsqlite3,
#                         Windows links the statically-built sqlite3.lib from the
#                         cached amalgamation (see SQLITE_AVAILABLE in
#                         pkg/std/sqlite/sqlite.odin and scripts/build-sqlite-windows.sh).
#   node-compat suite   : all platforms — the cases branch on process.platform for
#                         the few path/URL/error-code behaviors that differ on
#                         Windows (e.g. tests/node-compat/cases/02-fs-path.js).
#
# Honors RUN_LAVA, LAVA_BIN and NODE_BIN (passed through to each sub-runner).
ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
RUN_LAVA=${RUN_LAVA:-1}
export RUN_LAVA

if [ "${LAVA_ORACLE_SERIAL:-0}" = "1" ]; then
	SKIP_KNOWN_LAVA_GAPS=1 "$ROOT_DIR/scripts/run-eventloop-oracle.sh"
	"$ROOT_DIR/scripts/run-fs-oracle.sh"
	"$ROOT_DIR/scripts/run-sqlite-oracle.sh"
	SKIP_KNOWN_LAVA_GAPS=1 "$ROOT_DIR/scripts/run-node-compat-all.sh"
else
	OUT_DIR=$(mktemp -d "${TMPDIR:-/tmp}/lava-oracles.XXXXXX")
	cleanup() {
		rm -rf "$OUT_DIR"
	}
	trap cleanup EXIT

	SKIP_KNOWN_LAVA_GAPS=1 "$ROOT_DIR/scripts/run-eventloop-oracle.sh" >"$OUT_DIR/01-eventloop.log" 2>&1 &
	pid_eventloop=$!
	"$ROOT_DIR/scripts/run-fs-oracle.sh" >"$OUT_DIR/02-fs.log" 2>&1 &
	pid_fs=$!
	"$ROOT_DIR/scripts/run-sqlite-oracle.sh" >"$OUT_DIR/03-sqlite.log" 2>&1 &
	pid_sqlite=$!
	SKIP_KNOWN_LAVA_GAPS=1 "$ROOT_DIR/scripts/run-node-compat-all.sh" >"$OUT_DIR/04-node-compat.log" 2>&1 &
	pid_compat=$!

	failed=0
	for spec in \
		"eventloop:$pid_eventloop:$OUT_DIR/01-eventloop.log" \
		"fs:$pid_fs:$OUT_DIR/02-fs.log" \
		"sqlite:$pid_sqlite:$OUT_DIR/03-sqlite.log" \
		"node-compat:$pid_compat:$OUT_DIR/04-node-compat.log"; do
		name=${spec%%:*}
		rest=${spec#*:}
		pid=${rest%%:*}
		log=${rest#*:}
		set +e
		wait "$pid"
		rc=$?
		set -e
		cat "$log"
		if [ "$rc" -ne 0 ]; then
			printf 'oracle suite %s failed (exit %s)\n' "$name" "$rc" >&2
			failed=1
		fi
	done
	[ "$failed" -eq 0 ] || exit 1
fi

printf '%s\n' 'all supported oracle suites passed'
