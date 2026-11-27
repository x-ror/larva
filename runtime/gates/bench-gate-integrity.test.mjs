// Pins the fail-closed paths of `make bench-gate` (bench/run.mjs --gate).
//
// The gate compares two Lava binaries, so these tests stand in for both with a
// fake: a shell script that answers `eval 0` and `run noop.js`, and for any other
// `run <script>` prints one ##BENCH## line named after the script with a fixed
// ns/op. Real binaries would make every assertion depend on timing noise; the fake
// makes the ratio exact (3.00x, 1.00x) so each test fails only for its stated reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const RUN = join(ROOT, 'bench/run.mjs');

function fakeLava(dir, name, nsPerOp, { done = true } = {}) {
  const path = join(dir, name);
  writeFileSync(
    path,
    `#!/bin/sh
[ "$1" = eval ] && exit 0
case "$2" in *noop.js) exit 0 ;; esac
n=$(basename "$2" .js)
echo "##BENCH## {\\"name\\":\\"$n\\",\\"nsPerOp\\":${nsPerOp}}"
${done ? 'echo "##BENCH-DONE##"' : ''}
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function runGate(env) {
  return spawnSync(process.execPath, [RUN, '--gate'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, BENCH_LAUNCHES: '1', BENCH_STARTUP_REPS: '1', ...env },
    timeout: 60_000,
  });
}

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'bench-gate-test-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('bench --gate fails when LAVA_BIN is not runnable', () => {
  withDir((dir) => {
    const r = runGate({
      LAVA_BIN: '/nonexistent/lava-agent-system-probe',
      BASE: fakeLava(dir, 'base', 100),
    });
    assert.notEqual(r.status, 0, `lava not runnable must fail --gate\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /new lava not runnable/);
  });
});

test('bench --gate fails without a baseline', () => {
  withDir((dir) => {
    const r = runGate({ LAVA_BIN: fakeLava(dir, 'new', 100), BASE: 'none' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /needs a baseline/);
  });
});

test('bench --gate fails a benchmark whose new/base ratio exceeds its cap', () => {
  withDir((dir) => {
    const r = runGate({ LAVA_BIN: fakeLava(dir, 'new', 300), BASE: fakeLava(dir, 'base', 100) });
    assert.notEqual(r.status, 0, `3x must breach\n${r.stdout}\n${r.stderr}`);
    // json.js has no override in thresholds.json: the default cap applies to it.
    assert.match(r.stderr, /json: 3\.00x > /);
  });
});

test('bench --gate does not flag a benchmark at 1.00x (control for the breach test)', () => {
  withDir((dir) => {
    const r = runGate({ LAVA_BIN: fakeLava(dir, 'new', 100), BASE: fakeLava(dir, 'base', 100) });
    // `startup` times two real spawns of the fake and may itself be noisy, so only
    // the fixed-ratio rows are asserted.
    assert.doesNotMatch(r.stderr, /json: /);
    assert.doesNotMatch(r.stderr, /no result from the binary under test/);
  });
});

test('bench --gate fails when a bench file never reports ##BENCH-DONE##', () => {
  withDir((dir) => {
    const r = runGate({
      LAVA_BIN: fakeLava(dir, 'new', 100, { done: false }),
      BASE: fakeLava(dir, 'base', 100),
    });
    assert.notEqual(r.status, 0, `a truncated run must fail --gate\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /no result from the binary under test for: .*bench\/micro\/json\.js/);
  });
});
