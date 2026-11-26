// What TextEncoder/TextDecoder's WebIDL bindings do before the codec runs: argument
// counts, Symbol and null coercion, the receiver brand check, the ORDER arguments and
// dictionary members are converted in (each observable through a getter), and what
// encode()/encodeInto() hand back — a plain, unpooled Uint8Array and a plain object.
// encoding-errors.js holds the codec's own errors; this case is the binding layer.
function show(label, f) {
  try {
    const v = f();
    print(label + ': no throw ' + (typeof v === 'string' ? JSON.stringify(v) : String(v)));
  } catch (e) {
    print(label + ': ' + e.constructor.name + ': ' + e.message + ' code=' + e.code);
  }
}
const enc = new TextEncoder();
const dec = new TextDecoder();

// Coercion of the string arguments (DOMString label, USVString input/source).
show('ctor Symbol label', () => new TextDecoder(Symbol('s')));
show('ctor null label', () => new TextDecoder(null));
show('encode Symbol', () => enc.encode(Symbol('s')));
show('encode null', () => enc.encode(null).length);
show('encode number', () => Array.from(enc.encode(12)).join(','));
show('encodeInto Symbol source', () => enc.encodeInto(Symbol('s'), new Uint8Array(4)));

// Argument counts and encodeInto's destination type.
show('encodeInto no args', () => enc.encodeInto());
show('encodeInto one arg', () => enc.encodeInto('a'));
show('encodeInto undefined dest', () => enc.encodeInto('a', undefined));
show('encodeInto clamped dest', () => enc.encodeInto('a', new Uint8ClampedArray(2)));
show('encodeInto DataView dest', () => enc.encodeInto('a', new DataView(new ArrayBuffer(2))));
show('encodeInto ArrayBuffer dest', () => enc.encodeInto('a', new ArrayBuffer(2)));
show('encodeInto plain dest', () => enc.encodeInto('a', { length: 2 }));
let order = [];
show('encodeInto source before dest', () =>
  enc.encodeInto(
    {
      toString() {
        order.push('source');
        return 'a';
      },
    },
    5,
  ),
);
print('encodeInto order ' + order.join(','));

// decode()'s input: null, plain objects and strings are not BufferSources.
show('decode null', () => dec.decode(null));
show('decode undefined', () => dec.decode(undefined));
show('decode plain object', () => dec.decode({ length: 1, 0: 65 }));
show('decode number array', () => dec.decode([65]));
// The brand is the internal slot, not the prototype chain: an object that only
// inherits from Uint8Array.prototype has no bytes, and a Uint8Array whose prototype
// was re-pointed still has them.
show('decode Uint8Array.prototype heir', () => dec.decode(Object.create(Uint8Array.prototype)));
show('decode re-pointed Uint8Array', () =>
  dec.decode(Object.setPrototypeOf(new Uint8Array([104, 105]), Object.prototype)),
);
show('fatal decode Uint8Array.prototype heir', () =>
  new TextDecoder('utf-8', { fatal: true }).decode(Object.create(Uint8Array.prototype)),
);
show('encodeInto Uint8Array.prototype heir', () =>
  enc.encodeInto('a', Object.create(Uint8Array.prototype)),
);
show('encodeInto re-pointed Uint8Array', () =>
  enc.encodeInto('hi', Object.setPrototypeOf(new Uint8Array(4), null)),
);

// Dictionary members are read during conversion: before the label is looked up,
// after the input is converted, in lexicographic order, each exactly once.
order = [];
const opts = {
  get fatal() {
    order.push('fatal');
    return false;
  },
  get ignoreBOM() {
    order.push('ignoreBOM');
    return false;
  },
};
show('ctor bad label reads options', () => new TextDecoder('bogus', opts));
print('ctor order ' + order.join(','));
order = [];
show('ctor good label', () => new TextDecoder('utf-8', opts).encoding);
print('ctor order ' + order.join(','));
order = [];
const decodeOpts = {
  get stream() {
    order.push('stream');
    return false;
  },
};
show('decode bad input reads options', () => dec.decode(5, decodeOpts));
print('decode order ' + order.join(','));
order = [];
show('decode good input', () => dec.decode(new Uint8Array([65]), decodeOpts));
print('decode order ' + order.join(','));
show(
  'ctor fatal getter throws',
  () =>
    new TextDecoder('utf-8', {
      get fatal() {
        throw new RangeError('from fatal');
      },
    }),
);
show('decode stream getter throws', () =>
  dec.decode(new Uint8Array(1), {
    get stream() {
      throw new RangeError('from stream');
    },
  }),
);
show('ctor options function', () => new TextDecoder('utf-8', function () {}).fatal);
show('ctor options array', () => new TextDecoder('utf-8', [1]).fatal);
show('ctor options truthy fatal', () => new TextDecoder('utf-8', { fatal: 'yes' }).fatal);

// The receiver: every operation and accessor brand-checks `this`.
const D = TextDecoder.prototype;
const E = TextEncoder.prototype;
const getter = (p, name) => Object.getOwnPropertyDescriptor(p, name).get;
show('decode on plain object', () => D.decode.call({}, new Uint8Array(1)));
show('decode on encoder', () => D.decode.call(enc, new Uint8Array(1)));
show('decode on prototype', () => D.decode.call(D));
show('encoding getter on plain object', () => getter(D, 'encoding').call({}));
show('fatal getter on plain object', () => getter(D, 'fatal').call({}));
show('ignoreBOM getter on plain object', () => getter(D, 'ignoreBOM').call({}));
show('encode on plain object', () => E.encode.call({}, 'a'));
show('encode on decoder', () => E.encode.call(dec, 'a'));
show('encodeInto on plain object', () => E.encodeInto.call({}, 'a', new Uint8Array(1)));
show('encoder encoding getter on plain object', () => getter(E, 'encoding').call({}));
show('encoder encoding getter on decoder', () => getter(E, 'encoding').call(dec));
show('receiver before arguments', () => E.encodeInto.call({}));

// What encode() and encodeInto() return.
const out = enc.encode('héllo');
print(
  'encode result ' +
    (Object.getPrototypeOf(out) === Uint8Array.prototype) +
    ' ' +
    out.byteOffset +
    ' ' +
    out.buffer.byteLength +
    ' ' +
    out.length,
);
const empty = enc.encode('');
print('encode empty result ' + empty.byteOffset + ' ' + empty.buffer.byteLength);
print('encode results distinct ' + (enc.encode('a').buffer !== enc.encode('a').buffer));
const r = enc.encodeInto('ab', new Uint8Array(4));
print(
  'encodeInto result ' +
    (Object.getPrototypeOf(r) === Object.prototype) +
    ' ' +
    JSON.stringify(Object.keys(r)) +
    ' ' +
    JSON.stringify(Object.getOwnPropertyDescriptor(r, 'read')),
);
const sub = new Uint8Array(8).subarray(2, 5);
print('encodeInto subarray ' + JSON.stringify(enc.encodeInto('abcd', sub)));
