// structuredClone's options and errors as a page sees them: the transfer list
// (detaching an ArrayBuffer, a buffer shared by views, duplicates, non-transferables,
// a detached buffer), StructuredSerializeOptions conversion, the DataCloneError text for
// each uncloneable kind, and Blob/File, which are serializable.
function show(label, f) {
  try {
    print(label + ': ' + f());
  } catch (e) {
    print(label + ': ' + e.constructor.name + ' ' + e.name + ': ' + e.message + ' code=' + e.code);
  }
}

async function main() {
  // Transfer.
  const ab = new Uint8Array([1, 2, 3, 4]).buffer;
  show('transfer moves', () => {
    const out = structuredClone(ab, { transfer: [ab] });
    return (
      out.byteLength +
      ' ' +
      ab.byteLength +
      ' ' +
      new Uint8Array(out).join(',') +
      ' ' +
      (out !== ab)
    );
  });
  show('transfer detached again', () => structuredClone(ab, { transfer: [ab] }));
  show('clone detached', () => structuredClone(ab));
  const ab2 = new ArrayBuffer(8);
  const view = new Uint16Array(ab2, 2, 2);
  view[0] = 7;
  show('transfer under a view', () => {
    const out = structuredClone({ view, ab2 }, { transfer: [ab2] });
    return [
      out.view.buffer === out.ab2,
      out.view[0],
      out.view.byteOffset,
      ab2.byteLength,
      view.length,
    ].join(' ');
  });
  show('transfer not in value', () => {
    const lone = new ArrayBuffer(4);
    const out = structuredClone(1, { transfer: [lone] });
    return out + ' ' + lone.byteLength;
  });
  show('transfer duplicate', () => {
    const d = new ArrayBuffer(4);
    return structuredClone(d, { transfer: [d, d] });
  });
  show('transfer non-transferable', () => structuredClone(1, { transfer: [{}] }));
  show('transfer typed array', () => structuredClone(1, { transfer: [new Uint8Array(2)] }));
  show('transfer not iterable', () => structuredClone(1, { transfer: 5 }));
  show('transfer string', () => structuredClone(1, { transfer: 'ab' }));
  show('transfer null', () => structuredClone(1, { transfer: null }));
  show('transfer undefined', () => structuredClone(2, { transfer: undefined }));
  show('transfer empty', () => structuredClone(3, { transfer: [] }));
  show('options 5', () => structuredClone(1, 5));
  show('options null', () => structuredClone(4, null));
  show('options function', () => structuredClone(5, () => {}));
  show('failed clone keeps buffer', () => {
    const keep = new ArrayBuffer(4);
    try {
      structuredClone({ keep, f() {} }, { transfer: [keep] });
    } catch (e) {
      return e.name + ' ' + keep.byteLength;
    }
  });
  let order = [];
  show(
    'order',
    () =>
      structuredClone(
        {
          get a() {
            order.push('value');
            return 1;
          },
        },
        {
          get transfer() {
            order.push('transfer');
            return [];
          },
        },
      ).a,
  );
  print('order ' + order.join(','));

  // DataCloneError text per kind.
  function named() {}
  show('function', () => structuredClone(named));
  show('arrow', () => structuredClone(() => 1));
  show('symbol', () => structuredClone(Symbol('desc')));
  show('nested function', () => structuredClone({ a: [1, Math.max] }));
  show('promise', () => structuredClone(Promise.resolve()));
  show('weakmap', () => structuredClone(new WeakMap()));
  show('weakref', () => structuredClone(new WeakRef({})));
  show('no argument', () => structuredClone());
  show('error is DOMException', () => {
    try {
      structuredClone(named);
    } catch (e) {
      return (e instanceof DOMException) + ' ' + e.code + ' ' + Object.keys(e).length;
    }
  });

  // Boxed primitives.
  show('boxed BigInt', () => {
    const v = structuredClone(Object(5n));
    return Object.prototype.toString.call(v) + ' ' + v.valueOf() + ' ' + typeof v;
  });
  show('boxed Symbol', () => structuredClone(Object(Symbol('b'))));

  // Blob and File are serializable.
  const blob = new Blob(['hello'], { type: 'text/plain' });
  const blobClone = structuredClone(blob);
  print(
    'blob clone ' +
      (blobClone instanceof Blob) +
      ' ' +
      (blobClone !== blob) +
      ' ' +
      blobClone.size +
      ' ' +
      blobClone.type +
      ' ' +
      (await blobClone.text()),
  );
  const file = new File(['xy'], 'n.txt', { type: 'a/b', lastModified: 42 });
  const fileClone = structuredClone({ file, again: file });
  print(
    'file clone ' +
      Object.prototype.toString.call(fileClone.file) +
      ' ' +
      fileClone.file.name +
      ' ' +
      fileClone.file.lastModified +
      ' ' +
      fileClone.file.type +
      ' ' +
      (fileClone.file === fileClone.again) +
      ' ' +
      (await fileClone.file.text()),
  );
}
main().catch((e) => print('FAILED ' + e));
