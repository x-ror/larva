// Large / unpooled unsafe allocation (issue #212). Buffer.allocUnsafe above the
// pool threshold and Buffer.allocUnsafeSlow get their own backing store (Node 26
// removed SlowBuffer, so it is no longer exercised here). Node leaves those bytes uninitialized (its allocator skips the
// zero-fill); Lava now backs them with a native uninitialized allocation instead
// of a zero-filled `new Buffer(size)`.
//
// Reading uninitialized memory is undefined behavior and non-deterministic, so
// this case never asserts anything about the *values* of unwritten bytes. It
// asserts only the observable, deterministic guarantees that must hold on both
// engines: correct length / byteOffset / own right-sized backing store, faithful
// read-write round-trips (including through the native codecs and shared
// subarray views), that the copy paths (Buffer.from / Buffer.concat) never leak
// stale bytes, that Buffer.alloc stays fully zero-filled, and that an impossible
// size still throws RangeError. These are pure ArrayBuffer/Uint8Array semantics
// and so behave identically on Linux, macOS/Darwin, and Windows.
const assert = require('node:assert/strict');

const HALF = Buffer.poolSize >>> 1; // exactly the pool threshold (not pooled)
const BIG = Buffer.poolSize + 4096; // comfortably above the pool, and != poolSize

// --- Large allocUnsafe: own right-sized store, fully usable -----------------
// Sizes are derived from poolSize so they stay above the pool threshold (and
// distinct from poolSize) regardless of the runtime's default (8192 vs 65536).
for (const size of [HALF, BIG, Buffer.poolSize * 2, 250000]) {
  const b = Buffer.allocUnsafe(size);
  assert.ok(b instanceof Buffer, 'allocUnsafe returns a Buffer');
  assert.equal(b.length, size, 'allocUnsafe length');
  assert.equal(b.byteOffset, 0, 'large allocUnsafe is not pooled (byteOffset 0)');
  assert.equal(b.buffer.byteLength, size, 'large allocUnsafe owns a right-sized store');
  assert.notEqual(b.buffer.byteLength, Buffer.poolSize, 'and is not the shared pool');

  // Write-then-read round-trip over the whole buffer: every byte we set reads
  // back exactly, so the native backing is real, writable memory of full length.
  b.fill(0);
  b[0] = 0xab;
  b[size - 1] = 0xcd;
  assert.equal(b[0], 0xab, 'first byte round-trips');
  assert.equal(b[size - 1], 0xcd, 'last byte round-trips');
  b.writeUInt32BE(0xdeadbeef, 4);
  assert.equal(b.readUInt32BE(4), 0xdeadbeef, 'numeric read/write on native-backed buffer');
}

// --- Native codecs honor a native-backed (byteOffset 0) buffer --------------
{
  const b = Buffer.allocUnsafe(BIG);
  b.fill(0);
  const pattern = [0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04];
  for (let i = 0; i < pattern.length; i++) b[i] = pattern[i];
  assert.equal(b.toString('hex', 0, 8), 'deadbeef01020304', 'hex over native-backed buffer');
  assert.equal(b.toString('base64', 0, 8), '3q2+7wECAwQ=', 'base64 over native-backed buffer');
  b.write('héllo-世界', 0, 'utf8');
  assert.equal(
    b.toString('utf8', 0, Buffer.byteLength('héllo-世界')),
    'héllo-世界',
    'utf8 round-trip',
  );
}

// --- subarray shares the native backing and writes through ------------------
{
  const b = Buffer.allocUnsafe(64);
  b.fill(0x11);
  const sub = b.subarray(8, 16);
  assert.ok(sub instanceof Buffer, 'subarray is a Buffer');
  assert.equal(sub.length, 8);
  assert.equal(sub.buffer, b.buffer, 'subarray shares the same backing store');
  assert.equal(sub[0], 0x11, 'subarray sees the parent bytes');
  sub[0] = 0x22;
  assert.equal(b[8], 0x22, 'writing the subarray writes through to the parent');
}

