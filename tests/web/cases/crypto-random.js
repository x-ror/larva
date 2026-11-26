// Web Crypto's random half: randomUUID's v4 shape and uniqueness, getRandomValues
// filling in place and returning its argument, an offset non-Uint8 view touched only
// in its own bytes, a zero-length view, and the rejections. No random value is printed.
// Ported from tests/node-compat/cases/20-web-crypto.js and the getRandomValues half
// of 22-typed-array-offset.js (their node:crypto and node:fs parts are Node-only).
print(
  'types ' + typeof crypto + ' ' + typeof crypto.randomUUID + ' ' + typeof crypto.getRandomValues,
);
const re = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
print(
  'uuid v4 ' +
    re.test(crypto.randomUUID()) +
    ' unique ' +
    (crypto.randomUUID() !== crypto.randomUUID()),
);

const a = new Uint8Array(16);
print(
  'returns its argument ' + (crypto.getRandomValues(a) === a) + ' filled ' + a.some((x) => x !== 0),
);

const buf = new ArrayBuffer(32);
const view = new Uint32Array(buf, 8, 4);
crypto.getRandomValues(view);
print('offset view filled ' + Array.from(view).some((x) => x !== 0));
print('before untouched ' + new Uint8Array(buf, 0, 8).every((x) => x === 0));
print('after untouched ' + new Uint8Array(buf, 24, 8).every((x) => x === 0));

const zero = new Uint8Array(0);
print('zero-length ' + (crypto.getRandomValues(zero) === zero));

function show(label, f) {
  try {
    f();
    print(label + ': no throw');
  } catch (e) {
    print(label + ': ' + e.constructor.name + ' ' + e.name);
  }
}
show('Float32Array', () => crypto.getRandomValues(new Float32Array(4)));
show('65537 bytes', () => crypto.getRandomValues(new Uint8Array(65537)));
show('65536 bytes', () => crypto.getRandomValues(new Uint8Array(65536)));
show('not a view', () => crypto.getRandomValues([1, 2]));
