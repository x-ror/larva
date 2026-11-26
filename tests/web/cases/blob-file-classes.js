// Blob and File as classes, and the byte semantics where encoders disagree: the
// constructors' shape, subclassing, brands, nested Blobs, lone surrogates, native
// line endings, a rejected type, and File's fields.
// Ported from tests/node-compat/cases/77-blob-file-module.js (its module-frame and
// node:buffer parts are Node-only).
const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
for (const C of [Blob, File]) {
  print(C.name + ' prototype writable ' + Object.getOwnPropertyDescriptor(C, 'prototype').writable);
  try {
    C([], 'f');
    print(C.name + ' without new: no throw');
  } catch (e) {
    print(C.name + ' without new: ' + e.constructor.name);
  }
}
print('File extends Blob ' + (new File([], 'f') instanceof Blob));
class MyBlob extends Blob {
  hello() {
    return 'hello ' + this.size;
  }
}
const mine = new MyBlob(['abc']);
print(
  'subclass ' +
    (mine instanceof Blob) +
    ' ' +
    (mine instanceof MyBlob) +
    ' ' +
    mine.hello() +
    ' ' +
    JSON.stringify(mine.type),
);
class MyFile extends File {}
const myFile = new MyFile(['x'], 'my.txt', { lastModified: 7 });
print(
  'subclass File ' +
    (myFile instanceof File) +
    ' ' +
    myFile.name +
    ' ' +
    myFile.lastModified +
    ' ' +
    myFile.size,
);
const tag = (o) => Object.prototype.toString.call(o);
print('tags ' + tag(new Blob([])) + ' ' + tag(new File([], 'f')) + ' ' + String(new Blob([])));

async function main() {
  const b = new Blob(['ab', new Uint8Array([0x63]), 'dé'], { type: 'Text/Plain' });
  print('blob ' + b.size + ' ' + JSON.stringify(b.type) + ' ' + JSON.stringify(await b.text()));
  print('arrayBuffer ' + hex(new Uint8Array(await b.arrayBuffer())));
  print('bytes ' + hex(await b.bytes()));
  const s = b.slice(1, -1, 'x/y');
  print('slice ' + s.size + ' ' + s.type + ' ' + JSON.stringify(await s.text()));
  print('slice neg ' + JSON.stringify(await b.slice(-3).text()));
  print('nested ' + JSON.stringify(await new Blob([b, '!']).text()));
  const sur = new Blob(['\ud800', 'a\udc00', '😀']);
  print('surrogates ' + hex(await sur.bytes()));
  const crlf = new Blob(['a\r\nb\nc'], { endings: 'native' });
  print('endings native ' + hex(await crlf.bytes()));
  const transparent = new Blob(['a\r\nb\nc'], { endings: 'transparent' });
  print('endings transparent ' + hex(await transparent.bytes()));
  print('bad type ' + JSON.stringify(new Blob([], { type: 'a\u0001' }).type));
  const f = new File(['hi'], 'name.txt', { type: 'text/plain', lastModified: 42 });
  print(
    'file ' +
      f.name +
      ' ' +
      f.lastModified +
      ' ' +
      f.size +
      ' ' +
      f.type +
      ' ' +
      JSON.stringify(await f.text()),
  );
  print('file default lastModified is a number ' + typeof new File([], 'n').lastModified);
}
main().catch((e) => print('FAILED ' + e));