// --- copy in/out of a native-backed buffer ----------------------------------
{
  const dst = Buffer.allocUnsafe(BIG);
  dst.fill(0);
  const src = Buffer.from([1, 2, 3, 4, 5]);
  const n = src.copy(dst, 100);
  assert.equal(n, 5, 'copy reports bytes written');
  assert.deepEqual([...dst.subarray(100, 105)], [1, 2, 3, 4, 5], 'copy lands the bytes');
  assert.equal(dst[99], 0, 'byte before the copy is untouched');
  assert.equal(dst[105], 0, 'byte after the copy is untouched');
}

// --- allocUnsafeSlow: own store at every size (never pooled) -----------------
for (const size of [1, 8, HALF, 70000]) {
  const s = Buffer.allocUnsafeSlow(size);
  assert.ok(s instanceof Buffer, 'allocUnsafeSlow returns a Buffer');
  assert.equal(s.length, size);
  assert.equal(s.byteOffset, 0, 'allocUnsafeSlow is never pooled');
  assert.equal(s.buffer.byteLength, size, 'allocUnsafeSlow owns a right-sized store');
  s.fill(0x5a);
  assert.equal(s[0], 0x5a);
  assert.equal(s[size - 1], 0x5a);
}

// --- Copy paths over a large (native-backed) result never leak stale bytes ---
// Buffer.from must reflect exactly the source bytes, and Buffer.concat must
// zero-fill any tail an explicit length leaves uncovered, even though the
// underlying store is now uninitialized.
{
  const text = 'q'.repeat(BIG);
  const fromStr = Buffer.from(text);
  assert.equal(fromStr.buffer.byteLength, BIG, 'large from(string) is unpooled');
  for (let i = 0; i < BIG; i++) assert.equal(fromStr[i], 0x71, 'from(string) byte ' + i);

  const arr = Array.from({ length: BIG }, (_, i) => i & 0xff);
  const fromArr = Buffer.from(arr);
  for (let i = 0; i < BIG; i++) assert.equal(fromArr[i], i & 0xff, 'from(array) byte ' + i);

  const padded = Buffer.concat([Buffer.from([0xaa, 0xbb])], BIG);
  assert.equal(padded.length, BIG);
  assert.equal(padded.buffer.byteLength, BIG, 'large concat result is unpooled');
  assert.equal(padded[0], 0xaa);
  assert.equal(padded[1], 0xbb);
  for (let i = 2; i < BIG; i++) assert.equal(padded[i], 0, 'concat tail zero-filled at ' + i);
}

// --- Buffer.alloc stays fully zero-filled (must NOT use the unsafe path) -----
{
  const z = Buffer.alloc(100000);
  assert.equal(z.buffer.byteLength, 100000, 'alloc owns a right-sized store');
  for (let i = 0; i < z.length; i++) {
    if (z[i] !== 0) assert.fail('Buffer.alloc must be zero-filled, got ' + z[i] + ' at ' + i);
  }
  // A fill value still works on a large alloc.
  const f = Buffer.alloc(5000, 0x7);
  for (let i = 0; i < f.length; i++) assert.equal(f[i], 0x7, 'alloc(size, fill) at ' + i);
}

// --- An impossible (but <= MAX_SAFE) size still throws RangeError ------------
// The native fast-path declines (allocation fails / exceeds its cap) and the JS
// layer falls back to `new Buffer(size)`, which throws exactly as Node does.
{
  const MAX = Number.MAX_SAFE_INTEGER;
  for (const fn of [
    () => Buffer.allocUnsafe(MAX),
    () => Buffer.allocUnsafeSlow(MAX),
    () => Buffer.allocUnsafe(2 ** 48),
  ]) {
    assert.throws(fn, RangeError, 'impossible size throws RangeError');
  }
}

console.log('buffer-allocunsafe-large OK');
