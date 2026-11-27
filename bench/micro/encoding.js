// TextEncoder / TextDecoder throughput (run by bench/run.mjs under `lava run`, with
// bench/lib/harness.js prepended). Covers BOTH decoder routes, because they
// have completely different cost models and only one of them was ever measured:
//   * the native fast path — a fresh, non-streaming, non-fatal utf-8
//     decode, which is what most page code and url.js's lenient percent-decode hit;
//   * the JS code-unit loop — utf-16le, windows-1252, {fatal:true} and
//     {stream:true}. url.js's percentDecodeHostStrict decodes every
//     percent-encoded host through the fatal decoder, so this path is on the URL
//     hot path even though no user ever asks for it by name.
// The JS loop is the one that regressed 1.43x when its accumulator was routed
// through a variadic primordial wrapper, with `make bench` blind to it because
// bench/ had no encoding coverage at all.

const text = 'Lorem ipsum dolor sit amet, cönsectetur adipiscing élit — 你好世界 😀 ';
// ~3.96k code units: a realistic body; measures the decode loops themselves on
// a representative payload.
const big = text.repeat(60);
// ~8.7k code units: past what used to be unitsToString's 0x2000 fromCharCode
// chunk boundary. The little-endian path now routes every size through the
// native utf16le codec (only the big-endian fallback still chunks), so
// `decode-chunked` no longer exercises a distinct branch — it stays as the
// large-payload scaling check for the accumulator.
const huge = text.repeat(132);

const u8 = new TextEncoder().encode(big);
const u16 = (() => {
  const a = new Uint8Array(big.length * 2);
  for (let i = 0; i < big.length; i++) {
    const c = big.charCodeAt(i);
    a[i * 2] = c & 0xff;
    a[i * 2 + 1] = c >> 8;
  }
  return a;
})();
const latin = new Uint8Array(4096);
for (let i = 0; i < latin.length; i++) latin[i] = i & 0xff;

// windows-1252 bytes sized to `huge` (one byte -> one code unit).
const latinHuge = new Uint8Array(huge.length);
for (let i = 0; i < latinHuge.length; i++) latinHuge[i] = i & 0xff;

// 8 bytes: measures the fixed per-decode overhead of the accumulator route —
// view allocation, the captured-getter read, one FFI crossing into the utf16le
// codec. It exists to make a tiny-input regression visible; a path dominated by
// fixed cost is also the noisiest, see bench/thresholds.json before gating on it.
const latinTiny = new Uint8Array(8);
for (let i = 0; i < latinTiny.length; i++) latinTiny[i] = 0x80 + i;

const decUtf8 = new TextDecoder();
const decUtf8Fatal = new TextDecoder('utf-8', { fatal: true });
const dec16 = new TextDecoder('utf-16le');
const dec1252 = new TextDecoder('windows-1252');
const enc = new TextEncoder();
const dest = new Uint8Array(big.length * 4);

bench('decode-utf8-fastpath', () => decUtf8.decode(u8), { iterations: 5000 });
bench('decode-utf8-fatal', () => decUtf8Fatal.decode(u8), { iterations: 2000 });
bench('decode-utf16le', () => dec16.decode(u16), { iterations: 1500 });
bench('decode-win1252', () => dec1252.decode(latin), { iterations: 2000 });
bench('decode-win1252-tiny', () => dec1252.decode(latinTiny), { iterations: 50000 });
bench('decode-chunked', () => dec1252.decode(latinHuge), { iterations: 1000 });
bench(
  'decode-utf8-stream',
  () => {
    const d = new TextDecoder();
    d.decode(u8.subarray(0, 100), { stream: true });
    d.decode(u8.subarray(100));
  },
  { iterations: 2000 },
);
bench('encode-utf8', () => enc.encode(big), { iterations: 4000 });
bench('encode-into', () => enc.encodeInto(big, dest), { iterations: 2500 });
bench('new-textdecoder', () => new TextDecoder('utf-8'), { iterations: 200000 });

// btoa/atob: the forgiving-base64 pair a page reaches for in place of Buffer.
const ascii = 'The quick brown fox jumps over the lazy dog. '.repeat(24);
const b64 = btoa(ascii);
bench('btoa', () => btoa(ascii), { iterations: 10000 });
bench('atob', () => atob(b64), { iterations: 5000 });
