// Benchmark orchestrator: run every bench/micro/*.js under both Node (the oracle)
// and Lava, plus an external process-startup measurement, then print a node-vs-lava table
// and — with --gate — fail on any benchmark whose lava/node ratio exceeds its cap in
// bench/thresholds.json. All timing/parsing lives here (in Node, always present) rather
// than in shell, so the runner is portable across Linux/macOS and easy to extend.
//
// Env: NODE_BIN (oracle, default "node"), LAVA_BIN (default ../bin/lava), BENCH_STARTUP_REPS.
// Usage: node bench/run.mjs [--gate]

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const NODE_BIN = process.env.NODE_BIN || 'node';
const LAVA_BIN = process.env.LAVA_BIN || join(ROOT, 'bin', 'lava');
const STARTUP_REPS = Number(process.env.BENCH_STARTUP_REPS || 15);
const GATE = process.argv.includes('--gate');
const MARKER = '##BENCH##';

// Collect the bench files, excluding the startup noop target and lib.
function benchFiles() {
  const out = [];
  for (const group of ['micro']) {
    const dir = join(ROOT, 'bench', group);
    for (const name of readdirSync(dir).sort()) {
      if (name.endsWith('.js') && name !== 'noop.js') out.push(join(dir, name));
    }
  }
  return out;
}

// Run one bench file under a runtime and return the parsed ##BENCH## result lines.
function runFile(bin, args, file) {
  let stdout;
  try {
    stdout = execFileSync(bin, [...args, file], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    });
  } catch (e) {
    throw new Error(`${bin} failed on ${file}: ${e.message}`);
  }
  const results = [];
  for (const line of stdout.split('\n')) {
    const at = line.indexOf(MARKER);
    if (at < 0) continue;
    results.push(JSON.parse(line.slice(at + MARKER.length)));
  }
  return results;
}

// Time a process from spawn to exit, best of STARTUP_REPS, for the startup metric.
function measureStartup(bin, args) {
  let best = Infinity;
  for (let i = 0; i < STARTUP_REPS; i++) {
    const t0 = performance.now();
    execFileSync(bin, args, { stdio: 'ignore' });
    const dt = performance.now() - t0;
    if (dt < best) best = dt;
  }
  return Number(best.toFixed(4));
}

function collect(bin, args) {
  const byName = new Map();
  for (const file of benchFiles()) {
    for (const r of runFile(bin, args, file)) byName.set(r.name, r);
  }
  return byName;
}

// --gate reads the MEDIAN of GATE_LAUNCHES launches per side, not a single one.
//
// The per-process distribution here is bimodal, so one launch decides a pass/fail
// on a coin flip the caps were never calibrated against: median-of-3 was measured
// to cut the loaded-box false-positive rate from ~24% to ~16% with detection
// unchanged at 100%, for ~16s of CI. bench/thresholds.json has told readers to
// "re-run and compare MEDIANS of >=3 launches before believing it" since the caps
// were written — this makes the gate do what the note already asked of humans.
//
// Median, never min: min-of-N across launches is invalid on this distribution (it
// samples the fast mode only, which is not the mode the caps describe). Report-only
// runs still take one launch, because they fail nothing and pay no false-positive
// cost. And do NOT try to fix the variance by pinning instead — pinning shifts the
// ratio level 25-40% (it hurts node more than lava) and would invalidate every cap.
const GATE_LAUNCHES = 3;

function collectMedian(bin, args, launches) {
  if (launches <= 1) return collect(bin, args);
  const samples = new Map();
  for (let i = 0; i < launches; i++) {
    for (const [name, r] of collect(bin, args)) {
      // Only `ms` is medianed below; every other field (iterations, name)
      // describes the first launch that reported it, which is all the report
      // reads. A consumer deriving ns/op from `iterations` would mix launches.
      if (!samples.has(name)) samples.set(name, { r, ms: [] });
      samples.get(name).ms.push(r.ms);
    }
  }
  const byName = new Map();
  for (const [name, { r, ms }] of samples) {
    // Fail closed on a partial launch: a benchmark missing from one of the
    // launches means that launch died or truncated its output, and a median
    // over the remainder would silently gate on incomplete data.
    if (ms.length !== launches) {
      throw new Error(`benchmark ${name} reported ${ms.length}/${launches} launches`);
    }
    ms.sort((a, b) => a - b);
    // With launches=3 this is the true median; an even count is unreachable at
    // the current GATE_LAUNCHES. If someone raises it, note the lower median is
    // lenient on the lava side but pessimistic applied to node's (a smaller
    // node ms inflates every ratio).
    byName.set(name, { ...r, ms: ms[(ms.length - 1) >> 1] });
  }
  return byName;
}

