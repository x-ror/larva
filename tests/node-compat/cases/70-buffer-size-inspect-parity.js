// Four Buffer divergences from node 24 (issue #391), each printed rather than asserted so
// a regression shows up as a readable diff against the node oracle.
//
//   1. ERR_INVALID_ARG_TYPE wording: size/offset/length checks spliced a bare `number`
//      into the template — `must be number` where node says `must be of type number`.
//   2. Deprecated `Buffer(n)` / `new Buffer(n)`: -1 threw JSC's codeless
//      "length cannot be negative" and NaN returned an empty Buffer; node routes the
//      number branch through Buffer.alloc's size validation.
//   3. INSPECT_MAX_BYTES = 0: node keeps the separator space even with no hex shown,
//      `<Buffer  ... 3 more bytes>` (two spaces).
//   4. util.inspect shows a Buffer's extra own properties after the bytes,
//      `<Buffer 00 01 02, foo: 'bar'>`, honouring showHidden and depth.
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

// --- Self-referencing Buffers with MORE than one way back --------------------------------
// FIRST in the file, deliberately. In a fresh node 24.22.1 process these throw within
// ~20 ms: after the first stack overflow is caught, the enclosing hook moves on to its
// next key, and node's key-quoting regex /^[a-zA-Z_][a-zA-Z_0-9]*$/ is compiled lazily
// at that point, at the stack limit, so it throws a SyntaxError that node's overflow catch
// does not recognise. Once anything has inspected an object key, the regex is already
// compiled and node instead recurses with work like k^depth: in a process that had
// inspected `b.self = b` first, `b.k0 = b; b.k1 = b` ran 148 s and then threw
// `RangeError: Invalid string length`. Lava throws in both orders. Its overflow latch lets
// no hook descend again once an overflow has been caught, so this ends in bounded time.
// Only "threw" is printed: node's error is that V8 SyntaxError, Lava's is the stack-overflow
// RangeError. Bounded time is pinned Lava-only by buffer_inspect_cycle_bounded in
// cmd/lava/buffer_inspect_extras_test.odin.
for (const refs of [2, 3]) {
  const b = Buffer.from([1]);
  for (let i = 0; i < refs; i++) b['k' + i] = b;
  for (const [how, fn] of [
    ['util.inspect', () => util.inspect(b)],
    ['console.log', () => console.log(b)],
    // A direct call: no util.inspect or console.log frame above the hook, so only the
    // Buffer hook's own overflow latch keeps this bounded.
    ['inspect(0, {})', () => b.inspect(0, {})],
  ]) {
    let out;
    try {
      fn();
      out = 'returned';
    } catch {
      out = 'threw';
    }
    console.log(`cycle ${refs} self-refs ${how}: ${out}`);
  }
}

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

// --- 4. Extra own properties -----------------------------------------------------------
const sym = Symbol('s');
const cases = [];
{
  const x = bufOf(3);
  x.foo = 'bar';
  cases.push(['string prop', x]);
}
{
  const x = bufOf(3);
  x.b = 2;
  x.a = 1;
  cases.push(['insertion order b,a', x]);
}
{
  const x = bufOf(3);
  x[sym] = 1;
  x.after = 'str';
  cases.push(['symbol after string', x]);
}
{
  const x = bufOf(3);
  Object.defineProperty(x, 'hid', { value: 1, enumerable: false });
  cases.push(['non-enumerable', x]);
}
{
  const x = bufOf(3);
  Object.defineProperty(x, 'g', { get: () => 7, enumerable: true });
  cases.push(['enumerable getter', x]);
}
{
  const x = bufOf(3);
  x.o = { a: { b: { c: 1 } } };
  cases.push(['nested object', x]);
}
{
  const x = bufOf(3);
  x['a-b'] = 1;
  x.$d = 2;
  x._ok = 3;
  cases.push(['key quoting', x]);
}
{
  const x = bufOf(0);
  x.foo = 'bar';
  cases.push(['zero-length', x]);
}
{
  const x = bufOf(10);
  x.foo = 'bar';
  cases.push(['truncated max=4', x, 4]);
}
{
  const x = bufOf(3);
  x.foo = 'bar';
  cases.push(['max=0', x, 0]);
}
const opts = [
  ['default', undefined],
  ['showHidden', { showHidden: true }],
  ['depth0', { depth: 0 }],
  ['depthNull', { depth: null }],
  ['breakLength20', { breakLength: 20 }],
  ['compact false', { compact: false }],
];
for (const [label, x, max] of cases) {
  buffer.INSPECT_MAX_BYTES = max === undefined ? 50 : max;
  for (const [on, o] of opts) console.log(`${label} ${on}:`, JSON.stringify(util.inspect(x, o)));
  console.log(`${label} nested:`, JSON.stringify(util.inspect({ k: x })));
  console.log(`${label} nested depth0:`, JSON.stringify(util.inspect({ k: x }, { depth: 0 })));
  console.log(`${label} x.inspect():`, JSON.stringify(x.inspect()));
  console.log(`${label} x[custom]():`, JSON.stringify(x[util.inspect.custom]()));
  // Concatenated, not passed as a second argument: a `%O` in console.log's FIRST
  // argument is itself a format directive.
  console.log(label + ' format(%O): ' + JSON.stringify(util.format('%O', x)));
}
buffer.INSPECT_MAX_BYTES = 50;
// console.log renders through the same hook (stdout is compared byte-for-byte).
{
  const x = bufOf(3);
  x.foo = 'bar';
  console.log(x);
  console.log([x]);
}

