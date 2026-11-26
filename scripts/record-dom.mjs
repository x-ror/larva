#!/usr/bin/env node
// Records the DOM oracle: parses each tests/dom case in headless Chrome and writes
// tests/dom/cases/<case>.expected — the tree dump and the serialization
// (scripts/lib/dom-oracle.mjs defines both) under the Window suite's header
// (scripts/lib/web-oracle.mjs formatExpected).
//
//   node scripts/record-dom.mjs                      # every case
//   node scripts/record-dom.mjs void-elements ...    # only these
//   node scripts/record-dom.mjs --jobs 8 html5lib-   # every case with that prefix, 8 at once
//   node scripts/record-dom.mjs --runs 5 --chrome /path/to/chrome
//
// Each case runs --runs times (default 3), each in a fresh Chrome profile, and is
// written only if every run produced the same bytes and the harness threw in none:
// the Window suite's rule (web-oracle.mjs recordVerdict). No virtual time: the
// harness page does all its work in one inline script, before the load event that
// --dump-dom waits for.
//
// --jobs records that many cases side by side (default 1). Each run is still its own
// Chrome in its own profile, so cases share nothing but the server; the html5lib
// corpus (~1800 cases) takes minutes with it instead of a quarter of an hour. A name
// ending in '-' selects every case it prefixes.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CASES_DIR,
  domPage,
  fragmentContext,
  inputProblem,
  listCases,
  splitViews,
} from './lib/dom-oracle.mjs';
import {
  chromeVersion as readChromeVersion,
  formatExpected,
  recordRuns,
  startServer,
} from './lib/web-oracle.mjs';

const args = process.argv.slice(2);
let chrome = process.env.CHROME_BIN || 'google-chrome';
let runs = 3;
let jobs = 1;
const names = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--chrome') chrome = args[++i];
  else if (args[i] === '--runs') runs = Number(args[++i]);
  else if (args[i] === '--jobs') jobs = Number(args[++i]);
  else if (args[i].startsWith('-')) die(`unknown option ${args[i]}`);
  else names.push(args[i]);
}
if (!Number.isInteger(runs) || runs < 1) die('--runs wants a positive integer');
if (!Number.isInteger(jobs) || jobs < 1) die('--jobs wants a positive integer');

const all = listCases();
const selected = [];
for (const n of names) {
  const hit = n.endsWith('-') ? all.filter((c) => c.startsWith(n)) : all.filter((c) => c === n);
  if (hit.length === 0) die(`no such case: tests/dom/cases/${n}${n.endsWith('-') ? '*' : ''}.html`);
  selected.push(...hit);
}
if (names.length === 0) selected.push(...all);

let chromeVersion;
try {
  chromeVersion = readChromeVersion(chrome);
} catch (e) {
  die(e.message);
}

const inputs = new Map();
const pageFor = (name) => {
  const input = inputs.get(name);
  return input === undefined ? null : domPage(name, input, fragmentContext(name));
};

const server = await startServer(CASES_DIR, { pageFor });
const date = new Date().toISOString().slice(0, 10);
let failed = 0;

const recordOne = async (name) => {
  const input = readFileSync(join(CASES_DIR, `${name}.html`));
  const problem = inputProblem(input);
  if (problem) {
    failed++;
    console.error(`FAIL ${name}: the input ${problem}`);
    return;
  }
  inputs.set(name, input);
  const res = await recordRuns(chrome, `${server.origin}/page/${name}`, runs);
  if (!res.error) {
    try {
      splitViews(res.output);
    } catch (e) {
      res.error = `the views cannot be told apart: ${e.message}`;
    }
  }
  if (res.error) {
    failed++;
    console.error(`FAIL ${name}: ${res.error}`);
    return;
  }
  const meta = {
    chrome: chromeVersion,
    date,
    runs,
    command: `node scripts/record-dom.mjs ${runs === 3 ? '' : `--runs ${runs} `}${name}`,
  };
  writeFileSync(join(CASES_DIR, `${name}.expected`), formatExpected(meta, res.output));
  console.log(`recorded ${name} (${res.output.split('\n').length - 1} lines)`);
};

try {
  let next = 0;
  const worker = async () => {
    while (next < selected.length) await recordOne(selected[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(jobs, selected.length) }, worker));
} finally {
  await server.close();
}
console.log(`${chromeVersion}: ${selected.length - failed} recorded, ${failed} failed`);
process.exit(failed ? 1 : 0);

function die(msg) {
  console.error(`record-dom: ${msg}`);
  process.exit(2);
}
