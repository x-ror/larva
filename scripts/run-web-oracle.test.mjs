// Tests for the Window-profile oracle suite's verdict rules and file formats
// (scripts/lib/web-oracle.mjs) and for scripts/run-web-oracle.mjs's exit status. A
// gate script: each rule here is one a broken runner would turn into a silent pass.
// Needs no bin/lava — the CLI test hands the runner a stand-in binary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import {
  HEADER_END,
  ROOT,
  caseOptions,
  chromePage,
  formatExpected,
  formatSnapshot,
  judge,
  lavaPrelude,
  parseExpected,
  parseKnown,
  readSink,
  recordVerdict,
  suiteProblems,
} from './lib/web-oracle.mjs';

const ok = (stdout) => ({ stdout, stderr: '', code: 0 });
const KNOWN = { stage: 'S4a', reason: 'node-shaped errors' };

test('a run that prints the recording and exits 0 passes', () => {
  const r = judge({
    name: 'c',
    expected: 'a\nb\n',
    actual: ok('a\nb\n'),
    known: undefined,
    snapshot: null,
  });
  assert.equal(r.verdict, 'pass');
});

test('a mismatch fails and names the first differing line', () => {
  const r = judge({
    name: 'c',
    expected: 'a\nb\n',
    actual: ok('a\nB\n'),
    known: undefined,
    snapshot: null,
  });
  assert.equal(r.verdict, 'fail');
  assert.match(r.detail, /line 2/);
  assert.match(r.detail, /want: "b"/);
});

test('a missing recording fails rather than skipping', () => {
  const r = judge({
    name: 'c',
    expected: null,
    actual: ok('a\n'),
    known: undefined,
    snapshot: null,
  });
  assert.equal(r.verdict, 'fail');
  assert.match(r.detail, /no Chrome recording/);
});

test('matching output with a non-zero exit fails: the throw would be a page error', () => {
  const r = judge({
    name: 'c',
    expected: 'a\n',
    actual: { stdout: 'a\n', stderr: 'Uncaught', code: 1 },
    known: undefined,
    snapshot: null,
  });
  assert.equal(r.verdict, 'fail');
  assert.match(r.detail, /exit code 1/);
});

test('a missing final newline is a difference', () => {
  const r = judge({
    name: 'c',
    expected: 'a\n',
    actual: ok('a'),
    known: undefined,
    snapshot: null,
  });
  assert.equal(r.verdict, 'fail');
});

test('a known gap holds while Lava prints exactly its pinned output', () => {
  const actual = ok('lava says\n');
  const r = judge({
    name: 'c',
    expected: 'chrome says\n',
    actual,
    known: KNOWN,
    snapshot: formatSnapshot(actual),
  });
  assert.equal(r.verdict, 'known');
  assert.match(r.detail, /S4a/);
});

test('a known gap whose Lava output drifts fails', () => {
  const r = judge({
    name: 'c',
    expected: 'chrome says\n',
    actual: ok('lava says something else\n'),
    known: KNOWN,
    snapshot: formatSnapshot(ok('lava says\n')),
  });
  assert.equal(r.verdict, 'fail');
  assert.match(r.detail, /drifted/);
});

test('a known gap with a pinned exit code holds only on that exit code', () => {
  const pinned = formatSnapshot({ stdout: '', code: 1 });
  const same = judge({
    name: 'c',
    expected: 'x\n',
    actual: { stdout: '', stderr: '', code: 1 },
    known: KNOWN,
    snapshot: pinned,
  });
  const other = judge({
    name: 'c',
    expected: 'x\n',
    actual: ok(''),
    known: KNOWN,
    snapshot: pinned,
  });
  assert.equal(same.verdict, 'known');
  assert.equal(other.verdict, 'fail');
});

test('a known gap without a pinned output fails', () => {
  const r = judge({ name: 'c', expected: 'x\n', actual: ok('y\n'), known: KNOWN, snapshot: null });
  assert.equal(r.verdict, 'fail');
  assert.match(r.detail, /update-known/);
});

test('a known gap that now matches Chrome fails until its entry is removed', () => {
  const r = judge({
    name: 'c',
    expected: 'x\n',
    actual: ok('x\n'),
    known: KNOWN,
    snapshot: formatSnapshot(ok('y\n')),
  });
  assert.equal(r.verdict, 'fail');
  assert.match(r.detail, /remove the entry/);
});

