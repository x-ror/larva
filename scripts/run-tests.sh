#!/usr/bin/env sh
set -eu

# One entry point for the regular Odin test suite. The Chrome-recorded oracles
# (`make test-web`, `make test-dom`) need bin/lava and run as their own targets.
ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ODIN=${ODIN:-odin}

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
# pkg/runtime unit tests (links JSC like cmd/lava).
"$ODIN" test "$ROOT_DIR/pkg/runtime" -collection:lava="$ROOT_DIR"
# pkg/html links lexbor, which is built for Linux only (pkg/html/lexbor.odin). pkg/http's
# tests are Linux only, as its transport is; the flags match `make test-http-odin`, so a
# leak fails here as it does there.
if [ "$(uname -s)" = Linux ]; then
	"$ODIN" test "$ROOT_DIR/pkg/html"
	"$ODIN" test "$ROOT_DIR/pkg/http" -collection:lava="$ROOT_DIR" -define:ODIN_TEST_FAIL_ON_BAD_MEMORY=true
	"$ODIN" test "$ROOT_DIR/pkg/http/cookie" -collection:lava="$ROOT_DIR" -define:ODIN_TEST_FAIL_ON_BAD_MEMORY=true
	"$ODIN" test "$ROOT_DIR/pkg/tls" -collection:lava="$ROOT_DIR" -define:ODIN_TEST_FAIL_ON_BAD_MEMORY=true
fi

if [ "$is_windows" = 1 ] && [ ! -f "$ROOT_DIR/build/sqlite3.lib" ]; then
	printf '%s\n' 'skip pkg/std/sqlite Odin link test (missing build/sqlite3.lib)'
else
	if [ "$is_windows" = 1 ]; then
		export LIB="$(cygpath -w "$ROOT_DIR/build");${LIB:-}"
	fi
	"$ODIN" test "$ROOT_DIR/pkg/std/sqlite"
fi

printf '%s\n' 'all tests passed'
