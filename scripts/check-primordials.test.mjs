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
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { KINDS, countSource, countFile, walkDir, JS_DIR } from './lib/primordials-detect.mjs';
import { SELF_TEST, E } from './lib/primordials-fixtures.mjs';
import { scanTree } from './lib/primordials-scan.mjs';

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

// The detector fixtures above pass `eager` in by hand, so they cannot see the
// ratchet's own eager/lazy classification — lib/primordials-scan.mjs's `isEager`
// over lib/js-graph.mjs's `eagerModules`. That path used to be pinned only by the
// real tree: a mutant scoring every module eager re-exempted some lazy module's
// module-eval capture and the baseline comparison caught it. Once #430 left no
// lazy module with such a capture, the mutant changed no count and survived. A
// fixture tree keeps the classification honest whatever the real tree holds: the
// loader's top-level req() makes one module eager, a second is reached by nothing
// the loader runs, and both open with the same `var S = String;`.
test('ratchet scan: a lazy module-eval capture counts as global, an eager one does not', () => {
  const root = mkdtempSync(join(tmpdir(), 'primordials-scan-'));
  const files = {
    'pkg/runtime/js/bootstrap/loader.js':
      "(function () { var S = String; function req(name) { return name; } req('internal/eager'); return req; });",
    'pkg/runtime/js/internal/eager.js':
      '(function (require, module) { var S = String; module.exports = S; });',
    'pkg/runtime/js/internal/lazy.js':
      '(function (require, module) { var S = String; module.exports = S; });',
  };
  try {
    for (const [rel, src] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), src);
    }
    const { counts } = scanTree(root);
    assert.deepEqual(Object.keys(counts).sort(), [
      'bootstrap/loader.js',
      'internal/eager.js',
      'internal/lazy.js',
    ]);
    assert.equal(
      counts['internal/lazy.js'].global,
      1,
      'eager classification: lazy module internal/lazy.js scored as eager',
    );
    assert.equal(
      counts['internal/eager.js'].global,
      0,
      'eager module internal/eager.js scored as lazy',
    );
    assert.equal(counts['bootstrap/loader.js'].global, 0, 'bootstrap/loader.js scored as lazy');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The CLI itself must report. It once sat behind an "am I the entry point?" guard
// so this file could import its scan, and that guard failed OPEN: run through a
// symlink, argv[1] no longer matched import.meta.url, the body never ran, and the
// gate exited 0 having printed nothing. The scan now lives in lib/ and the CLI has
// no guard; this pins both the plain invocation and the symlinked one, since an
// exit code alone cannot tell "checked and passed" from "never checked".
test('ratchet CLI reports OK on the real tree, also when invoked through a symlink', () => {
  const cli = join(import.meta.dirname, 'check-primordials.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'primordials-cli-'));
  try {
    const link = join(dir, 'check-primordials.mjs');
    symlinkSync(cli, link);
    for (const [how, path] of [
      ['direct path', cli],
      ['symlink', link],
    ]) {
      const r = spawnSync(process.execPath, [path], { encoding: 'utf8' });
      assert.equal(r.status, 0, `ratchet CLI (${how}) exited ${r.status}: ${r.stderr}`);
      assert.match(
        r.stdout,
        /^OK: pollution ratchet holds/m,
        `ratchet CLI (${how}) did not print its OK line; stdout: ${JSON.stringify(r.stdout)}`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
