import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routePaths, ALWAYS } from './route-gates.mjs';

test('ALWAYS is included for any path', () => {
  const r = routePaths(['README.md']);
  for (const t of ALWAYS) assert.ok(r.targets.includes(t), t);
});

test('loader.js routes strict + smokes (not silent drop of **.js)', () => {
  const r = routePaths(['pkg/runtime/js/bootstrap/loader.js']);
  assert.ok(r.targets.includes('make test-compat-lava-strict'));
  assert.ok(r.targets.includes('make test-stdio'));
  assert.ok(r.targets.includes('make check-js'));
});

test('buffer path routes bun-buffer + api-surface (non-CI)', () => {
  const r = routePaths(['pkg/runtime/buffer.odin']);
  assert.ok(
    r.nonCi.includes('make bun-buffer-tests') || r.targets.includes('make bun-buffer-tests'),
  );
  assert.ok(r.targets.includes('make api-surface'));
});

test('bench path routes bench-gate, reported as non-CI during the Node-profile removal', () => {
  const r = routePaths(['bench/micro/url.js']);
  assert.ok(r.targets.includes('make bench-gate'));
  assert.ok(r.nonCi.includes('make bench-gate'));
});

test('the always-set runs the green cmd/lava gate, not the red-by-design ones', () => {
  const t = routePaths(['pkg/runtime/page.odin']).targets;
  for (const g of ['make test-odin-green', 'make test-odin-green SERIAL=1', 'make test-web'])
    assert.ok(t.includes(g), g);
  for (const g of ['make test', 'make test-odin-serial']) assert.ok(!t.includes(g), g);
});

test('the known-red skip list and its runner route the green gate and the workflow lint', () => {
  for (const p of ['cmd/lava/known-node-red.txt', 'scripts/run-odin-green.sh']) {
    const r = routePaths([p]);
    assert.ok(r.matched.length > 0, p + ' matched no route');
    for (const g of ['make test-odin-green SERIAL=1', 'make check-actions'])
      assert.ok(r.targets.includes(g), p + ' ' + g);
  }
});

test('fetch internals route the fetch smoke, entry and split files alike', () => {
  for (const p of [
    'pkg/runtime/js/internal/fetch.js',
    'pkg/runtime/js/internal/fetch/headers.js',
    'pkg/runtime/js/internal/fetch/body.js',
  ]) {
    assert.ok(routePaths([p]).targets.includes('make test-fetch-smoke'), p);
  }
});

test('crypto internals route the crypto gates, entry and split files alike', () => {
  for (const p of [
    'pkg/runtime/js/node/crypto.js',
    'pkg/runtime/js/internal/crypto/random.js',
    'pkg/runtime/js/internal/crypto/util.js',
  ]) {
    const t = routePaths([p]).targets;
    for (const g of ['make test-odin-green', 'make api-surface'])
      assert.ok(t.includes(g), p + ' ' + g);
  }
});

test('buffer internals route the property tests, entry and split file alike', () => {
  for (const p of ['pkg/runtime/js/node/buffer.js', 'pkg/runtime/js/internal/buffer.js']) {
    assert.ok(routePaths([p]).targets.includes('make test-property'), p);
  }
});

test('url internals route the URL bench and property tests, entry and split files alike', () => {
  for (const p of [
    'pkg/runtime/js/node/url.js',
    'pkg/runtime/js/internal/url.js',
    'pkg/runtime/js/internal/idna.js',
    'pkg/runtime/js/internal/punycode.js',
  ]) {
    const t = routePaths([p]).targets;
    for (const g of ['make bench-gate', 'make test-property'])
      assert.ok(t.includes(g), p + ' ' + g);
  }
});

test('invalid **.js style is not required — **/* works', () => {
  const r = routePaths(['pkg/runtime/js/bootstrap/console.js']);
  assert.ok(r.targets.includes('make check-js'));
});

test('the fetch transport routes its smoke (picohttpparser and the TLS client included)', () => {
  for (const p of [
    'pkg/runtime/fetch.odin',
    'pkg/runtime/picohttpparser/picohttpparser.odin',
    'pkg/tls/tls.odin',
    'pkg/runtime/tls_darwin.odin',
  ]) {
    assert.ok(routePaths([p]).targets.includes('make test-fetch-smoke'), p);
  }
});

test('pkg/http routes its own Odin tests (make check alone never runs them)', () => {
  for (const p of [
    'pkg/http/content_coding.odin',
    'pkg/http/transfer_linux.odin',
    'pkg/http/testdata/content-coding/gen.mjs',
  ]) {
    assert.ok(routePaths([p]).targets.includes('make test-http-odin'), p);
  }
});
