// A synchronous top-level throw reaches stderr before teardown, not after it.
//
// This is a node:test rather than an oracle case because neither runtime exits: the
// script starts fs.readFile on a FIFO nobody writes, so a pool worker sits in open()
// for good, and both runtimes join that worker on the way out — node (libuv) at
// process exit, Lava in eval's deferred loop teardown. The compat harness waits for an
// exit and would only ever see a timeout. What CAN be compared is whether the uncaught
// error has been written by the time the process is stuck in that join.
//
// Measured on node v26.13.0 (probe case H): node prints the error and its stack to
// stderr at once and then hangs. Lava hung with EMPTY stderr: the CLI printed the
// Result only after runtime.eval returned, and eval's deferred eventloop.destroy joins
// the worker first. The fix is eval's `report` hook (runtime.odin), which the CLI passes
// print_result as, so the report runs before the defers.
//
// Both CLI entry points are covered — `lava run <file>` against `node <file>`, and
// `lava eval <src>` against `node -e <src>` — since each passes the hook separately.
//
// Each child is killed by the test itself, as a whole process group, once stderr shows
// the message or after WAIT_MS, so a regression reads as `false`, never as a hang
// reaching a gate timeout.
// The assertions cover node's side too: if node ever stopped printing first, this goes
// red instead of silently pinning a stale reading.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LAVA = process.env.LAVA_BIN || join(ROOT, 'bin', 'lava');
const NODE = process.env.NODE_BIN || process.execPath;
const WAIT_MS = 3000;
// How long a child that printed is given to exit on its own before it is killed. Only
// the control case relies on it (it must exit 1 by itself); generous, since a loaded
// runner can be slow to reap a process that has already written its last byte.
const EXIT_GRACE_MS = 1000;
const MESSAGE = 'lava-uncaught-before-teardown';

const DIR = mkdtempSync(join(tmpdir(), 'lava-uncaught-'));
test.after(() => rmSync(DIR, { recursive: true, force: true }));

// Every child runs in its own process group (detached), and the group is killed, so a
// runtime's worker threads and anything it spawned go with it. Groups still alive when
// this process exits — a failed assertion, a crashed runner — are killed on the way out.
const live = new Set();
function killGroup(child) {
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // already gone
  }
}
process.on('exit', () => {
  for (const child of live) killGroup(child);
});

// The throw must come only once the read is really stuck in a pool worker: a job no
// worker has taken yet is dropped at teardown (Lava) or never run at exit (libuv), and
// the process just exits 1 — measured on 2 CPUs, node did that in 3 of 30 runs when the
// script threw right after readFile. Opening the FIFO's write end to detect the reader
// does not work either: node's readFile opens in one pool job and reads in the next,
// which it submits from the main thread — so once the open succeeds, nothing is left
// blocked. Instead the harness watches the child's threads through /proc until one
// sleeps in the kernel's FIFO open, and only then creates GO, which the script spins on
// before it throws.
//
// The wait shows in /proc/<pid>/task/<tid>/wchan as a Linux kernel symbol:
// `wait_for_partner` on the 6.x kernels this was written on (whose stack reads
// wait_for_partner <- fifo_open), and `fifo_open` where that helper is inlined. Kernel
// symbols are not ABI, so the gate is probed once below on a shell blocked opening a
// FIFO; where it cannot be observed (not Linux, wchan unreadable, or reading "0" under
// a restricted kptr policy) the blocked-worker tests SKIP with the reason, rather than
// pass without having seen a worker blocked.
const FIFO_OPEN_WCHAN = new Set(['wait_for_partner', 'fifo_open']);

let seq = 0;
function fifo() {
  const path = join(DIR, `f-${seq++}.fifo`);
  execFileSync('mkfifo', [path]);
  return path;
}

// wchans lists the wchan of every thread of `pid`; a thread that exits between the
// listing and the read is left out.
function wchans(pid) {
  let tasks;
  try {
    tasks = readdirSync(`/proc/${pid}/task`);
  } catch {
    return [];
  }
  const out = [];
  for (const tid of tasks) {
    try {
      out.push(readFileSync(`/proc/${pid}/task/${tid}/wchan`, 'utf8').trim());
    } catch {
      // thread gone
    }
  }
  return out;
}

const inFifoOpen = (pid) => wchans(pid).some((w) => FIFO_OPEN_WCHAN.has(w));

