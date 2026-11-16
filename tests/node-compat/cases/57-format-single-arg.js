// util.format / console.log: a lone string argument is returned VERBATIM.
//
// Node's formatWithOptions short-circuits before the substitution loop — string
// first argument and nothing after it means the string is the answer, directives
// and all. Verified against node 26.13.0 rather than read off the docs: `format('%s')`,
// `format('%z')`, `format('100%')` and `format('%%')` all come back untouched.
//
// Lava got every one of those right EXCEPT `%%`, which it folded to `%` even with
// one argument, because its loop handled `%%` unconditionally while `%s` and
// friends were saved by a separate "arguments exhausted" branch. Eight rows of a
// 31-row contract probe diverged, all of them `%%`.
//
// TWO implementations are covered on purpose. `util.format` runs
// internal/util/inspect.js's formatWithOptions; `console.log` runs console.js's own
// formatArgs, because console.js is the bootstrap prelude — it receives native
// write functions and has no `require`, so it cannot delegate. A test through
// `util` alone would leave console.js unpinned, and the two are pinned by separate
// mutation-manifest entries for the same reason.
//
// EVERY label and value is percent-encoded before printing. A case about percent
// handling that prints raw percent signs feeds its own output back through the bug
// under test, and then compares two corrupted strings for equality — which is
// exactly what the oracle model reads as success.

const util = require('node:util');
const E = (s) => String(s).split('%').join('<p>');

const lines = [];
const row = (label, fn) => {
  let r;
  try {
    r = JSON.stringify(fn());
  } catch (e) {
    r = 'THREW:' + e.name;
  }
  lines.push(E(label).padEnd(34) + ' -> ' + E(r));
};

// --- the rule: one string argument, returned as-is -------------------------
row("format('a%%b')", () => util.format('a%%b'));
row("format('%%')", () => util.format('%%'));
row("format('%%%%')", () => util.format('%%%%'));
row("format('%i%%')", () => util.format('%i%%'));
row("format('100%%')", () => util.format('100%%'));
row("format('%%s')", () => util.format('%%s'));

// --- directives with no consumer: already correct, and the guard must not
//     change them, since it now short-circuits ahead of the branch that did.
row("format('%s')", () => util.format('%s'));
row("format('%d')", () => util.format('%d'));
row("format('%j')", () => util.format('%j'));
row("format('%o')", () => util.format('%o'));
row("format('%c')", () => util.format('%c'));
row("format('%z')", () => util.format('%z'));

// --- lone / trailing percent, which has no pair to fold --------------------
row("format('%')", () => util.format('%'));
row("format('100%')", () => util.format('100%'));
row("format('a%')", () => util.format('a%'));

// --- two or more arguments: substitution DOES run, and must keep doing so.
//     These are the rows that prove the guard is narrow rather than a blanket
//     "never substitute".
row("format('a%%b','x')", () => util.format('a%%b', 'x'));
row("format('%%','x')", () => util.format('%%', 'x'));
row("format('%%s','x')", () => util.format('%%s', 'x'));
row("format('%s','a')", () => util.format('%s', 'a'));
row("format('%d',5)", () => util.format('%d', 5));
row("format('%','x')", () => util.format('%', 'x'));

// --- arity and non-string first arguments ----------------------------------
row('format()', () => util.format());
row('format(5)', () => util.format(5));
// A non-string first argument means no format string at all, so `%%` in a LATER
// argument stays literal — node joins with a space and inspects.
row("format(5,'%%')", () => util.format(5, '%%'));
row('format(null)', () => util.format(null));
row('format(undefined)', () => util.format(undefined));
row("format('a',undefined)", () => util.format('a', undefined));
row("format('')", () => util.format(''));
row("format('','x')", () => util.format('', 'x'));
row("format('plain')", () => util.format('plain'));

// --- formatWithOptions takes the same path, including with options set -----
row("fmtOpts({},'a%%b')", () => util.formatWithOptions({}, 'a%%b'));
row("fmtOpts({},'a%%b','x')", () => util.formatWithOptions({}, 'a%%b', 'x'));
row("fmtOpts({colors:true},'%%')", () => util.formatWithOptions({ colors: true }, '%%'));

console.log(lines.join('\n'));

