// User code must not teach the typed-array cell probe a wrong layout. Natives borrow a
// Uint8Array's bytes by reading the engine cell and decline the fast path for a view
// over a resizable buffer; which mode byte means "fixed length" is learned by building
// probe views through the global constructors. The constructor below answers the
// probe's questions wrongly, and the first native byte op runs while it is installed.
// A correct runtime decodes the shrunk window as empty, not as bytes past the end.
// Ported from tests/node-compat/cases/69-view-probe-pollution.js (its Buffer.compare
// line is Node-only; `window` is a page global, so the view is `win` here).
const Real = Uint8Array;
globalThis.Uint8Array = function (a, b, c) {
  if (typeof a === 'number') return new Real(new ArrayBuffer(a, { maxByteLength: a + 8 }), 0, a);
  if (b === 0 && c === 4) return new Real(8);
  return arguments.length === 1 ? new Real(a) : new Real(a, b, c);
};
const td = new TextDecoder();
td.decode(new Real([0x61]).subarray(0));
globalThis.Uint8Array = Real;

const rab = new ArrayBuffer(4, { maxByteLength: 16 });
new Uint8Array(rab).set([0x61, 0x62, 0x63, 0x64]);
const win = new Uint8Array(rab, 0, 3);
rab.resize(1);
// Chrome refuses a resizable-backed view outright; what must never happen is reading
// the three stale bytes.
for (const [label, f] of [
  ['decode', () => JSON.stringify(td.decode(win))],
  ['blob', () => new Blob([win]).size],
  ['length', () => win.length],
]) {
  try {
    print('out-of-bounds window ' + label + ' ' + f());
  } catch (e) {
    print('out-of-bounds window ' + label + ' THROWS ' + e.constructor.name);
  }
}
