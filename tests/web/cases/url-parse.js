// WHATWG URL and URLSearchParams: parsing, serialization, relative resolution, every
// getter, the setters, query mutations (duplicates, empty values, percent-encoding,
// Unicode), sorting, iteration and USVString conversion.
// Ported from tests/node-compat/cases/33-url.js; node:url's own exports
// (domainToASCII, urlToHttpOptions, format, fileURLToPath, pathToFileURL) are
// Node-only and not ported.
// Each line prints the expression and its value; a throw prints the error's class
// only (what it says is url-errors.js).
const fmt = (v) =>
  typeof v === 'string'
    ? JSON.stringify(v)
    : typeof v === 'object' && v !== null
      ? JSON.stringify(v)
      : String(v);
function show(label, f) {
  let out;
  try {
    out = fmt(f());
  } catch (e) {
    out = 'THREW ' + e.constructor.name;
  }
  print(label + ' => ' + out);
}
function throws(label, f) {
  try {
    f();
    print(label + ' => no throw');
  } catch (e) {
    print(label + ' => throws ' + e.constructor.name);
  }
}

// --- global API availability ---
show('typeof globalThis.URL', () => typeof globalThis.URL);
show('typeof globalThis.URLSearchParams', () => typeof globalThis.URLSearchParams);
// The object-URL statics live on the global URL.
show('typeof URL.createObjectURL', () => typeof URL.createObjectURL);
show('typeof URL.revokeObjectURL', () => typeof URL.revokeObjectURL);
// Brand / tags.
show("Object.prototype.toString.call(new URL('http://a.b/'))", () =>
  Object.prototype.toString.call(new URL('http://a.b/')),
);
show('Object.prototype.toString.call(new URLSearchParams())', () =>
  Object.prototype.toString.call(new URLSearchParams()),
);

// --- basic parsing + every getter ---
{
  const u = new URL('https://user:pass@example.com:8443/a/b?x=1&y=2#frag');
  show('u.href', () => u.href);
  show('u.protocol', () => u.protocol);
  show('u.username', () => u.username);
  show('u.password', () => u.password);
  show('u.host', () => u.host);
  show('u.hostname', () => u.hostname);
  show('u.port', () => u.port);
  show('u.pathname', () => u.pathname);
  show('u.search', () => u.search);
  show('u.hash', () => u.hash);
  show('u.origin', () => u.origin);
  show('u.toString()', () => u.toString());
  show('u.toJSON()', () => u.toJSON());
  show('JSON.stringify({ u })', () => JSON.stringify({ u }));
}

// The verification example from the task.
show("new URL('https://a.b/c?x=1').pathname", () => new URL('https://a.b/c?x=1').pathname);

// Default ports are dropped; an explicit default port round-trips away.
show("new URL('https://a.com:443/').port", () => new URL('https://a.com:443/').port);
show("new URL('http://a.com:80/').href", () => new URL('http://a.com:80/').href);
show("new URL('http://a.com/').pathname", () => new URL('http://a.com/').pathname);
show("new URL('http://a.com').href", () => new URL('http://a.com').href);

// Case-folding of scheme and host; path/query/fragment case preserved.
{
  const u = new URL('HTTP://Example.COM/PaTh?Q=V#Frag');
  show('u.protocol', () => u.protocol);
  show('u.hostname', () => u.hostname);
  show('u.pathname', () => u.pathname);
  show('u.search', () => u.search);
  show('u.hash', () => u.hash);
}

// Non-special scheme: opaque path, null origin.
{
  const u = new URL('mailto:hello@example.com');
  show('u.protocol', () => u.protocol);
  show('u.pathname', () => u.pathname);
  show('u.host', () => u.host);
  show('u.origin', () => u.origin);
}

// IPv4 / IPv6 / numeric host normalization.
show("new URL('http://0x7f.1/').hostname", () => new URL('http://0x7f.1/').hostname);
show("new URL('http://192.168.000.1/').hostname", () => new URL('http://192.168.000.1/').hostname);
show(
  "new URL('http://[2001:db8::0:1]/').hostname",
  () => new URL('http://[2001:db8::0:1]/').hostname,
);
show("new URL('http://[::1]/').host", () => new URL('http://[::1]/').host);

// --- percent encoding + Unicode ---
show("new URL('https://a.com/p q').pathname", () => new URL('https://a.com/p q').pathname);
show("new URL('https://a.com/ünïcödé').pathname", () => new URL('https://a.com/ünïcödé').pathname);
show("new URL('https://a.com/?q=ä').search", () => new URL('https://a.com/?q=ä').search);
// Unicode host → Punycode in href/host/hostname.
show("new URL('https://例え.テスト/').hostname", () => new URL('https://例え.テスト/').hostname);
show(
  "new URL('https://xn--r8jz45g.xn--zckzah/').href",
  () => new URL('https://xn--r8jz45g.xn--zckzah/').href,
);