// --- the SECOND implementation: console.js's own formatArgs ---------------
//
// These MUST pass the raw string to console.log, un-encoded, because the whole
// point is to drive console.js's formatter with a real `%%`. That is safe here
// precisely because each call has exactly ONE argument: with nothing to
// substitute in, no other text on the line can be mangled. The earlier rows
// encode because they pass a label AND a value, and a two-argument console.log
// would substitute directives out of the label itself.
//
// The marker lines carry no percent sign, so the diff stays readable when a row
// below it diverges.
console.log('--- console.log single argument ---');
console.log('a%%b');
console.log('%%');
console.log('%i%%');
console.log('100%%');
console.log('%s');
console.log('%');
console.log('100%');

console.log('--- console.log two arguments, substitution must still run ---');
console.log('a%%b', 'x');
console.log('%%', 'x');
console.log('%s', 'a');
console.log('%d', 5);

console.log('--- console.log arity edges ---');
console.log();
console.log(5);
console.log(null);
console.log('plain');

// util.inspect is the CONTRAST to everything above, and the two are easy to conflate:
// format/console.log print a string argument raw, but `util.inspect` QUOTES a top-level
// string. Lava returned it unquoted — inspect()'s internal `depth === 0` branch exists to
// serve format, and the public entry was inheriting it.
//
// Pinned here, next to the verbatim rules, precisely because the fix for one is a
// plausible-looking break of the other: making format quote, or making inspect not, both
// turn this block red.
console.log('--- util.inspect quoting vs format verbatim ---');
console.log(util.inspect('x'));
console.log(util.inspect(''));
console.log(util.inspect("it's"));
console.log(util.inspect('a%%b'));
console.log(util.format('%s', 'x'), util.format('%o', 'x'), util.format('%O', 'x'));
console.log(util.inspect(123), util.inspect(true), util.inspect(null), util.inspect(1n));
console.log(util.inspect({ a: 'x' }), util.inspect(['x']), util.inspect({}));

// The delimiter rule's remaining branches. `it's` (above) only exercises the DOUBLE-quote
// arm; these two were unpinned, and a mutation deleting the backtick line survived the
// case until they were added.
//
// The `${` row is the one that matters most: inspect output is meant to read back as a
// literal, and a backtick-delimited string containing `${` is a live template
// substitution. node's strEscape refuses the backtick for exactly that reason.
console.log('--- util.inspect delimiter branches ---');
console.log(util.inspect('both \' and "'));
console.log(util.inspect('a\'b"c${d}'));
console.log(util.inspect({ 'a\'b"c${d}': 1 }));
console.log(util.inspect('all ` \' " '));
console.log(util.inspect("tick ` and ' only"));

// The escape table, matching node's strEscape. This was a security gap, not a cosmetic
// one: an unescaped \x1B makes any line built with util.inspect an ANSI-injection vector,
// and a lone surrogate used to come back as U+FFFD — lossy, not merely rendered
// differently. Note 0x0B is `\x0B`, not `\v`, and node uses UPPERCASE hex for \xNN but
// LOWERCASE for \uXXXX.
console.log('--- util.inspect escapes ---');
// JSON.stringify around every row on purpose: when the escape table is broken the raw
// control bytes make the output a binary blob, and `diff` then reports "binary files
// differ" instead of the bytes — unreadable for a human AND unkeyable for the mutation
// runner. Wrapping keeps both sides printable whatever the code does.
const codes = [];
for (let i = 0; i < 0x20; i++) codes.push(JSON.stringify(util.inspect(String.fromCharCode(i))));
console.log(codes.join(' '));
console.log(
  [0x7f, 0x80, 0x9b, 0x9f, 0xa0]
    .map((i) => JSON.stringify(util.inspect(String.fromCharCode(i))))
    .join(' '),
);
console.log(
  JSON.stringify(util.inspect('\ud800')),
  JSON.stringify(util.inspect('\udfff')),
  JSON.stringify(util.inspect('\u{1F600}')),
);
console.log(
  JSON.stringify(util.inspect('a\tb\x1Bc\\d')),
  JSON.stringify(util.inspect({ 'k\ty': 1 })),
  JSON.stringify(util.inspect(['a\x00b'])),
);
// A Buffer exercises the util.inspect.custom hook, which is looked up through the
// Symbol.for captured in primordials. Capturing the Symbol OBJECT is not enough — `.for`
// is writable on it — and without the hook a Buffer renders as a plain Uint8Array.
console.log(util.inspect(Buffer.from('ab')), util.inspect({ b: Buffer.alloc(1) }));
