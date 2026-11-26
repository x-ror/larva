#!/usr/bin/env node
// Generates the html5lib part of the DOM oracle (tests/dom, stage 3b of docs/LARVA.md)
// from the vendored html5lib-tests tree-construction inputs in tests/dom/html5lib/.
//
//   node scripts/gen-html5lib-cases.mjs                 # (re)write tests/dom/cases/html5lib-*.html
//   node scripts/gen-html5lib-cases.mjs --check         # fail when the committed cases drift
//   node scripts/gen-html5lib-cases.mjs --cross-check   # Chrome's trees vs html5lib's own
//
// Each test becomes one case, `html5lib-<file>-<NNN>.html` — its #data, byte for byte —
// or `html5lib-<file>-<NNN>.frag-<context>.html` when it has a #document-fragment
// context (`svg desc` names as `frag-svg-desc`). NNN is the test's 1-based place in its
// file, so a left-out test does not renumber the rest. The recording is Chrome's, made
// by scripts/record-dom.mjs like any other case: html5lib's expected trees are NOT the
// expectation (CLAUDE.md §6; docs/LARVA.md decision 1). They serve only --cross-check,
// which reports where Chrome and html5lib disagree, for whoever reads a failing case.
//
// Left out, with the reason printed on every run:
//   - #script-on tests: Chrome records through DOMParser, whose documents have
//     scripting disabled, so it cannot produce a scripting-on parse. Stage 4 pages
//     parse with scripting on; their oracle is a navigation, not this suite.
//   - inputs the recorder refuses (inputProblem in scripts/lib/dom-oracle.mjs).
//   - tree-construction/scripted/ was not vendored: those tests run script.
// The output and the vendored inputs are both committed; scripts/gen-html5lib-cases.test.mjs
// runs --check's comparison, so an edited case or an un-regenerated input fails there.

import { readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CASES_DIR,
  GENERATED_PREFIX,
  inputProblem,
  listCases,
  splitViews,
} from './lib/dom-oracle.mjs';
import { ROOT, parseExpected } from './lib/web-oracle.mjs';

export const DAT_DIR = join(ROOT, 'tests/dom/html5lib');
// The prefix every generated case name starts with (scripts/lib/dom-oracle.mjs).
export const CASE_PREFIX = GENERATED_PREFIX;

// The section lines of a test (tree-construction/README.md); anything else is content.
const SECTIONS = new Set([
  '#data',
  '#errors',
  '#new-errors',
  '#document-fragment',
  '#script-off',
  '#script-on',
  '#document',
]);

/**
 * Reads one .dat file into its tests: `{data, fragment, script, document}`, where
 * `fragment` is the #document-fragment context or null, `script` 'on', 'off' or null,
 * and `document` the expected dump with its lines' newlines. A test starts at a
 * `#data` line at the top of the file or after a blank line; a blank line anywhere
 * else is content (a text node or an input may hold one). Throws on a test missing
 * #errors or #document, rather than reading a broken file as fewer tests.
 */
export function parseDat(text) {
  const lines = text.split('\n');
  const tests = [];
  let cur = null;
  let section = null;
  const close = () => {
    if (!cur) return;
    if (!cur.seen.has('#errors')) throw new Error(`test ${tests.length + 1}: no #errors`);
    if (!cur.seen.has('#document')) throw new Error(`test ${tests.length + 1}: no #document`);
    // The data loses only its final newline (the line break before #errors). The
    // document's last line is followed by the blank separator line, which is not
    // part of it.
    let doc = cur.document;
    while (doc.length && doc[doc.length - 1] === '') doc = doc.slice(0, -1);
    tests.push({
      data: cur.data.join('\n'),
      fragment: cur.fragment,
      script: cur.script,
      document: doc.map((l) => l + '\n').join(''),
    });
    cur = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === '#data' && (i === 0 || lines[i - 1] === '')) {
      close();
      cur = { data: [], document: [], fragment: null, script: null, seen: new Set(['#data']) };
      section = '#data';
      continue;
    }
    if (!cur) {
      if (line === '') continue;
      throw new Error(`line ${i + 1}: content before the first #data`);
    }
    // In the data, only #errors ends it: an input line may look like any section.
    if (section === '#data' ? line === '#errors' : SECTIONS.has(line) && section !== '#document') {
      section = line;
      cur.seen.add(line);
      if (line === '#script-on') cur.script = 'on';
      if (line === '#script-off') cur.script = 'off';
      continue;
    }
    if (section === '#data') cur.data.push(line);
    else if (section === '#document-fragment' && cur.fragment === null) cur.fragment = line;
    else if (section === '#document') cur.document.push(line);
  }
  close();
  return tests;
}

/**
 * The case name of the `index`th (0-based) test of `file`. A context in html5lib's
 * notation (`svg desc`) becomes `frag-svg-desc`; fragmentContext in
 * scripts/lib/dom-oracle.mjs reads it back.
 */
export function caseName(file, index, fragment) {
  const stem = file.replace(/\.dat$/, '').toLowerCase();
  const base = `${CASE_PREFIX}${stem}-${String(index + 1).padStart(3, '0')}`;
  return fragment === null ? base : `${base}.frag-${fragment.replace(' ', '-')}`;
}

/** The vendored .dat files, name → text, in name order. */
export function readDats(dir = DAT_DIR) {
  return new Map(
    readdirSync(dir)
      .filter((f) => f.endsWith('.dat'))
      .sort()
      .map((f) => [f, readFileSync(join(dir, f), 'utf8')]),
  );
}

/**
 * Every case the .dat files make, name → input bytes, and every test left out with
 * its reason.
 */
