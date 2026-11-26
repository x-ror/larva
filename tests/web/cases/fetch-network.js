// fetch() over a real socket, against the suite's fixture server (ORIGIN): status,
// headers, text/json/bytes bodies, UTF-8, a redirect, a 404, and a POST body with
// request headers echoed back. Paths are printed relative to ORIGIN, never the port.
const rel = (url) => (url.startsWith(ORIGIN) ? url.slice(ORIGIN.length) : 'foreign ' + url);
async function main() {
  const text = await fetch(ORIGIN + '/fx/text');
  print('text ' + text.status + ' ' + text.ok + ' ' + rel(text.url) + ' ' + text.redirected);
  print('text type ' + text.headers.get('content-type') + ' body ' + (await text.text()));

  const utf8 = await fetch(ORIGIN + '/fx/utf8');
  print('utf8 ' + JSON.stringify(await utf8.text()));

  const json = await fetch(ORIGIN + '/fx/json');
  print('json ' + JSON.stringify(await json.json()));

  const bytes = await fetch(ORIGIN + '/fx/bytes');
  const u8 = new Uint8Array(await bytes.arrayBuffer());
  print('bytes ' + u8.length + ' ' + Array.from(u8).join(','));

  const redirected = await fetch(ORIGIN + '/fx/redirect');
  print('redirect ' + redirected.status + ' ' + rel(redirected.url) + ' ' + redirected.redirected);

  const missing = await fetch(ORIGIN + '/fx/missing');
  print('missing ' + missing.status + ' ' + missing.ok + ' ' + (await missing.text()));

  const headers = await fetch(ORIGIN + '/fx/headers');
  print(
    'x-fixture ' +
      headers.headers.get('x-fixture') +
      ' length ' +
      headers.headers.get('content-length'),
  );

  const echo = await fetch(ORIGIN + '/fx/echo', {
    method: 'POST',
    headers: { 'content-type': 'text/plain;charset=UTF-8', 'x-test': 'yes' },
    body: 'café',
  });
  print('echo ' + (await echo.text()));

  const req = new Request(ORIGIN + '/fx/echo', { method: 'PUT', body: 'from a Request' });
  print('echo request ' + (await (await fetch(req)).text()));

  const ac = new AbortController();
  ac.abort();
  await fetch(ORIGIN + '/fx/text', { signal: ac.signal }).then(
    () => print('aborted fetch resolved'),
    (e) => print('aborted fetch rejected ' + e.name),
  );
}
main().catch((e) => print('FAILED ' + e));
