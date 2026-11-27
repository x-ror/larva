// FormData: the entry list (USVString conversion, Blob values as Files), its methods,
// iteration and errors; FormData as a fetch body (multipart/form-data with a fresh
// boundary, masked as BND); and Request/Response.formData() over urlencoded and
// multipart bodies.
function t(label, f) {
  try {
    print(label + ' ' + f());
  } catch (e) {
    print(label + ' THREW ' + e.constructor.name + ': ' + e.message);
  }
}
async function ta(label, f) {
  try {
    print(label + ' ' + (await f()));
  } catch (e) {
    print(label + ' THREW ' + e.constructor.name + ': ' + e.message);
  }
}
const tag = (v) => Object.prototype.toString.call(v);
const show = (fd) =>
  [...fd]
    .map(
      ([k, v]) =>
        k +
        '=' +
        (typeof v === 'string'
          ? JSON.stringify(v)
          : tag(v) + ':' + v.name + ':' + v.type + ':' + v.size),
    )
    .join(' ');

t('call', () => FormData());
t('number form', () => new FormData(5));
t('null form', () => new FormData(null));
t('undefined form', () => show(new FormData(undefined)));

const fd = new FormData();
t('append()', () => fd.append());
t('append(name)', () => fd.append('a'));
t('append 3 args, string', () => fd.append('a', 'x', 'f'));
t('append 3 args, object', () => fd.append('a', {}, 'f'));
fd.append('a', '1');
fd.append('b', 2);
fd.append('a', 'line\nbreak\r\n\rx');
fd.append('lone', '\ud800x');
fd.append('blob', new Blob(['hey'], { type: 'text/plain' }));
fd.append('blob2', new Blob(['hey']), 'name.txt');
const original = new File(['abc'], 'orig.bin', { type: 'application/x' });
fd.append('file', original);
fd.append('file2', new File(['abc'], 'orig.bin', { lastModified: 42 }), 'renamed');
fd.append({ toString: () => 'objkey' }, { toString: () => 'objval' });
fd.append('nul', null);
print('entries ' + show(fd));
print(
  'file kept ' + (fd.get('file') === original) + ' renamed stamp ' + fd.get('file2').lastModified,
);
print('blob became ' + tag(fd.get('blob')) + ' ' + typeof fd.get('blob').lastModified);
print(
  'get missing ' +
    fd.get('zz') +
    ' getAll ' +
    JSON.stringify(fd.getAll('a')) +
    ' ' +
    JSON.stringify(fd.getAll('zz')),
);
print('has ' + fd.has('a') + ' ' + fd.has('zz'));
fd.set('a', 'S');
print('after set ' + [...fd.keys()].join(','));
fd.set('new', 'N');
fd.delete('b');
print('after delete ' + [...fd.keys()].join(','));
print('values ' + [...fd.values()].filter((v) => typeof v === 'string').join('|'));
t('get()', () => fd.get());
t('set(name)', () => fd.set('a'));
t('delete()', () => fd.delete());
t('has()', () => fd.has());
t('getAll()', () => fd.getAll());
t('forEach()', () => fd.forEach());
t('forEach(5)', () => fd.forEach(5));
const seen = [];
fd.forEach(function (v, k, o) {
  seen.push(k + ':' + (o === fd));
});
print('forEach ' + seen.join(','));
const it = fd.entries();
const itProto = Object.getPrototypeOf(it);
print(
  'iterator ' +
    tag(it) +
    ' ' +
    Object.getOwnPropertyNames(itProto).join(',') +
    ' ' +
    tag(Object.getPrototypeOf(itProto)),
);
t('next on a foreign object', () => itProto.next.call({}));
const live = new FormData();
live.append('x', '1');
const liveKeys = live.keys();
live.append('y', '2');
print('live ' + [...liveKeys].join(','));
print(
  '@@iterator is entries ' + (FormData.prototype[Symbol.iterator] === FormData.prototype.entries),
);
t('foreign this', () => FormData.prototype.get.call({}, 'a'));
print('tag ' + tag(fd));

