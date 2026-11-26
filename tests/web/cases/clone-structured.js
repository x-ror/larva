// structuredClone: primitives, deep graphs, arrays with holes and extra properties,
// what is dropped (prototype, symbols, non-enumerables, getters), Date/RegExp/Map/Set,
// buffers and every view brand, Errors, cycles, and the values that cannot be cloned.
// Ported from the value half of tests/node-compat/cases/13-structured-clone.js (Buffer
// replaced by plain views); the steering vectors are robust-clone-steering.js.
function show(label, f) {
  let out;
  try {
    out = String(f());
  } catch (e) {
    out = 'THREW ' + e.constructor.name + ' ' + e.name;
  }
  print(label + ': ' + out);
}
const tag = (o) => Object.prototype.toString.call(o);

show(
  'global',
  () => typeof structuredClone + ' ' + (globalThis.structuredClone === structuredClone),
);
show('length', () => structuredClone.length);
show('primitives', () =>
  [42, 'hi', true, null, undefined, 10n, -0]
    .map((v) => {
      const c = structuredClone(v);
      return Object.is(c, v) + ':' + typeof c;
    })
    .join(','),
);

const src = { a: 1, nested: { b: [1, 2, 3] } };
const out = structuredClone(src);
out.nested.b[0] = 99;
show('deep', () =>
  [JSON.stringify(out), out !== src, out.nested !== src.nested, src.nested.b[0]].join(' '),
);

const arr = [1, 2];
arr.foo = 'bar';
show('array extra prop', () => structuredClone(arr).foo + ' ' + structuredClone(arr).length);
const choled = structuredClone([1, , 3]);
show('holes', () => (1 in choled) + ' ' + choled.length);

class Point {
  constructor(x) {
    this.x = x;
  }
}
const cp = structuredClone(new Point(5));
show(
  'class instance',
  () => (cp instanceof Point) + ' ' + (Object.getPrototypeOf(cp) === Object.prototype) + ' ' + cp.x,
);
const sym = Symbol('s');
show(
  'symbol keys',
  () => Object.getOwnPropertySymbols(structuredClone({ keep: 1, [sym]: 2 })).length,
);
const hidden = {};
Object.defineProperty(hidden, 'h', { value: 7, enumerable: false });
show('non-enumerable', () => Object.keys(structuredClone(hidden)).length);
const cgetter = structuredClone({
  get g() {
    return 42;
  },
});
show('getter flattened', () => cgetter.g + ' ' + Object.getOwnPropertyDescriptor(cgetter, 'g').get);
show('key order', () => Object.keys(structuredClone({ b: 1, a: 2, 1: 3, 0: 4 })).join(','));

const date = new Date(1717689600000);
show('date', () => {
  const c = structuredClone(date);
  return (c instanceof Date) + ' ' + c.getTime() + ' ' + (c !== date);
});
show('date shared', () => {
  const c = structuredClone({ a: date, b: date });
  return c.a === c.b;
});
const re = /ab+/gi;
re.lastIndex = 2;
show('regexp', () => {
  const c = structuredClone(re);
  return c.source + ' ' + c.flags + ' ' + c.lastIndex;
});
show('map', () => {
  const m = new Map([['k', { n: 1 }]]);
  const c = structuredClone(m);
  return (c instanceof Map) + ' ' + JSON.stringify(c.get('k')) + ' ' + (c.get('k') !== m.get('k'));
});
show('set', () => [...structuredClone(new Set([1, 2, 3]))].join(','));
show('boxed', () =>
  [new Number(1), new String('s'), new Boolean(false), Object(2n)]
    .map((v) => tag(structuredClone(v)) + '=' + structuredClone(v).valueOf())
    .join(','),
);

const ab = new Uint8Array([1, 2, 3, 4]).buffer;
show('arraybuffer', () => {
  const c = structuredClone(ab);
  return (c instanceof ArrayBuffer) + ' ' + c.byteLength + ' ' + (c !== ab);
});
const buf = new ArrayBuffer(8);
new Uint8Array(buf)[0] = 1;
show('views share their buffer', () => {
  const c = structuredClone({ u8: new Uint8Array(buf), u16: new Uint16Array(buf) });
  c.u8[0] = 9;
  return c.u16[0];
});
const dv = new DataView(new ArrayBuffer(4));
dv.setInt32(0, 123456);
show('dataview', () => {
  const c = structuredClone(dv);
  return (c instanceof DataView) + ' ' + c.getInt32(0);
});
for (const name of [
  'Uint8Array',
  'Uint8ClampedArray',
  'Int8Array',
  'Uint16Array',
  'Int16Array',
  'Uint32Array',
  'Int32Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',
  'Float16Array',
]) {
  const Ctor = globalThis[name];
  show('view ' + name, () => {
    if (typeof Ctor !== 'function') return 'absent';
    const s = name.startsWith('Big') ? new Ctor([1n, 2n]) : new Ctor([1, 2]);
    const c = structuredClone(s);
    return tag(c) + ' ' + c.length + ' ' + (c.buffer !== s.buffer);
  });
}
class Mine extends Uint8Array {}
show('subclass', () => {
  const m = structuredClone(new Mine([7, 8]));
  return m.constructor.name + ' ' + Array.from(m).join(',');
});
show('offset view', () => {
  const c = structuredClone(new TextEncoder().encode('abcdefgh').subarray(3));
  return new TextDecoder().decode(c) + ' ' + c.byteOffset + ' ' + c.buffer.byteLength;
});

const err = new TypeError('boom', { cause: new RangeError('why') });
show('error', () => {
  const c = structuredClone(err);
  return [
    c instanceof TypeError,
    c.name,
    c.message,
    typeof c.stack,
    c.cause instanceof RangeError,
    c.cause.message,
  ].join(' ');
});
for (const name of [
  'toString',
  'valueOf',
  'constructor',
  '__proto__',
  'NotAnError',
  'EvalError',
  'URIError',
]) {
  show('error name ' + name, () => {
    const e = new Error('boom');
    e.name = name;
    const c = structuredClone(e);
    return (c instanceof Error) + ' ' + c.name + ' ' + c.message;
  });
}
for (const Ctor of [TypeError, RangeError, SyntaxError, ReferenceError]) {
  show('error class ' + Ctor.name, () => {
    const c = structuredClone(new Ctor('boom'));
    return c.name + ' ' + c.constructor.name;
  });
}
const cyclic = { name: 'root' };
cyclic.self = cyclic;
show('cycle', () => {
  const c = structuredClone(cyclic);
  return (c.self === c) + ' ' + c.name;
});
for (const [label, bad] of [
  ['function', () => {}],
  ['symbol', Symbol('x')],
  ['promise', Promise.resolve(1)],
  ['weakmap', new WeakMap()],
  ['weakset', new WeakSet()],
]) {
  show('uncloneable ' + label, () => structuredClone(bad));
}
show('no argument', () => structuredClone());
show('transfer', () => {
  const t = new ArrayBuffer(4);
  const c = structuredClone(t, { transfer: [t] });
  return c.byteLength + ' ' + t.byteLength + ' ' + t.detached;
});
