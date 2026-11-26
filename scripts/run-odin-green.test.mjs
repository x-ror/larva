// node:test for scripts/run-odin-green.sh, the runner behind CI's cmd/lava step. Each case
// builds a throwaway Odin package with the real compiler (ODIN, default `odin`) and points
// the script at it through ODIN_GREEN_PKG / ODIN_GREEN_LIST, so what is pinned is the
// script's verdict on real runner output, not on a stub of it. Skipped when no Odin
// compiler is on PATH (the checks job installs one before `make check-js`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'run-odin-green.sh');
const ODIN = process.env.ODIN ?? 'odin';
const haveOdin = spawnSync(ODIN, ['version'], { encoding: 'utf8' }).status === 0;

// Every attribute form discovery must accept: alone, on the declaration's line, among other
// attributes, indented inside a `when` block, spaced, and CRLF. A comment naming @(test)
// is not a test.
const PKG = [
  'package gr',
  'import "core:testing"',
  '// a comment mentioning @(test) is not a test',
  '@(test)',
  'stays_red :: proc(t: ^testing.T) { testing.expect(t, false, "still red") }',
  '@(test) same_line :: proc(t: ^testing.T) { testing.expect(t, true) }',
  '@(disabled = false, test)',
  'attr_list :: proc(t: ^testing.T) { testing.expect(t, true) }',
  'when ODIN_OS == .Linux || ODIN_OS != .Linux {',
  '\t@( test )',
  '\tindented :: proc(t: ^testing.T) { testing.expect(t, true) }',
  '}',
  '@(test, disabled = false)\r',
  'goes_green :: proc(t: ^testing.T) { testing.expect(t, true) }',
  '',
].join('\n');

function run(list, extra = '') {
  const dir = mkdtempSync(join(tmpdir(), 'odin-green-'));
  try {
    const pkg = join(dir, 'pkg');
    spawnSync('mkdir', [pkg]);
    writeFileSync(join(pkg, 'x_test.odin'), PKG + extra);
    writeFileSync(join(dir, 'list.txt'), list);
    const r = spawnSync('sh', [SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, ODIN, ODIN_GREEN_PKG: pkg, ODIN_GREEN_LIST: join(dir, 'list.txt') },
    });
    return { status: r.status, out: r.stdout + r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test(
  'runs every discovered form and passes while each listed test still fails',
  { skip: !haveOdin },
  () => {
    const r = run('# reason column\nstays_red  needs a deleted module\n');
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /run-odin-green: 4 tests, 1 skipped/);
  },
);

test('a listed test that now passes fails the run and is named', { skip: !haveOdin }, () => {
  const r = run('stays_red  r\ngoes_green  r\n');
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /now PASSING: goes_green/);
  assert.doesNotMatch(r.out, /PASSING:.*stays_red/);
});

test('a listed name that is no test fails the run', { skip: !haveOdin }, () => {
  const r = run('stays_red  r\nno_such_test  r\n');
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /no_such_test is listed .* no such test exists/);
});

test('an attribute discovery cannot pair with a name fails the run', { skip: !haveOdin }, () => {
  const r = run('stays_red  r\n', '@(test) /* no declaration follows */\n');
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /6 @\(test\) attributes .* but 5 test names discovered/);
});
