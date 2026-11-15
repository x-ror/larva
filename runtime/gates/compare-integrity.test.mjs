// Pins scripts/lib/compare.sh gate integrity, Node major match (#185), and per-case timeouts (#399).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRATCH = mkdtempSync(join(tmpdir(), 'lava-compare-test-'));
const BIN24_DIR = join(SCRATCH, 'bin24');
mkdirSync(BIN24_DIR);

const NODE24 = join(BIN24_DIR, 'node');
const NODE22 = join(SCRATCH, 'node22');
const NODE26 = join(SCRATCH, 'node26');
const FAKE_LAVA = join(SCRATCH, 'fake-lava');
const HANG_CASE = join(SCRATCH, 'hang.js');
const OK_CASE = join(SCRATCH, 'ok.js');

writeFileSync(
  NODE24,
  `#!/usr/bin/env sh
if [ "\${1:-}" = "-p" ]; then
  echo 24
  exit 0
fi
if [ "\${1:-}" = "--version" ]; then
  echo v24.22.2
  exit 0
fi
exec "${process.execPath}" "$@"
`,
  { mode: 0o755 },
);

writeFileSync(
  NODE22,
  `#!/usr/bin/env sh
[ "\${1:-}" = "-p" ] && echo 22 || echo v22.22.2
`,
  { mode: 0o755 },
);

writeFileSync(
  NODE26,
  `#!/usr/bin/env sh
[ "\${1:-}" = "-p" ] && echo 26 || echo v26.13.0
`,
  { mode: 0o755 },
);

writeFileSync(
  FAKE_LAVA,
  `#!/usr/bin/env sh
[ "\${1:-}" = "run" ] && shift
if [ "\${LAVA_SLEEP_SEC:-}" != "" ]; then
  sleep "$LAVA_SLEEP_SEC"
  exit 0
fi
exec "${process.execPath}" "$@"
`,
  { mode: 0o755 },
);

writeFileSync(HANG_CASE, 'while (true) {}\n');
writeFileSync(OK_CASE, 'console.log("ok");\n');

after(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

function sourceCompare(env, body = ':') {
  const pathEnv = `${BIN24_DIR}:${process.env.PATH || ''}`;
  return spawnSync(
    'sh',
    ['-c', `ROOT_DIR="${ROOT}" TMP_DIR="${SCRATCH}" . "${ROOT}/scripts/lib/compare.sh"\n${body}`],
    {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, ...env, PATH: pathEnv },
    },
  );
}

test('compare.sh refuses NODE_BIN=lava under RUN_LAVA=1', () => {
  const r = sourceCompare({
    NODE_BIN: `${ROOT}/bin/lava`,
    LAVA_BIN: `${ROOT}/bin/lava`,
    RUN_LAVA: '1',
  });
  assert.equal(
    r.status,
    2,
    `GATE INTEGRITY must exit 2 for lava-vs-lava, got ${r.status}: ${r.stderr || r.stdout}`,
  );
  assert.match(r.stderr || '', /GATE INTEGRITY/);
});

test('compare.sh allows NODE_BIN=node under RUN_LAVA=1', () => {
  const r = sourceCompare({
    NODE_BIN: 'node',
    LAVA_BIN: `${ROOT}/bin/lava`,
    RUN_LAVA: '1',
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});

test('compare.sh is a no-op integrity-wise when RUN_LAVA=0', () => {
  // Same path for both would be refused under RUN_LAVA=1; use the fake Node 24
  // binary so the major check passes while keeping NODE_BIN === LAVA_BIN.
  const r = sourceCompare({
    NODE_BIN: NODE24,
    LAVA_BIN: NODE24,
    RUN_LAVA: '0',
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});

test('compare.sh refuses a non-Node-24 NODE_BIN (#185)', () => {
  for (const [bin, ver] of [
    [NODE22, 'v22.22.2'],
    [NODE26, 'v26.13.0'],
  ]) {
    const r = sourceCompare({ NODE_BIN: bin, LAVA_BIN: FAKE_LAVA, RUN_LAVA: '1' });
    assert.equal(r.status, 2, r.stderr || r.stdout);
    assert.match(
      r.stderr || '',
      new RegExp(`oracle requires node 24 \\(\\.nvmrc\\), found ${ver.replace(/\./g, '\\.')}`),
    );
  }
});

test('run_node_case fails with timeout message when a case exceeds CASE_TIMEOUT_SEC (#399)', () => {
  const r = sourceCompare(
    { NODE_BIN: NODE24, LAVA_BIN: FAKE_LAVA, RUN_LAVA: '0', CASE_TIMEOUT_SEC: '1' },
    `run_case "${HANG_CASE}"`,
  );
  assert.equal(r.status, 124, r.stderr || r.stdout);
  assert.match(r.stderr || '', /timeout \(1s\) running node for /);
});

test('compare_case fails when both node and lava time out instead of matching 124==124 (#399)', () => {
  const r = sourceCompare(
    { NODE_BIN: NODE24, LAVA_BIN: FAKE_LAVA, RUN_LAVA: '1', CASE_TIMEOUT_SEC: '1' },
    `run_case "${HANG_CASE}"`,
  );
  assert.equal(r.status, 124, r.stderr || r.stdout);
  assert.match(r.stderr || '', /timeout \(1s\) running node for /);
});

test('compare_case fails with lava timeout message when only lava hangs (#399)', () => {
  const r = sourceCompare(
    {
      NODE_BIN: NODE24,
      LAVA_BIN: FAKE_LAVA,
      RUN_LAVA: '1',
      CASE_TIMEOUT_SEC: '1',
      LAVA_SLEEP_SEC: '5',
    },
    `run_case "${OK_CASE}"`,
  );
  assert.equal(r.status, 124, r.stderr || r.stdout);
  assert.match(r.stderr || '', /timeout \(1s\) running lava for /);
});
