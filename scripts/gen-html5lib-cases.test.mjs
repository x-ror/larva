// Tests for the html5lib corpus generator (scripts/gen-html5lib-cases.mjs): the .dat
// reader, the case names it gives, what it leaves out and why, the drift check that
// keeps tests/dom/cases in step with the vendored inputs, and the cross-check's
// normalisation of html5lib's sorted attributes. A gate script: the drift check is what
// stops a hand edit to a generated case — or a .dat update nobody regenerated — from
// being recorded and passed as if it were the corpus.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CASE_PREFIX,
  caseName,
  crossCheck,
  driftProblems,
  generate,
  parseDat,
  readDats,
  sortAttributes,
} from './gen-html5lib-cases.mjs';
import { CASES_DIR, fragmentContext } from './lib/dom-oracle.mjs';
import { caseFloor } from './lib/web-oracle.mjs';

const DAT = [
  '#data',
  '<p>One<p>Two',
  '#errors',
  '(1,3): expected-doctype-but-got-start-tag',
  '#document',
  '| <html>',
  '|   <head>',
  '|   <body>',
  '|     <p>',
  '|       "One"',
  '',
  '#data',
  'a',
  '',
  'b',
  '#errors',
  '#new-errors',
  '(1:1) x',
  '#document-fragment',
  'svg desc',
  '#script-off',
  '#document',
  '| "a',
  '',
  'b"',
  '',
  '#data',
  '<noscript>x',
  '#errors',
  '#script-on',
  '#document',
  '| <html>',
  '',
].join('\n');

test('a .dat file reads into its tests, the data without its final newline', () => {
  const tests = parseDat(DAT);
  assert.equal(tests.length, 3);
  assert.equal(tests[0].data, '<p>One<p>Two');
  assert.equal(tests[0].fragment, null);
  assert.equal(tests[0].script, null);
  assert.equal(tests[0].document, '| <html>\n|   <head>\n|   <body>\n|     <p>\n|       "One"\n');
  // A blank line inside the data or inside a text node is data, not a test boundary.
  assert.equal(tests[1].data, 'a\n\nb');
  assert.equal(tests[1].fragment, 'svg desc');
  assert.equal(tests[1].script, 'off');
  assert.equal(tests[1].document, '| "a\n\nb"\n');
  assert.equal(tests[2].script, 'on');
});

test('a .dat file that breaks the format is refused, not half read', () => {
  assert.throws(() => parseDat('#data\nx\n#document\n| <html>\n'), /no #errors/);
  assert.throws(() => parseDat('#data\nx\n#errors\n'), /no #document/);
  assert.throws(() => parseDat('| <html>\n'), /before the first #data/);
});

test('a case is named after its file and its 1-based place there', () => {
  assert.equal(caseName('tests1.dat', 0, null), `${CASE_PREFIX}tests1-001`);
  assert.equal(
    caseName('tests_innerHTML_1.dat', 41, 'td'),
    `${CASE_PREFIX}tests_innerhtml_1-042.frag-td`,
  );
  assert.equal(
    caseName('math.dat', 2, 'math annotation-xml'),
    `${CASE_PREFIX}math-003.frag-math-annotation-xml`,
  );
  // The runner reads the context back out of the name, namespace and all.
  assert.equal(fragmentContext(caseName('svg.dat', 0, 'svg foreignObject')), 'svg foreignObject');
  assert.equal(fragmentContext(caseName('x.dat', 0, 'tbody')), 'tbody');
});

test('scripting-on tests are left out with the reason, and numbering does not shift', () => {
  const { cases, skipped } = generate(new Map([['x.dat', DAT]]));
  assert.deepEqual([...cases.keys()], [`${CASE_PREFIX}x-001`, `${CASE_PREFIX}x-002.frag-svg-desc`]);
  assert.equal(cases.get(`${CASE_PREFIX}x-002.frag-svg-desc`).toString('utf8'), 'a\n\nb');
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].name, `${CASE_PREFIX}x-003`);
  assert.match(skipped[0].reason, /scripting/);
});

test('an input the recorder cannot hand Chrome unchanged is left out with the reason', () => {
  const { cases, skipped } = generate(
    new Map([['b.dat', '#data\n﻿x\n#errors\n#document\n| <html>\n']]),
  );
  assert.equal(cases.size, 0);
  assert.match(skipped[0].reason, /BOM/);
});

test('drift: a missing, an extra and a changed case are each reported', () => {
  const dir = mkdtempSync(join(tmpdir(), 'larva-html5lib-drift-'));
  try {
    const gen = new Map([
      [`${CASE_PREFIX}x-001`, Buffer.from('<p>')],
      [`${CASE_PREFIX}x-002`, Buffer.from('<b>')],
    ]);
    writeFileSync(join(dir, `${CASE_PREFIX}x-002.html`), '<i>');
    writeFileSync(join(dir, `${CASE_PREFIX}x-009.html`), '<u>');
    writeFileSync(join(dir, `${CASE_PREFIX}x-009.expected`), 'orphan');
    writeFileSync(join(dir, 'hand-case.html'), 'not ours');
    const problems = driftProblems(gen, dir).join('\n');
    assert.match(problems, /x-001\.html is missing/);
    assert.match(problems, /x-002\.html differs/);
    assert.match(problems, /x-009\.html is not generated/);
    assert.doesNotMatch(problems, /hand-case/);
    // The orphan x-009 is reported once for its input and once for its recording.
    assert.deepEqual(
      driftProblems(new Map([[`${CASE_PREFIX}x-002`, Buffer.from('<i>')]]), dir).length,
      2,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the committed corpus cases are exactly what the vendored .dat files generate', () => {
  const problems = driftProblems(generate().cases, CASES_DIR);
  assert.deepEqual(problems, [], 'run: node scripts/gen-html5lib-cases.mjs');
  // The exact set protects the cases; this floor protects the inputs, without which an
  // emptied tests/dom/html5lib would generate, and so expect, nothing.
  const floor = caseFloor('tests/dom/html5lib');
  assert.ok(
    readDats().size >= floor,
    `tests/dom/html5lib has ${readDats().size} .dat files, floor ${floor}`,
  );
});

test("the cross-check sorts our element-order attributes as html5lib's format does", () => {
  const ours = [
    '| <p>',
    '|   z="1"',
    '|   a="2"',
    '|   "t"',
    '| <svg svg>',
    '|   xlink href="h"',
    '|   b="c"',
    '',
  ].join('\n');
  assert.equal(
    sortAttributes(ours),
    [
      '| <p>',
      '|   a="2"',
      '|   z="1"',
      '|   "t"',
      '| <svg svg>',
      '|   b="c"',
      '|   xlink href="h"',
      '',
    ].join('\n'),
  );
  const tests = [{ name: 'a', document: '| <p>\n|   a="2"\n|   z="1"\n' }];
  assert.deepEqual(
    crossCheck(tests, () => '| <p>\n|   z="1"\n|   a="2"\n'),
    { agree: ['a'], differ: [], unrecorded: [] },
  );
  assert.deepEqual(
    crossCheck(tests, () => '| <p>\n'),
    { agree: [], differ: ['a'], unrecorded: [] },
  );
  assert.deepEqual(
    crossCheck(tests, () => null),
    { agree: [], differ: [], unrecorded: ['a'] },
  );
});

test('the vendored inputs carry their MIT licence', () => {
  assert.match(
    readFileSync(join(CASES_DIR, '../html5lib/LICENSE'), 'utf8'),
    /Permission is hereby granted, free of charge/,
  );
});
