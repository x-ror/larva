// What TextDecoder throws, as a page sees it: an unknown or non-ASCII-trimmed label,
// fatal decoding, a non-object options argument, and the order the checks run in.
// Each line prints the error's class, message and `code` (a page's errors have none).
// Ported from the error half of tests/node-compat/cases/11-text-encoding.js.
function show(label, f) {
  try {
    const v = f();
    print(label + ': no throw ' + JSON.stringify(v));
  } catch (e) {
    print(label + ': ' + e.constructor.name + ': ' + e.message + ' code=' + e.code);
  }
}
show('made-up label', () => new TextDecoder('made-up'));
show('nbsp label', () => new TextDecoder(' utf-8'));
show('ideographic space label', () => new TextDecoder('　utf-8'));
show('zero-width label', () => new TextDecoder('​utf-8'));
show('replacement label', () => new TextDecoder('replacement'));
let calls = 0;
show(
  'label coerced once',
  () =>
    new TextDecoder({
      toString() {
        calls++;
        return 'zz-bogus';
      },
    }),
);
print('label toString calls ' + calls);
show('fatal 0xff', () => new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array([0xff])));
show('fatal utf-16le lone', () =>
  new TextDecoder('utf-16le', { fatal: true }).decode(new Uint8Array([0x00, 0xd8])),
);
const f1 = new TextDecoder('utf-16le', { fatal: true });
show('fatal odd mid-stream', () => f1.decode(new Uint8Array([0x41]), { stream: true }));
show('fatal odd flushed', () => f1.decode());
const f2 = new TextDecoder('utf-8', { fatal: true });
show('fatal tail mid-stream', () => f2.decode(new Uint8Array([0xe2, 0x82]), { stream: true }));
show('fatal tail flushed', () => f2.decode());
for (const bad of [5, -0, 'x', true, 1n, Symbol('s')]) {
  const name =
    typeof bad === 'symbol' ? 'Symbol' : typeof bad === 'bigint' ? '1n' : JSON.stringify(bad);
  show('ctor options ' + name, () => new TextDecoder('utf-8', bad).encoding);
  show('decode options ' + name, () => new TextDecoder().decode(new Uint8Array(1), bad));
}
show('options before label', () => new TextDecoder('bogus-enc', 5));
show(
  'label coerced before options',
  () =>
    new TextDecoder(
      {
        toString() {
          throw new RangeError('coerced first');
        },
      },
      5,
    ),
);
show('decode options before input', () => new TextDecoder().decode(5, 5));
show('decode non-buffer input', () => new TextDecoder().decode('abc'));
show('encodeInto non-Uint8Array', () => new TextEncoder().encodeInto('a', new Uint16Array(2)));
