import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkCommand,
  checkWritePath,
  checkReadPath,
  extractCommandFromHookInput,
  RULES,
  PROTECTED_WRITE_PATHS,
} from './integrity.mjs';

test('rules cover the eight plan classes', () => {
  assert.ok(RULES.length >= 8);
});

const blocked = [
  ['NODE_BIN=./bin/lava make test-lava', 'node-bin-override'],
  ['RUN_LAVA=0 make test-compat-lava', 'run-lava-off'],
  ['LAVA_BIN=node make bench-gate', 'lava-bin-to-node'],
  ['PROPERTY_RUNS=1 make test-property', 'property-runs'],
  ['MUTATION_MANIFEST=/tmp/m make test-mutation', 'mutation-override'],
  ['MUTATION_BASE=HEAD make test-mutation CHANGED=1', 'mutation-override'],
  ['node scripts/run-mutations.mjs --filter=clone', 'mutation-override'],
  ['make check-primordials UPDATE=1', 'primordials-update'],
  ['git commit --no-verify -m x', 'no-verify'],
  ['rm tests/node-compat/cases/00-commonjs.js', 'delete-oracle-or-bench'],
  ['rm bin/lava', 'delete-oracle-or-bench'],
  ['git stash push -m x', 'git-stash-cycle'],
  ['git stash', 'git-stash-cycle'],
  ['sed -i s/x/y/ Makefile', 'inplace-edit-tooling'],
];

for (const [cmd, id] of blocked) {
  test(`blocks: ${id} — ${cmd.slice(0, 48)}`, () => {
    const r = checkCommand(cmd);
    assert.equal(r.blocked, true, `expected block for: ${cmd}`);
    assert.equal(r.id, id);
  });
}

const allowed = [
  'make test-mutation CHANGED=1',
  'make check',
  'make test-lava',
  'make check-js',
  'make build',
  'git status',
  'git diff HEAD',
  'git stash list',
  'LAVA_BIN=/home/x/lava-wt/bin/lava make -C /home/x/lava-wt test-lava',
  './scripts/run-fetch-smoke.sh',
  'node scripts/check-global-replace.mjs',
];

for (const cmd of allowed) {
  test(`allows: ${cmd}`, () => {
    const r = checkCommand(cmd);
    assert.equal(r.blocked, false, `unexpected block [${r.id}]: ${cmd}`);
  });
}

test('blocks write of pollution baseline', () => {
  const r = checkWritePath('tests/node-compat/pollution-baseline.json');
  assert.equal(r.blocked, true);
});

test('self-protect: blocks Edit of settings.json', () => {
  assert.equal(checkWritePath('.claude/settings.json').blocked, true);
});

test('self-protect: blocks Edit of gate-integrity.mjs', () => {
  assert.equal(checkWritePath('runtime/gates/integrity.mjs').blocked, true);
});

test('blocks Edit of compare.sh (oracle spine)', () => {
  assert.equal(checkWritePath('scripts/lib/compare.sh').blocked, true);
});

test('blocks Edit of Makefile', () => {
  assert.equal(checkWritePath('Makefile').blocked, true);
});

test('blocks write under .claude/hooks/', () => {
  assert.equal(checkWritePath('.claude/hooks/gate-integrity.sh').blocked, true);
});

test('PROTECTED_WRITE_PATHS includes self-protect entries', () => {
  assert.ok(PROTECTED_WRITE_PATHS.includes('.claude/settings.json'));
  assert.ok(PROTECTED_WRITE_PATHS.includes('runtime/gates/integrity.mjs'));
  assert.ok(PROTECTED_WRITE_PATHS.includes('scripts/lib/compare.sh'));
});

test('blocks read of .env', () => {
  const r = checkReadPath('.env');
  assert.equal(r.blocked, true);
});

test('allows read of .env.example', () => {
  const r = checkReadPath('.env.example');
  assert.equal(r.blocked, false);
});

test('hook extract: Bash tool_input.command', () => {
  const x = extractCommandFromHookInput({
    tool_name: 'Bash',
    tool_input: { command: 'NODE_BIN=./bin/lava make test-lava' },
  });
  assert.equal(x.kind, 'bash');
  assert.equal(checkCommand(x.command).blocked, true);
});

test('hook extract: Edit file_path is write', () => {
  const x = extractCommandFromHookInput({
    tool_name: 'Edit',
    tool_input: { file_path: '.claude/settings.json', old_string: 'a', new_string: 'b' },
  });
  assert.equal(x.kind, 'write');
  assert.equal(checkWritePath(x.path).blocked, true);
});

test('hook extract: Write path', () => {
  const x = extractCommandFromHookInput({
    tool_name: 'Write',
    tool_input: { file_path: 'scripts/lib/compare.sh', content: 'x' },
  });
  assert.equal(x.kind, 'write');
  assert.equal(checkWritePath(x.path).blocked, true);
});

test('blocks cd && NODE_BIN form', () => {
  const r = checkCommand('cd /tmp && NODE_BIN=./bin/lava make test-lava');
  assert.equal(r.blocked, true);
});

test('blocks sh -c with RUN_LAVA=0', () => {
  const r = checkCommand("sh -c 'RUN_LAVA=0 make test-compat-lava'");
  assert.equal(r.blocked, true);
});
