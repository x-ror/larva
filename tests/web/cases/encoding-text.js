// TextEncoder/TextDecoder values: UTF-8 encode and encodeInto, the decoder's defaults,
// label resolution (aliases, ASCII-whitespace trim), BOM handling, streaming across
// chunk seams, maximal-subpart U+FFFD substitution, utf-16le, windows-1252, and
// inputs straddling the decoder's 0x2000-unit accumulator.
// Ported from the value half of tests/node-compat/cases/11-text-encoding.js; what the
// decoder THROWS is encoding-errors.js.
const codes = (s) => Array.from(s, (c) => c.codePointAt(0).toString(16)).join(' ');
const bytes = (u8) => u8.constructor.name + '[' + Array.from(u8).join(',') + ']';

const encoder = new TextEncoder();
print('encoder ' + encoder.encoding);
print('encode héllo ' + bytes(encoder.encode('héllo')));
print('encode empty ' + bytes(encoder.encode('')));
print('encode no arg ' + bytes(encoder.encode()));
print('encode euro ' + bytes(encoder.encode('€')));
print('encode emoji ' + bytes(encoder.encode('😀')));
print('encode lone ' + bytes(encoder.encode('a\ud800b')));

const dest = new Uint8Array(10);
print(
  'encodeInto ' +
    JSON.stringify(encoder.encodeInto('abc€', dest)) +
    ' ' +
    Array.from(dest.slice(0, 6)).join(','),
);
print('encodeInto capacity ' + JSON.stringify(encoder.encodeInto('a€b', new Uint8Array(4))));
print('encodeInto pair split ' + JSON.stringify(encoder.encodeInto('a😀', new Uint8Array(3))));

const decoder = new TextDecoder();
print('decoder ' + decoder.encoding + ' ' + decoder.fatal + ' ' + decoder.ignoreBOM);
print('decode ' + decoder.decode(new Uint8Array([104, 195, 169])));
print('decode no arg ' + JSON.stringify(decoder.decode()));
print('utf-16le ' + new TextDecoder('utf-16le').decode(new Uint8Array([0x68, 0, 0xe9, 0])));
for (const label of [
  'latin1',
  'ascii',
  'UTF-16LE',
  'utf-16',
  'unicode-1-1-utf-8',
  'iso-ir-100',
  'iso_8859-1',
  'iso_8859-1:1987',
  'csisolatin1',
  ' \t utf-8 \r\n',
]) {
  print('label ' + JSON.stringify(label) + ' -> ' + new TextDecoder(label).encoding);
}
print(
  'windows-1252 ' +
    new TextDecoder('windows-1252').decode(new Uint8Array([0x80, 0xe9, 0x81, 0x9f])),
);
print(
  'bom stripped ' +
    JSON.stringify(new TextDecoder().decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))),
);
print(
  'bom kept ' +
    new TextDecoder('utf-8', { ignoreBOM: true }).decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))
      .length,
);
print(
  'utf-16le bom ' +
    JSON.stringify(new TextDecoder('utf-16le').decode(new Uint8Array([0xff, 0xfe, 0x41, 0]))),
);

for (const n of [8191, 8192, 8193, 16384, 16385]) {
  const latin = new Uint8Array(n);
  for (let i = 0; i < n; i++) latin[i] = 0x41 + (i % 26);
  const out = new TextDecoder('windows-1252').decode(latin);
  const u16 = new Uint8Array(n * 2);
  for (let i = 0; i < n; i++) u16[i * 2] = 0x41 + (i % 26);
  const out16 = new TextDecoder('utf-16le').decode(u16);
  print(
    'seam ' +
      n +
      ' ' +
      out.length +
      ' ' +
      out.charCodeAt(n - 1) +
      ' ' +
      out16.length +
      ' ' +
      out16.charCodeAt(n - 1),
  );
}
for (const n of [0, 1, 0x1fff, 0x2000, 0x2001]) {
  const latin = new Uint8Array(n).fill(0xe9);
  const utf16 = new Uint8Array(n * 2);
  for (let i = 0; i < n; i++) utf16[i * 2] = 0xe9;
  print(
    'accumulator ' +
      n +
      ' ' +
      (new TextDecoder('windows-1252').decode(latin) === 'é'.repeat(n)) +
      ' ' +
      (new TextDecoder('utf-16le').decode(utf16) === 'é'.repeat(n)),
  );
}

print('invalid byte ' + codes(new TextDecoder().decode(new Uint8Array([0xff]))));
print('arraybuffer ' + decoder.decode(new Uint8Array([0x41]).buffer));
print('dataview ' + decoder.decode(new DataView(new Uint8Array([0x42, 0x43]).buffer, 1)));

const s1 = new TextDecoder();
print(
  'stream utf-8 ' +
    JSON.stringify(s1.decode(new Uint8Array([0xe2, 0x82]), { stream: true })) +
    ' ' +
    s1.decode(new Uint8Array([0xac])),
);
const s2 = new TextDecoder('utf-16le');
print(
  'stream pair ' +
    JSON.stringify(s2.decode(new Uint8Array([0x3d, 0xd8]), { stream: true })) +
    ' ' +
    codes(s2.decode(new Uint8Array([0x00, 0xde]))),
);
const s3 = new TextDecoder('utf-16le');
print(
  'stream odd ' +
    JSON.stringify(s3.decode(new Uint8Array([0x41]), { stream: true })) +
    ' ' +
    s3.decode(new Uint8Array([0x00])),
);
const s4 = new TextDecoder();
print(
  'stream bom ' +
    JSON.stringify(s4.decode(new Uint8Array([0xef, 0xbb]), { stream: true })) +
    ' ' +
    s4.decode(new Uint8Array([0xbf, 0x61])),
);
const s5 = new TextDecoder();
print(
  'stream flush tail ' +
    codes(s5.decode(new Uint8Array([0x61, 0xe2]), { stream: true }) + s5.decode()),
);

print('truncated ' + codes(new TextDecoder().decode(new Uint8Array([0xf0, 0x9f]))));
print(
  'maximal subpart ' +
    codes(
      new TextDecoder().decode(new Uint8Array([0x61, 0xf1, 0x80, 0x80, 0xe1, 0x80, 0xc2, 0x62])),
    ),
);
print(
  'overlong ' + codes(new TextDecoder().decode(new Uint8Array([0xc0, 0xaf, 0xe0, 0x80, 0xbf]))),
);
print('surrogate bytes ' + codes(new TextDecoder().decode(new Uint8Array([0xed, 0xa0, 0x80]))));
print('utf-16le lone ' + codes(new TextDecoder('utf-16le').decode(new Uint8Array([0x00, 0xd8]))));
print('fatal pair ' + new TextDecoder('utf-8', { fatal: true }).decode(encoder.encode('𝄞')).length);
print(
  'options accepted ' +
    [null, [1, 2], function () {}, Object.create(null)]
      .map((o) => new TextDecoder('utf-8', o).decode(new Uint8Array([0x41]), o))
      .join(''),
);
print(
  'globals ' +
    (globalThis.TextEncoder === TextEncoder) +
    ' ' +
    (globalThis.TextDecoder === TextDecoder),
);
