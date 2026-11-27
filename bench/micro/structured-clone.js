// structuredClone: the serialize/deserialize pair behind postMessage and
// history.state, measured on the two shapes that cost differently — a plain
// object graph (property walk) and a typed-array payload (byte copy).

const graph = {
  id: 42,
  name: 'page',
  when: new Date(0),
  tags: ['a', 'b', 'c', 'd'],
  rows: Array.from({ length: 16 }, (_, i) => ({ k: i, v: `row-${i}`, ok: i % 2 === 0 })),
  map: new Map([
    ['x', 1],
    ['y', 2],
  ]),
};
const payload = new Uint8Array(16384);
for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;

bench('structuredclone-object', () => structuredClone(graph).rows.length, { iterations: 2500 });
bench('structuredclone-bytes', () => structuredClone(payload).length, { iterations: 4000 });
