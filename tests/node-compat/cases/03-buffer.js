const assert = require('node:assert/strict');

const input = Buffer.from('lava', 'utf8');
const copy = Buffer.alloc(4);
input.copy(copy);

assert.equal(input.toString('hex'), '6c617661');
assert.equal(copy.toString('utf8'), 'lava');
assert.equal(Buffer.concat([input, Buffer.from('-runtime')]).toString(), 'lava-runtime');
assert.equal(Buffer.from('_w', 'base64').toString('hex'), 'ff');
assert.equal(Buffer.from('-w', 'base64').toString('hex'), 'fb');
assert.equal(Buffer.from([0xfb, 0xff]).toString('base64url'), '-_8');
assert.equal(Buffer.from('-_8', 'base64url').toString('hex'), 'fbff');
assert.equal(Buffer.byteLength('-_8', 'base64url'), 2);

assert.equal(Buffer.isEncoding('utf-8'), true);
assert.equal(Buffer.isEncoding('made-up'), false);
assert.equal(Buffer.compare(Buffer.from('a'), Buffer.from('b')), -1);
assert.equal(Buffer.from('lava').compare(Buffer.from('lava')), 0);
assert.equal(Buffer.from('lava').includes('av'), true);
assert.equal(Buffer.from('lava lava').indexOf('lava', 1), 5);
assert.equal(Buffer.from('lava lava').lastIndexOf('lava'), 5);
assert.equal(Buffer.alloc(4, 'ab').toString(), 'abab');
assert.equal(Buffer.from('6100', 'hex').swap16().toString('hex'), '0061');

const numeric = Buffer.alloc(24);
numeric.writeUInt16LE(0x1234, 0);
numeric.writeUInt16BE(0x1234, 2);
numeric.writeInt32LE(-2, 4);
numeric.writeFloatBE(1.5, 8);
numeric.writeDoubleLE(2.25, 12);
assert.equal(numeric.readUInt16LE(0), 0x1234);
assert.equal(numeric.readUInt16BE(2), 0x1234);
assert.equal(numeric.readInt32LE(4), -2);
assert.equal(numeric.readFloatBE(8), 1.5);
assert.equal(numeric.readDoubleLE(12), 2.25);

if (typeof BigInt === 'function') {
  const big = Buffer.alloc(8);
  big.writeBigUInt64BE(0x0102030405060708n, 0);
  assert.equal(big.toString('hex'), '0102030405060708');
  assert.equal(big.readBigUInt64BE(0), 0x0102030405060708n);
}

assert.equal(Buffer.copyBytesFrom(new Uint16Array([0x1234])).toString('hex'), '3412');
assert.equal(require('node:buffer').atob('Zm9v'), 'foo');
assert.equal(require('node:buffer').btoa('foo'), 'Zm9v');
assert.equal(globalThis.atob, require('node:buffer').atob);
assert.equal(globalThis.btoa, require('node:buffer').btoa);
assert.equal(atob('Zm9v'), 'foo');
assert.equal(btoa('foo'), 'Zm9v');
assert.equal(require('node:buffer').isAscii(Buffer.from('abc')), true);
// Node 26 removed SlowBuffer (DEP0030 end-of-life): the export is gone, not deprecated.
assert.equal('SlowBuffer' in require('node:buffer'), false, 'node:buffer has no SlowBuffer');
