// Buffer allocation pooling (Node parity). Small Buffer.allocUnsafe /
// Buffer.from results are carved out of a shared per-runtime ArrayBuffer (the
// pool) at different byteOffsets, while Buffer.alloc, large allocUnsafe, and
// allocUnsafeSlow keep their own backing store. These properties are pure JS
// over ArrayBuffer/Uint8Array and so behave identically on Linux, macOS/Darwin,
// and Windows — the assertions below make no OS-specific assumptions.
//
// The pool's absolute offset depends on whatever the runtime allocated during
// startup, so this case never asserts a specific byteOffset; it only asserts
// relative, warm-state-independent invariants that hold in Node and Lava alike.
const assert = require('node:assert/strict');

// poolSize defaults differ by runtime (8192 on Node <= 25 / Bun, 65536 on Node
// >= 26.3, which Lava follows), so assert the property both share rather than a
// literal, and derive all pool-dependent sizes from poolSize so the invariants
// hold regardless of its value.
assert.ok(
  Buffer.poolSize > 0 && (Buffer.poolSize & (Buffer.poolSize - 1)) === 0,
  'poolSize is a positive power of two',
);
const HALF = Buffer.poolSize >>> 1; // exactly the pool threshold (strictly <, so not pooled)
const BIG = Buffer.poolSize + 4096; // comfortably above the pool, and != poolSize

// --- Small allocUnsafe shares one backing ArrayBuffer ----------------------
// Over a short run of small allocations at most one pool recreation can occur,
// so the vast majority of consecutive pairs share the same backing store. We
// require at least one sharing pair and check pool invariants on it.
{
  let sawShared = false;
  let prev = Buffer.allocUnsafe(8);
  assert.equal(prev.byteOffset % 8, 0, 'pooled byteOffset is 8-aligned');
  // Node 26 backs the pool with poolSize + 64 bytes (65600 for 65536), so only
  // "at least poolSize" is a guarantee both runtimes share.
  assert.ok(prev.buffer.byteLength >= Buffer.poolSize, 'pooled buffer backs onto the pool');
  for (let i = 0; i < 16; i++) {
    const cur = Buffer.allocUnsafe(8);
    assert.equal(cur.length, 8);
    assert.equal(cur.byteOffset % 8, 0, 'pooled byteOffset stays 8-aligned');
    if (cur.buffer === prev.buffer) {
      sawShared = true;
      // Within one pool, consecutive 8-byte buffers sit 8 bytes apart and never
      // overlap.
      assert.equal(cur.byteOffset - prev.byteOffset, 8, 'pool advances by aligned size');
      assert.notEqual(cur.byteOffset, prev.byteOffset);
    }
    prev = cur;
  }
  assert.ok(sawShared, 'small allocUnsafe calls share a backing ArrayBuffer');
}

// --- 8-byte alignment for non-multiple-of-8 sizes --------------------------
// A 1-byte allocation still advances the pool offset to the next 8-byte
// boundary, so a following allocation in the same pool is 8 bytes along.
{
  let checked = false;
  let prev = Buffer.allocUnsafe(1);
  for (let i = 0; i < 16 && !checked; i++) {
    const cur = Buffer.allocUnsafe(1);
    if (cur.buffer === prev.buffer) {
      assert.equal(cur.byteOffset - prev.byteOffset, 8, '1-byte alloc rounds offset up to 8');
      checked = true;
    }
    prev = cur;
  }
  assert.ok(checked, 'observed 8-byte alignment of a sub-8-byte allocation');
}

// --- Large allocUnsafe does NOT use the pool -------------------------------
// Node's threshold is `size < (poolSize >>> 1)`, so exactly poolSize/2 and
// above get their own backing store (byteOffset 0, buffer sized to the request).
{
  const half = Buffer.allocUnsafe(HALF);
  assert.equal(half.byteOffset, 0, 'poolSize/2 is not pooled');
  assert.equal(half.buffer.byteLength, HALF, 'unpooled buffer owns a right-sized store');

  const big = Buffer.allocUnsafe(BIG);
  assert.equal(big.byteOffset, 0);
  assert.equal(big.buffer.byteLength, BIG);
  assert.notEqual(big.buffer.byteLength, Buffer.poolSize);
}

// --- Buffer.alloc is zero-filled and never shares pooled memory ------------
{
  const z = Buffer.alloc(8);
  assert.equal(z.byteOffset, 0, 'alloc owns its backing store');
  assert.equal(z.buffer.byteLength, 8, 'alloc backing store is exactly the size');
  for (let i = 0; i < z.length; i++) assert.equal(z[i], 0, 'alloc is zero-filled');

  // Two allocs never share a backing store with each other or with the pool.
  const z2 = Buffer.alloc(8);
  assert.notEqual(z.buffer, z2.buffer, 'distinct alloc() buffers');
  const pooled = Buffer.allocUnsafe(8);
  assert.notEqual(z.buffer, pooled.buffer, 'alloc() does not draw from the unsafe pool');
}

// --- allocUnsafeSlow is unpooled -------------------------------------------
{
  const slow = Buffer.allocUnsafeSlow(8);
  assert.equal(slow.byteOffset, 0);
  assert.equal(slow.buffer.byteLength, 8, 'allocUnsafeSlow owns its store');
}

