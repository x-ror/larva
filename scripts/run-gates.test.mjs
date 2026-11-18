// Tests for scripts/run-gates.mjs (#360): verifies honest exit-code propagation,
// stop-on-first-failure behavior, and path routing via route-gates.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = join(ROOT, 'scripts/run-gates.mjs');

function runRunner(args) {
  return spawnSync(process.execPath, [RUNNER, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 15_000,
  });
}

test('stops at the first failing target and exits non-zero', () => {
  const targets = [
    `${process.execPath} -e "process.exit(0)"`,
    `${process.execPath} -e "process.exit(7)"`,
    `${process.execPath} -e "console.log('MUST_NOT_RUN')"`,
  ].join(',');
  const r = runRunner([`--targets=${targets}`]);
  assert.equal(r.status, 7, `expected exit 7, got ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /FAIL/);
  assert.doesNotMatch(r.stdout, /MUST_NOT_RUN/, 'must stop at the first failing gate');
});

test('runs all targets and exits 0 when every target passes', () => {
  const targets = [
    `${process.execPath} -e "console.log('first-ok')"`,
    `${process.execPath} -e "console.log('second-ok')"`,
  ].join(',');
  const r = runRunner([`--targets=${targets}`]);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /first-ok/);
  assert.match(r.stdout, /second-ok/);
  assert.match(r.stdout, /PASS/);
  assert.doesNotMatch(r.stdout, /FAIL/);
});

test('--dry-run routes changed paths through route-gates.mjs', () => {
  const r = runRunner(['--dry-run', 'README.md']);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /^make check-md$/m);
});
