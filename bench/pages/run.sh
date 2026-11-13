#!/usr/bin/env bash
# Pages-per-thread benchmark (#4): builds bench/pages and runs it for N = 1, 10, 50,
# 100 concurrent pages on one thread, LAUNCHES processes per N — interleaved, each
# round running every N once, so machine drift hits every N alike — and prints the
# median of each metric per N. Report-only; not in CI.
set -euo pipefail
cd "$(dirname "$0")/../.."
LAUNCHES="${LAUNCHES:-5}"
TOTAL="${TOTAL:-1000}"
BIN="${TMPDIR:-/tmp}/lava-bench-pages"
odin build bench/pages -collection:lava=. -o:speed -out:"$BIN"
OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT
for _ in $(seq "$LAUNCHES"); do
	for n in 1 10 50 100; do "$BIN" "$n" "$TOTAL" >>"$OUT"; done
done
node - "$OUT" <<'JS'
const lines = require('fs').readFileSync(process.argv[2], 'utf8').trim().split('\n');
const by = new Map();
for (const l of lines) {
  const kv = Object.fromEntries(l.split(' ').map((p) => p.split('=')));
  if (!by.has(kv.N)) by.set(kv.N, []);
  by.get(kv.N).push(kv);
}
const med = (a) => { const s = a.map(Number).sort((x, y) => x - y); return s[s.length >> 1]; };
const cols = ['cold_ms', 'warm_ms', 'live_kb_page', 'idle_kb_vm', 'pages_per_s'];
console.log(['N', ...cols, 'launches'].join('\t'));
for (const [n, rows] of by) console.log([n, ...cols.map((c) => med(rows.map((r) => r[c]))), rows.length].join('\t'));
JS
