// A native call that borrows a TypedArray must honor the view's byteOffset
// (issue #68): pre-fix it used the ArrayBuffer base and ignored the offset, so an
// offset view (e.g. Buffer.subarray / new Uint8Array(buf, offset)) was written at
// the wrong position. Assertions are shape-only (no random values printed), so
// Node and Lava produce identical output. This case also guards the fix on the
// macOS CI backend, whose JSC may handle the pointer differently from Linux.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// randomFillSync(buffer, offset, size) must fill exactly [offset, offset+size).
const b = Buffer.alloc(16); // zeroed
crypto.randomFillSync(b, 8, 8);
assert.ok(
  Array.from(b.subarray(0, 8)).every((x) => x === 0),
  'bytes before offset untouched',
);
assert.ok(
  Array.from(b.subarray(8, 16)).some((x) => x !== 0),
  'target region filled',
);

// getRandomValues on an offset view: only the view's bytes change.
const buf = new ArrayBuffer(24);
crypto.getRandomValues(new Uint8Array(buf, 8, 8));
assert.ok(
  new Uint8Array(buf, 0, 8).every((x) => x === 0),
  'bytes before view untouched',
);
assert.ok(
  new Uint8Array(buf, 16, 8).every((x) => x === 0),
  'bytes after view untouched',
);
