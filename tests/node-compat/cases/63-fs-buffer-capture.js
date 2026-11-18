// fs must not resolve Buffer through the mutable `node:buffer` exports.
//
// `js/node/fs.js` is a LAZY internal module: its factory does not run until user code
// calls require('fs'). A `require('buffer').Buffer` capture at ITS module-eval therefore
// reads whatever the exports object holds by then — and that is the same object user code
// holds. §5's "capture at module-eval is safe" rule only holds for modules the LOADER
// instantiates before user code, which fs is not.
//
// The realistic shape is not adversarial. A dependency's top-level body runs before the
// app's first require('fs'), and assigning `exports.Buffer` is something real packages do
// (browserify's buffer shim, test doubles, instrumentation). With a late capture, such a
// package both READS every file the app loads and REWRITES what the app receives:
//
//   node       app sees: "top secret"   dep captured: []
//   lava (pre) app sees: "TAMPERED"     dep captured: ["top secret"]
//
// loader.js snapshots Buffer.from / isEncoding / prototype.toString immediately after it
// eager-instantiates buffer, and hands them to every migrated internal module as
// `require.pristineBuffer`, so the capture provably precedes user code. (fs took them
// through its `natives` argument until #333 unified the two channels.)
//
// This is an ORACLE case rather than a Lava-only one because the fix makes Lava agree with
// node: node's fs builds its result from an internal binding, so the shim never sees it.
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

// Swap the public Buffer export BEFORE the first require('fs'), the way a dependency's
// top-level body would. Keep the real one for the harness's own use.
const bufferModule = require('node:buffer');
const RealBuffer = bufferModule.Buffer;
const seen = [];

function Shim() {}
Shim.prototype = RealBuffer.prototype;
Shim.isEncoding = RealBuffer.isEncoding;
Shim.alloc = RealBuffer.alloc;
Shim.from = function (a, b, c) {
  // The three-argument form is the fs read re-tag. Record what it would have exfiltrated
  // and hand back something else entirely.
  if (arguments.length === 3) {
    seen.push(RealBuffer.from(a, b, c).toString('utf8'));
    return RealBuffer.from('TAMPERED');
  }
  return RealBuffer.from(a, b, c);
};
bufferModule.Buffer = Shim;

// Only now require fs, which is when a lazily-captured Buffer would be taken.
const fs = require('node:fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lava-fscap-'));
const file = path.join(dir, 'secret.txt');
fs.writeFileSync(file, 'top secret config');

const got = fs.readFileSync(file);
assert.equal(got.toString('utf8'), 'top secret config', 'the shim must not steer the read');
assert.equal(seen.length, 0, 'the shim must not observe the file contents');
assert.equal(RealBuffer.isBuffer(got), true, 'and the result is still a real Buffer');

// The encoded path routes through Buffer.prototype.toString, captured at the same point.
assert.equal(fs.readFileSync(file, 'utf8'), 'top secret config');
assert.equal(seen.length, 0);

// Restore before exiting so nothing downstream inherits the shim.
bufferModule.Buffer = RealBuffer;
fs.rmSync(dir, { recursive: true });
console.log('ok');
