// XMLHttpRequest and the cookie jar: a same-origin request carries the page's cookies
// and stores the ones its response sets whether or not withCredentials is set, and the
// response's Set-Cookie stays out of getAllResponseHeaders().
function xhr(path, withCredentials) {
  return new Promise((resolve) => {
    const x = new XMLHttpRequest();
    x.open('GET', ORIGIN + path);
    x.withCredentials = withCredentials;
    x.onloadend = () => resolve(x);
    x.send();
  });
}
const q = (cookies) => cookies.map((c) => 'c=' + encodeURIComponent(c)).join('&');
async function main() {
  print('fresh ' + (await xhr('/fx/cookie-echo', false)).responseText);
  const set = await xhr('/fx/cookie-set?' + q(['x=1', 'y=2; HttpOnly']), false);
  print(
    'set-cookie hidden ' +
      set.getResponseHeader('set-cookie') +
      ' ' +
      /set-cookie/i.test(set.getAllResponseHeaders()),
  );
  print('stored ' + (await xhr('/fx/cookie-echo', false)).responseText);
  await xhr('/fx/cookie-set?' + q(['w=1']), true);
  print('withCredentials ' + (await xhr('/fx/cookie-echo', true)).responseText);
  print('redirect ' + (await xhr('/fx/cookie-redirect?' + q(['z=1']), false)).responseText);
  const f = await fetch(ORIGIN + '/fx/cookie-echo');
  print('fetch sees xhr cookies ' + (await f.text()));
}
main().catch((e) => print('error ' + e));
