// What Blob, File and the object-URL statics throw, as a page sees them: the WebIDL
// conversions (sequence<BlobPart>, the BlobPropertyBag/FilePropertyBag dictionaries and
// their EndingType enum, slice's long long and DOMString), argument counts, the
// receiver brand check (a rejected promise for the promise-returning operations), and
// the order every conversion runs in, observed through getters and toString.
// Each line prints the error's class, message and `code` (a page's errors have none).
function show(label, f) {
  try {
    const v = f();
    if (v && typeof v.then === 'function') {
      return v.then(
        (r) => print(label + ': resolved ' + (typeof r === 'string' ? JSON.stringify(r) : r)),
        (e) => print(label + ': rejected ' + e.constructor.name + ': ' + e.message),
      );
    }
    print(label + ': no throw ' + (typeof v === 'string' ? JSON.stringify(v) : String(v)));
  } catch (e) {
    print(label + ': ' + e.constructor.name + ': ' + e.message + ' code=' + e.code);
  }
}

async function main() {
  // sequence<BlobPart> and the dictionary.
  show('Blob(5)', () => new Blob(5));
  show('Blob(string)', () => new Blob('abc'));
  show('Blob({})', () => new Blob({}));
  show('Blob(null)', () => new Blob(null).size);
  show('Blob(undefined)', () => new Blob(undefined).size);
  show('Blob(array-like)', () => new Blob({ length: 1, 0: 'a' }));
  show('Blob(Set)', () => new Blob(new Set(['ab', 'c'])).size);
  show('Blob([Symbol])', () => new Blob([Symbol('s')]));
  show('Blob([], 5)', () => new Blob([], 5));
  show('Blob([], null)', () => new Blob([], null).type);
  show('Blob endings bogus', () => new Blob([], { endings: 'bogus' }));
  show('Blob endings Symbol', () => new Blob([], { endings: Symbol('e') }));
  show('Blob type Symbol', () => new Blob([], { type: Symbol('t') }));
  show('Blob type number', () => new Blob([], { type: 12 }).type);
  let order = [];
  show(
    'Blob conversion order',
    () =>
      new Blob(
        [
          {
            toString() {
              order.push('part');
              return 'p';
            },
          },
        ],
        {
          get endings() {
            order.push('endings');
            return 'transparent';
          },
          get type() {
            order.push('type');
            return 'a/b';
          },
        },
      ).type,
  );
  print('Blob order ' + order.join(','));
  order = [];
  show(
    'Blob bad endings after parts',
    () =>
      new Blob(
        [
          {
            toString() {
              order.push('part');
              return 'p';
            },
          },
        ],
        { endings: 'nope' },
      ),
  );
  print('Blob order ' + order.join(','));
  show(
    'Blob iterator throws',
    () =>
      new Blob({
        [Symbol.iterator]: () => ({
          next() {
            throw new RangeError('it');
          },
        }),
      }),
  );
  show('Blob next not object', () => new Blob({ [Symbol.iterator]: () => ({ next: () => 5 }) }));

  // slice's conversions.
  const blob = new Blob(['abcdef'], { type: 'text/plain' });
  show('slice strings', () => blob.slice('1', '3').size);
  show('slice NaN', () => blob.slice(NaN, Infinity).size);
  show('slice huge', () => blob.slice(-1e20, 1e20).size);
  show('slice Symbol start', () => blob.slice(Symbol('s')));
  show('slice BigInt start', () => blob.slice(1n));
  show('slice Symbol type', () => blob.slice(0, 1, Symbol('t')));
  show('slice type number', () => blob.slice(0, 1, 7).type);
  show('slice type bad char', () => JSON.stringify(blob.slice(0, 1, 'aé').type));
  order = [];
  show(
    'slice order',
    () =>
      blob.slice(
        { valueOf: () => (order.push('start'), 0) },
        { valueOf: () => (order.push('end'), 1) },
        { toString: () => (order.push('type'), 'x/y') },
      ).type,
  );
  print('slice order ' + order.join(','));

  // File.
  show('File()', () => new File());
  show('File(parts)', () => new File(['a']));
  show('File(5, name)', () => new File(5, 'n'));
  show('File Symbol name', () => new File([], Symbol('n')));
  show('File null name', () => new File([], null).name);
  show('File lastModified string', () => new File([], 'n', { lastModified: '12' }).lastModified);
  show('File lastModified NaN', () => new File([], 'n', { lastModified: NaN }).lastModified);
  show('File lastModified 1.9', () => new File([], 'n', { lastModified: 1.9 }).lastModified);
  show('File lastModified -1.9', () => new File([], 'n', { lastModified: -1.9 }).lastModified);
  show('File lastModified huge', () => new File([], 'n', { lastModified: 2 ** 64 }).lastModified);
  show('File endings bogus', () => new File([], 'n', { endings: 'bogus' }));
  show('File type Symbol', () => new File([], 'n', { type: Symbol('t') }));
  show('File options 5', () => new File([], 'n', 5));
  show('File options null', () => new File([], 'n', null).name);
  show('File lastModified Symbol', () => new File([], 'n', { lastModified: Symbol('m') }));
  show('File lastModified BigInt', () => new File([], 'n', { lastModified: 1n }));
  order = [];
  show(
    'File order',
    () =>
      new File(
        [{ toString: () => (order.push('part'), 'p') }],
        { toString: () => (order.push('name'), 'n') },
        {
          get endings() {
            order.push('endings');
          },
          get lastModified() {
            order.push('lastModified');
          },
          get type() {
            order.push('type');
          },
        },
      ).name,
  );
  print('File order ' + order.join(','));

  // What text() decodes: UTF-8 with the BOM stripped and U+FFFD for bad bytes.
  await show('text strips BOM', () => new Blob(['\uFEFFab']).text());
  await show('text replaces bad bytes', () =>
    new Blob([new Uint8Array([0x61, 0xff, 0x62])]).text(),
  );
  await show('text keeps second BOM', () =>
    new Blob(['\uFEFF\uFEFFa']).text().then((t) => t.length),
  );

  // The receiver.
  const B = Blob.prototype;
  const F = File.prototype;
  const getter = (p, n) => Object.getOwnPropertyDescriptor(p, n).get;
  show('size on plain object', () => getter(B, 'size').call({}));
  show('type on plain object', () => getter(B, 'type').call({}));
  show('slice on plain object', () => B.slice.call({}));
  show('stream on plain object', () => B.stream.call({}));
  show('textStream on plain object', () => B.textStream.call({}));
  await show('text on plain object', () => B.text.call({}));
  await show('arrayBuffer on plain object', () => B.arrayBuffer.call({}));
  await show('bytes on plain object', () => B.bytes.call({}));
  show('name on a Blob', () => getter(F, 'name').call(blob));
  show('lastModified on a Blob', () => getter(F, 'lastModified').call(blob));
  show('lastModifiedDate on a Blob', () => getter(F, 'lastModifiedDate').call(blob));
  show('webkitRelativePath on a Blob', () => getter(F, 'webkitRelativePath').call(blob));
  show('size on a File', () => getter(B, 'size').call(new File(['ab'], 'f')));
  show('instance own keys', () => JSON.stringify(Reflect.ownKeys(new File(['a'], 'f'))));

  // The object-URL statics.
  show('createObjectURL()', () => URL.createObjectURL());
  show('createObjectURL({})', () => URL.createObjectURL({}));
  show('createObjectURL(blob heir)', () => URL.createObjectURL(Object.create(Blob.prototype)));
  show('revokeObjectURL()', () => URL.revokeObjectURL());
  show('revokeObjectURL(Symbol)', () => URL.revokeObjectURL(Symbol('u')));
  show('revokeObjectURL(undefined)', () => URL.revokeObjectURL(undefined));
}
main().catch((e) => print('FAILED ' + e));
