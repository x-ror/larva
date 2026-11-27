#!/usr/bin/env sh
set -eu

# Thin wrapper around bench/run.mjs, mirroring the oracle runners (scripts/run-*.sh) so
# the Makefile invokes benchmarks the same way it invokes tests. All timing, parsing,
# baseline building and gating live in the Node orchestrator; node only drives the
# runs, every benchmark executes under `lava run`.
#
# Honors LAVA_BIN, BASE and BASE_REF (see bench/run.mjs). Pass --gate to enforce the
# new/base caps in bench/thresholds.json (exit non-zero on breach); without it the run
# is report-only and always succeeds.
ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
NODE_BIN=${NODE_BIN:-node}
LAVA_BIN=${LAVA_BIN:-"$ROOT_DIR/bin/lava"}
export LAVA_BIN

"$NODE_BIN" --version >/dev/null

exec "$NODE_BIN" "$ROOT_DIR/bench/run.mjs" "$@"