// --- path normalization (dot segments) ---
show(
  "new URL('http://a.com/x/y/../z/./w').pathname",
  () => new URL('http://a.com/x/y/../z/./w').pathname,
);
show(
  "new URL('http://a.com/a/b/c/../../').pathname",
  () => new URL('http://a.com/a/b/c/../../').pathname,
);
show("new URL('http://a.com/../../x').pathname", () => new URL('http://a.com/../../x').pathname);

// --- malformed / relative inputs ---
throws("() => new URL('not a url')", () => new URL('not a url'));
throws("() => new URL('http://')", () => new URL('http://'));
show("URL.canParse('http://a.com')", () => URL.canParse('http://a.com'));
show("URL.canParse('nope')", () => URL.canParse('nope'));
show("URL.parse('nope')", () => URL.parse('nope'));
show("URL.parse('http://a.com').href", () => URL.parse('http://a.com').href);

// --- relative URL resolution against a base ---
{
  const base = 'https://base.com/dir/page?old#h';
  show("new URL('//cdn.com/lib.js', base).href", () => new URL('//cdn.com/lib.js', base).href);
  show("new URL('/abs', base).href", () => new URL('/abs', base).href);
  show("new URL('sibling', base).href", () => new URL('sibling', base).href);
  show("new URL('../up', base).href", () => new URL('../up', base).href);
  show("new URL('?q2', base).href", () => new URL('?q2', base).href);
  show("new URL('#h2', base).href", () => new URL('#h2', base).href);
  show("new URL('', base).href", () => new URL('', base).href);
  // A base passed as a URL object is accepted.
  show("new URL('x', new URL(base)).href", () => new URL('x', new URL(base)).href);
}

// --- serialization round-trips ---
for (const input of [
  'https://a.com/p?x=1&y=2#z',
  'http://u:p@h.com:81/a/b/c?d=e#f',
  'ftp://ftp.example.com/pub/file.txt',
  'ws://socket.example.com/feed',
  'https://例え.テスト/パス?q=値',
]) {
  show('new URL(new URL(input).href).href', () => new URL(new URL(input).href).href);
}

// --- setters ---
{
  // The task's verification example.
  const u = new URL('https://a.b/c?x=1');
  u.searchParams.set('x', '2');
  show('u.href', () => u.href);
}
{
  const u = new URL('http://a.com/p?q#h');
  u.protocol = 'https';
  show('u.protocol', () => u.protocol);
  u.hostname = 'b.com';
  show('u.host', () => u.host);
  u.port = '8080';
  show('u.host', () => u.host);
  show('u.href', () => u.href);
  u.port = '';
  show('u.port', () => u.port);
  u.pathname = '/new';
  show('u.pathname', () => u.pathname);
  u.username = 'bob';
  u.password = 'secret';
  show('u.href', () => u.href);
}
// search / hash setters with and without leading punctuation; empty clears them.
{
  const u = new URL('http://a.com/p?old#frag');
  u.search = '?new=1';
  show('u.search', () => u.search);
  u.search = 'bare=2';
  show('u.search', () => u.search);
  u.search = '';
  show('u.search', () => u.search);
  show('u.href', () => u.href);
  u.hash = '#h2';
  show('u.hash', () => u.hash);
  u.hash = 'h3';
  show('u.hash', () => u.hash);
  u.hash = '';
  show('u.hash', () => u.hash);
  show('u.href', () => u.href);
}
// The href setter fully re-parses.
{
  const u = new URL('http://a.com/p?x=1#h');
  u.href = 'https://other.com/y?z=2';
  show('u.hostname', () => u.hostname);
  show('u.search', () => u.search);
  show('u.hash', () => u.hash);
  // searchParams stays in sync after an href reset.
  show("u.searchParams.get('z')", () => u.searchParams.get('z'));
  show("u.searchParams.get('x')", () => u.searchParams.get('x'));
}

// --- URL.searchParams live binding ---
{
  const u = new URL('https://a.b/c?x=1&y=2');
  u.searchParams.append('x', '3');
  show('u.search', () => u.search);
  show('u.href', () => u.href);
  u.searchParams.delete('x');
  show('u.search', () => u.search);
  u.searchParams.delete('y');
  // Emptying the params drops the '?' entirely.
  show('u.search', () => u.search);
  show('u.href', () => u.href);
  // Mutating url.search re-syncs the bound searchParams.
  u.search = '?a=1&a=2';
  show("u.searchParams.getAll('a')", () => u.searchParams.getAll('a'));
}

