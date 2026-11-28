// An empty body is a body: the fetch standard's "extract a body" gives '' (or an empty
// Blob, or a zero-length buffer) an empty byte stream, and only an absent body
// (undefined, null) leaves `body` null. What a page sees of each: the stream, what a
// default and a BYOB reader get, the readers' results, and what follows from a body
// being present (GET/HEAD and null-body statuses refuse it, a clone keeps it).
const log = (...parts) => print(parts.join(' '));
async function t(name, f) {
  try {
    log(name, await f());
  } catch (e) {
    log(name, 'THREW', e.name, e.message);
  }
}
const kind = (b) => (b === null ? 'null' : b.constructor.name);
async function readAll(body) {
  if (body === null) return 'null';
  const r = await body.getReader().read();
  return JSON.stringify(r.done) + ' ' + String(r.value);
}
async function byob(body) {
  const r = await body.getReader({ mode: 'byob' }).read(new Uint8Array(4));
  return (
    r.done +
    ' ' +
    r.value.constructor.name +
    ' ' +
    r.value.byteLength +
    ' ' +
    r.value.buffer.byteLength
  );
}
const post = (body) => new Request('http://x/', { method: 'POST', body });

async function main() {
  const responses = [
    ['absent', () => new Response()],
    ['undefined', () => new Response(undefined)],
    ['null', () => new Response(null)],
    ['string', () => new Response('')],
    ['blob', () => new Response(new Blob([]))],
    ['buffer', () => new Response(new ArrayBuffer(0))],
    ['view', () => new Response(new Uint8Array(0))],
    ['params', () => new Response(new URLSearchParams())],
    ['toString', () => new Response({ toString: () => '' })],
  ];
  for (const [name, make] of responses) {
    await t('response ' + name, async () => {
      const r = make();
      return kind(r.body) + ' ' + r.bodyUsed + ' ' + (await readAll(r.body)) + ' ' + r.bodyUsed;
    });
  }
  const requests = [
    ['absent', () => new Request('http://x/', { method: 'POST' })],
    ['null', () => post(null)],
    ['string', () => post('')],
    ['blob', () => post(new Blob([]))],
    ['view', () => post(new Uint8Array(0))],
  ];
  for (const [name, make] of requests) {
    await t('request ' + name, async () => {
      const r = make();
      return kind(r.body) + ' ' + (await readAll(r.body));
    });
  }

  await t('byob response', () => byob(new Response('').body));
  await t('byob request', () => byob(post('').body));
  await t('text', () => new Response('').text().then(JSON.stringify));
  await t('arrayBuffer', async () => (await new Response('').arrayBuffer()).byteLength);
  await t('bytes', async () => (await new Response('').bytes()).length);
  await t('blob', async () => {
    const b = await new Response('').blob();
    return b.size + ' ' + JSON.stringify(b.type);
  });
  // The name only: the message is the engine's JSON parser's.
  await t('json', () =>
    new Response('').json().then(
      () => 'resolved',
      (e) => e.name,
    ),
  );
  await t('used', async () => {
    const r = new Response('');
    await r.text();
    return r.bodyUsed + ' ' + (await r.text());
  });
  await t('clone', async () => {
    const c = new Response('').clone();
    return kind(c.body) + ' ' + (await readAll(c.body));
  });
  await t('request clone', async () => {
    const c = post('').clone();
    return kind(c.body) + ' ' + (await readAll(c.body));
  });
  await t('content-type', () => new Response('').headers.get('content-type'));
  await t('status 204', () => kind(new Response('', { status: 204 }).body));
  await t('status 204 null', () => kind(new Response(null, { status: 204 }).body));
  await t('get with empty', () => kind(new Request('http://x/', { body: '' }).body));
  await t('get from empty post', () => kind(new Request(post(''), { method: 'GET' }).body));
  await t('get from bodiless post', () =>
    kind(new Request(new Request('http://x/', { method: 'POST' }), { method: 'GET' }).body),
  );
  await t('fetch post empty', async () => {
    const r = await fetch(ORIGIN + '/fx/echo', { method: 'POST', body: '' });
    return await r.text();
  });
}
main().catch((e) => print('FAILED ' + e));
