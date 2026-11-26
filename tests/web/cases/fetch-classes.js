// Headers/Request/Response as a page sees them: the globals' descriptors, statics,
// identities between the classes, header iteration, Response.json/error, clone, the
// body readers over bytes/Blob/stream sources, and a derived Request.
// Ported from the behavior half of tests/node-compat/cases/82-fetch-internal-modules.js
// (its module-frame half is Node-only; its error messages are fetch-errors.js).
for (const k of ['Headers', 'Request', 'Response', 'fetch']) {
  const d = Object.getOwnPropertyDescriptor(globalThis, k);
  print(
    'global ' +
      k +
      ' ' +
      typeof d.value +
      ' ' +
      d.value.name +
      ' ' +
      d.writable +
      ' ' +
      d.enumerable +
      ' ' +
      d.configurable,
  );
}
print('statics ' + typeof Response.json + ' ' + typeof Response.error);

const res = new Response('hi', { status: 201, headers: [['X-A', '1']] });
const req = new Request('http://example.com/a', { method: 'post', body: 'b' });
print(
  'identities ' +
    [
      res instanceof Response,
      res.headers instanceof Headers,
      req instanceof Request,
      req.headers.constructor === Headers,
      new Request(new Request('http://x/')).headers.constructor === Headers,
      res.clone().constructor === Response,
      Response.json({}).constructor === Response,
      Response.error().constructor === Response,
    ].join(','),
);

async function main() {
  const h = new Headers({ 'Content-Type': 'text/plain' });
  h.set('P-Trim', '  \tv\r\n');
  h.append('Set-Cookie', 'a=1; Expires=Wed, 21 Oct 2015 07:28:00 GMT');
  h.append('set-cookie', 'b=2');
  h.append('B-Second', 'x');
  print('headers ' + [...h].map((e) => e.join('=')).join(' | '));
  print('keys ' + [...h.keys()].join(','));
  print('getSetCookie ' + h.getSetCookie().length + ' ' + h.get('set-cookie'));

  print('response ' + res.status + ' ' + res.ok + ' ' + res.statusText + ' ' + res.type);
  print('response header ' + res.headers.get('x-a') + ' body ' + (await res.text()));
  print('request ' + req.method + ' ' + req.url + ' ' + (await req.text()) + ' ' + req.bodyUsed);
  print('request defaults ' + [req.redirect, req.mode, req.credentials, req.cache].join(','));

  const j = Response.json({ n: 1 }, { status: 202 });
  print(
    'json ' + j.status + ' ' + j.headers.get('content-type') + ' ' + JSON.stringify(await j.json()),
  );
  const err = Response.error();
  print('error ' + err.status + ' ' + err.type + ' ' + err.ok);

  const original = new Response('cloned');
  const copy = original.clone();
  print('clone ' + (await original.text()) + ' ' + (await copy.text()));

  const bytes = await new Response(new Uint8Array([0xe2, 0x82, 0xac])).bytes();
  print('bytes ' + bytes.constructor.name + ' ' + bytes.length);
  const ab = await new Response('abc').arrayBuffer();
  print('arrayBuffer ' + ab.constructor.name + ' ' + ab.byteLength);
  const blob = await new Response('abc').blob();
  print('blob ' + blob.constructor.name + ' ' + blob.size + ' ' + JSON.stringify(blob.type));

  const blobRes = new Response(new Blob(['x'], { type: 'text/x-lava' }));
  print('blob type ' + blobRes.headers.get('content-type') + ' ' + (await blobRes.text()));

  const enc = new TextEncoder();
  const stream = new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(enc.encode('st'));
        c.enqueue(enc.encode('ream'));
        c.close();
      },
    }),
  );
  print('stream body ' + (await stream.text()) + ' ' + stream.bodyUsed);
  await stream.text().then(
    () => print('second read resolved'),
    (e) => print('second read ' + e.constructor.name),
  );

  const derived = new Request(new Request('http://x/p', { method: 'PUT', body: 'z' }), {
    headers: { 'x-d': '1' },
  });
  print(
    'derived ' + derived.method + ' ' + derived.headers.get('x-d') + ' ' + (await derived.text()),
  );
  print('body null ' + new Response(null).body + ' ' + new Request('http://x/').body);
}
main().catch((e) => print('FAILED ' + e));