// --- Buffer.from(string) and Buffer.from(array) are pooled for small inputs
{
  let sawShared = false;
  let prev = Buffer.from('ab');
  assert.equal(prev.toString(), 'ab');
  for (let i = 0; i < 16 && !sawShared; i++) {
    const cur = Buffer.from('cd');
    assert.equal(cur.toString(), 'cd', 'pooled from(string) holds its own bytes');
    if (cur.buffer === prev.buffer) {
      sawShared = true;
      assert.ok(cur.buffer.byteLength >= Buffer.poolSize);
    }
    prev = cur;
  }
  assert.ok(sawShared, 'small Buffer.from(string) shares the pool');

  let arrShared = false;
  let prevArr = Buffer.from([1, 2, 3, 4]);
  assert.deepEqual([...prevArr], [1, 2, 3, 4]);
  for (let i = 0; i < 16 && !arrShared; i++) {
    const cur = Buffer.from([9, 8, 7]);
    assert.deepEqual([...cur], [9, 8, 7], 'pooled from(array) holds its own bytes');
    if (cur.buffer === prevArr.buffer) arrShared = true;
    prevArr = cur;
  }
  assert.ok(arrShared, 'small Buffer.from(array) shares the pool');

  // A large string allocation is not pooled.
  const bigStr = Buffer.from('x'.repeat(BIG));
  assert.equal(bigStr.byteOffset, 0);
  assert.equal(bigStr.buffer.byteLength, BIG);
}

// --- Mutation of one pooled buffer leaves its neighbor untouched ------------
// Find a consecutive sharing pair, write disjoint patterns, and confirm neither
// bleeds into the other's byte range despite sharing one ArrayBuffer.
{
  let m1 = Buffer.allocUnsafe(8);
  let m2 = Buffer.allocUnsafe(8);
  let tries = 0;
  while (m1.buffer !== m2.buffer && tries < 32) {
    m1 = m2;
    m2 = Buffer.allocUnsafe(8);
    tries++;
  }
  assert.equal(m1.buffer, m2.buffer, 'found a shared pooled pair to test isolation');
  m1.fill(0xaa);
  m2.fill(0xbb);
  for (let i = 0; i < 8; i++) {
    assert.equal(m1[i], 0xaa, 'first pooled buffer keeps its bytes');
    assert.equal(m2[i], 0xbb, 'second pooled buffer keeps its bytes');
  }
}

// --- Pool exhaustion creates a fresh backing store -------------------------
// Enough small allocations must roll past poolSize and force a new pool, so the
// backing ArrayBuffer identity changes at least once. The iteration count is
// derived from poolSize (like every other size here) so the test holds for any
// pool size a runtime picks.
{
  const CHUNK = 64;
  const ROLLS = Math.ceil(Buffer.poolSize / CHUNK) + 2;
  let recreated = false;
  let prev = Buffer.allocUnsafe(CHUNK).buffer;
  for (let i = 0; i < ROLLS && !recreated; i++) {
    const cur = Buffer.allocUnsafe(CHUNK).buffer;
    if (cur !== prev) recreated = true;
    prev = cur;
  }
  assert.ok(recreated, 'pool is recreated once exhausted');
}

// --- A pooled (byteOffset > 0) buffer round-trips through the native codecs --
// Pooling makes a non-zero byteOffset the common case, so this is the scenario
// that regresses if a codec or the typed-array marshalling reads from the pool's
// base instead of the buffer's byteOffset. Land a buffer at a non-zero offset,
// write a known pattern, and confirm hex/base64/utf8 and the numeric readers all
// observe exactly the buffer's own bytes (not neighboring pool data).
{
  let buf = Buffer.allocUnsafe(8);
  for (let i = 0; i < 16 && buf.byteOffset === 0; i++) buf = Buffer.allocUnsafe(8);
  assert.ok(buf.byteOffset > 0, 'have a pooled buffer at a non-zero offset to test');
  assert.ok(buf.buffer.byteLength >= Buffer.poolSize, 'and it is pool-backed');

  const pattern = [0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04];
  for (let i = 0; i < 8; i++) buf[i] = pattern[i];

  assert.equal(buf.toString('hex'), 'deadbeef01020304', 'hex honors byteOffset');
  assert.equal(buf.toString('base64'), '3q2+7wECAwQ=', 'base64 honors byteOffset');
  assert.equal(buf.readUInt32BE(0), 0xdeadbeef, 'readUInt32BE honors byteOffset');
  assert.equal(buf.readUInt32LE(4), 0x04030201, 'readUInt32LE honors byteOffset');

  // utf8 through a pooled (small, so pooled) Buffer.from result.
  const text = 'héllo-世界';
  const u = Buffer.from(text);
  assert.ok(u.byteLength < HALF, 'sample stays in the pooled range');
  assert.equal(u.toString('utf8'), text, 'utf8 round-trips through a pooled buffer');
}

// --- Buffer.concat pools small results and zero-fills an over-long tail ------
// Node carves small concat results from the pool too; when totalLength exceeds
// the supplied data, the uncovered tail must read back as zero (not stale pool
// bytes).
{
  const small = Buffer.concat([Buffer.from([1, 2]), Buffer.from([3, 4])]);
  assert.deepEqual([...small], [1, 2, 3, 4], 'concat copies the inputs');
  assert.ok(small.buffer.byteLength >= Buffer.poolSize, 'small concat result is pooled');

  // An explicit totalLength larger than the data zero-fills the remainder.
  const padded = Buffer.concat([Buffer.from([0xaa, 0xbb])], 6);
  assert.equal(padded.length, 6);
  assert.deepEqual([...padded], [0xaa, 0xbb, 0, 0, 0, 0], 'concat zero-fills the uncovered tail');

  // A totalLength smaller than the data truncates without over-reading.
  const cut = Buffer.concat([Buffer.from([1, 2, 3, 4])], 2);
  assert.deepEqual([...cut], [1, 2], 'concat truncates to totalLength');

  // A large concat result keeps its own right-sized backing store.
  const big = Buffer.concat([Buffer.alloc(BIG, 7)]);
  assert.equal(big.byteOffset, 0);
  assert.equal(big.buffer.byteLength, BIG, 'large concat result is unpooled');
}
