// Buffer fill(null), missing type checks, and BigInt/Symbol handling (#392 groups 1-3).
function show(label, fn) {
  let r;
  try {
    const v = fn();
    r = 'OK ' + (Buffer.isBuffer(v) ? v.toString('hex') : JSON.stringify(v));
  } catch (e) {
    // JSC and V8 phrase BigInt/Symbol coercion TypeErrors differently, so compare name + code.
    r = 'THREW ' + e.name + ' ' + e.code;
    if (e.code) r += ' | ' + e.message;
  }
  console.log(label + ' => ' + r);
}

const b = () => Buffer.alloc(8, 0xaa);

// Group 1: fill(null) and fill argument validation
show('fill(null)', () => b().fill(null));
show('fill(undefined)', () => b().fill(undefined));
show('fill(true)', () => b().fill(true));
show('fill({})', () => b().fill({}));
show('fill(1n)', () => b().fill(1n));
show('fill(Symbol)', () => b().fill(Symbol('s')));
show('fill("a", null)', () => b().fill('a', null));
show('fill("a", 1n)', () => b().fill('a', 1n));
show('fill("a", 0, null)', () => b().fill('a', 0, null));
show('fill("a", 0, 1n)', () => b().fill('a', 0, 1n));
show('alloc(4, null)', () => Buffer.alloc(4, null));
show('alloc(4, 1n)', () => Buffer.alloc(4, 1n));

// Group 2: missing type checks
show('write(null)', () => b().write(null));
show('write(123)', () => b().write(123));
show('write("a", null)', () => b().write('a', null));
show('write("a", 1n)', () => b().write('a', 1n));
show('write("a", 0, null)', () => b().write('a', 0, null));
show('write("a", 0, 1n)', () => b().write('a', 0, 1n));
show('write("a", 0, -1)', () => b().write('a', 0, -1));
show('compare(null)', () => b().compare(null));
show('compare(b, null)', () => b().compare(b(), null));
show('compare(b, 1n)', () => b().compare(b(), 1n));
// *Start is bounded by kMaxLength, not the buffer length; only *End is length-bounded.
show('compare(b, 100)', () => Buffer.alloc(3).compare(Buffer.alloc(3), 100));
show('compare(b, 0, 3, 100)', () => Buffer.alloc(3).compare(Buffer.alloc(3), 0, 3, 100));
show('compare(b, 0, 4)', () => Buffer.alloc(3).compare(Buffer.alloc(3), 0, 4));
show('compare(b, 0, 3, 0, 4)', () => Buffer.alloc(3).compare(Buffer.alloc(3), 0, 3, 0, 4));
// write's length is validated against this.length, then clamped to the remaining bytes.
show('write("abcdef", 5, 8)', () => Buffer.alloc(10).write('abcdef', 5, 8));
show('write("abc", 0, 11)', () => Buffer.alloc(10).write('abc', 0, 11));
show('write("abc", 2, 11)', () => Buffer.alloc(10).write('abc', 2, 11));
show('write(hex, 5, 8, "hex")', () => Buffer.alloc(10).write('aabbccddeeff', 5, 8, 'hex'));
show('indexOf(null)', () => b().indexOf(null));
show('indexOf(1n)', () => b().indexOf(1n));
show('indexOf(Symbol)', () => b().indexOf(Symbol('s')));
show('Buffer.compare(null, b)', () => Buffer.compare(null, b()));
show('Buffer.compare(b, null)', () => Buffer.compare(b(), null));
show('Buffer.copyBytesFrom(null)', () => Buffer.copyBytesFrom(null));

// Group 3: BigInt / Symbol
show('writeBigInt64LE(1)', () => b().writeBigInt64LE(1, 0));
show('writeBigInt64LE(Symbol)', () => b().writeBigInt64LE(Symbol('s'), 0));
show('writeBigUInt64BE(1)', () => b().writeBigUInt64BE(1, 0));
show('toString(Symbol)', () => b().toString(Symbol('s')));
show('toString("utf8", 1n)', () => b().toString('utf8', 1n));
show('toString("utf8", 10n)', () => b().toString('utf8', 10n));
show('toString("utf8", 0, 1n)', () => b().toString('utf8', 0, 1n));
show('Buffer.isEncoding(1n)', () => Buffer.isEncoding(1n));
show('Buffer.isEncoding(Symbol)', () => Buffer.isEncoding(Symbol('s')));
