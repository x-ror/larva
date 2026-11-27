// Benchmark orchestrator: Lava against Lava. Runs every bench/micro/*.js under a
// BASELINE binary and the binary under test, interleaved launch by launch, plus an
// external process-startup measurement, and prints absolute ns/op for both with the
// new/base ratio. With --gate it fails on any ratio above its cap in
// bench/thresholds.json.
//
// Why not node any more: the Node profile is gone (#130), so `lava run` executes a
// page with the Window globals and node runs none of these files the same way. The
// oracle for page-facing SPEED would be Chrome, but Chrome's headless runner times
// an async benchmark under virtual time, where the clock stands still inside a task
// (scripts/lib/web-oracle.mjs, caseOptions), so a Chrome column is left out until it
// can be driven through DevTools instead. What a change needs to know — did it make
// Lava slower — is answered by the binary it replaces, on the same box, interleaved.
//
// Env:
//   LAVA_BIN        binary under test (default bin/lava)
//   BASE            baseline binary; `none` prints absolute numbers only. Unset:
//                   BASE_REF (default origin/master) is built once in a temporary
//                   git worktree and cached at bin/bench-base/<sha>/lava.
//   BENCH_LAUNCHES  launches per binary (default 5); every number is their median
//   BENCH_STARTUP_REPS  spawns per launch for `startup` (best of; default 10)
// Usage: node bench/run.mjs [--gate]

import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const LAVA_BIN = resolve(process.env.LAVA_BIN || join(ROOT, 'bin', 'lava'));
const LAUNCHES = Number(process.env.BENCH_LAUNCHES || 5);
const STARTUP_REPS = Number(process.env.BENCH_STARTUP_REPS || 10);
const GATE = process.argv.includes('--gate');
const MARKER = '##BENCH##';
const DONE = '##BENCH-DONE##';
const HARNESS = readFileSync(join(HERE, 'lib', 'harness.js'), 'utf8');
const NOOP = join(HERE, 'micro', 'noop.js');

if (!Number.isInteger(LAUNCHES) || LAUNCHES < 1) {
  console.error(`BENCH_LAUNCHES must be a positive integer, got ${process.env.BENCH_LAUNCHES}`);
  process.exit(1);
}

function git(args, opts = {}) {
  // stdout is null when the caller ignores it.
  const out = execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', ...opts });
  return (out ?? '').trim();
}

