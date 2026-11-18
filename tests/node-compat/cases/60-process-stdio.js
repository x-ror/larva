// process.stdout / process.stderr — the shape node exposes, diffed against node.
//
// Node's `process.stdout` is polymorphic by fd type, which is the part a reimplementation
// gets wrong. Measured against node 26.13.0 (probe, 2026-11-16; tty via script(1)):
//
//   stdout ->  constructor        write(300KB)   isTTY      columns
//   file       SyncWriteStream    true           undefined  undefined
//   pipe       Socket             false          undefined  undefined
//   tty        WriteStream        true           true        <number>
//
// This case runs under the compat harness, which redirects both streams to files, so it
// pins the NON-TTY half only. The TTY half needs a pty and is NOT pinned anywhere yet —
// an earlier version of this comment cited cmd/lava/process_stdio_test.odin, which does
// not exist. Tracked in ROADMAP beside the TIOCGWINSZ entry.
//
// `instanceof stream.Writable` is true for node in all three cases, which is why this is
// built on the real Writable rather than a lookalike: libraries feature-detect with it.
const assert = require('node:assert/strict');
const stream = require('node:stream');

const out = process.stdout;
const err = process.stderr;

// Identity and shape.
assert.equal(typeof out, 'object', 'process.stdout must exist');
assert.equal(typeof err, 'object', 'process.stderr must exist');
assert.equal(out, process.stdout, 'the getter must be stable, not build a new stream');
assert.equal(out.fd, 1);
assert.equal(err.fd, 2);
assert.ok(out instanceof stream.Writable, 'stdout must be a real Writable');
assert.ok(err instanceof stream.Writable, 'stderr must be a real Writable');
assert.equal(typeof out.write, 'function');
assert.equal(typeof out.end, 'function');
assert.equal(typeof out.on, 'function');
assert.equal(typeof out.once, 'function');
assert.equal(typeof out.emit, 'function');
assert.equal(typeof out.cork, 'function');

// Non-TTY: node reports undefined for all three, NOT false/80/24. A capability check
// written as `if (process.stdout.isTTY)` must see undefined, and `columns || 80` must
// fall through to the caller's default rather than to a fake terminal size.
assert.equal(out.isTTY, undefined, 'isTTY is undefined off a terminal, not false');
assert.equal(out.columns, undefined);
assert.equal(out.rows, undefined);

// Writable state.
assert.equal(out.writable, true);
assert.equal(out.writableEnded, false);
assert.equal(out.destroyed, false);

// NOT asserted here, and the omission is deliberate. Node throws ERR_INVALID_ARG_TYPE
// for `write(5)` and ERR_STREAM_NULL_VALUES for `write(null)` SYNCHRONOUSLY; Lava's
// stream.js produces both codes correctly but delivers them as an asynchronous 'error'
// on the stream. Fixing that is a change to every Writable in the tree (net, http, fs) —
// an attempt to do it inside this PR introduced two regressions (a DataView poisoned
// writableLength to NaN and permanently stalled pipe(); the throw also moved the pipe()
// error from the writable onto the readable), so it is reverted and tracked in ROADMAP
// as its own change with its own tests.

// Accepted chunk types.
assert.equal(out.write(''), true);
assert.equal(out.write('', 'utf8'), true);
assert.equal(out.write(Buffer.alloc(0)), true);

// Ordering against console.log — they share the same fd and must not reorder. This is the
// assertion that catches a buffered implementation: anything that queues stdout writes
// while console.log stays synchronous prints these out of order.
process.stdout.write('A');
console.log('B');
process.stdout.write('C');
console.log('D');

// stderr is a separate stream and must not interleave into stdout's ordering above.
process.stderr.write('E1\n');

// The write callback runs, and asynchronously (node does not call it inline).
let cbRan = 'no';
process.stdout.write('F', () => {
  cbRan = 'yes';
});
assert.equal(cbRan, 'no', 'the write callback must not fire synchronously');

// The callback lands on a later turn. A timer rather than process.on('exit') because
// `process.on` does not exist in Lava yet — a separate gap, recorded in ROADMAP, and not
// something this case should smuggle in as a requirement.
setTimeout(() => {
  assert.equal(cbRan, 'yes', 'the write callback must eventually run');
  console.log('done');
}, 0);
