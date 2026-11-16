// node:process / node:console must export the intrinsic, not a lazy global read.
//
// The factories used to do `module.exports = process` / `= console`, so the first
// require after a dependency reassigned (or deleted) globalThis.process /
// globalThis.console captured the shim. Node's require('node:process') /
// require('node:console') always return the intrinsic module object regardless
// of global mutation (node 26.13.0, verified by this case). Found in Codex review of #246; #247.
//
// NOTHING under test may be required above the swaps — a prior require would
// populate the module cache with the real object and this case would pass with
// the fix reverted. Verified by mutation (see tests/mutation-manifest.json).
const assert = require('node:assert/strict');

const realProcess = process;
const realConsole = console;

// Swap BEFORE the first require of either module. That is the whole point.
globalThis.process = { fake: true, pid: -1 };
globalThis.console = {
  fake: true,
  log: function () {},
  error: function () {},
  warn: function () {},
};

const proc = require('node:process');
const con = require('node:console');

// --- process: intrinsic, not the shim ---
assert.strictEqual(proc, realProcess, 'require("node:process") must be the intrinsic');
assert.notStrictEqual(proc, globalThis.process, 'must not capture the reassigned global');
assert.equal(typeof proc.pid, 'number');
assert.notEqual(proc.pid, -1);
assert.equal(proc.fake, undefined);

// --- console: intrinsic, not the shim ---
assert.strictEqual(con, realConsole, 'require("node:console") must be the intrinsic');
assert.notStrictEqual(con, globalThis.console, 'must not capture the reassigned global');
assert.equal(typeof con.log, 'function');
assert.equal(con.fake, undefined);

// Cache holds the intrinsic across further global mutation.
globalThis.process = { fake2: true };
globalThis.console = { fake2: true };
assert.strictEqual(require('node:process'), realProcess);
assert.strictEqual(require('node:console'), realConsole);

// Delete, but note what this can and cannot prove: both modules are already
// cached above, so this pins only that the cache survives a later delete. It is
// NOT the delete-before-first-require shape — that needs a fresh module cache,
// i.e. its own process, and lives in 67-process-console-deleted-global.js.
delete globalThis.process;
delete globalThis.console;
assert.strictEqual(require('node:process'), realProcess);
assert.strictEqual(require('node:console'), realConsole);

// Restore so the trailing ok line (and any harness) still has working globals.
globalThis.process = realProcess;
globalThis.console = realConsole;

// Unmutated identity — the common case already pinned by 38-stdlib-modules-2.js,
// re-checked here so a fix that only hardens the mutated path cannot drop it.
assert.strictEqual(require('node:process'), process);
assert.strictEqual(require('node:console'), console);

console.log('ok');
