// node:buffer is assembled from two files laid out like node's: js/internal/buffer.js
// holds the encoding codecs and the fixed-width numeric accessors (node's
// lib/internal/buffer.js, whose addBufferPrototypeMethods installs readUInt8 and
// friends), and node/buffer stays the public entry with the constructor, the statics
// and the lib/buffer.js prototype methods. A bounds error from readUInt8 used to carry
// only `node:buffer` frames, because everything was defined in buffer.js; now it names
// node:internal/buffer, exactly as node's does.
//
// Each frame line prints `ok` when the stack carries `node:<file>:` and names the
// first `node:` frame it got otherwise (past internal/errors, which builds the error). Only the source name is compared, never the
// message, line or column. Sites whose frame is not runtime-neutral are left out:
// node runs `hexWrite` itself in internal/buffer, and Lava's alias tail-calls `write`,
// so JSC drops its frame; `toString('bogus')` throws from the codec, whose only caller
// frame is likewise a tail call.
//
// The new id must stay internal: neither the bare nor the `node:` spelling may resolve
// from user code. Only the error CODE of the bare spelling is printed (the messages
// diverge, #415).
//
// The export and prototype lines check what crosses the new seam: the keys, their
// descriptor kinds, the identities the globals share, and Buffer's own shape (callable
// without `new`, one prototype with FastBuffer). Export ORDER and the prototype's full
// key order are not oracle-able — node's lists are different sets — so the split was
// checked against the previous binary instead (the PR records the diff).
'use strict';

// node prints DEP0005 for Buffer(n) on stderr, which the runner compares.
process.noDeprecation = true;

const buffer = require('buffer');
const { Buffer } = buffer;

for (const id of ['internal/buffer']) {
  let code = 'RESOLVED';
  try {
    require(id);
  } catch (e) {
    code = e.code;
  }
  let threw = false;
  try {
    require('node:' + id);
  } catch {
    threw = true;
  }
  console.log('hidden', id, code, 'node:' + (threw ? 'threw' : 'RESOLVED'));
}

function frame(label, file, f) {
  let stack = null;
  try {
    f();
  } catch (e) {
    stack = String(e && e.stack);
  }
  if (stack === null) return console.log(label + ': NO THROW');
  const where = stack.includes('node:' + file + ':')
    ? 'ok'
    : 'got ' + (stack.match(/node:(?!internal\/errors)[\w/]+/) || ['no node: frame'])[0];
  console.log(label + ': ' + file + ' ' + where);
}

// The numeric accessors: node:internal/buffer on both runtimes.
frame('readUInt8 offset', 'internal/buffer', () => Buffer.alloc(1).readUInt8(5));
frame('readUInt16LE bounds', 'internal/buffer', () => Buffer.alloc(1).readUInt16LE(0));
frame('readUIntLE byteLength', 'internal/buffer', () => Buffer.alloc(4).readUIntLE(0, 9));
frame('readIntBE offset', 'internal/buffer', () => Buffer.alloc(4).readIntBE(-1, 2));
frame('writeUInt8 value', 'internal/buffer', () => Buffer.alloc(1).writeUInt8(300, 0));
frame('writeInt32BE value', 'internal/buffer', () => Buffer.alloc(4).writeInt32BE(2 ** 40, 0));
frame('writeUIntBE byteLength', 'internal/buffer', () => Buffer.alloc(4).writeUIntBE(1, 0, 0));
frame('writeBigInt64LE value', 'internal/buffer', () =>
  Buffer.alloc(8).writeBigInt64LE(2n ** 70n, 0),
);
frame('readBigUInt64BE bounds', 'internal/buffer', () => Buffer.alloc(4).readBigUInt64BE(0));
frame('readDoubleLE offset', 'internal/buffer', () => Buffer.alloc(8).readDoubleLE(1.5));
frame('writeFloatBE offset', 'internal/buffer', () => Buffer.alloc(8).writeFloatBE(1, 'x'));
// What stayed in the public entry: node:buffer on both runtimes.
frame('from encoding', 'buffer', () => Buffer.from('a', 'bogus'));
frame('write encoding', 'buffer', () => Buffer.alloc(2).write('a', 'bogus'));
frame('alloc size', 'buffer', () => Buffer.alloc(-1));
frame('concat element', 'buffer', () => Buffer.concat([1]));
frame('swap16 size', 'buffer', () => Buffer.alloc(3).swap16());
frame('byteLength type', 'buffer', () => Buffer.byteLength(5));
frame('compare target', 'buffer', () => Buffer.alloc(2).compare(5));