test('parseKnown requires a known stage and a reason, once per case', () => {
  const m = parseKnown('# comment\n\na S4b: why\nb unplanned: because\n');
  assert.deepEqual([...m.keys()], ['a', 'b']);
  assert.equal(m.get('a').stage, 'S4b');
  assert.throws(() => parseKnown('a S4b:\n'), /no reason/);
  assert.throws(() => parseKnown('a later: someday\n'), /stage 'later'/);
  assert.throws(() => parseKnown('a\n'), /want/);
  assert.throws(() => parseKnown('a S4b: x\na S4c: y\n'), /twice/);
});

test('a recording round-trips its header and output, and a header-less file is refused', () => {
  const meta = { chrome: 'Google Chrome 1.2.3', date: '2026-01-01', runs: 3, command: 'x' };
  const text = formatExpected(meta, 'out\nno newline at end');
  const parsed = parseExpected(text);
  assert.equal(parsed.header.chrome, 'Google Chrome 1.2.3');
  assert.equal(parsed.output, 'out\nno newline at end');
  assert.throws(() => parseExpected('out\n'), /header end/);
  assert.throws(() => parseExpected('# date: x\n' + HEADER_END + 'out\n'), /chrome version/);
});

test('the Lava prelude is one line, so a case keeps its own line numbers', () => {
  const p = lavaPrelude('http://127.0.0.1:1');
  assert.equal(p.includes('\n'), false);
  assert.match(p, /var print = /);
  assert.match(p, /var ORIGIN = "http:\/\/127\.0\.0\.1:1"/);
});

test('caseOptions reads the real-time directive and defaults to virtual time', () => {
  assert.deepEqual(caseOptions('// x\n// web-oracle: real-time 1500\ncode();\n'), {
    realTimeMs: 1500,
  });
  assert.deepEqual(caseOptions('code();\n'), { realTimeMs: 0 });
});

