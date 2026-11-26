#!/usr/bin/env node
// Records the Window-profile oracle: runs each tests/web case in headless Chrome and
// writes tests/web/cases/<case>.expected with the Chrome version, the date and the
// command that re-records it (scripts/lib/web-oracle.mjs owns the format).
//
//   node scripts/record-chrome.mjs                 # every case
//   node scripts/record-chrome.mjs url-parse ...   # only these
//   node scripts/record-chrome.mjs --runs 5 --chrome /path/to/chrome
//
// Each case runs --runs times (default 3), each in a fresh Chrome profile, and is
// written only if every run printed the same bytes and none raised a page error or an
// unhandled rejection. A flaky case is reported, never recorded: the #96 clearTimeout
// recording showed one Chrome answer flip with the case's position in the page.
//
// Completion is Chrome's virtual time (--virtual-time-budget): timers fast-forward
// and the DOM is dumped once the budget is spent, the closest Chrome has to Lava
// running a script until its loop is idle. A case must therefore end on its own — a
// timer that never stops would print until the budget, not the same thing twice.

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CASES_DIR,
  caseOptions,
  formatExpected,
  listCases,
  readSink,
  startServer,
} from './lib/web-oracle.mjs';

const args = process.argv.slice(2);
let chrome = process.env.CHROME_BIN || 'google-chrome';
let runs = 3;
const names = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--chrome') chrome = args[++i];
  else if (args[i] === '--runs') runs = Number(args[++i]);
  else if (args[i].startsWith('-')) die(`unknown option ${args[i]}`);
  else names.push(args[i]);
}
if (!Number.isInteger(runs) || runs < 1) die('--runs wants a positive integer');

const all = listCases();
for (const n of names) if (!all.includes(n)) die(`no such case: tests/web/cases/${n}.js`);
const selected = names.length ? names : all;

const version = spawnSync(chrome, ['--version'], { encoding: 'utf8' });
if (version.status !== 0) die(`cannot run ${chrome} --version (set CHROME_BIN or --chrome)`);
const chromeVersion = version.stdout.trim();

// Virtual time, not wall time. 60 s covers the slowest case (a 1100-turn timer chain
// at Chrome's 4 ms nesting clamp); the wall-clock guard is for a Chrome that hangs.
const BUDGET_MS = 60_000;
const WALL_TIMEOUT_MS = 120_000;

function runChrome(url, profile, realTimeMs) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      chrome,
      [
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        '--no-first-run',
        '--disable-extensions',
        `--user-data-dir=${profile}`,
        ...(realTimeMs ? [] : [`--virtual-time-budget=${BUDGET_MS}`]),
        '--dump-dom',
        url,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let dom = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => (dom += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), WALL_TIMEOUT_MS);
    child.on('error', rejectRun);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return rejectRun(new Error(`chrome exited ${code ?? 'on a signal'}`));
      resolveRun(dom);
    });
  });
}

async function recordOne(origin, name) {
  const { realTimeMs } = caseOptions(readFileSync(join(CASES_DIR, `${name}.js`), 'utf8'));
  const outputs = [];
  for (let r = 0; r < runs; r++) {
    const profile = mkdtempSync(join(tmpdir(), 'larva-web-oracle-'));
    try {
      let dom;
      try {
        dom = await runChrome(`${origin}/page/${name}`, profile, realTimeMs);
      } catch (e) {
        return { error: `run ${r + 1}: ${e.message}` };
      }
      const out = readSink(dom, 'out');
      const err = readSink(dom, 'err');
      if (out === null) return { error: 'no #out in the dumped DOM (did the page load?)' };
      if (err) return { error: `page error in run ${r + 1}:\n${err}` };
      outputs.push(out);
    } finally {
      rmSync(profile, { recursive: true, force: true });
    }
  }
  for (let r = 1; r < runs; r++) {
    if (outputs[r] !== outputs[0]) return { error: `run ${r + 1} differs from run 1 (flaky)` };
  }
  return { output: outputs[0] };
}

const server = await startServer();
const date = new Date().toISOString().slice(0, 10);
let failed = 0;
try {
  for (const name of selected) {
    const res = await recordOne(server.origin, name);
    if (res.error) {
      failed++;
      console.error(`FAIL ${name}: ${res.error}`);
      continue;
    }
    const meta = {
      chrome: chromeVersion,
      date,
      runs,
      command: `node scripts/record-chrome.mjs ${name}`,
    };
    writeFileSync(join(CASES_DIR, `${name}.expected`), formatExpected(meta, res.output));
    console.log(`recorded ${name} (${res.output.split('\n').length - 1} lines)`);
  }
} finally {
  await server.close();
}
console.log(`${chromeVersion}: ${selected.length - failed} recorded, ${failed} failed`);
process.exit(failed ? 1 : 0);

function die(msg) {
  console.error(`record-chrome: ${msg}`);
  process.exit(2);
}
