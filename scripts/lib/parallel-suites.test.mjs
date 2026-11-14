// Tests for scripts/lib/parallel-suites.sh, which runs the oracle suites concurrently.
// What matters is that running them together never turns a red suite green: every
// failure must reach the exit status, and the log must read as a serial run would.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB = join(dirname(fileURLToPath(import.meta.url)), 'parallel-suites.sh');

function run(body, env = {}) {
  const script = `set -eu\n. '${LIB}'\n${body}\nif run_suites; then echo RESULT=pass; else echo RESULT=fail; fi\n`;
  const r = spawnSync('sh', ['-c', script], { encoding: 'utf8', env: { ...process.env, ...env } });
  return { out: r.stdout, err: r.stderr, status: r.status };
}

for (const serial of ['0', '1']) {
  const mode = serial === '1' ? 'serial' : 'parallel';

  test(`${mode}: a failing suite fails the run even when a later one passes`, () => {
    const r = run(`suite bad sh -c 'exit 3'\nsuite good sh -c 'echo good-out'`, {
      LAVA_ORACLE_SERIAL: serial,
    });
    assert.match(r.out, /RESULT=fail/);
    assert.match(r.err, /oracle suite bad failed \(exit 3\)/);
    assert.match(r.out, /good-out/, 'a failure must not hide the other suites');
  });

  test(`${mode}: output is in declaration order, not completion order`, () => {
    const r = run(`suite slow sh -c 'sleep 0.3; echo first'\nsuite fast sh -c 'echo second'`, {
      LAVA_ORACLE_SERIAL: serial,
    });
    assert.match(r.out, /first\nsecond\n/);
    assert.match(r.out, /RESULT=pass/);
  });
}

test('parallel: suites really overlap', () => {
  const t0 = Date.now();
  const r = run(`suite a sleep 1\nsuite b sleep 1\nsuite c sleep 1`);
  assert.match(r.out, /RESULT=pass/);
  assert.ok(Date.now() - t0 < 2500, `took ${Date.now() - t0}ms for three 1s suites`);
});
