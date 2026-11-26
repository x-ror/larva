#!/usr/bin/env sh
set -eu

# `odin test cmd/lava` minus the tests named in cmd/lava/known-node-red.txt: the cmd/lava
# tests that are red in the default build for Node-profile reasons and wait for their
# rewrite onto the Window surface (S5a of the Node-profile removal). CI's test job runs
# this instead of `make test-odin`, so a NEW red fails the job while the known ones are
# written down, each with its reason, instead of hidden behind a red job nobody reads.
#
# A skip-list entry naming a test that no longer exists fails the run: a stale entry
# would otherwise keep excusing a name a later test could reuse. Extra arguments go to
# `odin test` (the Makefile passes -define:ODIN_TEST_THREADS=1 for SERIAL=1).
#
# ODIN_TEST_NAMES, not a runtime -tests: flag, because the Makefile's test targets
# already select that way (test-one); the runner only WARNS on an unknown name, which is
# why the stale check below exists.
ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ODIN=${ODIN:-odin}
LIST="$ROOT_DIR/cmd/lava/known-node-red.txt"

# Every @(test) proc in the package: the declaration line right after the attribute.
all=$(cat "$ROOT_DIR"/cmd/lava/*_test.odin | awk 'prev == "@(test)" { sub(/ ::.*/, ""); print } { prev = $0 }' | sort -u)
skip=$(grep -v '^#' "$LIST" | awk 'NF { print $1 }' | sort -u)

for name in $skip; do
	if ! printf '%s\n' "$all" | grep -qx "$name"; then
		printf 'run-odin-green: %s is listed in cmd/lava/known-node-red.txt but no such test exists: drop the entry\n' "$name" >&2
		exit 1
	fi
done

names=$(printf '%s\n' "$all" | grep -vxF "$(printf '%s\n' "$skip")" | sed 's/^/main./' | paste -sd, -)

if [ -z "$names" ]; then
	printf '%s\n' 'run-odin-green: no tests left to run' >&2
	exit 1
fi

printf 'run-odin-green: %d tests, %d skipped as known Node-profile reds\n' \
	"$(printf '%s\n' "$all" | grep -vxcF "$(printf '%s\n' "$skip")")" \
	"$(printf '%s\n' "$skip" | grep -c .)"
cd "$ROOT_DIR"
"$ODIN" test cmd/lava -collection:lava=. "-define:ODIN_TEST_NAMES=$names" "$@"
