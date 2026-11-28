// web-oracle: real-time 2000
// The platform's own bodies are byte streams: Blob.prototype.stream(), a Request's and
// a Response's body (in-memory, from a Blob, cloned, teed) and a fetched response's
// body all take a BYOB reader. Every chunk a page reads is its own: reading must leave
// the source readable and unchanged even when the page writes into the chunk (the
// "intact" lines) — a source handing out its own bytes would let the page rewrite the
// Blob, and the spec's enqueue would detach them. Chunk boundaries are printed only
// where Chrome's are stable: a large Blob's depend on its data pipe and vary run to
// run, so none is read here. Real time, not virtual: Chrome's blob reads cross
// processes, and under the virtual-time budget the page was dumped before they
// finished.
const log = (...parts) => print(parts.join(' '));
function show(v) {
  if (v === undefined) return 'undefined';
  const bytes = Array.from(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
  return (
    v.constructor.name +
    '(off ' +
    v.byteOffset +
    ' len ' +
    v.byteLength +
    ' buf ' +
    v.buffer.byteLength +
    ')[' +
    bytes.slice(0, 8).join(',') +
    ']'
  );
}
// Every chunk a default reader gets: type, length, its buffer's length, offset.
async function chunks(rs) {
  const reader = rs.getReader();
  const out = [];
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    const v = r.value;
    out.push(
      v.constructor.name + ':' + v.byteLength + '/' + v.buffer.byteLength + '@' + v.byteOffset,
    );
  }
  return out.join(' ') || '(none)';
}
// BYOB reads into a fresh `n`-byte Uint8Array each time, through to done.
async function byob(rs, n) {
  const reader = rs.getReader({ mode: 'byob' });
  const out = [];
  for (;;) {
    const r = await reader.read(new Uint8Array(n));
    if (r.done) {
      out.push('done ' + show(r.value));
      break;
    }
    out.push(show(r.value));
  }
  return out.join(' | ');
}
async function t(name, f) {
  try {
    log(name, await f());
  } catch (e) {
    log(name, 'THREW', e.name, e.message);
  }
}

