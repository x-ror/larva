#!/usr/bin/env bash
# Serializer benchmark (stage 3b): builds bench/html with -o:speed and runs it LAUNCHES
# times; each launch alternates lexbor's serializer and pkg/html's round by round and
# prints the median of ROUNDS rounds per input. Prints the median over the launches of
# each, in ns per KB of input, and the odin/lexbor ratio. Report-only.
set -euo pipefail
cd "$(dirname "$0")/../.."
LAUNCHES="${LAUNCHES:-7}"
ROUNDS="${ROUNDS:-25}"
BIN="${TMPDIR:-/tmp}/lava-bench-html"
odin build bench/html -collection:lava=. -o:speed -out:"$BIN"
OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT
for _ in $(seq "$LAUNCHES"); do "$BIN" "$ROUNDS" >>"$OUT"; done
node - "$OUT" "$LAUNCHES" "$ROUNDS" <<'JS'
const lines = require('fs').readFileSync(process.argv[2], 'utf8').trim().split('\n');
const by = new Map();
for (const l of lines) {
  const kv = Object.fromEntries(l.split(' ').map((p) => p.split('=')));
  if (!by.has(kv.input)) by.set(kv.input, []);
  by.get(kv.input).push(kv);
}
const med = (a) => { const s = a.map(Number).sort((x, y) => x - y); return s[s.length >> 1]; };
console.log(`serializer, ns per KB of input: medians of ${process.argv[3]} launches x ${process.argv[4]} interleaved rounds`);
console.log('input     kb    docs  lexbor   odin  odin/lexbor  differ');
for (const [input, runs] of by) {
  const lex = med(runs.map((r) => r.lexbor_ns_per_kb));
  const odn = med(runs.map((r) => r.odin_ns_per_kb));
  console.log(
    `${input.padEnd(8)} ${runs[0].kb.padStart(5)} ${runs[0].docs.padStart(6)} ${String(lex).padStart(7)} ${String(odn).padStart(6)} ${(odn / lex).toFixed(2).padStart(12)} ${runs[0].differ.padStart(7)}`,
  );
}
JS
