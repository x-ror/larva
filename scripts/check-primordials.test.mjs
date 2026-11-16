// node:test view of the pollution ratchet's fixtures.
//
// The SAME table also gates the ratchet itself (lib/primordials-fixtures.mjs is
// imported by check-primordials.mjs, which refuses to report on the tree — or to
// rebaseline — when a fixture regresses). That fail-closed property is the point
// and does not move here. What this file adds is what a bespoke runner loop was
// never going to give: one named subtest per fixture, a real diff on failure, and
// `--test-name-pattern` to run a single case while iterating on a detector.
//
// Run: node --test scripts/       (or `make test-scripts`)
//
// These are node:test, not a hand-rolled harness. The repo had no runner for
// `scripts/` and that absence was mistaken for a constraint once; node:test ships
// in the Node the repo already requires, so there was never anything to build.

import test from 'node:test';
import assert from 'node:assert/strict';
import { KINDS, countSource, countFile, walkDir, JS_DIR } from './lib/primordials-detect.mjs';
import { SELF_TEST, E } from './lib/primordials-fixtures.mjs';

test('detector fixtures', async (t) => {
  for (const fixture of SELF_TEST) {
    await t.test(fixture.name, () => {
      const { hits } = countSource(fixture.src, fixture.name, { eager: !fixture.lazy });
      const actual = E();
      for (const h of hits) actual[h.kind]++;
      // Exact per-class counts. An `includes`-style assertion passes while the
      // detector ALSO over-fires, which is how a `length`-in-ACCESSOR regression
      // and a double-count both survived the previous harness.
      assert.deepEqual(
        actual,
        fixture.expect,
        `hits: ${hits.map((h) => `${h.kind}@${h.line} ${h.name}`).join(', ') || 'none'}`,
      );
      if (fixture.expectLine !== undefined && hits.length > 0) {
        assert.equal(hits[0].line, fixture.expectLine, 'line attribution');
      }
    });
  }
});

// Every fixture must be reachable by the class it claims to pin: a table where
// some class has only negatives would let that detector be deleted silently.
test('every class has at least one positive fixture', () => {
  const covered = new Set();
  for (const fixture of SELF_TEST) {
    for (const kind of KINDS) if (fixture.expect[kind] > 0) covered.add(kind);
  }
  assert.deepEqual([...covered].sort(), [...KINDS].sort());
});

// The detector must parse every file it is responsible for. A parse failure is a
// hard error rather than a zero count — a scanner silently reporting 0 sites on a
// file it could not read is the failure mode this tool exists to prevent — so
// this catches a syntax level acorn does not know about before it reaches CI.
test('every scanned file parses', () => {
  const files = walkDir(JS_DIR);
  assert.ok(files.length > 0, 'walkDir found no files to scan');
  for (const file of files) {
    assert.doesNotThrow(() => countFile(file), `${file} did not parse`);
  }
});
