// Blob, File and the blob: URL registry live in their own internal modules, laid out
// like node's lib/internal: an error thrown from inside the Blob constructor carries a
// `node:internal/blob` frame, one from inside File a `node:internal/file` frame. Both
// used to say `node:buffer`, because all three were defined inside node/buffer.js.
//
// Only the frame's SOURCE NAME is compared — never the message, line or column, which
// differ by construction (node validates `sources` through internal/webidl, Lava throws
// from the constructor itself). The behavior lines after it are there so a move that
// loses a helper, or re-wires the string encoder, fails here and not only in a stack.
'use strict';

const { Blob, File, resolveObjectURL } = require('node:buffer');

function frameFrom(label, f, source) {
  try {
    f();
    console.log(label + ': NO THROW');
  } catch (e) {
    console.log(label + ': ' + source + ' ' + String(e.stack).includes(source));
  }
}

frameFrom('new Blob(string)', () => new Blob('x'), 'node:internal/blob');
frameFrom('new File([])', () => new File([]), 'node:internal/file');

// Same constructors under both names, and the globals are those exports.
console.log('globals', globalThis.Blob === Blob, globalThis.File === File);
console.log('File extends Blob', new File([], 'f') instanceof Blob);
// Both are classes, as in node: a non-writable `prototype`, and user subclasses work.
// Without `new` only the error's class is compared — the text is the engine's own on
// each side (Lava's pinned by cmd/lava/blob_class_test.odin).
for (const C of [Blob, File]) {
  console.log(
    C.name,
    'prototype writable',
    Object.getOwnPropertyDescriptor(C, 'prototype').writable,
  );
  try {
    C([], 'f');
    console.log(C.name, 'without new: NO THROW');
  } catch (e) {
    console.log(C.name, 'without new:', e.name, e instanceof TypeError);
  }
}
class MyBlob extends Blob {
  hello() {
    return 'hello ' + this.size;
  }
}
const mine = new MyBlob(['abc']);
console.log('subclass', mine instanceof Blob, mine instanceof MyBlob, mine.hello(), mine.type);
class MyFile extends File {}
const myFile = new MyFile(['x'], 'my.txt', { lastModified: 7 });
console.log('subclass File', myFile instanceof File, myFile.name, myFile.lastModified, myFile.size);

const tag = (o) => Object.prototype.toString.call(o);
console.log('tags', tag(new Blob([])), tag(new File([], 'f')), String(new Blob([])));

const hex = (u8) => Buffer.from(u8).toString('hex');

(async () => {
  const b = new Blob(['ab', new Uint8Array([0x63]), 'd\u00e9'], { type: 'Text/Plain' });
  console.log('blob', b.size, JSON.stringify(b.type), JSON.stringify(await b.text()));
  console.log('arrayBuffer', hex(new Uint8Array(await b.arrayBuffer())));
  console.log('bytes', hex(await b.bytes()));
  const s = b.slice(1, -1, 'x/y');
  console.log('slice', s.size, s.type, JSON.stringify(await s.text()));
  console.log('slice neg', JSON.stringify(await b.slice(-3).text()));
  console.log('nested', JSON.stringify(await new Blob([b, '!']).text()));

  // The string encoder Blob uses, on the inputs where encoders disagree: lone
  // surrogates (each becomes EF BF BD) and a valid pair.
  const sur = new Blob(['\ud800', 'a\udc00', '\ud83d\ude00']);
  console.log('surrogates', hex(await sur.bytes()));

  const crlf = new Blob(['a\r\nb\nc'], { endings: 'native' });
  console.log('endings native', hex(await crlf.bytes()));
  console.log('bad type', JSON.stringify(new Blob([], { type: 'a\u0001' }).type));

  const f = new File(['hi'], 'name.txt', { type: 'text/plain', lastModified: 42 });
  console.log('file', f.name, f.lastModified, f.size, f.type, JSON.stringify(await f.text()));

  const url = URL.createObjectURL(f);
  console.log('url prefix', url.startsWith('blob:nodedata:'), url.length);
  const r = resolveObjectURL(url);
  console.log('resolved', r instanceof Blob, r.size, r.type, JSON.stringify(await r.text()));
  URL.revokeObjectURL(url);
  console.log('revoked', resolveObjectURL(url));
})();
