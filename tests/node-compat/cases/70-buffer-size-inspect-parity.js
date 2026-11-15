// Three Buffer divergences from node 24 (issue #391), each printed rather than asserted so
// a regression shows up as a readable diff against the node oracle.
//
//   1. ERR_INVALID_ARG_TYPE wording: size/offset/length checks spliced a bare `number`
//      into the template — `must be number` where node says `must be of type number`.
//   2. Deprecated `Buffer(n)` / `new Buffer(n)`: -1 threw JSC's codeless
//      "length cannot be negative" and NaN returned an empty Buffer; node routes the
//      number branch through Buffer.alloc's size validation.
//   3. INSPECT_MAX_BYTES = 0: node keeps the separator space even with no hex shown,
//      `<Buffer  ... 3 more bytes>` (two spaces).
//
// Every line prints a RESULT. A case whose setup threw on both runtimes would print the
// same THREW line twice and pass while proving nothing (CLAUDE.md §6), so each THREW
// below is the behaviour under test, and the surrounding lines print real values.
//
// The out-of-range bound is masked: node reports 2**53-1, Lava its documented JSC-family
// kMaxLength (4 GiB, reference/node-compatibility.md). Masking through
// buffer.constants.MAX_LENGTH (the precedent in 34-oversized-allocation.js) keeps the
// line byte-identical while still proving the message quotes the advertised ceiling —
// a hard-coded or missing bound would not match the mask and would print verbatim.
const util = require('node:util');
const buffer = require('node:buffer');

// node prints DEP0005 for Buffer(n) on stderr, which the runner compares; Lava emits no
// deprecation warnings. Silenced so the compared output is the behaviour under test.
process.noDeprecation = true;

const MAX = String(buffer.constants.MAX_LENGTH);
function show(label, fn) {
  let r;
  try {
    const v = fn();
    r = 'ok ' + (Buffer.isBuffer(v) ? 'Buffer(' + v.length + ') ' + v.toString('hex') : String(v));
  } catch (e) {
    r =
      'THREW ' +
      e.name +
      ' ' +
      e.code +
      ' | ' +
      String(e.message)
        .split('<= ' + MAX)
        .join('<= kMaxLength');
  }
  console.log(label + ' => ' + r);
}

// --- 1. ERR_INVALID_ARG_TYPE wording ---------------------------------------------------
const b = Buffer.alloc(16);
show('alloc("5")', () => Buffer.alloc('5'));
show('allocUnsafe(null)', () => Buffer.allocUnsafe(null));
show('allocUnsafeSlow({})', () => Buffer.allocUnsafeSlow({}));
show('readUInt8("5")', () => b.readUInt8('5'));
show('readInt32LE(null)', () => b.readInt32LE(null));
show('readDoubleBE(true)', () => b.readDoubleBE(true));
show('readBigInt64LE({})', () => b.readBigInt64LE({}));
show('writeUInt16LE(0, "1")', () => b.writeUInt16LE(0, '1'));
show('writeBigUInt64BE(0n, 1n)', () => b.writeBigUInt64BE(0n, 1n));
show('readIntBE("0", 3)', () => b.readIntBE('0', 3));
show('writeUIntLE(1, null, 3)', () => b.writeUIntLE(1, null, 3));
show('concat([a], "5")', () => Buffer.concat([Buffer.from('ab')], '5'));
// Call sites that were already correct keep their wording.
show('readUIntLE(0, "3") byteLength', () => b.readUIntLE(0, '3'));
show('concat("x")', () => Buffer.concat('x'));
show('copy(5)', () => b.copy(5));
// Valid calls still answer.
show('alloc(3)', () => Buffer.alloc(3));
show('readUInt8(1)', () => b.readUInt8(1));
show('concat([a], 1)', () => Buffer.concat([Buffer.from('ab')], 1));

// --- 2. Deprecated constructor, number branch ------------------------------------------
const nums = [
  ['-1', -1],
  ['-0', -0],
  ['0', 0],
  ['1.5', 1.5],
  ['5', 5],
  ['NaN', NaN],
  ['Infinity', Infinity],
  ['-Infinity', -Infinity],
  ['2**53', 2 ** 53],
];
for (const [n, v] of nums) {
  show(`new Buffer(${n})`, () => new Buffer(v));
  show(`Buffer(${n})`, () => Buffer(v));
}
// Pooled storage would leak stale bytes here; node zero-fills.
show('Buffer(5) after dirtying the pool', () => {
  Buffer.allocUnsafe(8).fill(0xaa);
  return Buffer(5);
});

// --- 3. Separator with nothing shown ---------------------------------------------------
function bufOf(n) {
  const x = Buffer.alloc(n);
  for (let i = 0; i < n; i++) x[i] = i;
  return x;
}
for (const max of [0, 1, 2]) {
  buffer.INSPECT_MAX_BYTES = max;
  for (const len of [0, 1, 2, 3]) {
    const x = bufOf(len);
    console.log(
      `max=${max} len=${len}`,
      JSON.stringify(util.inspect(x)),
      JSON.stringify(x.inspect()),
    );
  }
}
buffer.INSPECT_MAX_BYTES = 50;
