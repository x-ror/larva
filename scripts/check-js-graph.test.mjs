// node:test view of scripts/check-js-graph.mjs: one fixture tree per rule, each a
// minimal pkg/runtime layout that is clean except for the ONE defect the rule exists
// to catch. The clean fixture runs first, so a rule that fires on everything cannot
// pass by accident, and every failing fixture asserts the exact rule set — a fixture
// that also tripped a second rule would be testing its own scaffolding.
//
// Run: node --test scripts/check-js-graph.test.mjs   (or `make test-scripts`)

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkJsGraph } from './check-js-graph.mjs';
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

const only = (vs) => [...new Set(vs.map((v) => v.rule))].sort();

test('clean fixture has no violations (late-bound stream <-> stream/web is not a cycle)', () => {
  assert.deepEqual(rules({}), []);
});

test('the real tree is clean', () => {
  assert.deepEqual(checkJsGraph(ROOT), []);
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
