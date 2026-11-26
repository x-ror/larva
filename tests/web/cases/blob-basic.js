// Blob and File: size, type normalization, text/arrayBuffer/bytes, slice with
// negative offsets, File's name/lastModified, and Blob.stream() as a byte stream
// (chunks are copies, an empty Blob closes at once, the stream is async-iterable).
// Ported from tests/node-compat/cases/09-blob.js (node:buffer and Buffer parts dropped).
const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
async function main() {
  const blob = new Blob(['foo', new TextEncoder().encode('bar'), new Uint8Array([0x21])], {
    type: 'Text/Plain',
  });
  print('size ' + blob.size + ' type ' + blob.type);
  print('text ' + (await blob.text()));
  print('arrayBuffer ' + hex(new Uint8Array(await blob.arrayBuffer())));
  const bytes = await blob.bytes();
  print('bytes ' + bytes.constructor.name + ' ' + hex(bytes));

  const slice = blob.slice(3, 6, 'x/y');
  print('slice ' + slice.size + ' ' + slice.type + ' ' + (await slice.text()));
  print('slice(-1) ' + (await blob.slice(-1).text()));
  print('non-printable type ' + JSON.stringify(new Blob([], { type: 'a\nb' }).type));

  const file = new File(['hello'], 'greeting.txt', { type: 'text/plain', lastModified: 42 });
  print(
    'file ' +
      (file instanceof Blob) +
      ' ' +
      file.name +
      ' ' +
      file.lastModified +
      ' ' +
      file.size +
      ' ' +
      (await file.text()),
  );
  try {
    new File(['x']);
    print('File without name did not throw');
  } catch (e) {
    print('File without name threw ' + e.constructor.name);
  }

  const sblob = new Blob(['foo', new Uint8Array([0x62, 0x61, 0x72]), new Uint8Array([0x21])]);
  const stream = sblob.stream();
  print('stream ' + stream.constructor.name);
  const reader = stream.getReader();
  const collected = [];
  let allU8 = true;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!(value instanceof Uint8Array)) allU8 = false;
    for (const byte of value) collected.push(byte);
  }
  print('streamed ' + hex(collected) + ' chunks Uint8Array ' + allU8);

  const r2 = sblob.stream().getReader();
  const { value: firstChunk } = await r2.read();
  firstChunk[0] = 0;
  print('chunk is a copy ' + ((await sblob.text()) === 'foobar!'));
  await r2.cancel();

  const emptyReader = new Blob([]).stream().getReader();
  print('empty stream done ' + (await emptyReader.read()).done);

  let viaIter = '';
  const dec = new TextDecoder();
  for await (const chunk of new Blob(['hello world']).stream()) viaIter += dec.decode(chunk);
  print('async iterated ' + viaIter);
}
main().catch((e) => print('FAILED ' + e));