(async () => {
  const params = new URLSearchParams('a=1&b=%20x&a=2');
  await ta('urlencoded', async () => show(await new Response(params).formData()));
  await ta('urlencoded text', async () =>
    show(
      await new Response('x=1&y', {
        headers: { 'content-type': 'Application/X-WWW-Form-Urlencoded;charset=UTF-8' },
      }).formData(),
    ),
  );
  await ta('text/plain', async () =>
    show(await new Response('x=1', { headers: { 'content-type': 'text/plain' } }).formData()),
  );
  await ta('no type', async () => show(await new Response('x=1').formData()));

  const body = new FormData();
  body.append('k', 'v');
  body.append('k2', 'v\nw');
  body.append('quo"te\n', 'x');
  body.append('f', new File(['hello'], 'a"b\n.txt', { type: 'text/plain' }));
  body.append('g', new Blob(['zz']));
  body.append('é', 'ü');
  const r = new Response(body);
  const ct = r.headers.get('content-type');
  const boundary = ct.split('boundary=')[1];
  print(
    'content-type ' +
      /^multipart\/form-data; boundary=----WebKitFormBoundary[A-Za-z0-9]{16}$/.test(ct),
  );
  print('multipart ' + JSON.stringify((await r.clone().text()).split(boundary).join('BND')));
  print('bytes ' + (await r.clone().arrayBuffer()).byteLength);
  await ta('round trip', async () => show(await r.formData()));
  const req = new Request(ORIGIN + '/fx/echo', { method: 'POST', body });
  print(
    'request type ' + req.headers.get('content-type').startsWith('multipart/form-data; boundary='),
  );
  await ta('request round trip', async () => show(await req.formData()));
  await ta('used', async () => r.formData());
  await ta('foreign', async () => Response.prototype.formData.call({}));

  const mp = (text, type) => new Response(text, { headers: { 'content-type': type } }).formData();
  const Z = 'multipart/form-data; boundary=zz';
  await ta('hand-written', async () =>
    show(
      await mp(
        '--zz\r\nContent-Disposition: form-data; name="a"\r\n\r\nval\r\n--zz\r\nContent-Disposition: form-data; name="f"; filename="n.txt"\r\nContent-Type: text/x\r\n\r\nfile body\r\n--zz--\r\n',
        Z,
      ),
    ),
  );
  await ta('no part type', async () =>
    show(
      await mp(
        '--zz\r\nContent-Disposition: form-data; name="f"; filename="n.txt"\r\n\r\nB\r\n--zz--',
        'multipart/form-data; boundary="zz"',
      ),
    ),
  );
  await ta('preamble, bare name', async () =>
    show(
      await mp('pre\r\n--zz\r\ncontent-disposition: form-data; name=a\r\n\r\nv\r\n--zz--\r\n', Z),
    ),
  );
  await ta('utf-8', async () =>
    show(await mp('--zz\r\nContent-Disposition: form-data; name="é"\r\n\r\nü\r\n--zz--\r\n', Z)),
  );
  await ta('garbage', async () => show(await mp('garbage', Z)));
  await ta('no disposition', async () => show(await mp('--zz\r\nX: y\r\n\r\nv\r\n--zz--\r\n', Z)));
  await ta('unterminated', async () =>
    show(await mp('--zz\r\nContent-Disposition: form-data; name="a"\r\n\r\nv\r\n', Z)),
  );
  await ta('LF only', async () =>
    show(await mp('--zz\nContent-Disposition: form-data; name="a"\n\nv\n--zz--\n', Z)),
  );
  await ta('no boundary', async () => show(await mp('garbage', 'multipart/form-data')));

  const res = await fetch(ORIGIN + '/fx/echo', { method: 'POST', body });
  const echo = await res.json();
  const sent = echo.contentType.split('boundary=')[1];
  print(
    'fetch ' +
      echo.method +
      ' ' +
      echo.contentType.replace(sent, 'BND') +
      ' ' +
      JSON.stringify(echo.body.split(sent).join('BND')),
  );
})();