// --- standalone URLSearchParams: every required operation ---
{
  const sp = new URLSearchParams('a=1&b=2&a=3');
  show("sp.get('a')", () => sp.get('a')); // first value
  show("sp.getAll('a')", () => sp.getAll('a')); // duplicates preserved
  show("sp.get('missing')", () => sp.get('missing'));
  show("sp.has('a')", () => sp.has('a'));
  show("sp.has('z')", () => sp.has('z'));
  show("sp.has('a', '3')", () => sp.has('a', '3')); // value-specific has (Node 20+)
  show("sp.has('a', '9')", () => sp.has('a', '9'));
  show('sp.size', () => sp.size);

  sp.append('c', '4');
  show('sp.toString()', () => sp.toString());

  sp.set('a', 'X'); // collapses duplicates to one, updates in place
  show('sp.toString()', () => sp.toString());

  sp.delete('b');
  show('sp.toString()', () => sp.toString());

  // value-specific delete (Node 20+).
  const sp2 = new URLSearchParams('k=1&k=2&k=3');
  sp2.delete('k', '2');
  show("sp2.getAll('k')", () => sp2.getAll('k'));
}

// Construction from array, object, Map, another URLSearchParams.
show("new URLSearchParams([ ['a', '1'], ['b', '2'], ]).toString()", () =>
  new URLSearchParams([
    ['a', '1'],
    ['b', '2'],
  ]).toString(),
);
show("new URLSearchParams({ a: '1', b: '2' }).toString()", () =>
  new URLSearchParams({ a: '1', b: '2' }).toString(),
);
show("new URLSearchParams(new Map([['x', '1']])).toString()", () =>
  new URLSearchParams(new Map([['x', '1']])).toString(),
);
show("new URLSearchParams(new URLSearchParams('p=q')).toString()", () =>
  new URLSearchParams(new URLSearchParams('p=q')).toString(),
);
show("new URLSearchParams('?lead=1').toString()", () => new URLSearchParams('?lead=1').toString()); // leading '?' stripped

// Empty values and keys.
show("new URLSearchParams('a=&b').toString()", () => new URLSearchParams('a=&b').toString());
show("new URLSearchParams('=v').get('')", () => new URLSearchParams('=v').get(''));
show("new URLSearchParams('a=1&&b=2').toString()", () =>
  new URLSearchParams('a=1&&b=2').toString(),
);

// Percent + '+' decoding/encoding (application/x-www-form-urlencoded).
show("new URLSearchParams('a+b=c+d').get('a b')", () => new URLSearchParams('a+b=c+d').get('a b'));
show("new URLSearchParams('x=%C3%A9').get('x')", () => new URLSearchParams('x=%C3%A9').get('x'));
{
  const sp = new URLSearchParams();
  sp.append('k', 'a b&c');
  show('sp.toString()', () => sp.toString());
}

// sort is stable by key (code units).
{
  const sp = new URLSearchParams('z=1&a=2&m=3&a=4');
  sp.sort();
  show('sp.toString()', () => sp.toString());
}

// --- iteration: entries / keys / values / forEach / Symbol.iterator ---
{
  const sp = new URLSearchParams('a=1&b=2&c=3');
  show('[...sp]', () => [...sp]);
  show('[...sp.entries()]', () => [...sp.entries()]);
  show('[...sp.keys()]', () => [...sp.keys()]);
  show('[...sp.values()]', () => [...sp.values()]);
  const seen = [];
  sp.forEach((value, key) => seen.push(`${key}=${value}`));
  show('seen', () => seen);
}

// --- USVString conversion: lone surrogates become U+FFFD ---
{
  const REPLACEMENT = '\uFFFD';
  const sp = new URLSearchParams([['k\uD800', 'v\uDC00']]); // lone high in key, lone low in value
  show("sp.get('k' + REPLACEMENT)", () => sp.get('k' + REPLACEMENT));
  show('sp.toString()', () => sp.toString());
  // A valid surrogate pair is preserved unchanged.
  show("new URLSearchParams([['a', '😀']]).get('a')", () =>
    new URLSearchParams([['a', '😀']]).get('a'),
  );
  // URL setters convert too: the lone surrogate becomes U+FFFD, then the URL
  // serializer percent-encodes it (UTF-8 of U+FFFD is EF BF BD).
  const u = new URL('http://h/');
  u.hash = 'x\uD834y'; // lone high surrogate
  show('u.hash', () => u.hash);
}

print('url ok');
