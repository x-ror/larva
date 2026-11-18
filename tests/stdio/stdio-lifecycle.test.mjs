// process.stdout's lifecycle and backpressure, pinned in BOTH of node's non-tty shapes.
//
// This is a node:test rather than an oracle case for the same reason as stdio-write:
// the condition is set by the PARENT, not by the script under test. `process.stdout` is
// polymorphic in node — a `SyncWriteStream` on a file, a `net.Socket` on a pipe — and the
// two disagree with each other, so a case that only ever runs under one of them pins half
// the surface. The compat harness redirects stdout to a file
// (`>"$node_stdout"` in scripts/lib/compare.sh), so tests/node-compat/cases/61 is the file
// half; this file is the pipe half, and it is where Lava's two declared deviations live.
//
// Measured on node 26.13.0, `write('A'); end('B'); <tick>; write('C')`:
//
//   shape   node stdout   node exit   why
//   file    A B C         0           SyncWriteStream + dummyDestroy: end() is undone
//   pipe    A B           1           Socket: end() half-closes, next write is EPIPE
//
// Lava is one shape for every fd and recovers in both. That is deliberate: it holds no
// socket, so there is nothing an end() could half-close, and reproducing node's pipe crash
// would mean closing fd 1 and losing every later byte in the process. Declared in
// js/internal/stdio.js's @deviates.
//
// The tests below assert node's side too, not just Lava's. A deviation pin that only
// checks Lava silently becomes wrong the day node changes; asserting both makes this go
// red instead, which is the point of recording it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LAVA = process.env.LAVA_BIN || join(ROOT, 'bin', 'lava');
const NODE = process.env.NODE_BIN || process.execPath;
const DIR = mkdtempSync(join(tmpdir(), 'lava-stdio-life-'));

let seq = 0;
function scriptFile(source) {
  const file = join(DIR, `s-${seq++}.js`);
  writeFileSync(file, source);
  return file;
}

