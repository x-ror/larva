// A typed array over a RESIZABLE ArrayBuffer must hand natives its current bytes.
//
// Every native that takes bytes (Buffer codecs, TextDecoder, and once fs writes, sqlite
// binds and crypto hashes, all gone with the Node profile) borrows them through one helper, typed_array_view. Its fast path reads the
// view's length straight out of the JSC cell, and for a view whose length is not fixed
// that field is not the length:
//
//   * a LENGTH-TRACKING view (`new Uint8Array(resizable)`, with or without a
//     byteOffset) stores 0 there and computes its length from the buffer on every
//     access — so natives saw an empty view,
//   * a FIXED-length view over a resizable buffer keeps its constructed length even
//     after the buffer shrinks under it; per spec it is then out of bounds and reads
//     as length 0 — natives read the stale length, i.e. bytes past the buffer's end.
//
// Measured before the fix (node 24.21 vs bin/lava):
//
//   TextDecoder#decode(new Uint8Array(rab))   node "abcd"   lava ""
//   ... after rab.resize(2), fixed [0, 3)     node ""       lava "abc" (stale bytes)
//
// Every surface below routes through the same helper; they are listed individually so
// a caller that grows its own byte-borrowing path is still pinned.
const assert = require('node:assert/strict');

const td = new TextDecoder();
const rab = () => {
  const b = new ArrayBuffer(4, { maxByteLength: 16 });
  new Uint8Array(b).set([0x61, 0x62, 0x63, 0x64]); // "abcd"
  return b;
};
const hex = (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('hex');

// Each view kind, with the bytes a correct runtime reports for it.
const views = [];
{
  const b = rab();
  views.push(['auto', new Uint8Array(b), 'abcd']);
}
{
  const b = rab();
  views.push(['auto at offset 1', new Uint8Array(b, 1), 'bcd']);
}
{
  const b = rab();
  const v = new Uint8Array(b);
  b.resize(6); // the view follows the buffer: two zero bytes appear
  views.push(['auto after grow', v, 'abcd\0\0']);
}
{
  const b = rab();
  const v = new Uint8Array(b);
  b.resize(2);
  views.push(['auto after shrink', v, 'ab']);
}
{
  const b = rab();
  views.push(['fixed in bounds', new Uint8Array(b, 1, 2), 'bc']);
}
{
  const b = rab();
  const v = new Uint8Array(b, 0, 3);
  b.resize(2); // [0, 3) no longer fits: the view is out of bounds, length 0
  views.push(['fixed out of bounds', v, '']);
}
{
  const b = rab();
  views.push(['Buffer over resizable', Buffer.from(b), 'abcd']);
}

for (const [label, v, want] of views) {
  const bytes = Buffer.from(want, 'latin1');
  assert.equal(v.length, bytes.length, label + ': length');
  assert.equal(td.decode(v), want, label + ': TextDecoder#decode');
  assert.equal(Buffer.byteLength(v), bytes.length, label + ': Buffer.byteLength');
  assert.equal(Buffer.from(v).toString('latin1'), want, label + ': Buffer.from');
  assert.equal(hex(v), bytes.toString('hex'), label + ': Buffer over the same window');
  assert.equal(Buffer.compare(v, bytes), 0, label + ': Buffer.compare');
  console.log(label, JSON.stringify(td.decode(v)));
}
console.log('ok');