test('suiteProblems reports orphans: a gap with no case, a recording or pin with no case', () => {
  const dir = mkdtempSync(join(tmpdir(), 'web-oracle-test-'));
  try {
    const cases = join(dir, 'cases');
    const known = join(dir, 'known');
    mkdirSync(cases);
    mkdirSync(known);
    writeFileSync(join(cases, 'gone.expected'), '');
    writeFileSync(join(known, 'unlisted.lava'), '');
    const problems = suiteProblems(['here'], new Map([['missing', KNOWN]]), cases, known);
    assert.equal(problems.length, 3, problems.join('\n'));
    assert.match(problems.join('\n'), /missing, which has no case/);
    assert.match(problems.join('\n'), /gone\.expected has no case/);
    assert.match(problems.join('\n'), /unlisted\.lava has no known-gaps/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The CLI end to end with a stand-in for bin/lava that prints nothing: every selected
// case is a mismatch, so the runner must exit non-zero and count it as a failure.
test('the runner exits non-zero when a case does not match its recording', () => {
  const dir = mkdtempSync(join(tmpdir(), 'web-oracle-cli-'));
  try {
    const fake = join(dir, 'lava');
    writeFileSync(fake, '#!/bin/sh\nexit 0\n');
    chmodSync(fake, 0o755);
    const r = spawnSync(
      process.execPath,
      [join(ROOT, 'scripts/run-web-oracle.mjs'), 'harness-print'],
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, LAVA_BIN: fake },
        timeout: 30_000,
      },
    );
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /FAIL harness-print/);
    assert.match(r.stdout, /0 pass, 0 known, 1 fail/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the recorder's side: what may become an oracle ---------------------------------

test('recordVerdict keeps an output only when every run printed it and none erred', () => {
  const run = (out, err = '') => ({ out, err });
  assert.deepEqual(recordVerdict([run('a\n'), run('a\n'), run('a\n')]), { output: 'a\n' });
  assert.match(
    recordVerdict([run('a\n'), run('a\n', 'error: boom\n')]).error,
    /page error in run 2/,
  );
  assert.match(recordVerdict([run('a\n'), run('b\n')]).error, /run 2 differs .*flaky/);
  assert.match(recordVerdict([run(null)]).error, /no #out/);
  assert.match(recordVerdict([]).error, /no run/);
});

// The Chrome shim, run for real: its inline script executes in a vm against just
// enough DOM to hold two text nodes, then the sinks are serialized the way
// --dump-dom does and read back through readSink. Pins the trailing newline, the
// UTF-8/base64 round-trip, and that a page error and an unhandled rejection land in
// #err, which the recorder refuses.
function runShim() {
  const html = chromePage('x');
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  class CharacterData {
    constructor() {
      this.data = '';
    }
    appendData(s) {
      this.data += s;
    }
  }
  const nodes = {};
  const handlers = {};
  const ctx = {
    TextEncoder,
    btoa,
    CharacterData,
    location: { origin: 'http://127.0.0.1:1' },
    addEventListener: (type, fn) => (handlers[type] = fn),
    document: {
      createTextNode: () => new CharacterData(),
      getElementById: (id) => ({ appendChild: (n) => (nodes[id] = n) }),
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  const dom = () => `<pre id="out">${nodes.out.data}</pre><pre id="err">${nodes.err.data}</pre>`;
  return { ctx, handlers, dom };
}

test('the Chrome shim prints String(value) and a newline per call, as UTF-8 through base64', () => {
  const { ctx, dom } = runShim();
  ctx.print('h\u00e9llo \u2615 \ud83d\ude00');
  ctx.print(42);
  ctx.print('lone \ud800');
  assert.equal(readSink(dom(), 'out'), 'h\u00e9llo \u2615 \ud83d\ude00\n42\nlone \ufffd\n');
  assert.equal(readSink(dom(), 'err'), '');
  assert.equal(ctx.ORIGIN, 'http://127.0.0.1:1');
});

test('the Chrome shim records a page error and an unhandled rejection in #err', () => {
  const { handlers, dom } = runShim();
  handlers.error({ message: 'Uncaught boom' });
  handlers.unhandledrejection({ reason: 'nope' });
  assert.equal(readSink(dom(), 'err'), 'error: Uncaught boom\nunhandled rejection: nope\n');
  assert.equal(readSink('<pre id="out"></pre>', 'err'), null);
});

// --- the runner's whole-suite rules, through the CLI ---------------------------------

const FLOOR = JSON.parse(readFileSync(join(ROOT, 'runtime/gates/case-counts.json'), 'utf8')).suites[
  'tests/web/cases'
].min;

// A throwaway suite of `count` cases whose recording is 'x\n', and a stand-in lava
// that prints exactly that: every case passes, so only suite-level rules can fail.
function runSuite(count, extra, lava = "#!/bin/sh\nprintf 'x\\n'\n") {
  const dir = mkdtempSync(join(tmpdir(), 'web-oracle-suite-'));
  try {
    const cases = join(dir, 'cases');
    mkdirSync(cases);
    mkdirSync(join(dir, 'known'));
    writeFileSync(join(dir, 'known-gaps.txt'), '# none\n');
    const meta = { chrome: 'Google Chrome 0', date: 'd', runs: 3, command: 'c' };
    for (let i = 0; i < count; i++) {
      writeFileSync(join(cases, `t-${i}.js`), "print('x');\n");
      writeFileSync(join(cases, `t-${i}.expected`), formatExpected(meta, 'x\n'));
    }
    if (extra) extra(dir);
    const fake = join(dir, 'lava');
    writeFileSync(fake, lava);
    chmodSync(fake, 0o755);
    return spawnSync(process.execPath, [join(ROOT, 'scripts/run-web-oracle.mjs')], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, LAVA_BIN: fake, WEB_ORACLE_SUITE: dir },
      timeout: 60_000,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a clean throwaway suite at the floor passes', () => {
  const r = runSuite(FLOOR);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`${FLOOR} pass, 0 known, 0 fail`));
});

// The mutation gate reads the report through a pipe; process.exit() used to drop the
// part still queued on it (see the same test in run-dom-oracle.test.mjs).
test('a long failing run reaches a pipe whole: every FAIL line and the summary', () => {
  // Each run prints 4 KiB of stderr, which lands in its failure's detail.
  const noisy = "#!/bin/sh\nhead -c 4096 /dev/zero | tr '\\0' x >&2\nprintf 'y\\n'\n";
  const r = runSuite(FLOOR, null, noisy);
  assert.equal(r.status, 1, r.stderr);
  for (let i = 0; i < FLOOR; i++) {
    assert.match(r.stdout, new RegExp(`^FAIL t-${i}$`, 'm'));
  }
  assert.match(r.stdout, new RegExp(`web oracle: 0 pass, 0 known, ${FLOOR} fail\\n$`));
});

test('an orphaned pin fails the run even when every case passes', () => {
  const r = runSuite(FLOOR, (dir) => writeFileSync(join(dir, 'known', 'zzz.lava'), '# exit 0\n'));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /FAIL tests\/web\/known\/zzz\.lava has no known-gaps\.txt entry/);
  assert.match(r.stdout, new RegExp(`${FLOOR} pass, 0 known, 1 fail`));
});

test('a suite below the case-count floor fails before running anything', () => {
  const r = runSuite(FLOOR - 1);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /case-count/);
  assert.doesNotMatch(r.stdout, /pass, 0 known/);
});
