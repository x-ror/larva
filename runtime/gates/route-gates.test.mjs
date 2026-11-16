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
  assert.ok(r.targets.includes('make test-fs-lava'));
  assert.ok(r.targets.includes('make check-js'));
});

test('buffer path routes bun-buffer + api-surface (non-CI)', () => {
  const r = routePaths(['pkg/runtime/buffer.odin']);
  assert.ok(
    r.nonCi.includes('make bun-buffer-tests') || r.targets.includes('make bun-buffer-tests'),
  );
  assert.ok(r.targets.includes('make api-surface'));
});

test('bench path routes bench-gate', () => {
  const r = routePaths(['bench/micro/url.js']);
  assert.ok(r.targets.includes('make bench-gate'));
  assert.ok(!r.nonCi.includes('make bench-gate'));
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
    'pkg/runtime/js/internal/crypto/hash.js',
    'pkg/runtime/js/internal/crypto/scrypt.js',
  ]) {
    const t = routePaths([p]).targets;
    for (const g of ['make test-odin', 'make api-surface']) assert.ok(t.includes(g), p + ' ' + g);
  }
});

test('invalid **.js style is not required — **/* works', () => {
  const r = routePaths(['pkg/runtime/js/bootstrap/console.js']);
  assert.ok(r.targets.includes('make check-js'));
});

test('internal/http/** routes like node/http.js (the split must not drop the http smoke)', () => {
  for (const f of ['common', 'incoming', 'outgoing', 'server']) {
    const r = routePaths([`pkg/runtime/js/internal/http/${f}.js`]);
    assert.ok(r.targets.includes('make test-http-smoke'), f);
    assert.ok(r.targets.includes('make bench-http') || r.nonCi.includes('make bench-http'), f);
  }
});
