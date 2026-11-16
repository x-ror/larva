// node:process / node:console must survive DELETION of the global before the
// first require — the issue's other mutation shape (#247).
//
// This has to be its OWN process. 66-process-console-intrinsic reassigns the
// globals before the first require and then deletes them at the end, but by then
// both modules are cached: those trailing assertions prove the cache is a cache
// and cannot see a lazy global read at all. Only a fresh module cache can.
//
// Deletion is also a different failure signature, which is why it is worth its
// own case rather than a second swap. A factory that exported the free variable
// `process` reads an undeclared identifier under 'use strict' once the global is
// gone, so it dies with ReferenceError instead of quietly exporting the wrong
// object. Node returns the intrinsic through either shape (node 26.13.0, verified by this case).
//
// NOTHING under test may be required above the delete, and `assert` is required
// only AFTER the globals are restored: assert pulls in util, and a transitive
// require that seeded the module cache first would make this case pass with the
// fix reverted. Verified by mutation (see tests/mutation-manifest.json).
const realProcess = process;
const realConsole = console;

// Delete BEFORE the first require of either module. That is the whole point.
delete globalThis.process;
delete globalThis.console;

// Recorded here, asserted after the restore. A case whose delete silently failed
// (a non-configurable global would refuse it in sloppy mode) would satisfy every
// identity assertion below for the wrong reason, and nothing else can tell.
const deletedProcess = typeof globalThis.process;
const deletedConsole = typeof globalThis.console;

const proc = require('node:process');
const con = require('node:console');

// Restore before touching anything else, so the rest of the case (and the
// harness) runs with working globals.
globalThis.process = realProcess;
globalThis.console = realConsole;

const assert = require('node:assert/strict');

// --- process: intrinsic, not a read of the deleted global ---
assert.strictEqual(proc, realProcess, 'require("node:process") must be the intrinsic');
assert.equal(typeof proc.pid, 'number');
assert.equal(typeof proc.platform, 'string');

// --- console: intrinsic, not a read of the deleted global ---
assert.strictEqual(con, realConsole, 'require("node:console") must be the intrinsic');
assert.equal(typeof con.log, 'function');

// The globals really were gone across the requires above.
assert.equal(deletedProcess, 'undefined', 'delete globalThis.process must have landed');
assert.equal(deletedConsole, 'undefined', 'delete globalThis.console must have landed');

console.log('ok');
