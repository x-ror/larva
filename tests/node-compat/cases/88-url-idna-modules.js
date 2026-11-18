// The URL Standard's IDNA step lives in its own files, laid out like node's
// lib/internal/idna.js: js/internal/idna.js holds the UTS-46 approximation (label
// separator fold, NFKC + lowercase mapping, the `xn--` ToASCII/ToUnicode passes)
// and js/internal/punycode.js the RFC 3492 codec it calls. internal/url keeps the
// host parser and reaches both through the domainToASCII/domainToUnicode bindings
// it captures at module-eval.
//
// The move is invisible by design — every helper on that side returns a failure
// value instead of throwing, so no frame changes file — which is why no line here
// was red against the previous binary. What the case pins is that the seam carries
// the same results: domainToASCII/domainToUnicode and the URL host for inputs that
// exercise each moved piece (separator fold, NFKC folding to ASCII, mixed-case
// `xn--`, astral and RTL labels, the percent-decoded path, a too-long label set, the
// invalid-UTF-8 failure), and format's `unicode` option, which decodes the host
// through the same Punycode decoder. The recorded mutations in
// tests/mutation-manifest.json carry the proof that it watches the moved code.
//
// Invalid-Punycode labels (`xn--a`, `xn--`, `xn--ls8h-`) are left out: Lava's
// decoder accepts labels node keeps verbatim, a pre-existing gap filed separately.
//
// The new ids must stay internal: neither the bare nor the `node:` spelling may
// resolve from user code. Only the error CODE of the bare spelling is printed (the
// messages diverge, #415).
'use strict';

const url = require('url');

for (const id of ['internal/idna', 'internal/punycode']) {
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

const domains = [
  'mañana.com',
  '例え.テスト',
  'ＥＸＡＭＰＬＥ．com',
  'a。b｡c．d',
  'Bücher.DE',
  '☃.net',
  '𝓊.com',
  'xn--maana-pta.com',
  'XN--MAANA-PTA.COM',
  'xn--ls8h.la',
  'ü'.repeat(40) + '.de',
  'straße.de',
  'ﬁ.com',
  'ابن.com',
  '日本語。ＪＰ',
  'München-Ost.de',
  'ǅ.com',
  'Ⅻ.com',
  '%E2%98%83.com',
  '%C3.com',
  'a.b.',
  '',
];

for (const d of domains) {
  console.log(
    'domain',
    JSON.stringify(d),
    JSON.stringify(url.domainToASCII(d)),
    JSON.stringify(url.domainToUnicode(d)),
  );
}

for (const d of domains) {
  let out;
  try {
    const u = new URL('http://' + d + '/p');
    out = u.host + ' ' + u.href + ' ' + url.format(u, { unicode: true });
  } catch (e) {
    out = 'THREW ' + e.name;
  }
  console.log('url', JSON.stringify(d), out);
}

// The host setter re-enters the same host parser on an existing record.
const u = new URL('https://example.com/x');
u.host = 'ＢÜCHER。de:8443';
console.log('setter', u.href, url.format(u, { unicode: true }));
