// The tests/web shape-* cases are generated (scripts/gen-web-shape.mjs). A hand edit of
// a case, or a generator change not run, would leave a recording that no longer
// matches its generator — this fails then, inside `make check-js`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { CASES_DIR, cases } from './gen-web-shape.mjs';

test('every generated shape case is up to date', () => {
  for (const [name, text] of cases()) {
    assert.equal(
      readFileSync(join(CASES_DIR, name + '.js'), 'utf8'),
      text,
      `${name}.js is stale: run node scripts/gen-web-shape.mjs`,
    );
  }
});
