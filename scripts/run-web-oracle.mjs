#!/usr/bin/env node
// `make test-web`: runs every tests/web case under `lava run` and
// compares its stdout byte for byte with the Chrome recording beside it
// (scripts/lib/web-oracle.mjs `judge` decides each verdict).
//
//   node scripts/run-web-oracle.mjs                       # every case
//   node scripts/run-web-oracle.mjs url-parse ...         # only these
//   node scripts/run-web-oracle.mjs --update-known NAME   # re-pin a known gap's Lava output
//
// A Node script rather than a shell runner like run-node-compat-all.sh: the fixture
// server the cases fetch from is the recorder's, in Node, and the run needs it up for
// its whole duration. LAVA_BIN overrides the binary, CASE_TIMEOUT_SEC (default 30)
// bounds one case.
//
// The case is written to a temp file as the one-line prelude (print, ORIGIN) followed
// by the case's own bytes, so a stack line number is the case's own, as in Chrome.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CASES_DIR,
  KNOWN_DIR,
  KNOWN_FILE,
  ROOT,
  areaOf,
  caseFloor,
  formatSnapshot,
  judge,
  lavaPrelude,
  listCases,
  parseExpected,
  parseKnown,
  startServer,
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
// The floor on the case count (lib caseFloor): a deleted case must not turn the
// suite green by vanishing.
if (all.length < caseFloor()) {
  console.error(
    `gate-integrity case-count: ${CASES_DIR} has ${all.length} cases, expected >= ${caseFloor()} (see runtime/gates/case-counts.json)`,
  );
  process.exit(1);
}
for (const n of names) if (!all.includes(n)) die(`no such case: tests/web/cases/${n}.js`);
const known = parseKnown(readFileSync(KNOWN_FILE, 'utf8'));
const problems = suiteProblems(all, known);

const tmp = mkdtempSync(join(tmpdir(), 'larva-web-'));
const server = await startServer();
const results = [];
try {
  for (const name of names.length ? names : all) {
    results.push(await runCase(name));
  }
} finally {
  await server.close();
  rmSync(tmp, { recursive: true, force: true });
}

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
console.log(`web oracle: ${total('pass')} pass, ${total('known')} known, ${failed} fail`);
// exitCode, not process.exit(): exit drops stdout still queued on a non-blocking pipe;
// see the same line in run-dom-oracle.mjs.
process.exitCode = failed ? 1 : 0;

async function runCase(name) {
  const source = readFileSync(join(CASES_DIR, `${name}.js`), 'utf8');
  const file = join(tmp, `${name}.js`);
  writeFileSync(file, lavaPrelude(server.origin) + source);
  const actual = await runLava(file, `${server.origin}/page/${name}`);

  if (update) {
    if (!known.has(name)) die(`${name} is not in known-gaps.txt; only a listed gap is pinned`);
    // A killed run (exit null) is a hang; pinned, it would cost CASE_TIMEOUT_SEC on every run.
    if (actual.code === null) die(`${name} did not finish; a hang is not pinned as a known gap`);
    writeFileSync(join(KNOWN_DIR, `${name}.lava`), formatSnapshot(actual));
    console.log(`pinned ${name} (exit ${actual.code})`);
  }

  let expected = null;
  const recording = join(CASES_DIR, `${name}.expected`);
  if (existsSync(recording)) {
    try {
      expected = parseExpected(readFileSync(recording, 'utf8')).output;
    } catch (e) {
      return { name, verdict: 'fail', detail: `${name}.expected: ${e.message}` };
    }
  }
  const snapshotFile = join(KNOWN_DIR, `${name}.lava`);
  const snapshot = existsSync(snapshotFile) ? readFileSync(snapshotFile, 'utf8') : null;
  return { name, ...judge({ name, expected, actual, known: known.get(name), snapshot }) };
}

// `pageURL` is the URL Chrome loaded the case from (`<origin>/page/<case>` on the
// fixture server), so `location` reads the same on both sides and a page's object URLs
// are minted under the same origin (blob-object-url, location-basic).
function runLava(file, pageURL) {
  return new Promise((resolveRun) => {
    const child = spawn(LAVA, ['run', `--origin=${pageURL}`, file], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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
  console.error(`run-web-oracle: ${msg}`);
  process.exit(2);
}
