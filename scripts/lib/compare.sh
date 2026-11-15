# Shared node-vs-lava comparison helpers, sourced by the compatibility runners.
#
# The caller must set these before sourcing and calling run_case:
#   ROOT_DIR              repo root (absolute)
#   NODE_BIN              node binary (oracle)
#   LAVA_BIN              lava binary
#   TMP_DIR               writable scratch dir (already created)
#   RUN_LAVA              "1" to compare node vs lava, else node-only
#
# Optional (run_case reads these defensively, so suites with no gaps need not
# set them — important under `set -u`):
#   SKIP_KNOWN_LAVA_GAPS  "1" to skip paths listed in KNOWN_GAPS_FILE (default 0)
#   KNOWN_GAPS_FILE       path to a gaps list (one relative path/line, # comments)
#   CASE_TIMEOUT_SEC      per-case wall-clock timeout in seconds (default 30)

# Gate integrity (agent-cycle F1): a lava-vs-lava "oracle" is byte-identical by
# construction and must never count as a pass. Refuse when NODE_BIN is lava or
# identical to LAVA_BIN under a comparative run.
_lava_gate_integrity_check() {
	if [ "${RUN_LAVA:-0}" != "1" ]; then
		return 0
	fi
	_node_base=$(basename -- "$NODE_BIN" 2>/dev/null || basename "$NODE_BIN")
	case "$_node_base" in
	lava | lava.exe)
		printf '%s\n' "GATE INTEGRITY: NODE_BIN must be the Node oracle, not Lava (got $NODE_BIN)" >&2
		return 2
		;;
	esac
	if [ -n "${LAVA_BIN:-}" ] && [ "$NODE_BIN" = "$LAVA_BIN" ]; then
		printf '%s\n' "GATE INTEGRITY: NODE_BIN and LAVA_BIN are the same path ($NODE_BIN) — refuse lava-vs-lava" >&2
		return 2
	fi
	# Resolve both if they exist; catch NODE_BIN=./bin/lava via realpath.
	if command -v realpath >/dev/null 2>&1; then
		_nr=$(realpath "$NODE_BIN" 2>/dev/null || true)
		_lr=$(realpath "$LAVA_BIN" 2>/dev/null || true)
		if [ -n "$_nr" ] && [ -n "$_lr" ] && [ "$_nr" = "$_lr" ]; then
			printf '%s\n' "GATE INTEGRITY: NODE_BIN and LAVA_BIN resolve to the same file ($_nr)" >&2
			return 2
		fi
	fi
	return 0
}
_lava_gate_integrity_check || exit $?

