// web-oracle: real-time 4000
// Reading a fetched body whole (text/arrayBuffer/bytes/blob/json) over a body that
// arrives as many chunks (/fx/large, 256 KiB in 16 KiB writes): what the page sees of
// the stream while and after it is read, and what each reader returns. Lava reads an
// untouched fetched body without a read() per chunk; a body the page locked or
// disturbed must still be refused, and a page's own reader must still get every byte.
// "paused" reads only after the body outgrew the stream's 64 KiB queue, which pauses
// Lava's socket read until something reads again.
const log = (...parts) => print(parts.join(' '));
const SIZE = 256 * 1024;
const large = () => fetch(ORIGIN + '/fx/large');
// Whether `bytes` is exactly /fx/large's body: its length and every byte.
function intact(bytes) {
  if (bytes.length !== SIZE) return 'length ' + bytes.length;
  for (let i = 0; i < SIZE; i++) {
    if (bytes[i] !== 0x61 + (i % 26)) return 'byte ' + i;
  }
  return 'intact';
}
const text = (s) => intact(new TextEncoder().encode(s));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function t(name, f) {
  try {
    log(name, await f());
  } catch (e) {
    log(name, 'THREW', e.name, e.message);
  }
}

async function main() {
  await t('text', async () => {
    const r = await large();
    const p = r.text();
    const during = r.bodyUsed + ' ' + r.body.locked;
    const s = await p;
    return during + ' | ' + text(s) + ' | ' + r.bodyUsed + ' ' + r.body.locked;
  });
  await t('arrayBuffer', async () => {
    const r = await large();
    const ab = await r.arrayBuffer();
    return ab.constructor.name + ' ' + intact(new Uint8Array(ab));
  });
  await t('bytes', async () => {
    const r = await large();
    const u = await r.bytes();
    return (
      u.constructor.name +
      ' ' +
      u.byteOffset +
      ' ' +
      (u.buffer.byteLength === SIZE) +
      ' ' +
      intact(u)
    );
  });
  await t('blob', async () => {
    const b = await (await large()).blob();
    return b.size + ' ' + JSON.stringify(b.type) + ' ' + text(await b.text());
  });
  await t('json', async () => JSON.stringify(await (await fetch(ORIGIN + '/fx/json')).json()));
  await t('again', async () => {
    const r = await large();
    await r.arrayBuffer();
    return r.text();
  });
  await t('two readers', async () => {
    const r = await large();
    const a = r.text();
    const b = r.arrayBuffer().then(
      () => 'resolved',
      (e) => e.name + ' ' + e.message,
    );
    return text(await a) + ' | ' + (await b);
  });
  // The page holds the stream: text() is refused, and the page's reader still gets
  // the whole body.
  await t('locked', async () => {
    const r = await large();
    const reader = r.body.getReader();
    const refused = await r.text().then(
      () => 'resolved',
      (e) => e.name + ' ' + e.message,
    );
    const parts = [];
    let n = 0;
    for (;;) {
      const x = await reader.read();
      if (x.done) break;
      parts.push(x.value);
      n += x.value.length;
    }
    const all = new Uint8Array(n);
    let at = 0;
    for (const p of parts) {
      all.set(p, at);
      at += p.length;
    }
    return refused + ' | ' + r.bodyUsed + ' ' + intact(all);
  });
  // One chunk read and the reader released: disturbed, so refused.
  await t('disturbed', async () => {
    const r = await large();
    const reader = r.body.getReader();
    await reader.read();
    reader.releaseLock();
    return r.bodyUsed + ' ' + r.body.locked + ' | ' + (await r.text());
  });
  await t('paused', async () => {
    const r = await large();
    await sleep(300);
    return text(await r.text());
  });
  await t('paused arrayBuffer', async () => {
    const r = await large();
    await sleep(300);
    return intact(new Uint8Array(await r.arrayBuffer()));
  });
  // An abort while the body is being read rejects the read with the abort's reason
  // and errors the stream, which stays locked.
  await t('abort', async () => {
    const ac = new AbortController();
    const r = await fetch(ORIGIN + '/fx/large', { signal: ac.signal });
    const p = r.text();
    ac.abort();
    const got = await p.then(
      () => 'resolved',
      (e) => e.name + ' ' + (e === ac.signal.reason),
    );
    return got + ' | ' + r.bodyUsed + ' ' + r.body.locked;
  });
  // A clone tees the body: each branch is read whole, independently.
  await t('clone', async () => {
    const r = await large();
    const c = r.clone();
    const [a, b] = await Promise.all([r.text(), c.arrayBuffer()]);
    return text(a) + ' ' + intact(new Uint8Array(b));
  });
}
main().catch((e) => print('FAILED ' + e));
