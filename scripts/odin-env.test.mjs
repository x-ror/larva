// `node scripts/odin-env.mjs --check` is what .github/actions/setup-odin runs right
// after installing Odin ("Verify the compiler is the pin"): its exit status is the
// only thing standing between a drifted toolchain and a green CI build. These tests
// drive the real script as a subprocess against fake `odin` executables, so they
// observe exactly the exit status CI does — and depend on neither the developer's
// own compiler nor an SDK checkout: ODIN_ROOT is an empty, non-git temp dir, and
// GIT_CEILING_DIRECTORIES stops git from finding a repository above it.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readPin } from './lib/odin-pin.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'odin-env.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'odin-env-test-'));
const sdkRoot = join(tmp, 'sdk');
mkdirSync(sdkRoot);
after(() => rmSync(tmp, { recursive: true, force: true }));

// Read the real pin rather than hardcoding it, so a pin bump does not turn these
// tests into ones that check the old commit.
const pin = readPin();

let fakes = 0;
/** A fake `odin` whose `odin version` prints `versionLine`. */
function fakeOdin(versionLine) {
  const p = join(tmp, `odin-${fakes++}`);
  writeFileSync(
    p,
    `#!/bin/sh\ncase "$1" in\n  version) echo '${versionLine}' ;;\n  root) echo '${sdkRoot}/' ;;\n  *) exit 2 ;;\nesac\n`,
  );
  chmodSync(p, 0o755);
  return p;
}

function runEnv(odin, args = ['--check']) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ODIN: odin, ODIN_ROOT: sdkRoot, GIT_CEILING_DIRECTORIES: tmp },
  });
  return { status: r.status, out: r.stdout + r.stderr };
}

test('--check exits 0 for a git build of the pinned commit', () => {
  const r = runEnv(fakeOdin(`odin version dev-2026-11:${pin.commit.slice(0, 9)}`));
  assert.equal(r.status, 0, `the pinned commit was rejected:\n${r.out}`);
  assert.match(r.out, /= pin/);
});

test('--check exits 1 for a git build of another commit, even under the pinned tag', () => {
  const other = pin.commit.startsWith('0') ? '1234567ab' : '0234567ab';
  const tag = pin.release || 'dev-2026-11';
  const r = runEnv(fakeOdin(`odin version ${tag}:${other}`));
  assert.equal(r.status, 1, `a drifted compiler passed --check:\n${r.out}`);
  assert.match(r.out, /not the commit pinned/);
});

test('--check matches a hashless prebuilt only by the pinned release tag', () => {
  const pinned = runEnv(fakeOdin(`odin version ${pin.release || 'dev-2026-11a'}`));
  assert.equal(
    pinned.status,
    pin.release ? 0 : 1,
    `hashless build of the pinned release (release=${pin.release}):\n${pinned.out}`,
  );
  const other = runEnv(fakeOdin('odin version dev-1999-01'));
  assert.equal(
    other.status,
    1,
    `a hashless build of another release passed --check:\n${other.out}`,
  );
});

test('--check exits 1 when there is no compiler at all', () => {
  const r = runEnv(join(tmp, 'no-such-odin'));
  assert.equal(r.status, 1, `a missing compiler passed --check:\n${r.out}`);
  assert.match(r.out, /NOT FOUND/);
});

test('without --check the report never fails, even on drift', () => {
  const r = runEnv(fakeOdin('odin version dev-2026-11:0000000aa'), []);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /≠ pin/);
});