// The baseline binary. Built from a ref rather than taken from a stale bin/ so the
// comparison is against exactly what the change will replace; cached by commit sha
// because the base rarely moves while a change is iterated on.
function resolveBase() {
  const explicit = process.env.BASE;
  if (explicit === 'none') return null;
  if (explicit) return resolve(explicit);
  const ref = process.env.BASE_REF || 'origin/master';
  const sha = git(['rev-parse', '--verify', `${ref}^{commit}`]);
  const cached = join(ROOT, 'bin', 'bench-base', sha, 'lava');
  if (existsSync(cached)) return cached;

  console.log(`building baseline ${ref} (${sha.slice(0, 12)}) in a temporary worktree…`);
  const scratch = mkdtempSync(join(tmpdir(), 'lava-bench-base-'));
  const tree = join(scratch, 'tree');
  try {
    git(['worktree', 'add', '--quiet', '--detach', tree, sha], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    // A copy, not a symlink: the base's build-native-deps may pin another lexbor
    // and rebuild .deps in place, which must not touch this tree's.
    if (existsSync(join(ROOT, '.deps')))
      cpSync(join(ROOT, '.deps'), join(tree, '.deps'), { recursive: true });
    execFileSync(join(tree, 'scripts', 'build.sh'), {
      cwd: tree,
      stdio: ['ignore', 'ignore', 'inherit'],
      env: { ...process.env, LAVA_FORCE_BUILD: '1', LAVA_JS_OVERRIDE: '0' },
    });
    mkdirSync(dirname(cached), { recursive: true });
    copyFileSync(join(tree, 'bin', 'lava'), cached);
  } finally {
    // Fails harmlessly when `add` never got as far as registering the worktree.
    try {
      git(['worktree', 'remove', '--force', tree], { stdio: 'ignore' });
    } catch {}
    rmSync(scratch, { recursive: true, force: true });
  }
  return cached;
}

function benchFiles() {
  const dir = join(HERE, 'micro');
  return readdirSync(dir)
    .filter((n) => n.endsWith('.js') && n !== 'noop.js')
    .sort()
    .map((n) => join(dir, n));
}

// The harness is prepended rather than required: a page has no module loader.
// One temp file per bench file, written once and shared by both binaries, so they
// run byte-identical source.
function prepareScripts(files, dir) {
  return files.map((file) => {
    const out = join(dir, file.slice(file.lastIndexOf('/') + 1));
    writeFileSync(out, `${HARNESS}\n${readFileSync(file, 'utf8')}`);
    return { file, script: out };
  });
}

// Runs one bench script and returns its results, or throws. A run without the DONE
// line threw or exited early; its partial results are discarded rather than read as
// a fast, short run.
function runScript(bin, script) {
  let stdout;
  try {
    stdout = execFileSync(bin, ['run', script], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    const why = String(e.stderr || e.message)
      .trim()
      .split('\n')
      .slice(0, 3)
      .join(' | ');
    throw new Error(why);
  }
  const results = [];
  let done = false;
  for (const line of stdout.split('\n')) {
    if (line === DONE) done = true;
    else if (line.startsWith(MARKER)) results.push(JSON.parse(line.slice(MARKER.length)));
  }
  if (!done) throw new Error('no ##BENCH-DONE## line');
  return results;
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Fails closed before anything is timed, in report-only mode too: with either binary
// unable to start there is no table worth printing, and under --gate a missing
// binary must never read as "no breaches" (`rm bin/lava` once passed the old gate).
function assertRunnable(label, bin) {
  try {
    execFileSync(bin, ['eval', '0'], { stdio: 'ignore' });
  } catch (e) {
    console.error(
      `benchmark run FAILED — ${label} lava not runnable: ${bin} (${e.code ?? e.status})`,
    );
    process.exit(1);
  }
}

assertRunnable('new', LAVA_BIN);
if (GATE && process.env.BASE === 'none') {
  console.error('benchmark gate FAILED — --gate needs a baseline (BASE=none given)');
  process.exit(1);
}
const base = resolveBase();
if (base) assertRunnable('base', base);
const sides = base
  ? [
      { key: 'base', bin: base },
      { key: 'new', bin: LAVA_BIN },
    ]
  : [{ key: 'new', bin: LAVA_BIN }];

console.log(`new:  ${LAVA_BIN}`);
console.log(`base: ${base ?? '(none — absolute numbers only)'}`);
if (base && readFileSync(base).equals(readFileSync(LAVA_BIN))) {
  console.log('base and new are the same binary: every ratio below is launch noise (A/A).');
}
console.log(`launches: ${LAUNCHES} per binary, interleaved; each number is their median`);

// samples[side][name] = ns/op per launch. failures[side][file] = first error.
const samples = { base: new Map(), new: new Map() };
const failures = { base: new Map(), new: new Map() };
const order = [];
const push = (side, name, v) => {
  if (!samples[side].has(name)) samples[side].set(name, []);
  samples[side].get(name).push(v);
  if (!order.includes(name)) order.push(name);
};

const work = mkdtempSync(join(tmpdir(), 'lava-bench-'));
try {
  const scripts = prepareScripts(benchFiles(), work);
  for (let launch = 0; launch < LAUNCHES; launch++) {
    // Alternate which binary goes first so a box warming up or throttling over the
    // run does not land on one side only.
    const seq = launch % 2 ? [...sides].reverse() : sides;
    for (const { key, bin } of seq) {
      let best = Infinity;
      for (let i = 0; i < STARTUP_REPS; i++) {
        const t0 = performance.now();
        execFileSync(bin, ['run', NOOP], { stdio: 'ignore' });
        best = Math.min(best, performance.now() - t0);
      }
      // Reported in ns like the rest: one op is one process.
      push(key, 'startup', best * 1e6);
    }
    for (const { file, script } of scripts) {
      for (const { key, bin } of seq) {
        if (failures[key].has(file)) continue;
        try {
          for (const r of runScript(bin, script)) push(key, r.name, r.nsPerOp);
        } catch (e) {
          failures[key].set(file, e.message);
        }
      }
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

const thresholds = JSON.parse(readFileSync(join(HERE, 'thresholds.json'), 'utf8'));
const caps = thresholds.caps || {};
const reportOnly = new Set(thresholds.report_only || []);
const capOf = (name) => (reportOnly.has(name) ? null : (caps[name] ?? thresholds.default_cap));

// A name with fewer than LAUNCHES samples came from a file that failed on a later
// launch; its median would be over a different set, so it counts as missing.
const valueOf = (side, name) => {
  const xs = samples[side].get(name);
  return xs && xs.length === LAUNCHES ? median(xs) : null;
};

const fmt = (ns) => {
  if (ns == null) return '-';
  if (ns >= 1e6) return `${(ns / 1e6).toFixed(2)} ms`;
  if (ns >= 1e3) return `${(ns / 1e3).toFixed(2)} us`;
  return `${ns.toFixed(1)} ns`;
};
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

console.log('');
console.log(
  `${pad('benchmark', 26)} ${padL('base /op', 12)} ${padL('new /op', 12)} ${padL('new/base', 9)} ${padL('cap', 6)}`,
);
console.log('-'.repeat(69));

const breaches = [];
const missing = [];
for (const name of order) {
  const b = base ? valueOf('base', name) : null;
  const n = valueOf('new', name);
  const cap = capOf(name);
  let ratio = '-';
  if (n == null) {
    missing.push(name);
  } else if (b != null) {
    const r = n / b;
    ratio = `${r.toFixed(2)}x`;
    if (cap != null && r > cap) breaches.push({ name, r, cap });
  }
  console.log(
    `${pad(name, 26)} ${padL(base ? fmt(b) : '', 12)} ${padL(fmt(n), 12)} ${padL(ratio, 9)} ${padL(cap == null ? '-' : `${cap}x`, 6)}`,
  );
}
console.log('');

for (const [key, map] of Object.entries(failures)) {
  for (const [file, why] of map)
    console.log(`${key} failed on ${file.slice(ROOT.length + 1)}: ${why}`);
}
// A benchmark the base lacks (a new bench file, or an API the base does not have)
// has no ratio: it is new coverage, not a regression, and is shown as '-'.

// A failed bench file on the NEW side is a failure under --gate: a benchmark that
// stops producing numbers must not drop out of the gate by crashing.
let failed = false;
if (missing.length || failures.new.size) {
  const what = [...missing, ...[...failures.new.keys()].map((f) => f.slice(ROOT.length + 1))];
  console.error(
    `benchmark run incomplete — no result from the binary under test for: ${what.join(', ')}`,
  );
  failed = GATE;
}
if (GATE) {
  if (breaches.length) {
    console.error('benchmark gate FAILED — new/base ratio above cap:');
    for (const x of breaches) console.error(`  ${x.name}: ${x.r.toFixed(2)}x > ${x.cap}x`);
    failed = true;
  }
  if (failed) process.exit(1);
  console.log('benchmark gate passed (every new/base ratio within its cap).');
} else {
  console.log('report-only (no gate). `make bench-gate` enforces bench/thresholds.json.');
}
