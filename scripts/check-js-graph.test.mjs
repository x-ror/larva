// node:test view of scripts/check-js-graph.mjs, whose rules live in
// lib/js-graph-check.mjs: one fixture tree per rule, each a minimal pkg/runtime layout
// that is clean except for the ONE defect the rule exists to catch. The clean fixture
// runs first, so a rule that fires on everything cannot pass by accident, and every
// failing fixture asserts the exact rule set — a fixture that also tripped a second
// rule would be testing its own scaffolding.
//
// Run: node --test scripts/check-js-graph.test.mjs   (or `make test-scripts`)

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkJsGraph } from './lib/js-graph-check.mjs';
import { eagerModules } from './lib/js-graph.mjs';
import { ROOT } from './lib/primordials-detect.mjs';

const ODIN = `package runtime
LOADER :: #load("js/bootstrap/loader.js", string)
ESM :: #load("js/bootstrap/esm.js", string)
DIRS := [?]Dir{
	{"node", #load_directory("js/node")},
	{"node/stream", #load_directory("js/node/stream")},
	{"internal", #load_directory("js/internal")},
}
init :: proc() {
	set_named(ctx, natives, "node/buffer", b)
}
`;

const CLEAN = {
  'pkg/runtime/globals.odin': ODIN,
  'pkg/runtime/js/bootstrap/loader.js':
    "(function (factories) { function req(name) { return name; } req('internal/primordials'); req('internal/fetch'); return req; });",
  'pkg/runtime/js/bootstrap/esm.js': '(function (primordials) { return function () {}; });',
  'pkg/runtime/js/node/buffer.js':
    "(function (require, module) { var p = require('internal/primordials'); module.exports = {}; });",
  'pkg/runtime/js/node/stream.js':
    "(function (require, module) { require('buffer'); function late() { return require('node:stream/web'); } module.exports = { late }; });",
  'pkg/runtime/js/node/stream/web.js':
    "(function (require, module) { require('stream'); module.exports = {}; });",
  'pkg/runtime/js/internal/primordials.js':
    '(function (require, module) { module.exports = {}; });',
  'pkg/runtime/js/internal/fetch.js':
    "(function (require, module) { require('stream/web'); module.exports = {}; });",
};

function tree(overrides) {
  const root = mkdtempSync(join(tmpdir(), 'js-graph-'));
  const files = { ...CLEAN, ...overrides };
  for (const [rel, src] of Object.entries(files)) {
    if (src === null) continue;
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), src);
  }
  return root;
}

