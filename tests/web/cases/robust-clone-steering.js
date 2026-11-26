// structuredClone must not be steerable by the value under clone or by poisoned
// accessors: a replaced constructor, a forged Symbol.toStringTag, poisoned
// DataView/%TypedArray% window getters over a neighbour's bytes, and a forged
// DataView[Symbol.hasInstance] in both directions. Every poison is lifted before
// the clone is inspected.
// Ported from the steering half of tests/node-compat/cases/13-structured-clone.js;
// the Buffer pool neighbour is a neighbouring range of one ArrayBuffer here.
const tag = (o) => Object.prototype.toString.call(o);
function attempt(label, poison, run, inspect) {
  let clone, threw;
  const undo = poison();
  try {
    clone = run();
  } catch (e) {
    threw = e;
  } finally {
    undo();
  }
  print(label + ': ' + (threw ? 'THREW ' + threw.name : inspect(clone)));
}

let attackerRan = false;
attempt(
  'constructor',
  () => {
    const real = Uint8Array.prototype.constructor;
    Uint8Array.prototype.constructor = function () {
      attackerRan = true;
      return { evil: 1 };
    };
    return () => (Uint8Array.prototype.constructor = real);
  },
  () => structuredClone(new Uint8Array([1, 2, 3])),
  (c) => attackerRan + ' ' + tag(c) + ' ' + Array.from(c).join(','),
);

const u = new Uint8Array([4, 5]);
Object.defineProperty(u, Symbol.toStringTag, { value: 'Bar', configurable: true });
attempt(
  'own toStringTag',
  () => () => {},
  () => structuredClone(u),
  (c) => c.constructor.name + ' ' + Array.from(c).join(','),
);
class Foo extends Uint8Array {
  get [Symbol.toStringTag]() {
    return 'Foo';
  }
}
attempt(
  'getter toStringTag',
  () => () => {},
  () => structuredClone(new Foo([1, 2, 3])),
  (c) => c.constructor.name + ' ' + Array.from(c).join(','),
);

const neighbourhood = new TextEncoder().encode('SECRET-TOKEN-DO-NOT-DISCLOSE-9876543210hi');
const victim = neighbourhood.subarray(39);
const latin = (c, off, len) => String.fromCharCode(...new Uint8Array(c.buffer, off, len));
attempt(
  'dataview window',
  () => {
    const dvp = DataView.prototype;
    const saved = ['byteOffset', 'byteLength'].map((k) => [
      k,
      Object.getOwnPropertyDescriptor(dvp, k),
    ]);
    Object.defineProperty(dvp, 'byteOffset', { configurable: true, get: () => 0 });
    Object.defineProperty(dvp, 'byteLength', { configurable: true, get: () => 64 });
    return () => {
      for (const [k, d] of saved) Object.defineProperty(dvp, k, d);
    };
  },
  () => structuredClone(new DataView(victim.buffer, victim.byteOffset, 2)),
  (c) => tag(c) + ' ' + c.byteLength + ' ' + JSON.stringify(latin(c, c.byteOffset, c.byteLength)),
);
attempt(
  'typed array window',
  () => {
    const taProto = Object.getPrototypeOf(Uint8Array.prototype);
    const saved = ['byteOffset', 'byteLength', 'length'].map((k) => [
      k,
      Object.getOwnPropertyDescriptor(taProto, k),
    ]);
    Object.defineProperty(taProto, 'byteOffset', { configurable: true, get: () => 0 });
    Object.defineProperty(taProto, 'byteLength', { configurable: true, get: () => 64 });
    Object.defineProperty(taProto, 'length', { configurable: true, get: () => 64 });
    return () => {
      for (const [k, d] of saved) Object.defineProperty(taProto, k, d);
    };
  },
  () => structuredClone(victim),
  (c) => c.length + ' ' + JSON.stringify(latin(c, c.byteOffset, c.length)),
);
const forge = (value) => () => {
  const had = Object.getOwnPropertyDescriptor(DataView, Symbol.hasInstance);
  Object.defineProperty(DataView, Symbol.hasInstance, { value: () => value, configurable: true });
  return () => {
    if (had) Object.defineProperty(DataView, Symbol.hasInstance, had);
    else delete DataView[Symbol.hasInstance];
  };
};
attempt(
  'hasInstance false',
  forge(false),
  () => structuredClone(new DataView(new ArrayBuffer(8), 2, 4)),
  (c) => tag(c) + ' ' + c.byteLength,
);
attempt(
  'hasInstance true',
  forge(true),
  () => structuredClone(new Uint8Array([1, 2, 3])),
  (c) => tag(c) + ' ' + Array.from(c).join(','),
);
