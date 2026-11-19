// Generates the Content-Encoding fixtures: <name>.in is the body as the server sends
// it, cases.json says which Content-Encoding lines carry it and whether the page is a
// secure context. record-chrome.py then records what Chrome decodes from each, into
// <name>.out (the bytes) or <name>.err (a network error). pkg/http/content_coding_test.odin
// compares the decoder against those recordings.
//
//   node pkg/http/testdata/content-coding/gen.mjs        (needs node and the zstd CLI)
//   python3 pkg/http/testdata/content-coding/record-chrome.py
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const dir = dirname(fileURLToPath(import.meta.url));
const text = Buffer.from('<p>hello decoded</p>');
const second = Buffer.from('<p>second</p>');
// Large enough that a truncated stream has decoded a good part of itself.
const big = Buffer.alloc(40_000, '<p>abcdefghij</p>');
// Exactly the decoder's first output buffer (INITIAL_OUTPUT in content_coding.odin).
const first = Buffer.alloc(16 * 1024, '<p>x</p>');

const gzip = (b) => zlib.gzipSync(b, { level: 9 });
const raw = (b) => zlib.deflateRawSync(b);
const br = (b) => zlib.brotliCompressSync(b);
const zstd = (b, ...args) => execFileSync('zstd', ['-q', '-c', ...args], { input: b });
const half = (b) => b.subarray(0, b.length >> 1);

// A gzip member with every optional header field (RFC 1952 §2.3.1): FEXTRA, FNAME,
// FCOMMENT and FHCRC, which a decoder must skip, not inflate.
function gzipAllFields(b) {
  const head = Buffer.from([0x1f, 0x8b, 8, 0x02 | 0x04 | 0x08 | 0x10, 0, 0, 0, 0, 0, 3]);
  const extra = Buffer.from([4, 0, 0x41, 0x42, 0, 0]);
  const fields = Buffer.concat([head, extra, Buffer.from('name.html\0comment\0')]);
  const crc16 = Buffer.alloc(2);
  crc16.writeUInt16LE(zlib.crc32(fields) & 0xffff);
  const plain = gzip(b);
  return Buffer.concat([fields, crc16, raw(b), plain.subarray(plain.length - 8)]);
}

const g = gzip(text);
const z = zlib.deflateSync(text);
const b = br(text);
const zs = zstd(text);

// [name, Content-Encoding lines, secure context, body]
const cases = [
  ['gzip', ['gzip'], true, g],
  ['x-gzip', ['x-gzip'], true, g],
  ['gzip-case-and-space', ['  GZIP  '], true, g],
  ['gzip-all-header-fields', ['gzip'], true, gzipAllFields(text)],
  ['gzip-two-members', ['gzip'], true, Buffer.concat([g, gzip(second)])],
  ['gzip-trailing-junk', ['gzip'], true, Buffer.concat([g, Buffer.from('JUNKJUNK')])],
  ['gzip-no-trailer', ['gzip'], true, g.subarray(0, g.length - 8)],
  [
    'gzip-bad-crc',
    ['gzip'],
    true,
    Buffer.concat([g.subarray(0, g.length - 8), Buffer.alloc(4), g.subarray(g.length - 4)]),
  ],
  ['gzip-truncated', ['gzip'], true, half(g)],
  ['gzip-truncated-big', ['gzip'], true, half(gzip(big))],
  ['gzip-header-only', ['gzip'], true, g.subarray(0, 5)],
  ['gzip-bad-magic', ['gzip'], true, Buffer.from('<p>not gzip</p>')],
  [
    'gzip-corrupt',
    ['gzip'],
    true,
    Buffer.concat([g.subarray(0, 10), Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff])]),
  ],
  ['deflate-zlib', ['deflate'], true, z],
  ['deflate-raw', ['deflate'], true, raw(text)],
  [
    'deflate-bad-adler',
    ['deflate'],
    true,
    Buffer.concat([z.subarray(0, z.length - 4), Buffer.alloc(4)]),
  ],
  ['deflate-truncated-big', ['deflate'], true, half(zlib.deflateSync(big))],
  ['deflate-corrupt', ['deflate'], true, Buffer.from([0xff, 0xff, 0xff, 0xff, 0x41, 0x42])],
  ['br', ['br'], true, b],
  ['br-two-streams', ['br'], true, Buffer.concat([b, br(second)])],
  ['br-trailing-junk', ['br'], true, Buffer.concat([b, Buffer.from('JUNK')])],
  ['br-truncated', ['br'], true, b.subarray(0, b.length - 3)],
  ['br-truncated-big', ['br'], true, half(br(big))],
  ['br-corrupt', ['br'], true, Buffer.from([0xff, 0xff, 0xff, 0xff, 0x41, 0x42])],
  ['zstd', ['zstd'], true, zs],
  ['zstd-two-frames', ['zstd'], true, Buffer.concat([zs, zstd(second)])],
  ['zstd-trailing-junk', ['zstd'], true, Buffer.concat([zs, Buffer.from('JUNK')])],
  ['zstd-truncated-big', ['zstd'], true, half(zstd(big))],
  ['zstd-window-8m', ['zstd'], true, zstd(text, '--long=23', '--no-content-size')],
  ['zstd-fills-first-buffer', ['zstd'], true, zstd(first)],
  ['zstd-window-16m', ['zstd'], true, zstd(text, '--long=24', '--no-content-size')],
  ['stack-gzip-zstd', ['gzip, zstd'], true, zstd(g)],
  ['stack-two-lines', ['gzip', 'br'], true, br(g)],
  ['stack-deflate-gzip', ['deflate, gzip'], true, gzip(z)],
  ['raw-unknown', ['foo'], true, text],
  ['raw-identity', ['identity'], true, text],
  ['raw-identity-in-chain', ['identity, gzip'], true, g],
  ['raw-unknown-in-chain', ['gzip, foo'], true, g],
  ['raw-empty-element', ['gzip,,zstd'], true, zstd(g)],
  ['raw-empty-value', [''], true, text],
  ['empty-body', ['gzip'], true, Buffer.alloc(0)],
  ['insecure-gzip', ['gzip'], false, g],
  ['insecure-deflate', ['deflate'], false, z],
  ['insecure-br', ['br'], false, b],
  ['insecure-zstd', ['zstd'], false, zs],
];

for (const [name, , , body] of cases) {
  writeFileSync(join(dir, `${name}.in`), body);
}

const index = cases.map(([name, encoding, secure]) => ({ name, encoding, secure }));
writeFileSync(join(dir, 'cases.json'), `${JSON.stringify(index, null, '\t')}\n`);
