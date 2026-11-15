// reference/node-compat.json and the GENERATED blocks of reference/node-compatibility.md
// are rendered from the table in gen-matrix.py. Both have drifted from it before: rows
// were hand-edited in the JSON only, and the page went on marking net/http/stream as
// missing after they shipped. `--check` renders without writing and fails on any
// difference, so an edit to either side that skips the generator is caught here.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

test('the committed matrix files are what gen-matrix.py renders', () => {
  const run = spawnSync('python3', [join(HERE, 'gen-matrix.py'), '--check'], { encoding: 'utf8' });
  assert.equal(run.error, undefined, 'python3 must be available to run the generator');
  assert.equal(run.status, 0, run.stdout + run.stderr);
});

test('the scoreboard counts are the tally of the rows', () => {
  const matrix = JSON.parse(readFileSync(join(ROOT, 'reference', 'node-compat.json'), 'utf8'));
  const tally = { full: 0, partial: 0, missing: 0, na: 0 };
  for (const row of matrix.modules) tally[row.status] += 1;
  assert.deepEqual(matrix.counts, tally);
  assert.equal(matrix.modules.length, matrix.generated_against.node_doc_pages);
});