// shape: 'pipe' hands the child a pipe (node's stdout becomes a net.Socket); 'file'
// redirects to a real file (node's stdout becomes a SyncWriteStream).
function run(bin, file, shape) {
  return new Promise((resolve, reject) => {
    const args = bin === LAVA ? ['run', file] : [file];
    const outPath = join(DIR, `o-${seq++}.txt`);
    if (shape === 'file') {
      // `sh -c` so the redirect is a genuine O_WRONLY file on fd 1, which is what the
      // compat harness does and what makes node pick SyncWriteStream.
      const cmd = [bin, ...args].map((a) => `'${a.replaceAll("'", `'\\''`)}'`).join(' ');
      const child = spawn('sh', ['-c', `${cmd} > '${outPath}' 2>/dev/null`], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout: readFileSync(outPath, 'utf8') }));
      return;
    }
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout }));
  });
}

const LIFECYCLE = `
const s = process.stdout;
s.write('A\\n');
s.end('B\\n');
setTimeout(function () {
  try { s.write('C\\n'); } catch (e) { /* surfaces as a nonzero exit either way */ }
}, 20);
`;

test('file shape: end() is undone on both runtimes, byte-identical', async () => {
  const file = scriptFile(LIFECYCLE);
  const n = await run(NODE, file, 'file');
  const l = await run(LAVA, file, 'file');
  assert.equal(n.stdout, 'A\nB\nC\n', 'node recovers from end() on a file');
  assert.equal(n.code, 0);
  assert.equal(l.stdout, n.stdout, 'lava must match node byte-for-byte on a file');
  assert.equal(l.code, n.code);
});

test('pipe shape: node dies on the write after end(), lava recovers (declared deviation)', async () => {
  const file = scriptFile(LIFECYCLE);
  const n = await run(NODE, file, 'pipe');
  const l = await run(LAVA, file, 'pipe');
  // node's stdout is a Socket here: end() half-closes it and the next write is a fatal
  // EPIPE. If this assertion ever fails, node changed and the deviation below is no
  // longer a deviation — re-measure before touching Lava.
  assert.equal(n.stdout, 'A\nB\n', 'node must drop the post-end() write on a pipe');
  assert.notEqual(n.code, 0, 'node must exit nonzero on the post-end() write');
  // Lava: no socket, so nothing is half-closed and the byte still lands.
  assert.equal(l.stdout, 'A\nB\nC\n', 'lava must keep writing after end() on a pipe');
  assert.equal(l.code, 0, 'lava must not die on the post-end() write');
});

const DESTROY = `
const s = process.stdout;
s.write('A\\n');
s.destroy();
setTimeout(function () {
  try { s.write('C\\n'); } catch (e) { /* surfaces as a nonzero exit either way */ }
}, 20);
`;

// destroy() is shape-INDEPENDENT on node, unlike end(): `_destroy` is the dummy, and it
// never touches the socket, so nothing is half-closed and the stream comes back in both
// shapes. Measured: node prints A, C and exits 0 on a file AND on a pipe. No deviation
// here — Lava must match node exactly in both.
for (const shape of ['file', 'pipe']) {
  test(`${shape} shape: destroy() is undone, on node and lava alike`, async () => {
    const file = scriptFile(DESTROY);
    const n = await run(NODE, file, shape);
    const l = await run(LAVA, file, shape);
    assert.equal(n.stdout, 'A\nC\n', `node recovers from destroy() on a ${shape}`);
    assert.equal(n.code, 0);
    assert.equal(l.stdout, n.stdout, `lava must match node on a ${shape}`);
    assert.equal(l.code, n.code);
  });
}

const PIPE_TO_STDOUT = `
const stream = require('node:stream');
var finished = 0;
process.stdout.on('finish', function () { finished++; });
const src = new stream.Readable({ read() {} });
src.push('one\\n');
src.push(null);
src.pipe(process.stdout);
src.on('end', function () {
  setTimeout(function () { process.stdout.write('two finished=' + finished + '\\n'); }, 20);
});
`;

// The P0 this file was added for: node's pipe() excludes the stdio singletons from the
// automatic dest.end(), so `src.pipe(process.stdout)` leaves stdout alive. No deviation
// here — Lava must match node exactly in both shapes.
//
// The `finished=` counter is load-bearing, and the obvious version of this test does not
// work. Because `_destroy` now undoes the teardown, a pipe that wrongly ends stdout
// recovers before the 20ms write lands, so 'two' arrives either way and the byte
// comparison alone passes with the exclusion deleted — confirmed by mutation. What does
// not recover is the fact that 'finish' was emitted at all.
for (const shape of ['file', 'pipe']) {
  test(`${shape} shape: src.pipe(process.stdout) leaves stdout writable`, async () => {
    const file = scriptFile(PIPE_TO_STDOUT);
    const n = await run(NODE, file, shape);
    const l = await run(LAVA, file, shape);
    assert.equal(n.stdout, 'one\ntwo finished=0\n', 'node never reaches end() on stdout');
    assert.equal(n.code, 0);
    assert.equal(l.stdout, n.stdout, `lava must match node on a ${shape}`);
    assert.equal(l.code, n.code);
  });
}

const BACKPRESSURE = `
const ok = process.stdout.write('x'.repeat(1 << 20));
require('node:fs').writeFileSync(process.env.REPORT, String(ok) + ' ' + String(process.stdout.writableLength));
`;

test('pipe shape: write() returns true where node reports backpressure (declared deviation)', async () => {
  const file = scriptFile(BACKPRESSURE);
  const report = join(DIR, `bp-${seq++}.txt`);
  const runWithReport = (bin) =>
    new Promise((resolve, reject) => {
      const args = bin === LAVA ? ['run', file] : [file];
      const child = spawn(bin, args, {
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, REPORT: report },
      });
      let bytes = 0;
      child.stdout.on('data', (d) => {
        bytes += d.length;
      });
      child.on('error', reject);
      child.on('close', () => resolve({ bytes, report: readFileSync(report, 'utf8') }));
    });

  const n = await runWithReport(NODE);
  assert.equal(n.report, 'false 1048576', 'node buffers a 1 MB pipe write and reports false');
  assert.equal(n.bytes, 1 << 20, 'node still delivers every byte');

  const l = await runWithReport(LAVA);
  // The deviation, stated exactly: true and 0, because the bytes are already on the fd.
  assert.equal(l.report, 'true 0', 'lava writes through, so there is no queue to report');
  assert.equal(l.bytes, 1 << 20, 'and every byte must still arrive');
});
