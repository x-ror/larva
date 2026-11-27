#!/usr/bin/env node
// `make test-dom`: parses every tests/dom case with `lava html` and compares each of
// its two views — the html5lib-format tree (--tree) and the serialization
// (--serialize) — byte for byte with the Chrome recording beside it
// (scripts/lib/dom-oracle.mjs defines the views; scripts/lib/web-oracle.mjs `judge`
// decides each verdict, under the Window suite's rules).
//
//   node scripts/run-dom-oracle.mjs                         # every case
//   node scripts/run-dom-oracle.mjs void-elements ...       # only these
//   node scripts/run-dom-oracle.mjs --update-known NAME     # re-pin a known gap's views
//
// A view is the unit: `<case>.tree` and `<case>.serialize` pass, fail and are listed
// in known-gaps.txt apart, so a serializer gap (stage 3b) does not excuse the parse.
// LAVA_BIN overrides the binary, CASE_TIMEOUT_SEC (default 30) bounds one run. Needs
// no Chrome and no server: the recordings are committed and the input is a file.
//
// Cases run DOM_ORACLE_JOBS at a time (default: the machine's parallelism). Each run
// is its own `lava html` process reading its own file, so they share nothing; the
// report is in case order whatever order they finish in. With the html5lib corpus
// (~1800 cases, two runs each) one at a time took ~18 s on 16 cores.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import {
  CASES_DIR,
  DOM_SUITE,
  FLOOR_KEY,
  KNOWN_DIR,
  KNOWN_FILE,
  STAGES,
  VIEWS,
  areaOf,
  fragmentContext,
  handCases,
  isPageCase,
  lavaArgs,
  navCharset,
  listCases,
  splitViews,
  unitsOf,
} from './lib/dom-oracle.mjs';
import {
  ROOT,
  caseFloor,
  formatSnapshot,
  judge,
  parseExpected,
  parseKnown,
  suiteProblems,
} from './lib/web-oracle.mjs';

const args = process.argv.slice(2);
const update = args[0] === '--update-known';
const names = update ? args.slice(1) : args;
if (update && names.length === 0) die('--update-known wants the case names to re-pin');
for (const a of names) if (a.startsWith('-')) die(`unknown option ${a}`);

const LAVA = process.env.LAVA_BIN || join(ROOT, 'bin/lava');
const TIMEOUT_MS = Number(process.env.CASE_TIMEOUT_SEC || 30) * 1000;
if (!existsSync(LAVA)) die(`${LAVA} does not exist; run make build`);

const all = listCases();
// The floor on the case count: a deleted case must not turn the suite green by
// vanishing. Hand cases only; FLOOR_KEY's comment says what holds the generated ones.
const hand = handCases(all);
if (hand.length < caseFloor(FLOOR_KEY)) {
  console.error(
    `gate-integrity case-count: ${CASES_DIR} has ${hand.length} hand-written cases, expected >= ${caseFloor(FLOOR_KEY)} (see runtime/gates/case-counts.json)`,
  );
  process.exit(1);
}
for (const n of names) if (!all.includes(n)) die(`no such case: tests/dom/cases/${n}.html`);
const known = parseKnown(readFileSync(KNOWN_FILE, 'utf8'), STAGES);
if (update) {
  for (const n of names) {
    if (!VIEWS.some((v) => known.has(`${n}.${v}`))) {
      die(`${n} has no view in known-gaps.txt; only a listed gap is pinned`);
    }
  }
}
const problems = suiteProblems(all, known, CASES_DIR, KNOWN_DIR, {
  units: unitsOf(all),
  label: 'tests/dom',
});

const JOBS = Number(process.env.DOM_ORACLE_JOBS) || availableParallelism();
const order = names.length ? names : all;
const perCase = new Array(order.length);
let next = 0;
const worker = async () => {
  while (next < order.length) {
    const i = next++;
    perCase[i] = await runCase(order[i]);
  }
};
await Promise.all(Array.from({ length: Math.min(JOBS, order.length) }, worker));
const results = perCase.flat();

const byArea = new Map();
for (const r of results) {
  const a = byArea.get(areaOf(r.name)) || { pass: 0, known: 0, fail: 0 };
  a[r.verdict]++;
  byArea.set(areaOf(r.name), a);
  if (r.verdict !== 'pass') console.log(`${r.verdict.toUpperCase()} ${r.name}`);
  if (r.verdict === 'fail') console.log(r.detail.replace(/^/gm, '    '));
}
for (const p of problems) console.log(`FAIL ${p}`);
console.log('\narea        pass known fail');
for (const [area, a] of [...byArea].sort()) {
  console.log(`${area.padEnd(11)} ${pad(a.pass)} ${pad(a.known)} ${pad(a.fail)}`);
}
const total = (v) => results.filter((r) => r.verdict === v).length;
const failed = total('fail') + problems.length;
console.log(`dom oracle: ${total('pass')} pass, ${total('known')} known, ${failed} fail`);
process.exit(failed ? 1 : 0);

// Both views of one case, judged apart. A missing recording fails both (judge's rule,
// with the recorder's command for the case rather than the view); one that does not
// split into its views fails both rather than comparing against the wrong bytes.
async function runCase(name) {
  const file = join(CASES_DIR, `${name}.html`);
  const context = fragmentContext(name);
  let expected = null;
  let broken = null;
  const recording = join(CASES_DIR, `${name}.expected`);
  if (!existsSync(recording)) {
    broken = `no Chrome recording; run: ${DOM_SUITE.record} ${name}`;
  } else {
    try {
      expected = splitViews(parseExpected(readFileSync(recording, 'utf8')).output);
    } catch (e) {
      broken = `${name}.expected: ${e.message}`;
    }
  }

  const out = [];
  for (const view of VIEWS) {
    const unit = `${name}.${view}`;
    if (broken) {
      out.push({ name: unit, verdict: 'fail', detail: broken });
      continue;
    }
    const actual = await runLava(lavaArgs(view, context, file, navCharset(name), isPageCase(name)));

    // Only a listed view is pinned; the case's other view must still match Chrome.
    if (update && known.has(unit)) {
      // A killed run (exit null) is a hang; pinned, it would cost CASE_TIMEOUT_SEC every run.
      if (actual.code === null) die(`${unit} did not finish; a hang is not pinned as a known gap`);
      writeFileSync(join(KNOWN_DIR, `${unit}.lava`), formatSnapshot(actual));
      console.log(`pinned ${unit} (exit ${actual.code})`);
    }

    const snapshotFile = join(KNOWN_DIR, `${unit}.lava`);
    const snapshot = existsSync(snapshotFile) ? readFileSync(snapshotFile, 'utf8') : null;
    out.push({
      name: unit,
      ...judge({
        name: unit,
        expected: expected[view],
        actual,
        known: known.get(unit),
        snapshot,
        suite: DOM_SUITE,
      }),
    });
  }
  return out;
}

function runLava(argv) {
  return new Promise((resolveRun) => {
    const child = spawn(LAVA, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      stderr += `\n[killed after ${TIMEOUT_MS} ms]`;
      child.kill('SIGKILL');
    }, TIMEOUT_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveRun({ stdout, stderr, code });
    });
  });
}

function pad(n) {
  return String(n).padStart(4);
}

function die(msg) {
  console.error(`run-dom-oracle: ${msg}`);
  process.exit(2);
}