// probeGate blocks `sh` in open() on a fresh FIFO and reports why the gate cannot be
// observed here, or '' when a thread was seen in the FIFO open.
async function probeGate() {
  if (process.platform !== 'linux') return `needs Linux /proc wchan (platform ${process.platform})`;
  const path = fifo();
  const child = spawn('sh', ['-c', `exec 3<'${path}'`], { stdio: 'ignore', detached: true });
  live.add(child);
  const seen = new Set();
  try {
    for (const deadline = Date.now() + 2000; Date.now() < deadline;) {
      for (const w of wchans(child.pid)) seen.add(w);
      if (inFifoOpen(child.pid)) return '';
      await new Promise((r) => setTimeout(r, 5));
    }
  } finally {
    killGroup(child);
    live.delete(child);
  }
  return `no thread blocked in a FIFO open showed wchan ${[...FIFO_OPEN_WCHAN].join('/')} (saw: ${[...seen].join(', ') || 'nothing readable'})`;
}
const SKIP_BLOCKED = await probeGate();

const blockedSource = (fifoPath, go) =>
  [
    `const fs = require('fs');`,
    `fs.readFile(${JSON.stringify(fifoPath)}, () => {});`,
    `while (!fs.existsSync(${JSON.stringify(go)})) {}`,
    `throw new Error('${MESSAGE}');`,
    '',
  ].join('\n');

// Resolves { reported, blocked, code, stderr }: reported is whether stderr carried
// MESSAGE within WAIT_MS; blocked whether a worker was seen in open() on `fifoPath`
// (always false without one); code is the exit status, or null when the child had to
// be killed. `argv(source)` turns the script into the command line.
function watch(bin, argv, fifoPath, source) {
  return new Promise((resolve, reject) => {
    const go = fifoPath ? `${fifoPath}.go` : '';
    const child = spawn(bin, argv(fifoPath ? blockedSource(fifoPath, go) : source), {
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: true,
    });
    live.add(child);
    let stderr = '';
    let reported = false;
    let blocked = false;
    const poll = fifoPath
      ? setInterval(() => {
          if (!inFifoOpen(child.pid)) return;
          clearInterval(poll);
          blocked = true;
          writeFileSync(go, '');
        }, 5)
      : null;
    const timer = setTimeout(() => killGroup(child), WAIT_MS);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      stderr += d;
      if (!reported && stderr.includes(MESSAGE)) {
        reported = true;
        clearTimeout(timer);
        // An exiting process (the control case) exits on its own within the grace;
        // one stuck in the join is killed.
        setTimeout(() => killGroup(child), EXIT_GRACE_MS);
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (poll) clearInterval(poll);
      live.delete(child);
      resolve({ reported, blocked, code, stderr });
    });
  });
}

// A script file per run: the script names its own FIFO and GO paths.
function asFile(source) {
  const file = join(DIR, `s-${seq++}.js`);
  writeFileSync(file, source);
  return file;
}
const nodeRun = (source) => [asFile(source)];
const lavaRun = (source) => ['run', asFile(source)];
const nodeEval = (source) => ['-e', source];
const lavaEval = (source) => ['eval', source];

function expectBlockedReport(node, lava) {
  assert.equal(node.blocked, true, 'no node worker was seen blocked in open() on the FIFO');
  assert.equal(lava.blocked, true, 'no lava worker was seen blocked in open() on the FIFO');
  assert.equal(node.reported, true, `node did not report the throw within ${WAIT_MS} ms`);
  assert.equal(
    lava.reported,
    true,
    `lava did not report the throw within ${WAIT_MS} ms (printed only after teardown)`,
  );
  // Both are stuck joining the worker, so both were killed.
  assert.equal(node.code, null);
  assert.equal(lava.code, null);
}

test(
  'a top-level throw is reported while a pool worker is still blocked',
  { skip: SKIP_BLOCKED || false },
  async () => {
    const [node, lava] = await Promise.all([
      watch(NODE, nodeRun, fifo()),
      watch(LAVA, lavaRun, fifo()),
    ]);
    expectBlockedReport(node, lava);
  },
);

test(
  'lava eval reports a top-level throw while a pool worker is still blocked',
  { skip: SKIP_BLOCKED || false },
  async () => {
    const [node, lava] = await Promise.all([
      watch(NODE, nodeEval, fifo()),
      watch(LAVA, lavaEval, fifo()),
    ]);
    expectBlockedReport(node, lava);
  },
);

test('a top-level throw with nothing pending is reported once and exits 1', async () => {
  const src = `throw new Error('${MESSAGE}');\n`;
  const [node, lava] = await Promise.all([
    watch(NODE, nodeRun, '', src),
    watch(LAVA, lavaRun, '', src),
  ]);
  assert.deepEqual([node.reported, node.code], [true, 1]);
  assert.deepEqual([lava.reported, lava.code], [true, 1]);
  // Lava's report is the bare `Error: <message>` line, printed exactly once: the
  // hook replaces the CLI's print after eval, it does not add a second one.
  assert.equal(lava.stderr, `Error: ${MESSAGE}\n`);
});
