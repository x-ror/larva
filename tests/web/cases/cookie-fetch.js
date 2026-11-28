// fetch() and the cookie jar, against the suite's fixture server (ORIGIN, a page of the
// same origin): Set-Cookie on a response is stored, and later requests carry it in
// Cookie per their credentials mode, the cookie's path, Secure and HttpOnly, including
// across a redirect whose own response sets a cookie.
const q = (cookies) => cookies.map((c) => 'c=' + encodeURIComponent(c)).join('&');
async function set(cookies, init) {
  const r = await fetch(ORIGIN + '/fx/cookie-set?' + q(cookies), init);
  await r.text();
}
async function echo(path, init) {
  const r = await fetch(ORIGIN + (path || '/fx/cookie-echo'), init);
  return r.text();
}
async function main() {
  print('fresh ' + (await echo()));
  await set(['a=1']);
  print('stored ' + (await echo()));
  await set(['b=2', 'c=3; Path=/']);
  print('two in one response ' + (await echo()));
  await set(['h=1; HttpOnly']);
  print('httponly is sent ' + (await echo()));
  print('omit sends none ' + (await echo(null, { credentials: 'omit' })));
  await set(['o=1'], { credentials: 'omit' });
  print('omit stores none ' + (await echo()));
  await set(['i=1'], { credentials: 'include' });
  print('include ' + (await echo(null, { credentials: 'include' })));
  await set(['p=1; Path=/fx/cookie-echo']);
  print('longer path first ' + (await echo()));
  print('path without a boundary ' + (await echo('/fx/cookie-echo2')));
  await set(['s=1; Secure']);
  print('secure from 127.0.0.1 ' + (await echo()));
  await set(['n=1; SameSite=None']);
  print('samesite none insecure ' + (await echo()));
  await set(['st=1; SameSite=Strict', 'lx=1; SameSite=Lax']);
  print('samesite same-origin ' + (await echo()));
  await set(['a=; Max-Age=0', 'b=; Expires=Thu, 01 Jan 1970 00:00:00 GMT']);
  print('deleted ' + (await echo()));
  await set(['d=1; Domain=127.0.0.1', 'e=1; Domain=example.com']);
  print('domain ' + (await echo()));
  print('page cookie header dropped ' + (await echo(null, { headers: { Cookie: 'forged=1' } })));
  const r = await fetch(ORIGIN + '/fx/cookie-redirect?' + q(['r=1']));
  print('redirect ' + r.redirected + ' ' + (await r.text()));
  const r2 = await fetch(ORIGIN + '/fx/cookie-redirect?' + q(['r2=1']), { credentials: 'omit' });
  print('redirect omit ' + r2.redirected + ' ' + (await r2.text()));
}
main().catch((e) => print('error ' + e));
