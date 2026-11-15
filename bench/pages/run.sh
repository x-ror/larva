#!/usr/bin/env bash
# Pages-per-thread benchmark (#4): builds bench/pages and runs it for N = 1, 10, 50,
# 100 concurrent pages on one thread, LAUNCHES processes per N — interleaved, each
# round running every N once, so machine drift hits every N alike — and prints the
# median of each metric per N. Report-only; CI runs only a small smoke of it
# (make test-bench-pages-smoke). A launch with a failed page exits 1, and set -e stops
# the run there rather than taking a median over refused pages.
set -euo pipefail
cd "$(dirname "$0")/../.."
LAUNCHES="${LAUNCHES:-5}"
TOTAL="${TOTAL:-1000}"
BIN="${TMPDIR:-/tmp}/lava-bench-pages"
odin build bench/pages -collection:lava=. -o:speed -out:"$BIN"
OUT="$(mktemp)"
HEAP="$(mktemp)"
DISP="$(mktemp)"
trap 'rm -f "$OUT" "$HEAP" "$DISP"' EXIT
for _ in $(seq "$LAUNCHES"); do
	for n in 1 10 50 100; do "$BIN" "$n" "$TOTAL" >>"$OUT"; done
done
# Heap-sampling arm (N=10, every page sampled vs none), per page shape, and the
# dispatcher at 1, 2 and 4 workers of 10 slots — each interleaved the same way.
for _ in $(seq "$LAUNCHES"); do
	for shape in trivial heavy; do
		for every in 0 1; do
			printf 'shape=%s ' "$shape" >>"$HEAP"
			"$BIN" 10 "$TOTAL" 30 "$every" "$shape" >>"$HEAP"
		done
	done
	for t in 1 2 4; do "$BIN" dispatch "$t" 10 "$((TOTAL * 2))" >>"$DISP"; done
done
node - "$OUT" "$HEAP" "$DISP" <<'JS'
const lines = require('fs').readFileSync(process.argv[2], 'utf8').trim().split('\n');
const by = new Map();
for (const l of lines) {
  const kv = Object.fromEntries(l.split(' ').map((p) => p.split('=')));
  if (!by.has(kv.N)) by.set(kv.N, []);
  by.get(kv.N).push(kv);
}
const med = (a) => { const s = a.map(Number).sort((x, y) => x - y); return s[s.length >> 1]; };
const cols = ['cold_ms', 'warm_ms', 'rss_growth_kb_per_live_page', 'rss_growth_kb_per_vm', 'pages_per_s'];
console.log(['N', ...cols, 'launches'].join('\t'));
for (const [n, rows] of by) console.log([n, ...cols.map((c) => med(rows.map((r) => r[c]))), rows.length].join('\t'));
const parse = (f) => require('fs').readFileSync(f, 'utf8').trim().split('\n').map((l) => Object.fromEntries(l.split(' ').map((p) => p.split('='))));
const group = (rows, key) => { const m = new Map(); for (const r of rows) { const k = key(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };
console.log('\nheap sampling, N=10 churn');
console.log(['shape', 'heap_every', 'pages_per_s', 'sampled', 'launches'].join('\t'));
for (const [k, rows] of group(parse(process.argv[3]), (r) => `${r.shape}\t${r.heap_every}`)) console.log([k, med(rows.map((r) => r.pages_per_s)), med(rows.map((r) => r.sampled)), rows.length].join('\t'));
console.log('\ndispatcher, 10 slots per worker');
console.log(['threads', 'pages_per_s', 'launches'].join('\t'));
for (const [k, rows] of group(parse(process.argv[4]), (r) => r.threads)) console.log([k, med(rows.map((r) => r.pages_per_s)), rows.length].join('\t'));
JS
