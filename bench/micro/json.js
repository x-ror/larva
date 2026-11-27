// JSON.parse / JSON.stringify throughput on a realistic nested object. Pure JSC: a
// Lava-vs-Lava ratio here moves only with the engine build or the flags it runs
// under, which makes it the control row for launch noise.

const obj = {
  id: 1234567,
  name: 'lava-runtime',
  active: true,
  ratio: 3.14159,
  tags: ['fast', 'small', 'headless', 'jsc'],
  nested: {
    a: [1, 2, 3, 4, 5, 6, 7, 8],
    b: { x: 'hello', y: 'world', z: null },
    c: Array.from({ length: 16 }, (_, i) => ({ k: i, v: `item-${i}` })),
  },
  blob: 'x'.repeat(256),
};
const json = JSON.stringify(obj);

bench('json-stringify', () => JSON.stringify(obj), { iterations: 25000 });
bench('json-parse', () => JSON.parse(json), { iterations: 10000 });
