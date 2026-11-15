// A synchronous top-level throw reaches stderr before teardown, not after it.
//
// This is a node:test rather than an oracle case because neither runtime exits: the
// script starts fs.readFile on a FIFO nobody writes, so a pool worker sits in open()
// for good, and both runtimes join that worker on the way out — node (libuv) at
// process exit, Lava in eval's deferred loop teardown. The compat harness waits for an
// exit and would only ever see a timeout. What CAN be compared is whether the uncaught
// error has been written by the time the process is stuck in that join.
//
// Measured on node v24.22.1 (probe case H): node prints the error and its stack to
// stderr at once and then hangs. Lava hung with EMPTY stderr: the CLI printed the
// Result only after runtime.eval returned, and eval's deferred eventloop.destroy joins
// the worker first. The fix is eval's `report` hook (runtime.odin), which the CLI passes
// print_result as, so the report runs before the defers.
//
// Each child is killed by the test itself once stderr shows the message or after
// WAIT_MS, so a regression reads as `false`, never as a hang reaching a gate timeout.
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
const MESSAGE = 'lava-uncaught-before-teardown';

const DIR = mkdtempSync(join(tmpdir(), 'lava-uncaught-'));
test.after(() => rmSync(DIR, { recursive: true, force: true }));

// The throw must come only once the read is really stuck in a pool worker: a job no
// worker has taken yet is dropped at teardown (Lava) or never run at exit (libuv), and
// the process just exits 1 — measured on 2 CPUs, node did that in 3 of 30 runs when the
// script threw right after readFile. Opening the FIFO's write end to detect the reader
// does not work either: node's readFile opens in one pool job and reads in the next,
// which it submits from the main thread — so once the open succeeds, nothing is left
// blocked. Instead the harness watches the child's threads (Linux /proc) until one
// sleeps in the kernel's FIFO open (wchan `wait_for_partner`), and only then creates GO,
// which the script spins on before it throws.
const SCRIPT = join(DIR, 'throw-with-blocked-read.js');
writeFileSync(
  SCRIPT,
  [
    `const fs = require('fs');`,
    `fs.readFile(process.argv[2], () => {});`,
    `while (!fs.existsSync(process.argv[3])) {}`,
    `throw new Error('${MESSAGE}');`,
    '',
  ].join('\n'),
);
const CONTROL = join(DIR, 'throw.js');
writeFileSync(CONTROL, `throw new Error('${MESSAGE}');\n`);

let seq = 0;
function fifo() {
  const path = join(DIR, `f-${seq++}.fifo`);
  execFileSync('mkfifo', [path]);
  return path;
}

// inFifoOpen reports whether any thread of `pid` is asleep in open() on a FIFO with no
// writer. A thread that exits between the listing and the read is skipped.
function inFifoOpen(pid) {
  let tasks;
  try {
    tasks = readdirSync(`/proc/${pid}/task`);
  } catch {
    return false;
  }
  return tasks.some((tid) => {
    try {
      return readFileSync(`/proc/${pid}/task/${tid}/wchan`, 'utf8') === 'wait_for_partner';
    } catch {
      return false;
    }
  });
}

// Resolves { reported, blocked, code, stderr }: reported is whether stderr carried
// MESSAGE within WAIT_MS; blocked whether a worker was seen in open() on `fifoPath`
// (always false without one); code is the exit status, or null when the child had to be killed.
function watch(bin, file, fifoPath) {
  return new Promise((resolve, reject) => {
    const go = fifoPath ? `${fifoPath}.go` : '';
    const args = fifoPath ? [file, fifoPath, go] : [file];
    const child = spawn(bin, bin === LAVA ? ['run', ...args] : args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
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
    const timer = setTimeout(() => child.kill('SIGKILL'), WAIT_MS);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      stderr += d;
      if (!reported && stderr.includes(MESSAGE)) {
        reported = true;
        clearTimeout(timer);
        // Give an exiting process a moment to exit on its own (the control case);
        // one stuck in the join gets killed.
        setTimeout(() => child.kill('SIGKILL'), 300);
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (poll) clearInterval(poll);
      resolve({ reported, blocked, code, stderr });
    });
  });
}

test('a top-level throw is reported while a pool worker is still blocked', async () => {
  const [node, lava] = await Promise.all([
    watch(NODE, SCRIPT, fifo()),
    watch(LAVA, SCRIPT, fifo()),
  ]);
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
});

test('a top-level throw with nothing pending is reported once and exits 1', async () => {
  const [node, lava] = await Promise.all([watch(NODE, CONTROL), watch(LAVA, CONTROL)]);
  assert.deepEqual([node.reported, node.code], [true, 1]);
  assert.deepEqual([lava.reported, lava.code], [true, 1]);
  // Lava's report is the bare `Error: <message>` line, printed exactly once: the
  // hook replaces the CLI's print after eval, it does not add a second one.
  assert.equal(lava.stderr, `Error: ${MESSAGE}\n`);
});
