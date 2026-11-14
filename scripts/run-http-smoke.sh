#!/usr/bin/env sh
# node:http server smoke test (M2). The echo server (tests/runtime/http/server.js) is
# run under BOTH Node and Lava; the same Node client (client.js) hits each, and the
# deterministic response fields it prints must be identical (server parity). Not part of
# the default `make test` because it binds a local TCP port; run with `make test-http-smoke`.
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
NODE_BIN=${NODE_BIN:-node}
LAVA_BIN=${LAVA_BIN:-"$ROOT_DIR/bin/lava"}

SERVER="$ROOT_DIR/tests/runtime/http/server.js"
CLIENT="$ROOT_DIR/tests/runtime/http/client.js"
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/lava-http-smoke.XXXXXX")
SENTINEL='HTTP SMOKE OK'
SRV_PID=""
PHASE_JOBS=""

cleanup() {
	[ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null || true
	for pid_file in "$TMP_DIR"/srv-*.pid; do
		[ -s "$pid_file" ] || continue
		srv=$(cat "$pid_file" 2>/dev/null || true)
		[ -n "${srv:-}" ] && kill "$srv" 2>/dev/null || true
	done
	for job in $PHASE_JOBS; do
		p=${job%%:*}
		kill "$p" 2>/dev/null || true
	done
	wait 2>/dev/null || true
	rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

"$NODE_BIN" --version >/dev/null

# run_suite <client-out-file> <server launcher...> — start the echo server under the
# given runtime, wait for its READYPORT line, run the Node client against it, capture the
# client stdout, then stop the server.
run_suite() {
	out_file=$1
	shift
	srv_out="$TMP_DIR/srv.out"
	: >"$srv_out"
	"$@" "$SERVER" >"$srv_out" 2>&1 &
	SRV_PID=$!

	port=""
	i=0
	while [ "$i" -lt 500 ]; do
		port=$(sed -n 's/^READYPORT=//p' "$srv_out")
		[ -n "$port" ] && break
		kill -0 "$SRV_PID" 2>/dev/null || break
		i=$((i + 1))
		sleep 0.01
	done
	if [ -z "$port" ]; then
		printf '%s\n' 'http smoke FAILED: echo server never became reachable' >&2
		cat "$srv_out" >&2 || true
		exit 1
	fi

	HTTP_PORT="$port" "$NODE_BIN" "$CLIENT" >"$out_file" 2>"$out_file.err" || true
	kill "$SRV_PID" 2>/dev/null || true
	wait "$SRV_PID" 2>/dev/null || true
	SRV_PID=""
}

run_suite "$TMP_DIR/node.out" "$NODE_BIN"
run_suite "$TMP_DIR/lava.out" "$LAVA_BIN" run

for who in node lava; do
	if ! grep -q "$SENTINEL" "$TMP_DIR/$who.out"; then
		printf '%s\n' "http smoke FAILED: client did not reach '$SENTINEL' against the $who server (crashed or exited early)" >&2
		printf '%s\n' "--- $who client stdout ---" >&2
		cat "$TMP_DIR/$who.out" >&2 || true
		printf '%s\n' "--- $who client stderr ---" >&2
		cat "$TMP_DIR/$who.out.err" >&2 || true
		exit 1
	fi
done

if diff -u "$TMP_DIR/node.out" "$TMP_DIR/lava.out"; then
	printf '%s\n' 'http smoke phase 1 passed (lava server matches node server)'
else
	printf '%s\n' 'http smoke FAILED: lava server output differs from node server' >&2
	exit 1
fi

# Lava-only assertion phases: run an assertion client (its own pass/fail logic, exit
# non-zero on failure) against a fresh Lava echo server. These cover behavior that
# intentionally differs from Node (rejection codes, connection reuse), so they are not a
# node-vs-lava diff. Each phase runs in its own background subshell with isolated
# server/client logs so all independent phases execute concurrently.
lava_assert() {
	client=$1
	label=$2
	srv_env=${3:-} # optional "VAR=value" exported for the server process
	srv_pid=""
	client_pid=""
	srv_out="$TMP_DIR/srv-$label.out"
	pid_file="$TMP_DIR/srv-$label.pid"
	sub_cleanup() {
		[ -n "$client_pid" ] && kill "$client_pid" 2>/dev/null || true
		[ -n "$srv_pid" ] && kill "$srv_pid" 2>/dev/null || true
	}
	trap sub_cleanup EXIT INT TERM

	: >"$srv_out"
	env ${srv_env:+"$srv_env"} "$LAVA_BIN" run "$SERVER" >"$srv_out" 2>&1 &
	srv_pid=$!
	printf '%s\n' "$srv_pid" >"$pid_file"

	port=""
	i=0
	while [ "$i" -lt 500 ]; do
		port=$(sed -n 's/^READYPORT=//p' "$srv_out")
		[ -n "$port" ] && break
		kill -0 "$srv_pid" 2>/dev/null || break
		i=$((i + 1))
		sleep 0.01
	done
	if [ -z "$port" ]; then
		printf '%s\n' "http smoke FAILED: lava server never came up for the $label checks" >&2
		cat "$srv_out" >&2 || true
		exit 1
	fi
	# `set -e` is on, and a failing assertion client is an EXPECTED outcome here —
	# it is how a phase reports failure. Without the guard the shell dies on that
	# exit status before the `cat` below, so a failing phase printed nothing at all:
	# no check list, no label, no reason. Found by adding a phase that was supposed
	# to fail and getting silence instead of a diagnosis.
	set +e
	HTTP_PORT="$port" "$NODE_BIN" "$client" >"$TMP_DIR/$label.out" 2>&1 &
	client_pid=$!
	wait "$client_pid"
	rc=$?
	client_pid=""
	set -e
	kill "$srv_pid" 2>/dev/null || true
	wait "$srv_pid" 2>/dev/null || true
	srv_pid=""
	rm -f "$pid_file"
	cat "$TMP_DIR/$label.out"
	if [ "$rc" -ne 0 ]; then
		printf '%s\n' "http smoke FAILED: $label checks failed" >&2
		exit 1
	fi
}

start_assert() {
	client=$1
	label=$2
	srv_env=${3:-}
	(
		lava_assert "$client" "$label" "$srv_env"
	) >"$TMP_DIR/phase-$label.stdout" 2>"$TMP_DIR/phase-$label.stderr" &
	PHASE_JOBS="$PHASE_JOBS $!:$label"
}

start_response_unit() {
	(
		unit_out="$TMP_DIR/response-unit.out"
		if "$LAVA_BIN" run "$ROOT_DIR/tests/runtime/http/response-unit.js" >"$unit_out" 2>&1 &&
			grep -q 'RESPONSE UNIT OK' "$unit_out"; then
			cat "$unit_out"
		else
			printf '%s\n' 'http smoke FAILED: ServerResponse coalescing unit test failed' >&2
			cat "$unit_out" >&2 || true
			exit 1
		fi
	) >"$TMP_DIR/phase-response-unit.stdout" 2>"$TMP_DIR/phase-response-unit.stderr" &
	PHASE_JOBS="$PHASE_JOBS $!:response-unit"
}

wait_phases() {
	for job in $PHASE_JOBS; do
		p=${job%%:*}
		label=${job#*:}
		set +e
		wait "$p"
		rc=$?
		set -e
		[ -s "$TMP_DIR/phase-$label.stdout" ] && cat "$TMP_DIR/phase-$label.stdout"
		[ -s "$TMP_DIR/phase-$label.stderr" ] && cat "$TMP_DIR/phase-$label.stderr" >&2
		if [ "$rc" -ne 0 ]; then
			exit 1
		fi
	done
}

# Phase 2 — malformed/untrusted-input handling (injection, smuggling, oversized, etc.).
start_assert "$ROOT_DIR/tests/runtime/http/malformed.js" malformed
# Phase 2b — the SAME checks against a server whose RegExp.prototype has been
# replaced, which is a plain assignment away for anything in the dependency tree.
# Every framing check in phase 2 is regex-validated (Content-Length numeric,
# Transfer-Encoding chunked, chunk size hex, chunk extension), so before these
# validators were routed through a captured `exec` a poisoned prototype turned
# exactly four of them off: `Content-Length: abc` answered 200 OK, and
# `Transfer-Encoding: gzip` was accepted as chunked. That is request smuggling, and
# the other 18 checks kept passing, which is why it needs its own phase rather than
# a note in the first one.
#
# Both directions are run because they are not the same vector. `exec` is the
# sharper: the spec's RegExpExec re-reads `R.exec` off the receiver, so poisoning it
# also steers a `test` captured pristine at module-eval — capturing `test` is not a
# fix, only calling a captured `exec` is. `test` is the obvious one and is pinned so
# a future refactor cannot quietly reintroduce `re.test(...)`.
#
# Lava-only by necessity, not by choice: node cannot be the oracle here because
# node's own internals use regexes, and its server dies inside `net` at startup
# under the same poison. That is fail-closed, and Lava's was fail-open.
start_assert "$ROOT_DIR/tests/runtime/http/malformed.js" malformed-poisoned-exec "HTTP_POISON_REGEXP=exec"
start_assert "$ROOT_DIR/tests/runtime/http/malformed.js" malformed-poisoned-test "HTTP_POISON_REGEXP=test"
# Phase 2c — the carrier the first two phases do not touch. Routing a validator off
# RegExp says nothing about what it reads instead: assertValidHeaderChar and
# isHttpToken scanned with a live String.prototype.charCodeAt, so a gadget lying
# only about CR/LF turned `res.setHeader('Location', decodeURIComponent(req.url))`
# into response splitting from a REMOTE request line — while phases 2a and 2b
# passed throughout. node rejects the same request with ERR_INVALID_CHAR.
start_assert "$ROOT_DIR/tests/runtime/http/malformed.js" malformed-poisoned-charcodeat "HTTP_POISON_REGEXP=charcodeat"
# Phase 2d — conversion beside the validator. A sound digit check next to a live
# globalThis.parseInt still desyncs Content-Length framing when the conversion
# returns a gadget value. Applied before require('node:http') so a factory-time
# capture would bind the poison; the fix is bootstrap capture on primordials.
start_assert "$ROOT_DIR/tests/runtime/http/malformed.js" malformed-poisoned-parseint "HTTP_POISON_REGEXP=parseint"
# Phase 3 — keep-alive: connection reuse, pipelining, Connection: close, HTTP/1.0.
start_assert "$ROOT_DIR/tests/runtime/http/keepalive.js" keepalive
# Phase 4 — timeouts / slowloris: idle, slow-head, slow-body evicted; fast client OK.
# (HTTP_SHORT_TIMEOUTS makes the fixture use sub-second timeouts.)
start_assert "$ROOT_DIR/tests/runtime/http/timeouts.js" timeouts HTTP_SHORT_TIMEOUTS=1

# Phase 5 — ServerResponse head/body coalescing unit test. Runs in-process under Lava with a
# mock socket (no server/client): asserts the single-write fast path, its head+body size
# bound, the chunked/HEAD/large paths, and that a non-coalescable body never marks the
# response sent without writing the head. Also covers latin1WriteInto high-byte heads.
start_response_unit

# Phase 6 — header bridge (lowercased req.headers keys + case-preserving rawHeaders +
# latin1 values + response-head bytes). Lava server only: locks the parseRequest
# result contract and headBytes/latin1WriteInto.
start_assert "$ROOT_DIR/tests/runtime/http/headers-bridge.js" headers-bridge

wait_phases

printf '%s\n' 'http smoke passed (parity + malformed + keep-alive + timeouts + response-unit + headers-bridge)'
