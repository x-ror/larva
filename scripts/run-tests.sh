#!/usr/bin/env sh
set -eu

# One entry point for the regular test suite. It runs Odin unit tests first, then
# the JS oracle suites. Set RUN_LAVA=1 to compare each oracle case through Lava;
# set INCLUDE_FETCH_SMOKE=1 to include the socket/TLS fetch smoke.
ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ODIN=${ODIN:-odin}
RUN_LAVA=${RUN_LAVA:-0}
INCLUDE_FETCH_SMOKE=${INCLUDE_FETCH_SMOKE:-0}

case "$(uname -s)" in
	MINGW* | MSYS* | CYGWIN*) is_windows=1 ;;
	*) is_windows=0 ;;
esac

printf '%s\n' '== Odin tests =='
# cmd/lava links the runtime, which links the vendored C deps (picohttpparser). Build
# them first so the Odin test link succeeds even before `make build` has run.
"$ROOT_DIR/scripts/build-native-deps.sh"
"$ODIN" test "$ROOT_DIR/cmd/lava" -collection:lava="$ROOT_DIR"
# ONE runner thread, matching `make test-eventloop-odin` and for the reason stated
# there: the loop owns process-wide resources, so concurrent tests turn one
# another's fd allocation into spurious failures and skip the two cases that need
# an exclusive process. This line ran multithreaded for a while and CI silently
# disagreed with the Makefile about how the suite is meant to run. (It is not a
# race fix — the stale-wakeup defect this suite caught reproduces at one thread
# too — it just stops CI from contradicting the documented requirement.)
"$ODIN" test "$ROOT_DIR/pkg/runtime/eventloop" -define:ODIN_TEST_THREADS=1
# pkg/runtime unit tests (links JSC like cmd/lava): the LAVA_WORKERS parser + the startup barrier.
"$ODIN" test "$ROOT_DIR/pkg/runtime" -collection:lava="$ROOT_DIR"
# pkg/html links lexbor, which is built for Linux only (pkg/html/lexbor.odin).
if [ "$(uname -s)" = Linux ]; then
	"$ODIN" test "$ROOT_DIR/pkg/html"
fi

if [ "$is_windows" = 1 ] && [ ! -f "$ROOT_DIR/build/sqlite3.lib" ]; then
	printf '%s\n' 'skip pkg/std/sqlite Odin link test (missing build/sqlite3.lib)'
else
	if [ "$is_windows" = 1 ]; then
		export LIB="$(cygpath -w "$ROOT_DIR/build");${LIB:-}"
	fi
	"$ODIN" test "$ROOT_DIR/pkg/std/sqlite"
fi

printf '%s\n' '== Oracle suites =='
if [ "$RUN_LAVA" = 1 ]; then
	RUN_LAVA=1 "$ROOT_DIR/scripts/run-oracles.sh"
else
	# shellcheck source=lib/parallel-suites.sh
	. "$ROOT_DIR/scripts/lib/parallel-suites.sh"
	suite node-compat "$ROOT_DIR/scripts/run-node-compat-all.sh"
	suite sqlite "$ROOT_DIR/scripts/run-sqlite-oracle.sh"
	suite fs "$ROOT_DIR/scripts/run-fs-oracle.sh"
	suite eventloop "$ROOT_DIR/scripts/run-eventloop-oracle.sh"
	run_suites || exit 1
fi

if [ "$INCLUDE_FETCH_SMOKE" = 1 ]; then
	printf '%s\n' '== Fetch smoke =='
	"$ROOT_DIR/scripts/run-fetch-smoke.sh"
fi

printf '%s\n' 'all tests passed'
