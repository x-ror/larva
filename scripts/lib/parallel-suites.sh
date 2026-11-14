# Sourced by scripts/run-oracles.sh and scripts/run-tests.sh: run independent oracle
# suites concurrently and report them as if they had run one after another.
#
# Each suite already writes into its own mktemp dir, so running them together shares
# nothing on disk. Output is buffered per suite and printed in declaration order once
# that suite has finished, so a log reads the same as a serial run. Every suite runs to
# completion and every failure is named; the exit status is 1 if any failed.
# LAVA_ORACLE_SERIAL=1 runs them one after another instead, for bisecting a suspected
# interaction between suites.
#
# Usage:
#   suite <name> <command> [args...]   # queue (use `env VAR=x cmd` for env)
#   run_suites                          # run the queue; returns 1 if any failed

SUITES_DIR=""
SUITES_N=0

suite() {
	if [ -z "$SUITES_DIR" ]; then
		SUITES_DIR=$(mktemp -d "${TMPDIR:-/tmp}/lava-suites.XXXXXX")
	fi
	SUITES_N=$((SUITES_N + 1))
	name=$1
	shift
	printf '%s\n' "$name" >"$SUITES_DIR/$SUITES_N.name"
	if [ "${LAVA_ORACLE_SERIAL:-0}" = "1" ]; then
		set +e
		"$@"
		printf '%s\n' "$?" >"$SUITES_DIR/$SUITES_N.rc"
		set -e
	else
		(
			set +e
			"$@" >"$SUITES_DIR/$SUITES_N.log" 2>&1
			printf '%s\n' "$?" >"$SUITES_DIR/$SUITES_N.rc"
		) &
	fi
}

run_suites() {
	wait
	failed=0
	i=1
	while [ "$i" -le "$SUITES_N" ]; do
		name=$(cat "$SUITES_DIR/$i.name")
		[ -f "$SUITES_DIR/$i.log" ] && cat "$SUITES_DIR/$i.log"
		rc=$(cat "$SUITES_DIR/$i.rc" 2>/dev/null || printf '%s' 'missing')
		if [ "$rc" != 0 ]; then
			printf 'oracle suite %s failed (exit %s)\n' "$name" "$rc" >&2
			failed=1
		fi
		i=$((i + 1))
	done
	rm -rf "$SUITES_DIR"
	SUITES_DIR=""
	SUITES_N=0
	return "$failed"
}