# Issue #185: the oracle suites are baselined to the Node major pinned in .nvmrc,
# and that major is a floor, not an exact match: Lava tracks Node forward (26 now,
# 28 planned), so a newer oracle may run and its drift shows up as case diffs.
# An older one cannot run at all: node:sqlite alone binds `undefined` as NULL from
# 26 where 24 threw, so its expectations are wrong for us. Fail before any case.
_lava_node_major_check() {
	_want=$(cut -d. -f1 "$ROOT_DIR/.nvmrc" | tr -dc '0-9')
	_got=$("$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null) || _got=0
	if [ "$_got" -lt "$_want" ]; then
		printf '%s\n' "oracle requires node >= $_want (.nvmrc), found $("$NODE_BIN" --version 2>/dev/null || echo none) ($NODE_BIN)" >&2
		return 2
	fi
}
_lava_node_major_check || exit $?

CASE_TIMEOUT_SEC=${CASE_TIMEOUT_SEC:-30}

# Portable per-case wall-clock timeout (#399). Uses perl (present on Linux, macOS,
# and Git for Windows) so child process groups are killed with SIGKILL on alarm
# and exit 124 matches GNU timeout without requiring coreutils on macOS.
_run_with_timeout() {
	_timeout_sec=$1
	shift
	perl -e '
		my $t = shift;
		my $pid = fork // die "fork: $!";
		if ($pid == 0) { setpgrp(0, 0); exec @ARGV or exit 127; }
		local $SIG{ALRM} = sub { kill -9, -$pid, $pid; waitpid($pid, 0); exit 124; };
		alarm $t;
		waitpid($pid, 0);
		alarm 0;
		if ($? & 127) { exit(128 + ($? & 127)); }
		exit($? >> 8);
	' "$_timeout_sec" "$@"
}

run_node_case() {
	case_file=$1
	rel_case=${case_file#$ROOT_DIR/}
	printf 'node %s\n' "$rel_case"
	set +e
	_run_with_timeout "$CASE_TIMEOUT_SEC" "$NODE_BIN" "$case_file"
	_node_status=$?
	set -e
	if [ "$_node_status" -eq 124 ]; then
		printf 'timeout (%ss) running node for %s\n' "$CASE_TIMEOUT_SEC" "$rel_case" >&2
		return 124
	fi
	return "$_node_status"
}

# compare_case runs a case through both node and lava and fails on any
# difference in exit status, stdout, or stderr.
compare_case() {
	case_file=$1
	case_key=$(printf '%s' "${case_file#$ROOT_DIR/}" | tr '/.' '__')
	node_stdout="$TMP_DIR/$case_key.node.stdout"
	node_stderr="$TMP_DIR/$case_key.node.stderr"
	lava_stdout="$TMP_DIR/$case_key.lava.stdout"
	lava_stderr="$TMP_DIR/$case_key.lava.stderr"

	set +e
	_run_with_timeout "$CASE_TIMEOUT_SEC" "$NODE_BIN" "$case_file" >"$node_stdout" 2>"$node_stderr"
	node_status=$?
	if [ "$node_status" -eq 124 ]; then
		set -e
		printf 'timeout (%ss) running node for %s\n' "$CASE_TIMEOUT_SEC" "${case_file#$ROOT_DIR/}" >&2
		return 124
	fi
	_run_with_timeout "$CASE_TIMEOUT_SEC" "$LAVA_BIN" run "$case_file" >"$lava_stdout" 2>"$lava_stderr"
	lava_status=$?
	set -e
	if [ "$lava_status" -eq 124 ]; then
		printf 'timeout (%ss) running lava for %s\n' "$CASE_TIMEOUT_SEC" "${case_file#$ROOT_DIR/}" >&2
		return 124
	fi

	if [ "$node_status" -ne "$lava_status" ]; then
		printf 'exit mismatch for %s: node=%s lava=%s\n' "${case_file#$ROOT_DIR/}" "$node_status" "$lava_status"
		return 1
	fi

	if ! cmp -s "$node_stdout" "$lava_stdout"; then
		printf 'stdout mismatch for %s\n' "${case_file#$ROOT_DIR/}"
		diff -u "$node_stdout" "$lava_stdout" || true
		return 1
	fi

	if ! cmp -s "$node_stderr" "$lava_stderr"; then
		printf 'stderr mismatch for %s\n' "${case_file#$ROOT_DIR/}"
		diff -u "$node_stderr" "$lava_stderr" || true
		return 1
	fi
}

# run_case dispatches a single case: node-only, lava-compare, or skipped when it
# is a documented known gap under lava.
run_case() {
	case_file=$1
	rel_path=${case_file#$ROOT_DIR/}
	if [ "${RUN_LAVA:-0}" = "1" ] && [ "${SKIP_KNOWN_LAVA_GAPS:-0}" = "1" ] && [ -n "${KNOWN_GAPS_FILE:-}" ] && [ -f "$KNOWN_GAPS_FILE" ]; then
		if grep -v '^[[:space:]]*#' "$KNOWN_GAPS_FILE" | grep -qx "$rel_path"; then
			printf 'skip-known-gap %s\n' "$rel_path"
			return 0
		fi
	fi
	if [ "${RUN_LAVA:-0}" = "1" ]; then
		compare_case "$case_file"
	else
		run_node_case "$case_file"
	fi
}
