// A typed array over a RESIZABLE ArrayBuffer must hand natives its current bytes:
// a length-tracking view (with or without an offset, after a grow or a shrink) and a
// fixed view that the buffer shrank out from under (out of bounds: length 0). Each
// view is read through every page-facing byte consumer. Chrome refuses resizable-backed
// views in most WebIDL byte arguments (no [AllowResizable]), so each consumer reports
// its own value or the class it threw; the case pins which ones accept them, and what
// the ones that do read.
// Ported from tests/node-compat/cases/68-resizable-view-bytes.js; its Buffer, crypto
// hash and fs consumers are Node-only, Blob/Response/getRandomValues stand in.
const td = new TextDecoder();
const rab = () => {
  const b = new ArrayBuffer(4, { maxByteLength: 16 });
  new Uint8Array(b).set([0x61, 0x62, 0x63, 0x64]);
  return b;
};
const views = [];
{
  views.push(['auto', new Uint8Array(rab())]);
  views.push(['auto at offset 1', new Uint8Array(rab(), 1)]);
  const b1 = rab();
  const grown = new Uint8Array(b1);
  b1.resize(6);
  views.push(['auto after grow', grown]);
  const b2 = rab();
  const shrunk = new Uint8Array(b2);
  b2.resize(2);
  views.push(['auto after shrink', shrunk]);
  views.push(['fixed in bounds', new Uint8Array(rab(), 1, 2)]);
  const b3 = rab();
  const oob = new Uint8Array(b3, 0, 3);
  b3.resize(2);
  views.push(['fixed out of bounds', oob]);
}
async function attempt(f) {
  try {
    return JSON.stringify(await f());
  } catch (e) {
    return 'THROWS ' + e.constructor.name;
  }
}
async function main() {
  for (const [label, v] of views) {
    print(label + ': length ' + v.length);
    print('  decode ' + (await attempt(() => td.decode(v))));
    print('  blob ' + (await attempt(() => new Blob([v]).text())));
    print('  response ' + (await attempt(() => new Response(v).text())));
    print('  encodeInto ' + (await attempt(() => new TextEncoder().encodeInto('zz', v))));
    print('  getRandomValues ' + (await attempt(() => crypto.getRandomValues(v).length)));
  }
  print('ok');
}
main().catch((e) => print('FAILED ' + e));