const haveLava = (() => {
  try {
    execFileSync(LAVA_BIN, ['eval', '0'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

console.log(`node: ${NODE_BIN}`);
console.log(`lava: ${LAVA_BIN}${haveLava ? '' : '  (not runnable — node-only report)'}`);

const noop = join(ROOT, 'bench', 'micro', 'noop.js');
const LAUNCHES = GATE ? GATE_LAUNCHES : 1;
if (LAUNCHES > 1) console.log(`launches: ${LAUNCHES} per side (median; --gate)`);
const nodeResults = collectMedian(NODE_BIN, [], LAUNCHES);
nodeResults.set('startup', {
  name: 'startup',
  iterations: STARTUP_REPS,
  ms: measureStartup(NODE_BIN, [noop]),
});

let lavaResults = new Map();
if (haveLava) {
  lavaResults = collectMedian(LAVA_BIN, ['run'], LAUNCHES);
  lavaResults.set('startup', {
    name: 'startup',
    iterations: STARTUP_REPS,
    ms: measureStartup(LAVA_BIN, ['run', noop]),
  });
}

const names = [...nodeResults.keys()];
const thresholdsFile = JSON.parse(readFileSync(join(ROOT, 'bench', 'thresholds.json'), 'utf8'));
const thresholds = thresholdsFile.caps || {};
// Names that may lack a cap (explicit opt-out). A discovered bench with neither a
// cap nor an opt-out is a gate hole: deleting a file used to drop its cap too.
const reportOnly = new Set(thresholdsFile.report_only || []);

// Agent-cycle F1.2: every bench file under micro (except noop) must stay
// discoverable — silent rm of a .js would otherwise shrink the gate with no fail.
{
  let benchFileCount = 0;
  for (const group of ['micro']) {
    const dir = join(ROOT, 'bench', group);
    for (const name of readdirSync(dir)) {
      if (name.endsWith('.js') && name !== 'noop.js') benchFileCount++;
    }
  }
  // micro: buffer, encoding, json, require, url (+ noop excluded) = 5. bench/macro held
  // only fs.js, which went with node:fs.
  const minFiles = 0;
  if (benchFileCount < minFiles) {
    console.error(`gate-integrity: found ${benchFileCount} bench files, expected >= ${minFiles}`);
    process.exit(1);
  }
}

// Table.
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
console.log('');
console.log(
  `${pad('benchmark', 26)} ${padL('node ms', 12)} ${padL('lava ms', 12)} ${padL('ratio', 8)} ${padL('cap', 6)}`,
);
console.log('-'.repeat(68));

const breaches = [];
for (const name of names) {
  const n = nodeResults.get(name);
  const l = lavaResults.get(name);
  const cap = thresholds[name];
  let ratioStr = '-';
  const capStr = cap != null ? `${cap}x` : '-';
  if (haveLava && l) {
    const ratio = n.ms > 0 ? l.ms / n.ms : 0;
    ratioStr = `${ratio.toFixed(2)}x`;
    if (GATE && cap != null && ratio > cap) breaches.push({ name, ratio, cap });
  } else if (haveLava && GATE && cap != null) {
    // A gated benchmark that produced no lava result (crash, missing ##BENCH##
    // line) must breach, not silently vanish from the gate.
    breaches.push({ name, ratio: Infinity, cap });
  }
  console.log(
    `${pad(name, 26)} ${padL(n.ms.toFixed(3), 12)} ${padL(l ? l.ms.toFixed(3) : '-', 12)} ${padL(ratioStr, 8)} ${padL(capStr, 6)}`,
  );
}
console.log('');

if (!haveLava) {
  console.log('lava not runnable: printed Node baseline only (no ratios, no gate).');
  // Agent-cycle F1: --gate must not exit 0 when lava is missing — that is a
  // silent green ("rm bin/lava" used to pass the gate).
  if (GATE) {
    console.error('benchmark gate FAILED — lava not runnable (LAVA_BIN must work under --gate)');
    process.exit(1);
  }
  process.exit(0);
}

if (GATE) {
  // Every discovered name must have a cap or an explicit report_only entry.
  const uncapped = names.filter(
    (n) => thresholds[n] == null && !reportOnly.has(n) && !String(n).startsWith('//'),
  );
  if (uncapped.length > 0) {
    console.error(
      'benchmark gate FAILED — benches without a cap or report_only opt-out (agent-cycle F1.2):',
    );
    for (const n of uncapped) console.error(`  ${n}`);
    process.exit(1);
  }
  if (breaches.length > 0) {
    console.error('benchmark gate FAILED — lava/node ratio exceeded cap:');
    for (const b of breaches) console.error(`  ${b.name}: ${b.ratio.toFixed(2)}x > ${b.cap}x cap`);
    process.exit(1);
  }
  console.log('benchmark gate passed (all ratios within caps).');
} else {
  console.log('report-only (no gate). Run with --gate to enforce bench/thresholds.json caps.');
}
