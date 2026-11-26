// Tests for scripts/ci-scope.mjs. A wrong answer here skips gates on a pull
// request, so every case below is about narrowing too far, not too little.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify } from './ci-scope.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'ci-scope.mjs');

test('prose only is docs', () => {
  assert.equal(classify(['README.md', 'docs/ARCHITECTURE.md', 'NOTICE']), 'docs');
});

test('agent and gate tooling is tooling', () => {
  assert.equal(
    classify([
      'agents/prompts/pr-gate.md',
      'runtime/gates/route-gates.mjs',
      'scripts/run-mutations.mjs',
    ]),
    'tooling',
  );
});

test('one runtime file among docs makes the whole PR code', () => {
  assert.equal(classify(['README.md', 'pkg/runtime/net.odin']), 'code');
});

test('a shell script under scripts/ is code, not tooling', () => {
  // build.sh and the oracle/smoke runners decide what the code gates see.
  assert.equal(classify(['scripts/build.sh']), 'code');
  assert.equal(classify(['scripts/run-fetch-smoke.sh']), 'code');
});

test("the web oracle's runner and print shim are code, its recorder tooling", () => {
  // They decide what `make test-web` compares; the recorder only writes recordings.
  assert.equal(classify(['scripts/run-web-oracle.mjs']), 'code');
  assert.equal(classify(['scripts/lib/web-oracle.mjs']), 'code');
  assert.equal(classify(['scripts/record-chrome.mjs']), 'tooling');
  assert.equal(classify(['tests/web/cases/url-parse.js']), 'code');
});

test("the DOM oracle's runner and tree walker are code, its recorder tooling", () => {
  // They decide what `make test-dom` compares; the recorder only writes recordings.
  assert.equal(classify(['scripts/run-dom-oracle.mjs']), 'code');
  assert.equal(classify(['scripts/lib/dom-oracle.mjs']), 'code');
  assert.equal(classify(['scripts/record-dom.mjs']), 'tooling');
  assert.equal(classify(['tests/dom/cases/void-elements.html']), 'code');
});

test('the Makefile and the workflows are code', () => {
  assert.equal(classify(['Makefile']), 'code');
  assert.equal(classify(['.github/workflows/ci.yml']), 'code');
});

test('the mutation manifest and tests are code', () => {
  assert.equal(classify(['tests/mutation-manifest.json']), 'code');
  assert.equal(classify(['tests/node-compat/cases/00-commonjs.js']), 'code');
});

test('no paths is code, never a skip', () => {
  assert.equal(classify([]), 'code');
});

test('without a base the CLI reports full', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'scope=full');
});

test('--paths drives the same classifier from the CLI', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--paths', 'docs/x.md', 'cmd/lava/main.odin'], {
    encoding: 'utf8',
  });
  assert.equal(r.stdout.trim(), 'scope=code');
});
