// The fetch globals are assembled from internal modules laid out like undici's
// lib/web/fetch: js/internal/fetch/{headers,body,request,response}.js hold the classes,
// and internal/fetch keeps the driver (it owns the `native` transport binding) and
// installs the globals. A throw from Headers code used to carry a `node:internal/fetch:`
// frame, because everything was defined in internal/fetch.js; now it names its file.
//
// Node bundles undici into ONE file, so its frames all read
// `node:internal/deps/undici/undici` and there is no per-file name to oracle against.
// Each frame line therefore prints `ok` when the frame comes from the expected file in
// EITHER spelling (Lava's `node:internal/fetch/<file>`, node's bundled undici) and
// names the frame it got otherwise, plus whether the old `node:internal/fetch:` frame is
// still there — false on node by construction, false on Lava after the split. Only the
// source name is compared, never the message, line or column (Lava's messages are not
// undici's; that is a separate gap). Every site throws synchronously on both runtimes
// (probed on node 26.13.0).
//
// The new ids must stay internal: like `internal/fetch` itself (74-builtin-visibility),
// neither the bare nor the `node:` spelling may resolve from user code. Only the error
// CODE of the bare spelling is printed (the messages diverge, #415).
//
// The behavior lines after that cross every file seam — Response and Request build
// their Headers and Body from the same modules the globals expose — so a move that
// loses a helper or re-wires an identity fails here and not only in a stack.
'use strict';

for (const id of [
  'internal/fetch/headers',
  'internal/fetch/body',
  'internal/fetch/request',
  'internal/fetch/response',
  'fetch/headers',
]) {
  let code = 'RESOLVED';
  try {
    require(id);
  } catch (e) {
    code = e.code;
  }
  let threw = false;
  try {
    require('node:' + id);
  } catch {
    threw = true;
  }
  console.log('hidden', id, code, 'node:' + (threw ? 'threw' : 'RESOLVED'));
}

function frame(label, file, f) {
  let stack = null;
  try {
    f();
  } catch (e) {
    stack = String(e && e.stack);
  }
  if (stack === null) return console.log(label + ': NO THROW');
  const where =
    stack.includes('node:internal/deps/undici/') ||
    stack.includes('node:internal/fetch/' + file + ':')
      ? 'ok'
      : 'got ' + (stack.match(/node:[\w/]+/) || ['no node: frame'])[0];
  console.log(label + ': ' + file + ' ' + where, 'old=' + stack.includes('node:internal/fetch:'));
}

frame('Headers.append name', 'headers', () => new Headers().append('a b', 'v'));
frame('Headers.set value', 'headers', () => new Headers().set('a', 'x\r\ny'));
frame('Headers.get name', 'headers', () => new Headers().get('a b'));
frame('body toString throws', 'body', () => {
  new Response({
    toString() {
      throw new Error('x');
    },
  });
});
frame('Request credentials', 'request', () => new Request('http://u:p@x/'));
frame('Request GET body', 'request', () => new Request('http://x/', { body: 'a' }));
frame('Request redirect', 'request', () => new Request('http://x/', { redirect: 'nope' }));
frame(
  'Request duplex',
  'request',
  () => new Request('http://x/', { method: 'POST', body: new ReadableStream() }),
);
frame('Response.json BigInt', 'response', () => Response.json(1n));

// --- the assembled globals: shapes and identities --------------------------------
for (const k of ['Headers', 'Request', 'Response', 'fetch']) {
  const d = Object.getOwnPropertyDescriptor(globalThis, k);
  console.log('global', k, typeof d.value, d.value.name, d.writable, d.configurable);
}
console.log('statics', typeof Response.json, typeof Response.error);

const res = new Response('hi', { status: 201, headers: [['X-A', '1']] });
const req = new Request('http://example.com/a', { method: 'post', body: 'b' });
console.log(
  'identities',
  res instanceof Response,
  res.headers instanceof Headers,
  res.headers.constructor === Headers,
  req instanceof Request,
  req.headers.constructor === Headers,
  // A body-less source: node marks a source Request's body used when a derived one
  // takes it over, Lava shares it (a separate, pre-existing gap).
  new Request(new Request('http://x/')).headers.constructor === Headers,
  res.clone().constructor === Response,
  Response.json({}).constructor === Response,
  Response.error().constructor === Response,
);

// --- behavior across the file seams -----------------------------------------------
(async () => {
  // Names inserted in sorted order with set-cookie last: node iterates sorted, Lava in
  // insertion order with cookies at the end (a separate, pre-existing gap).
  const h = new Headers({ 'Content-Type': 'text/plain' });
  h.set('P-Trim', '  \tv\r\n');
  h.append('Set-Cookie', 'a=1; Expires=Wed, 21 Oct 2015 07:28:00 GMT');
  h.append('set-cookie', 'b=2');
  console.log('headers', [...h].map((e) => e.join('=')).join(' | '));
  console.log('getSetCookie', h.getSetCookie().length, h.get('set-cookie'));

  console.log('response', res.status, res.ok, res.headers.get('x-a'), await res.text());
  console.log('request', req.method, req.url, await req.text(), req.bodyUsed);

  const j = Response.json({ n: 1 }, { status: 202 });
  console.log('json', j.status, j.headers.get('content-type'), JSON.stringify(await j.json()));
  console.log('error', Response.error().status);

  const original = new Response('cloned');
  const copy = original.clone();
  console.log('clone', await original.text(), await copy.text());

  const bytes = await new Response(new Uint8Array([0xe2, 0x82, 0xac])).bytes();
  console.log('bytes', bytes.constructor.name, bytes.length);
  const ab = await new Response('abc').arrayBuffer();
  console.log('arrayBuffer', ab.byteLength);

  const blobRes = new Response(new Blob(['x'], { type: 'text/x-lava' }));
  console.log('blob type', blobRes.headers.get('content-type'), await blobRes.text());

  const stream = new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('st'));
        c.enqueue(new TextEncoder().encode('ream'));
        c.close();
      },
    }),
  );
  console.log('stream body', await stream.text(), stream.bodyUsed);
  try {
    await stream.text();
    console.log('second read', 'resolved');
  } catch (e) {
    console.log('second read', e.name);
  }

  const derived = new Request(new Request('http://x/p', { method: 'PUT', body: 'z' }), {
    headers: { 'x-d': '1' },
  });
  console.log('derived', derived.method, derived.headers.get('x-d'), await derived.text());

  try {
    await fetch('http://u:p@x/');
    console.log('fetch credentials', 'resolved');
  } catch (e) {
    console.log('fetch credentials', e.name);
  }
})();
