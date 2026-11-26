// Readable byte streams: the controller class, a `type: 'bytes'` source, and a BYOB
// reader filling a caller's buffer. Kept apart from streams-basic.js because Lava
// has no byte streams yet.
print('ReadableByteStreamController ' + typeof globalThis.ReadableByteStreamController);
async function main() {
  const rs = new ReadableStream({
    type: 'bytes',
    start(c) {
      c.enqueue(new Uint8Array([1, 2, 3]));
      c.close();
    },
  });
  const reader = rs.getReader({ mode: 'byob' });
  print('reader ' + reader.constructor.name);
  const { value, done } = await reader.read(new Uint8Array(8));
  print('read ' + done + ' ' + value.constructor.name + ' ' + Array.from(value).join(','));
  print('then done ' + (await reader.read(new Uint8Array(8))).done);
}
main().catch((e) => print('FAILED ' + e.constructor.name));