function rules(overrides) {
  const root = tree(overrides);
  try {
    return checkJsGraph(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function eager(overrides) {
  const root = tree(overrides);
  try {
    return eagerModules(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const only = (vs) => [...new Set(vs.map((v) => v.rule))].sort();

test('clean fixture has no violations (late-bound stream <-> stream/web is not a cycle)', () => {
  assert.deepEqual(rules({}), []);
});

test('the real tree is clean', () => {
  assert.deepEqual(checkJsGraph(ROOT), []);
});

// The CLI itself must report. It once sat behind an "am I the entry point?" guard so
// this file could import checkJsGraph, and that guard failed OPEN: run through a
// symlink, argv[1] is the link while import.meta.url is the realpath, the body never
// ran, and the gate exited 0 having printed nothing. The rules now live in lib/ and
// the CLI has no guard; this pins both the plain invocation and the symlinked one,
// since an exit code alone cannot tell "checked and passed" from "never checked".
test('graph CLI reports OK on the real tree, also when invoked through a symlink', () => {
  const cli = join(import.meta.dirname, 'check-js-graph.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'js-graph-cli-'));
  try {
    const link = join(dir, 'check-js-graph.mjs');
    symlinkSync(cli, link);
    for (const [how, path] of [
      ['direct path', cli],
      ['symlink', link],
    ]) {
      const r = spawnSync(process.execPath, [path], { encoding: 'utf8' });
      assert.equal(r.status, 0, `graph CLI (${how}) exited ${r.status}: ${r.stderr}`);
      assert.match(
        r.stdout,
        /^OK: embedded JS module graph is literal/m,
        `graph CLI (${how}) did not print its OK line; stdout: ${JSON.stringify(r.stdout)}`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The other half of the CLI contract: on a violating tree it must FAIL, and say why.
// Run only on the clean real tree, a CLI that exited 0 on violations, printed OK
// without checking, or dropped the violation lines would all have passed above. The
// CLI takes an optional root for exactly this; the fixture is the one-defect natives
// tree the rule test below uses.
test('graph CLI fails on a violating tree and names the violation', () => {
  const root = tree({ 'pkg/runtime/globals.odin': ODIN.replace('"node/buffer"', '"buffer"') });
  try {
    const cli = join(import.meta.dirname, 'check-js-graph.mjs');
    const r = spawnSync(process.execPath, [cli, root], { encoding: 'utf8' });
    // OK first: a CLI that skips the check also exits 0, and this keeps the two
    // mutants (wrong exit code, result discarded) reporting distinct failures.
    assert.doesNotMatch(r.stdout, /^OK:/m, `graph CLI printed OK on a violating tree: ${r.stdout}`);
    assert.equal(r.status, 1, `graph CLI exited ${r.status} on a violating tree: ${r.stderr}`);
    assert.match(
      r.stderr,
      /^JS module graph: 1 violation\(s\):$/m,
      `graph CLI header: ${r.stderr}`,
    );
    assert.match(
      r.stderr,
      /^  unresolved: pkg\/runtime\/globals\.odin  natives key "buffer" names no module$/m,
      `graph CLI violation line: ${r.stderr}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('dynamic: a non-literal require argument', () => {
  const vs = rules({
    'pkg/runtime/js/node/buffer.js':
      "(function (require, module) { var n = 'internal/primordials'; require(n); module.exports = {}; });",
  });
  assert.deepEqual(only(vs), ['dynamic']);
  assert.match(vs.find((v) => v.rule === 'dynamic').where, /node\/buffer\.js:1$/);
});

test('unresolved: a require literal with no file', () => {
  const vs = rules({
    'pkg/runtime/js/node/buffer.js':
      "(function (require, module) { require('internal/primordials'); require('internal/mim'); module.exports = {}; });",
  });
  assert.deepEqual(only(vs), ['unresolved']);
  assert.match(vs[0].msg, /internal\/mim/);
});

test('unresolved: a natives key naming no module', () => {
  const vs = rules({ 'pkg/runtime/globals.odin': ODIN.replace('"node/buffer"', '"buffer"') });
  assert.deepEqual(only(vs), ['unresolved']);
  assert.match(vs[0].msg, /natives key "buffer"/);
});

test('unreachable: an internal module nothing requires', () => {
  const vs = rules({
    'pkg/runtime/js/internal/mime.js': '(function (require, module) { module.exports = {}; });',
  });
  assert.deepEqual(only(vs), ['unreachable']);
  assert.match(vs[0].where, /internal\/mime\.js$/);
});

test('unembedded: a directory of .js no #load_directory reads', () => {
  const vs = rules({
    'pkg/runtime/js/node/util.js':
      "(function (require, module) { require('util/types'); module.exports = {}; });",
    'pkg/runtime/js/node/util/types.js': '(function (require, module) { module.exports = {}; });',
  });
  assert.deepEqual(only(vs), ['unembedded']);
  assert.match(vs[0].where, /node\/util\/types\.js$/);
});

test('unembedded: #load_directory of bootstrap/ would put esm.js on the module table', () => {
  const vs = rules({
    'pkg/runtime/globals.odin': ODIN.replace(
      '\t{"internal", #load_directory("js/internal")},',
      '\t{"internal", #load_directory("js/internal")},\n\t{"bootstrap", #load_directory("js/bootstrap")},',
    ),
  });
  assert.deepEqual(only(vs), ['unembedded']);
  assert.match(vs[0].msg, /js\/bootstrap/);
});

test('cycle: two module-eval requires that close a loop', () => {
  const vs = rules({
    'pkg/runtime/js/node/stream.js':
      "(function (require, module) { require('buffer'); require('stream/web'); module.exports = {}; });",
  });
  assert.deepEqual(only(vs), ['cycle']);
  assert.match(
    vs[0].msg,
    /node\/stream -> node\/stream\/web -> node\/stream|node\/stream\/web -> node\/stream -> node\/stream\/web/,
  );
});

// --- the eager set the pollution ratchet reads (lib/js-graph.mjs eagerModules) ---
//
// A module-eval capture is pristine only in a module instantiated before user code,
// so the ratchet exempts module-eval reads in exactly these ids. Getting the set too
// LARGE is the bug direction: a lazy module called eager has its captures exempted.

test('eager: closes over module-eval requires from the loader roots', () => {
  // Roots are the loader's req() literals (primordials, fetch); buffer, stream and
  // stream/web are eager only through fetch -> stream/web -> stream -> buffer.
  assert.deepEqual(eager({}), [
    'internal/fetch',
    'internal/primordials',
    'node/buffer',
    'node/stream',
    'node/stream/web',
  ]);
});

test('eager: a function-body require does not make its target eager', () => {
  const ids = eager({
    'pkg/runtime/js/node/stream.js':
      "(function (require, module) { require('buffer'); function late() { return require('os'); } module.exports = { late }; });",
    'pkg/runtime/js/node/os.js': '(function (require, module) { module.exports = {}; });',
  });
  assert.ok(ids.includes('node/stream'), `stream is eager: ${ids}`);
  assert.ok(!ids.includes('node/os'), `node/os is lazy, got eager: ${ids}`);
});

// The runtime side of the same set. cmd/lava/lazy_builtins_test.odin carries the list
// as STATIC_EAGER and checks it against what context init actually compiles; this keeps
// that list equal to what the ratchet computes, so neither can drift alone.
test('eager: the Odin cross-check list matches the computed set', () => {
  const odin = readFileSync(join(ROOT, 'cmd', 'lava', 'lazy_builtins_test.odin'), 'utf8');
  const m = /STATIC_EAGER :: \[\?\]string\{([^}]*)\}/.exec(odin);
  assert.ok(m, 'STATIC_EAGER not found in lazy_builtins_test.odin');
  const listed = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort();
  assert.deepEqual(listed, eagerModules(ROOT));
});
