// The fetch classes' WebIDL surface beyond fetch-errors: Request's attribute defaults,
// the RequestInit enum and method checks, Headers' ByteString/init conversions and
// immutable guard, Response's status/statusText/null-body checks and statics, the
// receiver checks, and the context fetch() reports a Request's errors under. A case
// about messages, so it prints them; the rejections print in the order they settle.
function show(label, f) {
  try {
    const v = f();
    print(label + ': ok ' + (typeof v === 'string' ? JSON.stringify(v) : String(v)));
  } catch (e) {
    print(label + ': ' + e.constructor.name + ': ' + e.message);
  }
}
const r = new Request('http://x/');
for (const k of [
  'destination',
  'referrer',
  'referrerPolicy',
  'mode',
  'credentials',
  'cache',
  'redirect',
  'integrity',
  'keepalive',
  'duplex',
  'isHistoryNavigation',
  'targetAddressSpace',
  'isReloadNavigation',
  'method',
  'url',
])
  show('req ' + k, () => r[k]);
show('req signal', () => r.signal.constructor.name + ' ' + r.signal.aborted);
show('req signal same', () => r.signal === r.signal);
const ac = new AbortController();
const rs = new Request('http://x/', { signal: ac.signal });
show('req signal init same', () => rs.signal === ac.signal);
ac.abort();
show('req signal follows', () => rs.signal.aborted);
show('method patch', () => new Request('http://x/', { method: 'patch' }).method);
show('method post', () => new Request('http://x/', { method: 'pOsT' }).method);
show('method trace', () => new Request('http://x/', { method: 'trace' }));
show('method track', () => new Request('http://x/', { method: 'TRACK' }));
show('method empty', () => new Request('http://x/', { method: '' }));
show('mode bad', () => new Request('http://x/', { mode: 'x' }));
show('cred bad', () => new Request('http://x/', { credentials: 'x' }));
show('cache bad', () => new Request('http://x/', { cache: 'x' }));
show('mode navigate', () => new Request('http://x/', { mode: 'navigate' }));
show('only-if-cached', () => new Request('http://x/', { cache: 'only-if-cached' }));
show('bad url', () => new Request('http://['));
show('bad url fetch', () => {
  fetch('http://[').catch((e) => print('fetch bad url: ' + e.message));
});
show('hdr ctor name', () => new Headers([['a b', 'v']]));
show('hdr ctor value', () => new Headers({ a: 'x\ny' }));
show('hdr has', () => new Headers().has('a b'));
show('hdr delete', () => new Headers().delete('a b'));
show('hdr bytestring', () => new Headers().append('a', 'Ā'));
show('hdr bad init', () => new Headers(5));
show('req hdr name', () => new Request('http://x/', { headers: [['a b', 'v']] }));
show('req hdr pair', () => new Request('http://x/', { headers: [['a']] }));
show('fetch hdr pair', () => {
  fetch('http://x/', { headers: [['a']] }).catch((e) => print('fetch hdr pair: ' + e.message));
});
show('fetch method', () => {
  fetch('http://x/', { method: 'b d' }).catch((e) => print('fetch method: ' + e.message));
});
show('resp status 600', () => new Response('', { status: 600 }));
show('resp status 1.5', () => new Response('', { status: 200.5 }).status);
show('resp statusText', () => new Response('', { statusText: 'a\nb' }));
show('resp 204 empty', () => new Response('', { status: 204 }).status);
show('resp 204 null', () => new Response(null, { status: 204 }).status);
show('resp 304 blob', () => new Response(new Blob([]), { status: 304 }));
show('json undefined', () => Response.json(undefined));
show('json fn', () => Response.json(() => 1));
show('redirect bad status', () => Response.redirect('http://x/', 200));
show('redirect bad url', () => Response.redirect('http://[', 301));
show('redirect ok', () => {
  const x = Response.redirect('http://x/a', 307);
  return [x.status, x.headers.get('location'), x.type, x.url, x.body].join(',');
});
show('redirect default', () => Response.redirect('http://x/a').status);
show('error', () => {
  const e = Response.error();
  return [e.status, e.statusText, e.type, e.url, e.body, e.ok].join(',');
});
show('error headers append', () => Response.error().headers.append('a', 'b'));
show('resp defaults', () => {
  const x = new Response();
  return [x.status, x.statusText, x.type, JSON.stringify(x.url), x.redirected, x.body].join(',');
});
show('getter on {}', () =>
  Object.getOwnPropertyDescriptor(Request.prototype, 'method').get.call({}),
);
show('text on {}', () => {
  Response.prototype.text
    .call({})
    .catch((e) => print('text on {}: ' + e.constructor.name + ': ' + e.message));
});
show('clone used', () => {
  const x = new Response('a');
  x.text();
  return x.clone();
});
show('req clone used', () => {
  const x = new Request('http://x/', { method: 'POST', body: 'a' });
  x.text();
  return x.clone();
});
show('req clone', () => {
  const x = new Request('http://x/', { method: 'POST', body: 'a', mode: 'no-cors' });
  const c = x.clone();
  return c.method + c.mode + c.headers.get('content-type');
});
show('usp ct', () => new Response(new URLSearchParams('a=1')).headers.get('content-type'));
show('ab ct', () => new Response(new ArrayBuffer(1)).headers.get('content-type'));
show('used text', () => {
  const x = new Response('a');
  x.text();
  x.text().catch((e) => print('used text: ' + e.message));
});
show('req from used', () => {
  const x = new Request('http://x/', { method: 'POST', body: 'a' });
  x.text();
  return new Request(x);
});
show('hdr order', () => {
  const h = new Headers([
    ['b', '1'],
    ['a', '2'],
    ['B', '3'],
    ['set-cookie', 'z'],
    ['Set-Cookie', 'y'],
    ['c', '4'],
  ]);
  return [...h].join('|');
});
show('hdr get set-cookie', () => {
  const h = new Headers([
    ['set-cookie', 'z'],
    ['Set-Cookie', 'y'],
  ]);
  return h.get('set-cookie');
});
