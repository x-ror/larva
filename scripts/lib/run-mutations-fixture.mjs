// Shared fixture for the mutation gate's own tests (run-mutations*.test.mjs).
//
// Each case drives the real runner as a subprocess against a THROWAWAY git tree
// (`--root=` / `--manifest=`), never the repo. Split out of run-mutations.test.mjs
// so the slow cases — the ones that must wait out a real timeout — can live in
// their own file: eleven manifest entries use run-mutations.test.mjs as their
// gate, so every second in that file is paid eleven times per full mutation run.

import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUNNER = join(dirname(fileURLToPath(import.meta.url)), '..', 'run-mutations.mjs');

// The fixture source. `VALUE` is what the gate asserts on; a mutation that changes
// it makes the gate red, and one that only touches the comment leaves it green.
export const SOURCE = `// fixture module — MARKER
export const VALUE = 'expected';
export const OTHER = 'untouched';
`;

// The fixture gate. Distinct assertion messages so expect_detail can tell the two
// failure modes apart, which is the whole point of the field.
export const GATE = `import test from 'node:test';
import assert from 'node:assert/strict';
import { VALUE, OTHER } from './src.mjs';
test('value is expected', () => {
  assert.equal(VALUE, 'expected', 'THE-RECORDED-REASON');
});
test('other is untouched', () => {
  assert.equal(OTHER, 'untouched', 'AN-UNRELATED-REASON');
});
`;

export function makeTree(mutations, { source = SOURCE, gate = GATE } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lava-mut-'));
  mkdirSync(join(dir, 'fx'), { recursive: true });
  writeFileSync(join(dir, 'fx', 'src.mjs'), source);
  writeFileSync(join(dir, 'fx', 'gate.test.mjs'), gate);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ mutations }, null, 2));
  // A real git repo: the runner refuses to touch sources it cannot restore, and
  // that refusal is itself one of the behaviours under test.
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  git('add', '-A');
  git('commit', '-qm', 'fixture');
  return dir;
}

export function run(dir, extra = [], env = {}) {
  const r = spawnSync(
    process.execPath,
    [RUNNER, `--root=${dir}`, `--manifest=${join(dir, 'manifest.json')}`, ...extra],
    { encoding: 'utf8', cwd: dir, env: { ...process.env, ...env } },
  );
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

export const entry = (over = {}) => ({
  name: 'fixture dies when VALUE is broken',
  why: 'the gate must observe VALUE',
  source: 'fx/src.mjs',
  find: "export const VALUE = 'expected';",
  replace: "export const VALUE = 'BROKEN';",
  gate: 'node-test:fx/gate.test.mjs',
  expect_detail: 'THE-RECORDED-REASON',
  ...over,
});

export const sourceOf = (dir) => readFileSync(join(dir, 'fx', 'src.mjs'), 'utf8');

export function withTree(mutations, opts, fn) {
  const dir = makeTree(mutations, opts);
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// MUTATION_BASE and MUTATION_OPT are set explicitly per case and stripped
// otherwise, so a value in the developer's shell cannot decide a verdict here.
export function runClean(dir, extra = [], env = {}) {
  const base = { ...process.env };
  delete base.MUTATION_BASE;
  delete base.MUTATION_OPT;
  delete base.LAVA_OPT;
  const r = spawnSync(
    process.execPath,
    [RUNNER, `--root=${dir}`, `--manifest=${join(dir, 'manifest.json')}`, ...extra],
    { encoding: 'utf8', cwd: dir, env: { ...base, ...env } },
  );
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}
