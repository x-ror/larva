// Oversized typed-array and ArrayBuffer requests (beyond 2**53 - 1, past every
// engine's ceiling) throw a catchable RangeError instead of aborting, before any
// memory is reserved; ordinary allocations still work. Only the error's class is
// printed — its message is engine text.
// Ported from tests/node-compat/cases/34-oversized-allocation.js (its Buffer half is
// Node-only).
const HUGE = 2 ** 53;
const HUGER = 1e30;
function show(label, f) {
  try {
    const v = f();
    print(label + ': no throw ' + (v && v.constructor.name));
  } catch (e) {
    print(label + ': ' + e.constructor.name);
  }
}
for (const TA of [
  Uint8Array,
  Int8Array,
  Uint8ClampedArray,
  Uint16Array,
  Int16Array,
  Uint32Array,
  Int32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
]) {
  show(TA.name + '(2**53)', () => new TA(HUGE));
  show(TA.name + '(1e30)', () => new TA(HUGER));
}
show('ArrayBuffer(2**53)', () => new ArrayBuffer(HUGE));
show('ArrayBuffer(1e30)', () => new ArrayBuffer(HUGER));
show('ArrayBuffer(-1)', () => new ArrayBuffer(-1));
show('Blob of a huge sparse array', () => new Blob([{ length: HUGE }]).size);
const small = new Uint8Array(8);
small[0] = 255;
print('small ' + small.length + ' ' + small[0] + ' ' + (small instanceof Uint8Array));
const ab = new ArrayBuffer(16);
const view = new Uint32Array(ab);
print('view ' + ab.byteLength + ' ' + view.length + ' ' + (view.buffer === ab));
print('fractional ' + new Uint8Array(3.9).length);
