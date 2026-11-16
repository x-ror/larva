'use strict';

// URL parsing and URLSearchParams, node-vs-lava.
//
// Added because nothing measured this surface at all. A +6% to +20% regression on
// `new URL` shipped and was found by hand during a review, not by a gate: `bench/`
// covered buffer, encoding, json, require and startup, and URL was simply absent.
//
// What the first run showed was not the regression it was added to catch. Lava
// parses URLs at 9-11x node and constructs a URLSearchParams at ~44x, which is the
// worst ratio in this directory — the next worst caps are buffer-from-latin1 and
// decode-utf8-stream at 17.0. So these numbers are a measuring instrument for work
// that has not been done yet, and only secondarily a regression net.
//
// SHAPES. Each is a distinct code path in js/internal/url.js, not a variation in
// input length:
//   special   the common case — scheme, host, path, query, fragment
//   ipv4      dotted-quad host, which runs endsInANumber + parseIPv4Number per label
//   octal     the 0-prefixed radix-8 arm of parseIPv4Number, a different branch
//   relative  resolution against a base, which walks the leading-slash guards
//   sp-parse  URLSearchParams construction: the application/x-www-form-urlencoded
//             parser, and where essentially all of the 44x lives
//   sp-get    lookup on an ALREADY-BUILT object, measured separately because the
//             two were conflated at first and the combined number read as a slow
//             `get`. It is not: node 0.5 ms vs lava 0.6 ms, ~1.2x, near parity.
//             Kept as a cheap guard so a future rewrite of the backing store
//             cannot regress lookup unnoticed while the parse number improves.
//
// Every shape was checked to produce byte-identical output under node and lava
// before being benched — a ratio between two runtimes doing different work means
// nothing.
//
// THE CAPS WERE PROVEN TO FIRE, by hand, and are NOT wired into the mutation gate.
// Slowing basicURLParse's shared entry with ~45 redundant stripChars passes moved
// special 11.34x -> 17.42x, ipv4 -> 15.35x and octal -> 11.68x, all three breaching
// and each named individually, while urlsearchparams-* stayed put — so the caps
// fire and they name the right bench. (The first attempt discarded the redundant
// result and JIT dead-code elimination removed it: MORE work measured FASTER, 40
// passes 16.70x vs 120 passes 13.90x. A mutation that can be optimised away proves
// nothing.)
// It is not in tests/mutation-manifest.json because the gate refuses a red
// baseline and `make bench-gate` is not currently green: decode-utf16le breached
// ~3 of 8 runs on this box (11.07-15.61x against its 14.5 cap). Wiring a mutation
// entry on a flaky baseline would make `make test-mutation` — which IS in CI —
// flake too. Tracked in ROADMAP.
//
// The iteration counts are deliberately modest: lava spends 90-170 ms on 50k of
// these, and a bench that takes minutes stops being run.

const { bench } = require('../lib/harness.js');

bench('url-parse-special', () => new URL('http://example.com/a/b?c=1#d').pathname, {
  iterations: 50000,
});

bench('url-parse-ipv4', () => new URL('http://1.2.3.4/a?b=1').hostname, { iterations: 50000 });

bench('url-parse-octal', () => new URL('http://0300.0250.0.1/').hostname, { iterations: 50000 });

bench('url-relative', () => new URL('/a/b', 'http://h/x/y').href, { iterations: 50000 });

bench('urlsearchparams-parse', () => new URLSearchParams('a=1&b=2&c=3').get('b'), {
  iterations: 50000,
});

// Prebuilt on purpose — see sp-get above.
const prebuilt = new URLSearchParams('a=1&b=2&c=3');
bench('urlsearchparams-get', () => prebuilt.get('b'), { iterations: 50000 });