// The hook's third argument is util.inspect itself, so a custom hook that inspects a
// sub-value starts again at depth 0 rather than inheriting its caller's nesting.
const custom = util.inspect.custom;
console.log(util.inspect({ x: { [custom]: (d, o, insp) => insp({ a: { b: { c: 1 } } }) } }));
console.log(util.inspect({ x: { [custom]: (d, o, insp) => insp === util.inspect } }));

// console.log must cut nested extras at node's depth too, not at the prelude's own
// limit: the extras' values sit one level below the Buffer whatever its nesting.
{
  const x = bufOf(1);
  x.o = { a: { b: { c: { d: { e: 1 } } } } };
  console.log(x);
  console.log([x]);
  console.log({ k: { x } });
  const m = bufOf(1);
  m.meta = new Map([[1, { a: { b: { c: 1 } } }]]);
  console.log(m);
}

// Called directly WITH a context object, the hook renders the extras as well; with no
// context it prints the bytes only.
{
  const x = bufOf(3);
  x.tag = 1;
  Object.defineProperty(x, 'h', { value: 5, enumerable: false });
  x.o = { a: { b: { c: 1 } } };
  console.log('inspect(0, {}):', JSON.stringify(x.inspect(0, {})));
  console.log('inspect(0, {depth: 0}):', JSON.stringify(x.inspect(0, { depth: 0 })));
  console.log('[custom](0, {showHidden}):', JSON.stringify(x[custom](0, { showHidden: true })));
  console.log(
    'inspect():',
    JSON.stringify(x.inspect()),
    'inspect(0):',
    JSON.stringify(x.inspect(0)),
  );
}

// Key rendering: node's identifier test refuses a leading digit ('1a' is quoted, 'a1'
// is not), and a non-enumerable SYMBOL key shows only under showHidden.
{
  const x = bufOf(3);
  x['1a'] = 1;
  x.a1 = 2;
  Object.defineProperty(x, Symbol('h'), { value: 3, enumerable: false });
  x[Symbol('v')] = 4;
  console.log('keys:', JSON.stringify(util.inspect(x)));
  console.log('keys showHidden:', JSON.stringify(util.inspect(x, { showHidden: true })));
}

// A Buffer whose extras lead back to itself recurses until the stack runs out. node
// catches the overflow inside inspect and prints what it had, ending in
// `Inspection interrupted prematurely. Maximum call stack size exceeded`; logging never
// throws. Where the cut lands depends on the engine's stack size, so the lines print the
// shape rather than the full string: it returned, how it starts, that the marker is
// there, and how it ends.
function cycleShape(label, fn) {
  let s;
  try {
    s = fn();
  } catch (e) {
    console.log(label, 'THREW', e.name);
    return;
  }
  console.log(
    label,
    JSON.stringify(s.slice(0, 40)),
    s.includes('Inspection interrupted prematurely. Maximum call stack size exceeded'),
    JSON.stringify(s.slice(-4)),
  );
}
{
  const a = Buffer.from([1]);
  a.self = a;
  cycleShape('cycle self:', () => util.inspect(a));
  const b = Buffer.from([2]);
  const c = Buffer.from([3]);
  b.other = c;
  c.other = b;
  cycleShape('cycle pair:', () => util.inspect(b));
  const d = Buffer.from([4]);
  d.o = { back: d };
  cycleShape('cycle via object:', () => util.inspect(d));
}

// Errors other than a stack overflow propagate out of inspect, as in node: from a getter
// on the Buffer itself (read outside any catch) and from a hook further down (thrown
// inside the inspect of an extra's value, where the overflow catch must not swallow it).
// A getter that throws a RangeError carrying the overflow's own message also propagates:
// node reads the property outside its overflow catch, and so does Lava.
function threw(label, fn) {
  try {
    fn();
    console.log(label, 'returned');
  } catch (e) {
    console.log(label, 'THREW', e.name, e.message);
  }
}
{
  const g = Buffer.from([1]);
  Object.defineProperty(g, 'bad', {
    enumerable: true,
    get() {
      throw new TypeError('boom');
    },
  });
  threw('getter TypeError util.inspect:', () => util.inspect(g));
  threw('getter TypeError inspect(0, {}):', () => g.inspect(0, {}));
  const h = Buffer.from([2]);
  h.inner = {
    [custom]() {
      throw new TypeError('deep boom');
    },
  };
  threw('nested hook TypeError util.inspect:', () => util.inspect(h));
  threw('nested hook TypeError inspect(0, {}):', () => h.inspect(0, {}));
  const r = Buffer.from([3]);
  Object.defineProperty(r, 'forged', {
    enumerable: true,
    get() {
      throw new RangeError('Maximum call stack size exceeded.');
    },
  });
  threw('getter forged overflow util.inspect:', () => util.inspect(r));
}