// --- the assembled exports: shapes and identities ----------------------------------
console.log('same module', require('node:buffer') === buffer);
for (const k of [
  'Buffer',
  'Blob',
  'File',
  'kMaxLength',
  'kStringMaxLength',
  'constants',
  'atob',
  'btoa',
  'isAscii',
  'isUtf8',
  'transcode',
  'resolveObjectURL',
  'INSPECT_MAX_BYTES',
]) {
  const d = Object.getOwnPropertyDescriptor(buffer, k);
  console.log('export', k, typeof buffer[k], 'value' in d ? 'data' : 'accessor');
}
console.log(
  'identities',
  globalThis.Buffer === Buffer,
  globalThis.atob === buffer.atob,
  globalThis.btoa === buffer.btoa,
  globalThis.Blob === buffer.Blob,
  globalThis.File === buffer.File,
);

// --- Buffer itself: a function constructor, callable without `new` ------------------
const called = Buffer(3);
const constructed = new Buffer('ab');
console.log(
  'ctor',
  typeof Buffer,
  Buffer.length,
  Buffer.name,
  Buffer.isBuffer(called),
  called.length,
  Buffer.isBuffer(constructed),
  constructed.toString(),
);
const FastBuffer = Object.getPrototypeOf(Buffer.from('x')).constructor;
console.log(
  'prototype',
  FastBuffer === Buffer,
  Object.getPrototypeOf(Buffer.alloc(1)) === Buffer.prototype,
  Object.getPrototypeOf(Buffer.allocUnsafe(1)) === Buffer.prototype,
  Object.getPrototypeOf(Buffer.alloc(1).subarray(0)) === Buffer.prototype,
  Object.getPrototypeOf(Buffer.prototype) === Uint8Array.prototype,
);

// --- the methods internal/buffer installs ------------------------------------------
const proto = Buffer.prototype;
for (const k of [
  'readUInt8',
  'readUint8',
  'readBigUInt64LE',
  'readBigUint64LE',
  'writeUInt32BE',
  'writeUint32BE',
  'writeDoubleLE',
  'utf8Slice',
  'hexSlice',
  'ucs2Write',
  'latin1Write',
]) {
  const d = Object.getOwnPropertyDescriptor(proto, k);
  console.log('method', k, typeof d.value, d.writable, d.enumerable, d.configurable);
}
console.log(
  'aliases',
  proto.readUInt8 === proto.readUint8,
  proto.readBigUInt64LE === proto.readBigUint64LE,
  proto.writeUInt32BE === proto.writeUint32BE,
);

// --- behavior across the file seam ---------------------------------------------------
const b = Buffer.alloc(16);
b.writeUInt32BE(0xdeadbeef, 0);
b.writeInt16LE(-2, 4);
b.writeDoubleLE(Math.PI, 8);
console.log(
  'numeric',
  b.toString('hex'),
  b.readUInt32BE(0),
  b.readInt16LE(4),
  b.readDoubleLE(8),
  b.readUIntBE(0, 3),
  b.readIntLE(4, 2),
);
const big = Buffer.alloc(8);
big.writeBigInt64BE(-5n);
console.log('bigint', big.readBigInt64BE(0), big.readBigUInt64LE(0));
const s = Buffer.from('héllo wörld');
console.log(
  'codecs',
  s.toString('base64'),
  s.toString('base64url'),
  s.toString('latin1'),
  s.toString('ascii'),
  Buffer.from('aGk', 'base64url').toString(),
  Buffer.from('  aG k=  ', 'base64').toString(),
  Buffer.from('6869', 'hex').toString('ucs2'),
);
console.log(
  'slices',
  s.utf8Slice(0, 5),
  s.hexSlice(0, 2),
  s.latin1Slice(0, 3),
  s.base64Slice(0, 3),
  s.ucs2Slice(0, 4),
);
const w = Buffer.alloc(6);
console.log('writes', w.hexWrite('a1b2', 0), w.ucs2Write('z', 2), w.latin1Write('q', 5), w);
console.log(
  'encodings',
  Buffer.isEncoding('UTF-8'),
  Buffer.isEncoding('ucs-2'),
  Buffer.isEncoding('constructor'),
  Buffer.byteLength('aGk=', 'base64'),
  Buffer.byteLength('héllo'),
  Buffer.from('ff', 'HEX')[0],
);
console.log(
  'atob',
  buffer.atob('aGk='),
  buffer.btoa('hi'),
  buffer.transcode(s, 'utf8', 'latin1').length,
);
