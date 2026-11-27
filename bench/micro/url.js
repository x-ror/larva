// URL parsing and URLSearchParams.
//
// Added because nothing measured this surface at all. A +6% to +20% regression on
// `new URL` shipped and was found by hand during a review, not by a gate.
//
// SHAPES. Each is a distinct code path in js/internal/url.js, not a variation in
// input length:
//   special   the common case — scheme, host, path, query, fragment
//   ipv4      dotted-quad host, which runs endsInANumber + parseIPv4Number per label
//   octal     the 0-prefixed radix-8 arm of parseIPv4Number, a different branch
//   relative  resolution against a base, which walks the leading-slash guards
//   sp-parse  URLSearchParams construction: the application/x-www-form-urlencoded
//             parser
//   sp-get    lookup on an ALREADY-BUILT object, measured separately because the
//             two were conflated at first and the combined number read as a slow
//             `get`. Kept as a cheap guard so a future rewrite of the backing
//             store cannot regress lookup unnoticed while the parse number improves.
//
// When this file still ran node-vs-lava, Lava parsed URLs at 9-11x node and built
// a URLSearchParams at ~44x; the gate is now new-vs-base Lava (bench/run.mjs), so
// those ratios are history, not a target. A slowdown must survive JIT dead-code
// elimination to show here: an earlier proof run that discarded a redundant
// result measured MORE work as FASTER. Every shape returns a field of its result.

bench('url-parse-special', () => new URL('http://example.com/a/b?c=1#d').pathname, {
  iterations: 15000,
});

bench('url-parse-ipv4', () => new URL('http://1.2.3.4/a?b=1').hostname, { iterations: 15000 });

bench('url-parse-octal', () => new URL('http://0300.0250.0.1/').hostname, { iterations: 15000 });

bench('url-relative', () => new URL('/a/b', 'http://h/x/y').href, { iterations: 15000 });

bench('urlsearchparams-parse', () => new URLSearchParams('a=1&b=2&c=3').get('b'), {
  iterations: 7000,
});

// Prebuilt on purpose — see sp-get above.
const prebuilt = new URLSearchParams('a=1&b=2&c=3');
bench('urlsearchparams-get', () => prebuilt.get('b'), { iterations: 1000000 });
