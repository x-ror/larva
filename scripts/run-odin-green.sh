#!/usr/bin/env sh
set -eu

# `odin test cmd/lava` minus the tests named in cmd/lava/known-node-red.txt: the cmd/lava
# tests that are red in the default build for Node-profile reasons and wait for their
# rewrite onto the Window surface (S5a of the Node-profile removal). CI's test job runs
# this instead of `make test-odin`, so a NEW red fails the job while the known ones are
# written down, each with its reason, instead of hidden behind a red job nobody reads.
# CI also pins this file and the list by sha256 (ci.yml, "Skip list unchanged"), so
# widening either needs a human edit of ci.yml.
#
# The list can only shrink, in three ways this script enforces:
#   - an entry naming a test that no longer exists fails the run (a stale entry would
#     keep excusing a name a later test could reuse);
#   - after the green run, the listed tests run on their own and every one must still
#     FAIL: a listed test that passes fails the run with "drop it from the list";
#   - discovery is checked against a count of every @(…test…) attribute, so a test
#     written in a form the parser below misses fails the run instead of silently
#     never being selected.
# Extra arguments go to `odin test` (the Makefile passes -define:ODIN_TEST_THREADS=1 for
# SERIAL=1).
#
# ODIN_TEST_NAMES, not a runtime -tests: flag, because the Makefile's test targets
# already select that way (test-one). core:testing has no option to print its test list
# (runner.odin parses only -tests:), and it only WARNS on an unknown name (runner.odin:564),
# which is why discovery is cross-checked here rather than trusted.
ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ODIN=${ODIN:-odin}
LIST=${ODIN_GREEN_LIST:-"$ROOT_DIR/cmd/lava/known-node-red.txt"}
PKG_DIR=${ODIN_GREEN_PKG:-"$ROOT_DIR/cmd/lava"}

# Every proc carrying a `test` attribute, alone (`@(test)`) or among others
# (`@(test, …)`, `@(private, test)`), with any spacing or indentation (a `when` block),
# the declaration on the same line or a later one, CRLF tolerated.
discover() {
	cat "$PKG_DIR"/*.odin | tr -d '\r' | awk '
		function name_of(line,   m) {
			if (match(line, /[A-Za-z_][A-Za-z0-9_]*[ \t]*::[ \t]*proc/)) {
				m = substr(line, RSTART, RLENGTH)
				sub(/[ \t]*::.*/, "", m)
				return m
			}
			return ""
		}
		{
			line = $0
			if (pending) {
				n = name_of(line)
				if (n != "") { print n; pending = 0 }
				next
			}
			sub(/\/\/.*/, "", line)
			if (match(line, /@[ \t]*\(([^)]*[, \t])?test[ \t]*[,)]/)) {
				rest = substr(line, RSTART + RLENGTH)
				n = name_of(rest)
				if (n != "") print n; else pending = 1
			}
		}' | sort -u
}

all=$(discover)
attrs=$(cat "$PKG_DIR"/*.odin | tr -d '\r' | sed 's#//.*##' | grep -cE '@[[:space:]]*\(([^)]*[,[:space:]])?test[[:space:]]*[,)]' || true)
found=$(printf '%s\n' "$all" | grep -c . || true)

if [ "$attrs" != "$found" ]; then
	printf 'run-odin-green: %s @(test) attributes in %s but %s test names discovered: fix the discovery\n' \
		"$attrs" "$PKG_DIR" "$found" >&2
	exit 1
fi

skip=$(grep -v '^#' "$LIST" | awk 'NF { print $1 }' | sort -u)

for name in $skip; do
	if ! printf '%s\n' "$all" | grep -qx "$name"; then
		printf 'run-odin-green: %s is listed in %s but no such test exists: drop the entry\n' "$name" "$LIST" >&2
		exit 1
	fi
done

run=$(printf '%s\n' "$all" | grep -vxF "$(printf '%s\n' "$skip")" || true)

if [ -z "$run" ]; then
	printf '%s\n' 'run-odin-green: no tests left to run' >&2
	exit 1
fi

pkg=$(sed -n 's/^package \([A-Za-z_0-9]*\).*/\1/p' "$PKG_DIR"/*.odin | head -1)
qualify() { sed "s/^/$pkg./" | paste -sd, -; }

printf 'run-odin-green: %d tests, %d skipped as known Node-profile reds\n' \
	"$(printf '%s\n' "$run" | grep -c .)" "$(printf '%s\n' "$skip" | grep -c . || true)"
cd "$ROOT_DIR"
"$ODIN" test "$PKG_DIR" -collection:lava=. "-define:ODIN_TEST_NAMES=$(printf '%s\n' "$run" | qualify)" "$@"

if [ -z "$skip" ]; then
	exit 0
fi

# The listed tests, on their own: each must still fail. The runner's summary names every
# failed test as ` - <pkg>.<name>`; a listed name missing from it passed.
printf 'run-odin-green: checking the %d skipped tests still fail\n' "$(printf '%s\n' "$skip" | grep -c .)"
out=$("$ODIN" test "$PKG_DIR" -collection:lava=. "-define:ODIN_TEST_NAMES=$(printf '%s\n' "$skip" | qualify)" "$@" 2>&1 || true)

if ! printf '%s\n' "$out" | grep -q '^Finished '; then
	printf '%s\n' "$out" | tail -20 >&2
	printf '%s\n' 'run-odin-green: the skipped-test run did not finish; cannot tell which still fail' >&2
	exit 1
fi

passing=""
for name in $skip; do
	if ! printf '%s\n' "$out" | grep -qE "^ - $pkg\\.$name([[:space:]]|\$)"; then
		passing="$passing $name"
	fi
done

if [ -n "$passing" ]; then
	printf 'run-odin-green: listed as known red but now PASSING:%s — drop it from %s (and update its sha256 in ci.yml)\n' \
		"$passing" "$LIST" >&2
	exit 1
fi
