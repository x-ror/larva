#!/usr/bin/env sh
# bench/pages smoke. The benchmark is report-only, so nothing else builds or runs it,
# and it once shipped measuring nothing: after #26 the page runner refused every page
# it opened (no CPU budget), the refusals returned at once, and the cold/warm rounds
# timed them as fast start-ups. Two runs, both small:
#   1. `<bin> 2 8` must exit 0 and report zero failed pages in every round — the bench
#      still compiles, links, and runs real pages.
#   2. `<bin> 2 8 0` (budget 0, i.e. the #26 refusal) must exit 1 and report every page
#      of every round failed — a refused page is counted, never timed as a page. This
#      is the half that kills the mutation on the bench's exit line: with a valid
#      budget no page fails, so run 1 alone cannot tell a working exit check from none.
# Linux only (the page runner is); a no-op success elsewhere.
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ODIN=${ODIN:-odin}

case "$(uname -s)" in
Linux) ;;
*)
	echo "bench-pages smoke skipped (Linux only)"
	exit 0
	;;
esac

TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/lava-bench-pages-smoke.XXXXXX")
trap 'rm -rf "$TMP_DIR"' EXIT
BIN="$TMP_DIR/bench-pages"

# Default opt level: this proves the bench is honest, not how fast it is.
(cd "$ROOT_DIR" && "$ODIN" build bench/pages -collection:lava=. -out:"$BIN")

status=0
"$BIN" 2 8 >"$TMP_DIR/ok.out" || status=$?
cat "$TMP_DIR/ok.out"
if [ "$status" -ne 0 ]; then
	echo "bench-pages smoke: valid-budget run exited $status, want 0" >&2
	exit 1
fi
grep -q ' cold_failed=0 warm_failed=0 churn_failed=0 ' "$TMP_DIR/ok.out" || {
	echo "bench-pages smoke: valid-budget run reported failed pages" >&2
	exit 1
}

status=0
"$BIN" 2 8 0 >"$TMP_DIR/refused.out" 2>"$TMP_DIR/refused.err" || status=$?
cat "$TMP_DIR/refused.out"
if [ "$status" -ne 1 ]; then
	echo "bench-pages smoke: budget-0 run exited $status, want 1 (refused pages not failing the bench)" >&2
	exit 1
fi
grep -q ' cold_failed=2 warm_failed=2 churn_failed=8 ' "$TMP_DIR/refused.out" || {
	echo "bench-pages smoke: budget-0 run did not count every refused page as failed" >&2
	exit 1
}
echo "bench-pages smoke: ok"