export function generate(dats = readDats()) {
  const cases = new Map();
  const skipped = [];
  const tests = [];
  for (const [file, text] of dats) {
    parseDat(text).forEach((t, i) => {
      const name = caseName(file, i, t.fragment);
      const bytes = Buffer.from(t.data, 'utf8');
      tests.push({ name, ...t });
      if (t.script === 'on') {
        skipped.push({ name, reason: 'needs scripting on; a DOMParser document has it off' });
        return;
      }
      const problem = inputProblem(bytes);
      if (problem) {
        skipped.push({ name, reason: `the input ${problem}` });
        return;
      }
      if (cases.has(name)) throw new Error(`${file}: two tests name ${name}`);
      cases.set(name, bytes);
    });
  }
  return { cases, skipped, tests };
}

/**
 * How `dir` differs from the generated `cases`: a case missing or with other bytes,
 * and a committed html5lib case (input or recording) the generator does not make.
 * Hand-written cases (no html5lib prefix) are not the generator's business.
 */
export function driftProblems(cases, dir = CASES_DIR) {
  const problems = [];
  const present = new Set(readdirSync(dir));
  for (const [name, bytes] of cases) {
    const file = `${name}.html`;
    if (!present.has(file)) problems.push(`${file} is missing`);
    else if (!readFileSync(join(dir, file)).equals(bytes))
      problems.push(`${file} differs from its .dat test`);
  }
  for (const file of [...present].sort()) {
    if (!file.startsWith(CASE_PREFIX)) continue;
    const name = file.replace(/\.(html|expected)$/, '');
    if (!cases.has(name)) problems.push(`${file} is not generated by any vendored test`);
  }
  return problems;
}

/**
 * html5lib's dump sorts each element's attributes by name; ours keeps them in
 * element order (dumpTree's one departure). Sorts every run of attribute lines so
 * the two can be compared. An item is a `| ` line with the lines up to the next one
 * (a text node or a value may span lines); an attribute item is one whose content
 * after the indent is not an element, a text, a comment, a doctype or `content`.
 */
export function sortAttributes(dump) {
  // Every line ends in '\n'; split on the content only, so the last item does not
  // carry the final newline into a sort.
  const trailing = dump.endsWith('\n');
  const items = [];
  for (const line of (trailing ? dump.slice(0, -1) : dump).split('\n')) {
    if (line.startsWith('| ') || items.length === 0) items.push(line);
    else items[items.length - 1] += '\n' + line;
  }
  const isAttr = (item) => {
    const body = item.slice(2).trimStart();
    return (
      !(body.startsWith('<') || body.startsWith('"') || body === 'content') && body.includes('="')
    );
  };
  const indent = (item) => item.length - item.slice(2).trimStart().length;
  const key = (item) => item.slice(2).trimStart().split('="')[0];
  const out = [];
  for (let i = 0; i < items.length;) {
    if (!isAttr(items[i])) {
      out.push(items[i++]);
      continue;
    }
    const run = [];
    const depth = indent(items[i]);
    while (i < items.length && isAttr(items[i]) && indent(items[i]) === depth) run.push(items[i++]);
    run.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    out.push(...run);
  }
  return out.join('\n') + (trailing ? '\n' : '');
}

/**
 * Compares Chrome's recorded tree (`recorded(name)`, null when there is none) with
 * html5lib's expected one, attributes sorted on both sides. Fragment tests compare
 * the same way: html5lib dumps the context element's children, as our view does.
 */
export function crossCheck(tests, recorded) {
  const result = { agree: [], differ: [], unrecorded: [] };
  for (const t of tests) {
    const tree = recorded(t.name);
    if (tree === null) result.unrecorded.push(t.name);
    else if (sortAttributes(tree) === sortAttributes(t.document)) result.agree.push(t.name);
    else result.differ.push(t.name);
  }
  return result;
}

function recordedTree(name) {
  try {
    const text = readFileSync(join(CASES_DIR, `${name}.expected`), 'utf8');
    return splitViews(parseExpected(text).output).tree;
  } catch {
    return null;
  }
}

function main(args) {
  const { cases, skipped, tests } = generate();
  if (args[0] === '--check') {
    const problems = driftProblems(cases);
    for (const p of problems) console.error(`drift: ${p}`);
    console.log(`html5lib: ${cases.size} cases, ${problems.length} drifted`);
    return problems.length ? 1 : 0;
  }
  if (args[0] === '--cross-check') {
    const r = crossCheck(
      tests.filter((t) => cases.has(t.name)),
      recordedTree,
    );
    for (const n of r.differ) console.log(`differ ${n}`);
    console.log(
      `html5lib vs Chrome trees: ${r.agree.length} agree, ${r.differ.length} differ, ${r.unrecorded.length} unrecorded`,
    );
    return 0;
  }
  if (args.length) {
    console.error(`gen-html5lib-cases: unknown argument ${args[0]}`);
    return 2;
  }
  // Remove what the corpus no longer makes, inputs and recordings alike, then write.
  for (const name of listCases()) {
    if (name.startsWith(CASE_PREFIX) && !cases.has(name)) {
      for (const ext of ['.html', '.expected']) {
        try {
          unlinkSync(join(CASES_DIR, name + ext));
        } catch {}
      }
    }
  }
  for (const [name, bytes] of cases) writeFileSync(join(CASES_DIR, `${name}.html`), bytes);
  for (const s of skipped) console.log(`left out ${s.name}: ${s.reason}`);
  console.log(`html5lib: ${cases.size} cases written, ${skipped.length} left out`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
