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
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { KINDS, countSource, countFile, walkDir, JS_DIR, ROOT } from './lib/primordials-detect.mjs';
import { SELF_TEST, E } from './lib/primordials-fixtures.mjs';
import { scanTree } from './lib/primordials-scan.mjs';
import { totals } from './lib/primordials-baseline.mjs';

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
//
// Nor can the OK line by itself: a CLI that printed a bare OK passed this test
// too. What this test pins is narrow: the figures in the OK line equal what this
// process scans off the same tree. The real tree is clean and the fixtures pass, so
// no failing branch is reached here; a CLI that echoes the baseline's own totals
// instead of scanning (equal on a passing tree by definition), skips selfTest(), or
// skips compare() passes it. Those three are pinned by the sandbox tests below:
// "...fails and names the file when a scanned module gains a site" (echo, compare)
// and "...refuses to report when its self-test fails" (selfTest).
//
// The spawn is bounded so a hung CLI fails this test by name rather than hanging the
// suite: the CLI takes ~0.2 s wall here (`time`, three runs), so 60 s only trips on a
// real hang.
const SPAWN_TIMEOUT_MS = 60_000;
function run(label, bin, args) {
  // SIGKILL, not the default SIGTERM: a child that traps SIGTERM outlives the timeout
  // and spawnSync waits on it, so the bound would not bound anything (measured: a
  // SIGTERM-trapping child with an 8 s sleep held a 500 ms timeout for 8020 ms; with
  // SIGKILL it returned ETIMEDOUT at 504 ms).
  const r = spawnSync(bin, args, {
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  // The error first: a timeout AND an overflowed maxBuffer (ENOBUFS) both kill the
  // child with SIGTERM, so reading the signal alone misnames the second as an outside
  // kill. ENOENT passes through untouched, for the caller's own missing-binary message.
  if (r.error && r.error.code !== 'ENOENT') {
    assert.fail(
      r.error.code === 'ETIMEDOUT'
        ? `${label} timed out after ${SPAWN_TIMEOUT_MS} ms`
        : `${label} failed to run: ${r.error.code ?? r.error.message}`,
    );
  }
  assert.equal(r.signal, null, `${label} was killed by ${r.signal}`);
  return r;
}

test('ratchet CLI reports OK on the real tree, also when invoked through a symlink', () => {
  const cli = join(import.meta.dirname, 'check-primordials.mjs');
  const { perKind, total } = totals(scanTree(ROOT).counts);
  const okLine = `OK: pollution ratchet holds (${total} sites: ${KINDS.map((k) => `${k} ${perKind[k]}`).join(', ')}).`;
  const dir = mkdtempSync(join(tmpdir(), 'primordials-cli-'));
  try {
    const link = join(dir, 'check-primordials.mjs');
    symlinkSync(cli, link);
    for (const [how, path] of [
      ['direct path', cli],
      ['symlink', link],
    ]) {
      const r = run(`ratchet CLI (${how})`, process.execPath, [path]);
      assert.equal(r.status, 0, `ratchet CLI (${how}) exited ${r.status}: ${r.stderr}`);
      assert.match(
        r.stdout,
        /^OK: pollution ratchet holds/m,
        `ratchet CLI (${how}) did not print its OK line; stdout: ${JSON.stringify(r.stdout)}`,
      );
      assert.ok(
        r.stdout.split('\n').includes(okLine),
        `ratchet CLI (${how}) OK line does not report the in-process scan; want ${JSON.stringify(okLine)}, stdout: ${JSON.stringify(r.stdout)}`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The spawn above runs on the real tree, which is clean and whose fixtures pass, so
// no failing branch of the CLI is ever reached there: a CLI that skipped selfTest(),
// skipped compare(), or skipped the scan and echoed the baseline's own totals (equal
// to the scan on a passing tree, by definition) passed it. These drive those branches
// through the REAL CLI source rather than a root override on it: ROOT is derived from
// the CLI's own location (lib/primordials-detect.mjs), so a copy of the CLI, its lib/,
// the baseline and the scanned tree inside a scratch dir scans that copy. Copied at
// test time from the working tree, so a mutated check-primordials.mjs is what runs;
// node_modules is symlinked in so acorn resolves.
function ratchetSandbox() {
  const repo = join(import.meta.dirname, '..');
  // Without installed deps the symlink below dangles, the copied CLI dies resolving
  // acorn, and the tests fail on a missing "+1" line that says nothing about why.
  assert.ok(
    existsSync(join(repo, 'node_modules', 'acorn')),
    'sandbox needs installed deps: node_modules/acorn missing — run bun install',
  );
  const root = mkdtempSync(join(tmpdir(), 'primordials-sandbox-'));
  // The caller's finally only exists once this returns; a failed copy (EACCES,
  // ENOSPC) would otherwise leave the temp dir behind.
  try {
    for (const rel of [
      'scripts/check-primordials.mjs',
      'scripts/lib',
      'pkg/runtime/js',
      'tests/node-compat/pollution-baseline.json',
    ]) {
      cpSync(join(repo, rel), join(root, rel), { recursive: true });
    }
    symlinkSync(join(repo, 'node_modules'), join(root, 'node_modules'));
  } catch (err) {
    rmSync(root, { recursive: true, force: true });
    throw err;
  }
  return { root, cli: join(root, 'scripts', 'check-primordials.mjs') };
}

// One pollutable method call added to a lazy module must fail the CLI and name the
// file. A CLI that echoes the baseline instead of scanning, or never runs compare(),
// exits 0 with its OK line here.
test('ratchet CLI fails and names the file when a scanned module gains a site', () => {
  const { root, cli } = ratchetSandbox();
  try {
    const key = 'node/net.js';
    const base = JSON.parse(
      readFileSync(join(root, 'tests', 'node-compat', 'pollution-baseline.json'), 'utf8'),
    )[key].method;
    appendFileSync(
      join(root, 'pkg', 'runtime', 'js', key),
      '\nfunction injectedRatchetSite(a) { return a.push(1); }\n',
    );
    const r = run('ratchet CLI (sandbox, +1 site)', process.execPath, [cli]);
    assert.doesNotMatch(
      r.stdout,
      /^OK: pollution ratchet holds/m,
      `ratchet CLI printed OK over a tree with a new site; stdout: ${JSON.stringify(r.stdout)}`,
    );
    assert.equal(r.status, 1, `ratchet CLI exited ${r.status} over a tree with a new site`);
    assert.ok(
      r.stderr.includes(`${key}: ${base + 1} method sites, baseline ${base} (+1):`),
      `ratchet CLI did not report ${key} +1 method; stderr: ${JSON.stringify(r.stderr)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A detector whose self-test fails must not report on the tree. The sandbox's
// fixtures are replaced by a stub with the same exports whose selfTest() fails; a CLI
// that skips selfTest() scans the clean copy and prints OK.
test('ratchet CLI refuses to report when its self-test fails', () => {
  const { root, cli } = ratchetSandbox();
  try {
    writeFileSync(
      join(root, 'scripts', 'lib', 'primordials-fixtures.mjs'),
      'export const E = () => ({});\nexport const WRAP = (s) => s;\nexport const SELF_TEST = [];\n' +
        "export function selfTest() { return ['injected detector failure']; }\n",
    );
    const r = run('ratchet CLI (sandbox, failing self-test)', process.execPath, [cli]);
    assert.doesNotMatch(
      r.stdout,
      /^OK: pollution ratchet holds/m,
      `ratchet CLI printed OK with a failing self-test; stdout: ${JSON.stringify(r.stdout)}`,
    );
    assert.equal(r.status, 1, `ratchet CLI exited ${r.status} with a failing self-test`);
    assert.match(
      r.stderr,
      /SELF-TEST FAILED/,
      `no SELF-TEST FAILED; stderr: ${JSON.stringify(r.stderr)}`,
    );
    assert.match(r.stderr, /injected detector failure/, 'self-test failure text not reported');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