async function main() {
  const big = new Uint8Array(200000);
  for (let i = 0; i < big.length; i++) big[i] = i & 255;

  await t('blob reader', async () => {
    const s = new Blob(['x']).stream();
    return s.constructor.name + ' ' + s.getReader({ mode: 'byob' }).constructor.name;
  });
  // First, and over a one-part Blob, so that a source enqueuing the Blob's own bytes
  // instead of a copy breaks THIS line before any chunk boundary differs.
  await t('blob intact', async () => {
    const u = new Uint8Array([1, 2, 3, 4]);
    const b = new Blob([u]);
    const r = b.stream().getReader();
    const chunk = (await r.read()).value;
    chunk.fill(9);
    const first = show(chunk) + ' ' + JSON.stringify(await r.read());
    const second = await byob(b.stream(), 3);
    const third = await chunks(b.stream());
    const back = Array.from(new Uint8Array(await b.arrayBuffer())).join(',');
    return first + ' / ' + second + ' / ' + third + ' / ' + back + ' ' + u.buffer.byteLength;
  });
  await t('blob parts intact', async () => {
    const b = new Blob(['ab', new Uint8Array([1]), 'c']);
    const read = await chunks(b.stream());
    return read + ' / ' + JSON.stringify(await b.text()) + ' ' + b.size;
  });
  // A small Blob is one chunk, however many parts built it.
  await t('blob parts default', () =>
    chunks(new Blob(['abc', 'de', new Uint8Array([1])]).stream()),
  );
  await t('blob byob 4', () => byob(new Blob(['abcd', 'efghij']).stream(), 4));
  await t('blob empty byob', () => byob(new Blob([]).stream(), 4));
  await t('blob empty default', () => chunks(new Blob([]).stream()));
  await t('blob slice byob', () => byob(new Blob(['0123456789']).slice(2, 7).stream(), 3));
  await t('blob textStream', async () => {
    const r = new Blob(['hé']).textStream().getReader();
    return JSON.stringify((await r.read()).value);
  });
  await t('blob byob min', async () => {
    const r = new Blob(['abcdefgh']).stream().getReader({ mode: 'byob' });
    return show((await r.read(new Uint8Array(8), { min: 8 })).value);
  });
  await t('blob byob u16 odd tail', async () => {
    const r = new Blob(['abcdefg']).stream().getReader({ mode: 'byob' });
    const a = await r.read(new Uint16Array(4));
    log('  first', show(a.value));
    await r.read(new Uint16Array(4));
    return 'no throw';
  });
  await t('blob cancel', async () => {
    const s = new Blob(['abc']).stream();
    await s.cancel();
    return JSON.stringify(await s.getReader().read());
  });
  await t('blob release mid byob', async () => {
    const s = new Blob(['abcdef']).stream();
    const r = s.getReader({ mode: 'byob' });
    const a = await r.read(new Uint8Array(2));
    r.releaseLock();
    return show(a.value) + ' then ' + (await chunks(s));
  });
  await t('blob pipeThrough', () =>
    chunks(new Blob(['abc']).stream().pipeThrough(new TransformStream())),
  );
  await t('blob async iterator', async () => {
    const out = [];
    for await (const c of new Blob(['abc', 'd']).stream()) out.push(show(c));
    return out.join(' ');
  });

  // In-memory bodies: one chunk with the whole body.
  await t('response string default', () => chunks(new Response('hello').body));
  await t('response big default', () => chunks(new Response(big).body));
  await t('response string byob', () => byob(new Response('hello').body, 2));
  await t('response blob byob', () => byob(new Response(new Blob(['abc', 'de'])).body, 3));
  await t('response arraybuffer byob', () =>
    byob(new Response(new Uint8Array([1, 2, 3]).buffer).body, 8),
  );
  await t('response params byob', () => byob(new Response(new URLSearchParams('a=b')).body, 64));
  await t('response formdata byob', async () => {
    const fd = new FormData();
    fd.append('a', 'b');
    const r = new Response(fd).body.getReader({ mode: 'byob' });
    return (await r.read(new Uint8Array(4))).value.byteLength;
  });
  await t('response null body', async () => String(new Response(null).body));
  // A page's own stream stays what it was: a default stream.
  await t('response page stream', async () => {
    const s = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array([1]));
        c.close();
      },
    });
    const r = new Response(s);
    return (r.body === s) + ' ' + (await byob(r.body, 4));
  });
  await t('response intact', async () => {
    const u = new Uint8Array([5, 6, 7]);
    const r = new Response(u);
    const read = await byob(r.body, 2);
    return read + ' / ' + Array.from(u).join(',') + ' ' + u.buffer.byteLength;
  });
  await t('response clone intact', async () => {
    const r = new Response('abc');
    const c = r.clone();
    const chunk = (await r.body.getReader().read()).value;
    chunk.fill(48);
    return show(chunk) + ' / ' + (await c.text());
  });
  await t('response bodyUsed after byob', async () => {
    const r = new Response('xyz');
    await byob(r.body, 8);
    return (
      r.bodyUsed +
      ' ' +
      (await r.text().then(
        () => 'ok',
        (e) => e.message,
      ))
    );
  });
  await t('response clone byob', async () => {
    const r = new Response('abcdef');
    const c = r.clone();
    return (await byob(c.body, 4)) + ' / ' + (await byob(r.body, 4));
  });
  await t('response tee', async () => {
    const [a, b] = new Response('abcdef').body.tee();
    return (await byob(a, 4)) + ' / ' + (await chunks(b));
  });

  await t('request byob', () =>
    byob(new Request('http://x/', { method: 'POST', body: 'hello' }).body, 3),
  );
  await t('request blob byob', () =>
    byob(new Request('http://x/', { method: 'POST', body: new Blob(['hi']) }).body, 3),
  );
  await t('request clone byob', () =>
    byob(new Request('http://x/', { method: 'POST', body: 'hello' }).clone().body, 3),
  );

  // A body off the network.
  await t('fetch byob', async () => byob((await fetch(ORIGIN + '/fx/bytes')).body, 3));
  await t('fetch default', async () => chunks((await fetch(ORIGIN + '/fx/text')).body));
  await t('fetch tee', async () => {
    const [a, b] = (await fetch(ORIGIN + '/fx/text')).body.tee();
    return (await byob(a, 8)) + ' / ' + (await byob(b, 100));
  });
  await t('fetch clone', async () => {
    const r = await fetch(ORIGIN + '/fx/text');
    const c = r.clone();
    return (await byob(c.body, 8)) + ' / ' + (await r.text());
  });
}
main().catch((e) => print('FAILED ' + e));
