// Pins scripts/lib/compare.sh gate integrity, the Node major floor from .nvmrc (#185), and
// per-case timeouts (#399).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRATCH = mkdtempSync(join(tmpdir(), 'lava-compare-test-'));
// The floor is read, not hard-coded, so bumping .nvmrc does not touch this file.
const PIN = Number(readFileSync(join(ROOT, '.nvmrc'), 'utf8').split('.')[0]);
const PIN_BIN_DIR = join(SCRATCH, 'binpin');
mkdirSync(PIN_BIN_DIR);

const NODE_PIN = join(PIN_BIN_DIR, 'node');
const NODE_OLD = join(SCRATCH, 'node-old');
const NODE_NEW = join(SCRATCH, 'node-new');
const NODE_JUNK = join(SCRATCH, 'node-junk');
const BAD_PIN_ROOT = join(SCRATCH, 'bad-pin-root');
const FAKE_LAVA = join(SCRATCH, 'fake-lava');
const HANG_CASE = join(SCRATCH, 'hang.js');
const OK_CASE = join(SCRATCH, 'ok.js');

writeFileSync(
  NODE_PIN,
  `#!/usr/bin/env sh
if [ "\${1:-}" = "-p" ]; then
  echo ${PIN}
  exit 0
fi
if [ "\${1:-}" = "--version" ]; then
  echo v${PIN}.0.0
  exit 0
fi
exec "${process.execPath}" "$@"
`,
  { mode: 0o755 },
);

writeFileSync(
  NODE_OLD,
  `#!/usr/bin/env sh
[ "\${1:-}" = "-p" ] && echo ${PIN - 2} || echo v${PIN - 2}.22.2
`,
  { mode: 0o755 },
);

writeFileSync(
  NODE_NEW,
  `#!/usr/bin/env sh
[ "\${1:-}" = "-p" ] && echo ${PIN + 2} || echo v${PIN + 2}.1.0
`,
  { mode: 0o755 },
);

// A NODE_BIN whose `-p` prints no integer: `[ x -lt N ]` errors, `if` reads the
// error as false, and the floor check used to pass it.
writeFileSync(
  NODE_JUNK,
  `#!/usr/bin/env sh
[ "\${1:-}" = "-p" ] && echo banana || echo vbanana
`,
  { mode: 0o755 },
);

// A pin with no digits (`lts/*`) must refuse rather than compare against "".
mkdirSync(BAD_PIN_ROOT);
writeFileSync(join(BAD_PIN_ROOT, '.nvmrc'), 'lts/*\n');

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

function sourceCompare(env, body = ':', root = ROOT) {
  const pathEnv = `${PIN_BIN_DIR}:${process.env.PATH || ''}`;
  return spawnSync(
    'sh',
    ['-c', `ROOT_DIR="${root}" TMP_DIR="${SCRATCH}" . "${ROOT}/scripts/lib/compare.sh"\n${body}`],
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
  // Same path for both would be refused under RUN_LAVA=1; use the fake pinned
  // Node so the major check passes while keeping NODE_BIN === LAVA_BIN.
  const r = sourceCompare({
    NODE_BIN: NODE_PIN,
    LAVA_BIN: NODE_PIN,
    RUN_LAVA: '0',
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});

test('compare.sh refuses a NODE_BIN older than the .nvmrc major (#185)', () => {
  const r = sourceCompare({ NODE_BIN: NODE_OLD, LAVA_BIN: FAKE_LAVA, RUN_LAVA: '1' });
  assert.equal(r.status, 2, r.stderr || r.stdout);
  assert.match(
    r.stderr || '',
    new RegExp(`oracle requires node >= ${PIN} \\(\\.nvmrc\\), found v${PIN - 2}\\.22\\.2`),
  );
});

test('compare.sh refuses a NODE_BIN whose major is not an integer (#185)', () => {
  const r = sourceCompare({ NODE_BIN: NODE_JUNK, LAVA_BIN: FAKE_LAVA, RUN_LAVA: '1' });
  assert.equal(r.status, 2, r.stderr || r.stdout);
  assert.match(r.stderr || '', new RegExp(`oracle requires node >= ${PIN} \\(\\.nvmrc\\)`));
});

test('compare.sh refuses when .nvmrc carries no numeric major (#185)', () => {
  const r = sourceCompare(
    { NODE_BIN: NODE_PIN, LAVA_BIN: FAKE_LAVA, RUN_LAVA: '1' },
    ':',
    BAD_PIN_ROOT,
  );
  assert.equal(r.status, 2, r.stderr || r.stdout);
  assert.match(r.stderr || '', /\.nvmrc has no numeric Node major/);
});

test('compare.sh accepts a NODE_BIN newer than the .nvmrc major', () => {
  // The pin is a floor: the product tracks Node forward (26 now, 28 later), so a
  // newer oracle is allowed to run and any drift shows up as a case diff.
  const r = sourceCompare({ NODE_BIN: NODE_NEW, LAVA_BIN: FAKE_LAVA, RUN_LAVA: '1' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});

test('run_node_case fails with timeout message when a case exceeds CASE_TIMEOUT_SEC (#399)', () => {
  const r = sourceCompare(
    { NODE_BIN: NODE_PIN, LAVA_BIN: FAKE_LAVA, RUN_LAVA: '0', CASE_TIMEOUT_SEC: '1' },
    `run_case "${HANG_CASE}"`,
  );
  assert.equal(r.status, 124, r.stderr || r.stdout);
  assert.match(r.stderr || '', /timeout \(1s\) running node for /);
});

test('compare_case fails when both node and lava time out instead of matching 124==124 (#399)', () => {
  const r = sourceCompare(
    { NODE_BIN: NODE_PIN, LAVA_BIN: FAKE_LAVA, RUN_LAVA: '1', CASE_TIMEOUT_SEC: '1' },
    `run_case "${HANG_CASE}"`,
  );
  assert.equal(r.status, 124, r.stderr || r.stdout);
  assert.match(r.stderr || '', /timeout \(1s\) running node for /);
});

test('compare_case fails with lava timeout message when only lava hangs (#399)', () => {
  const r = sourceCompare(
    {
      NODE_BIN: NODE_PIN,
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
