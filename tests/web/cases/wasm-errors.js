// The messages of WebAssembly.compile / instantiate rejections a page can produce
// without a malformed module (#97). A module the engine refuses to compile or link
// carries the engine's own text, so those are wasm-async.js's (by error kind) only.
const EMPTY = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const cases = [
  ['compile()', () => WebAssembly.compile()],
  ['compile(5)', () => WebAssembly.compile(5)],
  ['compile({})', () => WebAssembly.compile({})],
  ['instantiate()', () => WebAssembly.instantiate()],
  ['instantiate(5)', () => WebAssembly.instantiate(5)],
  ['instantiate(bytes, 5)', () => WebAssembly.instantiate(EMPTY, 5)],
  ['instantiate(bytes, null)', () => WebAssembly.instantiate(EMPTY, null)],
];
(async () => {
  for (const [label, run] of cases) {
    try {
      await run();
      print(label + ' resolved');
    } catch (e) {
      print(label + ' ' + e.constructor.name + ': ' + e.message);
    }
  }
})();
