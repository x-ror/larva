// The Body mixin round-trips non-ASCII through UTF-8: text(), a Request body, the
// encoded bytes, and json(). Ported from tests/node-compat/cases/23-fetch-body-utf8.js.
async function main() {
  const s = 'héllo café ☕ 日本語';
  print('response text ' + ((await new Response(s).text()) === s));
  const req = new Request('http://example/', { method: 'POST', body: s });
  print('request text ' + ((await req.text()) === s));
  const bytes = new Uint8Array(await new Response('é').arrayBuffer());
  print('bytes ' + Array.from(bytes).join(','));
  const obj = await new Response(JSON.stringify({ msg: 'café ☕' })).json();
  print('json ' + (obj.msg === 'café ☕'));
  const lone = new Uint8Array(await new Response('a\ud800b').arrayBuffer());
  print('lone surrogate ' + Array.from(lone).join(','));
  print('content-type ' + new Response('x').headers.get('content-type'));
}
main().catch((e) => print('FAILED ' + e));
