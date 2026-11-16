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

test('invalid **.js style is not required — **/* works', () => {
  const r = routePaths(['pkg/runtime/js/bootstrap/console.js']);
  assert.ok(r.targets.includes('make check-js'));
});
