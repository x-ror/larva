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
const gzipTimes = (b, n) => (n === 0 ? b : gzipTimes(gzip(b), n - 1));
const gzipList = (n) => Array(n).fill('gzip').join(', ');

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

// A zstd v0.7 frame (magic 0xFD2FB527, a 1 KiB window, one raw block and the end block),
// which a libzstd built with legacy support decodes; no encoder writes this format today.
function zstdLegacy07(b) {
  const block = Buffer.from([0x40 | (b.length >> 16), (b.length >> 8) & 0xff, b.length & 0xff]);
  return Buffer.concat([Buffer.from([0x27, 0xb5, 0x2f, 0xfd, 0, 0]), block, b, Buffer.from([0xc0, 0, 0])]);
}

// A skippable frame (RFC 8878 §3.1.2, magic 0x184D2A50) carrying `b` as its user data.
function zstdSkippable(b) {
  const head = Buffer.from([0x50, 0x2a, 0x4d, 0x18, 0, 0, 0, 0]);
  head.writeUInt32LE(b.length, 4);
  return Buffer.concat([head, b]);
}

// A raw deflate stream whose first two bytes also pass as a zlib header (RFC 1950 §2.2:
// method 8, window 7, CMF*256+FLG a multiple of 31): a non-final stored block of
// `flg` bytes, whose LEN's low byte is the FLG zlib reads, then the rest as a final
// stream. With flg 0x20 the zlib reading also asks for a preset dictionary (FDICT).
function rawZlibLookalike(b, flg) {
  const stored = Buffer.from([0x78, flg, 0, ~flg & 0xff, 0xff]);
  return Buffer.concat([stored, b.subarray(0, flg), raw(b.subarray(flg))]);
}

const g = gzip(text);
const z = zlib.deflateSync(text);
const b = br(text);
const zs = zstd(text);
// A skippable frame cut short: its header declares 64 bytes of user data, 4 follow.
const skippableShort = zstdSkippable(Buffer.alloc(64)).subarray(0, 12);

// [name, Content-Encoding lines, secure context, body, status (200 when absent)]
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
  ['deflate-raw-zlib-lookalike', ['deflate'], true, rawZlibLookalike(text, 0x01)],
  ['deflate-raw-fdict-lookalike', ['deflate'], true, rawZlibLookalike(Buffer.alloc(64, '<p>fdict</p>'), 0x20)],
  ['deflate-bad-fcheck', ['deflate'], true, Buffer.concat([Buffer.from([0x78, 0x9d]), z.subarray(2)])],
  ['deflate-window-8', ['deflate'], true, Buffer.concat([Buffer.from([0x88, 0x1c]), z.subarray(2)])],
  ['deflate-raw-trailing-junk', ['deflate'], true, Buffer.concat([raw(text), Buffer.from('JUNKJUNK')])],
  // Fewer than four bytes after a raw stream are an adler32 cut short, not a wrong one.
  ['deflate-raw-trailing-3', ['deflate'], true, Buffer.concat([raw(text), Buffer.from('JUN')])],
  ['deflate-zlib-trailing-junk', ['deflate'], true, Buffer.concat([z, Buffer.from('JUNKJUNK')])],
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
  ['zstd-legacy-v07', ['zstd'], true, zstdLegacy07(text)],
  ['zstd-then-legacy-v07', ['zstd'], true, Buffer.concat([zs, zstdLegacy07(second)])],
  [
    'zstd-skippable-then-legacy-v07',
    ['zstd'],
    true,
    Buffer.concat([zstdSkippable(second), zstdLegacy07(text)]),
  ],
  ['zstd-then-skippable-cut-short', ['zstd'], true, Buffer.concat([zs, skippableShort])],
  ['zstd-skippable-then-frame', ['zstd'], true, Buffer.concat([zstdSkippable(second), zs])],
  ['stack-gzip-zstd', ['gzip, zstd'], true, zstd(g)],
  ['stack-two-lines', ['gzip', 'br'], true, br(g)],
  ['stack-deflate-gzip', ['deflate, gzip'], true, gzip(z)],
  ['stack-10', [gzipList(10)], true, gzipTimes(text, 10)],
  ['stack-11', [gzipList(11)], true, gzipTimes(text, 11)],
  ['stack-17-then-unknown', [`${gzipList(17)}, foo`], true, gzipTimes(text, 17)],
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
  ['insecure-br-then-unknown', ['br, foo'], false, b],
  ['insecure-unknown-then-br', ['foo, br'], false, b],
  ['insecure-zstd-identity', ['zstd, identity'], false, zs],
  ['insecure-br-line-unknown-line', ['br', 'foo'], false, b],
  ['insecure-br-204', ['br'], false, Buffer.alloc(0), 204],
  ['insecure-br-empty-200', ['br'], false, Buffer.alloc(0)],
];

// Bodies for what is Larva's alone, so they are not cases and have no recording. limit-*
// test the decoded-size limit (Chrome has none): 64 KiB of content, several times the
// decoder's first output buffer, so refusing it at a max_body between the two takes more
// than one growth. gzip-incompressible tests the decoded body's spare capacity: content
// that does not compress decodes to about the size of its input, a quarter of the
// decoder's first guess at it.
const sixtyFour = Buffer.alloc(64 * 1024, '<p>abcdefghij</p>');
const noise = Buffer.alloc(64 * 1024);
for (let i = 0, x = 1; i < noise.length; i++) {
  x = (Math.imul(x, 1103515245) + 12345) >>> 0;
  noise[i] = x >>> 24;
}
const limitOnly = [
  ['limit-gzip', gzip(sixtyFour)],
  ['limit-deflate', zlib.deflateSync(sixtyFour)],
  ['limit-br', br(sixtyFour)],
  ['limit-zstd', zstd(sixtyFour)],
  ['gzip-incompressible', gzip(noise)],
  // Over the inline input bound, under the inline output cap: it must still go to the pool.
  ['gzip-incompressible-4k', gzip(noise.subarray(0, 4096))],
];

for (const [name, , , body] of cases) {
  writeFileSync(join(dir, `${name}.in`), body);
}

for (const [name, body] of limitOnly) {
  writeFileSync(join(dir, `${name}.in`), body);
}

const index = cases.map(([name, encoding, secure, , status]) =>
  status ? { name, encoding, secure, status } : { name, encoding, secure },
);
writeFileSync(join(dir, 'cases.json'), `${JSON.stringify(index, null, '\t')}\n`);
