// node:url is assembled from two files laid out like node's: js/internal/url.js holds
// the WHATWG half (the URL Standard parser, URL, URLSearchParams, fileURLToPath,
// urlToHttpOptions, domainToASCII/domainToUnicode — node's lib/internal/url.js), and
// node/url stays the public entry with pathToFileURL and format, which node's
// lib/url.js defines. Every throw from the WHATWG half used to carry only `node:url`
// frames, because everything was defined in url.js; now it names node:internal/url,
// exactly as node's does, and the two that stayed still read node:url on both.
//
// Each frame line prints `ok` when the stack carries `node:<file>:` and names the
// first `node:` frame it got otherwise (past internal/errors, which builds the
// error). Only the source name is compared, never the message, code, line or column:
// several of these throw an uncoded TypeError on Lava where node's is coded, which is
// a pre-existing gap outside this split.
//
// The new id must stay internal: neither the bare nor the `node:` spelling may resolve
// from user code. Only the error CODE of the bare spelling is printed (the messages
// diverge, #415).
//
// The export lines check what crosses the new seam: the keys, their descriptor kinds,
// the identities the globals share, the object-URL statics node:buffer attaches, and
// behavior that runs through the internals node/url borrows (format reads the record,
// the path serializer and the Punycode decoder; pathToFileURL builds an internal URL).
// Export ORDER, function `.length` and the prototype's key order are not oracle-able —
// they differ from node's before and after the split — so the split was checked
// against the previous binary instead (the PR records the diff).
'use strict';

const url = require('url');

for (const id of ['internal/url']) {
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
  const where = stack.includes('node:' + file + ':')
    ? 'ok'
    : 'got ' + (stack.match(/node:(?!internal\/errors)[\w/]+/) || ['no node: frame'])[0];
  console.log(label + ': ' + file + ' ' + where);
}

// The WHATWG half: node:internal/url on both runtimes.
frame('new URL invalid', 'internal/url', () => new URL('nope'));
frame('new URL invalid base', 'internal/url', () => new URL('a', 'nope'));
frame('new URL no args', 'internal/url', () => new URL());
frame('href setter', 'internal/url', () => {
  new URL('http://a/').href = 'nope';
});
frame('canParse no args', 'internal/url', () => URL.canParse());
frame('fileURLToPath type', 'internal/url', () => url.fileURLToPath(123));
frame('fileURLToPath scheme', 'internal/url', () => url.fileURLToPath('http://a/'));
frame('fileURLToPath encoded slash', 'internal/url', () => url.fileURLToPath('file:///a%2fb'));
frame('fileURLToPath host', 'internal/url', () => url.fileURLToPath('file://remote/a'));
frame('fileURLToPath invalid', 'internal/url', () => url.fileURLToPath('nope'));
frame('urlToHttpOptions null', 'internal/url', () => url.urlToHttpOptions(null));
frame('searchParams tuple', 'internal/url', () => new URLSearchParams([[1]]));
frame('searchParams append', 'internal/url', () => new URLSearchParams().append());
frame('searchParams forEach', 'internal/url', () => new URLSearchParams().forEach(5));
frame('searchParams receiver', 'internal/url', () => URLSearchParams.prototype.get.call({}, 'a'));
// What stayed in the public entry: node:url on both runtimes.
frame('pathToFileURL type', 'url', () => url.pathToFileURL(1));
frame('format type', 'url', () => url.format(5));

// --- the assembled exports: shapes and identities ----------------------------------
console.log('same module', require('node:url') === url);
for (const k of [
  'URL',
  'URLSearchParams',
  'fileURLToPath',
  'pathToFileURL',
  'urlToHttpOptions',
  'format',
  'domainToASCII',
  'domainToUnicode',
]) {
  const d = Object.getOwnPropertyDescriptor(url, k);
  console.log(
    'export',
    k,
    typeof url[k],
    'value' in d ? 'data' : 'accessor',
    d.writable,
    d.enumerable,
    d.configurable,
  );
}
console.log(
  'identities',
  globalThis.URL === url.URL,
  globalThis.URLSearchParams === url.URLSearchParams,
  new URL('http://a/') instanceof url.URL,
  new url.URL('http://a/').searchParams instanceof URLSearchParams,
  url.pathToFileURL('/tmp') instanceof URL,
);
console.log(
  'object-url statics',
  typeof URL.createObjectURL,
  URL.createObjectURL.name,
  typeof URL.revokeObjectURL,
  URL.revokeObjectURL.name,
);
console.log('names', url.URL.name, url.URLSearchParams.name, url.fileURLToPath.name);

// --- behavior across the file seam ---------------------------------------------------
const u = new URL('http://user:pw@xn--nxasmq6b.com:8080/a b?x=1&y=2#f');
console.log('href', u.href);
console.log('format', url.format(u));
console.log('format opts', url.format(u, { unicode: true, auth: false, search: false }));
console.log('format fragment', url.format(u, { fragment: false }));
console.log(
  'domain',
  url.domainToUnicode('xn--nxasmq6b.com'),
  url.domainToASCII('βόλος.com'),
  JSON.stringify(url.domainToASCII('a b')),
);
console.log('fileURLToPath', url.fileURLToPath('file:///tmp/a%20b'));
console.log('pathToFileURL', url.pathToFileURL('/tmp/a b#?%').href);
console.log('urlToHttpOptions', JSON.stringify(url.urlToHttpOptions(u)));
u.searchParams.append('z', '3');
console.log('searchParams', u.search, [...u.searchParams.keys()].join());
