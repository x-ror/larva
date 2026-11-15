// util.MIMEType / util.MIMEParams — a WHATWG MIME parser. node and lava must match.
const assert = require('node:assert/strict');
const { MIMEType, MIMEParams } = require('node:util');

// parsing lowercases type/subtype and parameter names; values keep their case
const m = new MIMEType('Text/HTML;charset=utf-8;Foo=Bar');
assert.equal(m.type, 'text');
assert.equal(m.subtype, 'html');
assert.equal(m.essence, 'text/html');
assert.equal(m.toString(), 'text/html;charset=utf-8;foo=Bar');
assert.equal(m.params.get('charset'), 'utf-8');
assert.equal(m.params.get('foo'), 'Bar');
// names are lowercased on parse, and (node 24.x) every MIMEParams lookup lowercases
// its argument too, so the original spelling still finds the parameter
assert.equal(m.params.get('Foo'), 'Bar');
assert.equal(m.params.has('FOO'), true);

// leading/trailing whitespace is trimmed; a quoted value drops its quotes when it is a token
assert.equal(new MIMEType('  text/plain  ').toString(), 'text/plain');
assert.equal(new MIMEType('text/html; charset="UTF-8"').toString(), 'text/html;charset=UTF-8');
// a value with special chars stays quoted; first duplicate wins; empty/no-value dropped
assert.equal(new MIMEType('text/html; x="a;b c"').toString(), 'text/html;x="a;b c"');
assert.equal(new MIMEType('text/x; a=1; a=2').params.get('a'), '1');
assert.equal(new MIMEType('text/x; a=').toString(), 'text/x');
assert.equal(new MIMEType('text/x; novalue; a=b').toString(), 'text/x;a=b');
// an empty *quoted* value is kept; only an empty *unquoted* value is dropped (WHATWG)
assert.equal(new MIMEType('text/x; empty=""').toString(), 'text/x;empty=""');
assert.equal(new MIMEType('text/x; empty=""').params.get('empty'), '');

// setters lowercase + revalidate
const s = new MIMEType('text/plain;a=b');
s.type = 'IMAGE';
s.subtype = 'PNG';
assert.equal(s.toString(), 'image/png;a=b');

// MIMEParams: get/has/set/delete, serialization quoting, iteration order
const p = new MIMEParams();
p.set('a', 'has space');
p.set('b', 'tok');
p.set('c', '');
assert.equal(p.toString(), 'a="has space";b=tok;c=""');
assert.equal(p.has('a'), true);
p.delete('a');
assert.equal(p.has('a'), false);
assert.equal(p.get('missing'), null);
assert.deepEqual([...new MIMEType('text/x; a=1; b=2').params].flat(), ['a', '1', 'b', '2']);
assert.deepEqual([...new MIMEType('text/x; a=1; b=2').params.keys()], ['a', 'b']);
// set() escapes quotes/backslashes when serializing
const e = new MIMEType('text/x');
e.params.set('k', 'q"and\\bs');
assert.equal(e.toString(), 'text/x;k="q\\"and\\\\bs"');
// set()/get()/has()/delete() lowercase the name like parse does (node 24.x; node 22
// kept set()'s spelling), so two spellings of one name are one parameter
const cs = new MIMEType('text/x;mixedcase=a');
cs.params.set('MixedCase', 'V');
assert.equal(cs.toString(), 'text/x;mixedcase=V');
assert.deepEqual([...cs.params.keys()], ['mixedcase']);
assert.equal(cs.params.get('MIXEDCASE'), 'V');
cs.params.delete('mIxEdCaSe');
assert.equal(cs.toString(), 'text/x');
// the fold is ASCII-only: KELVIN SIGN (U+212A) is not "k" — it stays an invalid name
// and is reported in its original spelling
const KELVIN = String.fromCharCode(0x212a);
cs.params.set('k', 'v');
assert.equal(cs.params.get(KELVIN), null);
assert.throws(() => cs.params.set(KELVIN, 'v'), {
  code: 'ERR_INVALID_MIME_SYNTAX',
  message: 'The MIME syntax for a parameter name in "' + KELVIN + '" is invalid at 0',
});
// the syntax error reports the name after folding
assert.throws(() => cs.params.set('A B', 'v'), {
  code: 'ERR_INVALID_MIME_SYNTAX',
  message: 'The MIME syntax for a parameter name in "a b" is invalid at 1',
});

// invalid syntax throws ERR_INVALID_MIME_SYNTAX
assert.throws(() => new MIMEType('garbage'), { code: 'ERR_INVALID_MIME_SYNTAX' });
assert.throws(() => new MIMEType('text/'), { code: 'ERR_INVALID_MIME_SYNTAX' });
assert.throws(() => new MIMEType('/plain'), { code: 'ERR_INVALID_MIME_SYNTAX' });
assert.throws(() => p.set('bad name', 'v'), { code: 'ERR_INVALID_MIME_SYNTAX' });
assert.throws(() => p.set('a', 'bad\x01'), { code: 'ERR_INVALID_MIME_SYNTAX' });
// a type/subtype error's index is relative to that component, not the whole input, and
// the message quotes the input as given — leading whitespace included (node 24)
assert.throws(() => new MIMEType('text/p@in;a=b'), {
  message: 'The MIME syntax for a subtype in "text/p@in;a=b" is invalid at 1',
});
assert.throws(() => new MIMEType('a/' + KELVIN), {
  message: 'The MIME syntax for a subtype in "a/' + KELVIN + '" is invalid at 0',
});
assert.throws(() => new MIMEType('  text/p@in  '), {
  message: 'The MIME syntax for a subtype in "  text/p@in  " is invalid at 1',
});
assert.throws(() => new MIMEType('  t@xt/plain'), {
  message: 'The MIME syntax for a type in "  t@xt/plain" is invalid at 1',
});
assert.throws(() => new MIMEType('  garbage'), {
  message: 'The MIME syntax for a type in "  garbage" is invalid',
});
// parsing folds parameter names ASCII-only too: a KELVIN SIGN name is not "k", so the
// parameter is invalid and dropped rather than kept as k=1
assert.equal(new MIMEType('a/b;' + KELVIN + '=1').toString(), 'a/b');
assert.equal(new MIMEType('a/b;' + KELVIN + '=1').params.has('k'), false);

// form-feed (U+000C) is NOT HTTP whitespace: it is not trimmed and invalidates the type
const FF = String.fromCharCode(0x0c);
assert.throws(() => new MIMEType(FF + 'text/plain'), { code: 'ERR_INVALID_MIME_SYNTAX' });
assert.equal(new MIMEType('\ttext/plain').toString(), 'text/plain'); // tab IS whitespace

// after a quoted value everything up to the next ';' is discarded (WHATWG mimesniff,
// node 26; node 24 resumed one char past the quote and kept `c=d` in the first case)
assert.equal(new MIMEType('text/x; a="b" c=d').toString(), 'text/x;a=b');
assert.equal(new MIMEType('text/x; a="b"xyz;c=d').toString(), 'text/x;a=b;c=d');
assert.equal(new MIMEType('text/x; a="b" ;c=d').toString(), 'text/x;a=b;c=d');
assert.equal(new MIMEType('text/x; a="b"x=y;c=d').toString(), 'text/x;a=b;c=d');
// the whole input is trimmed at both ends first (WHATWG step 1, node 26), so trailing
// whitespace of an unterminated quoted value goes too; node 24 kept it. Whitespace
// inside the value, or before a closing quote, survives.
assert.equal(new MIMEType('text/x;a="b\t').params.get('a'), 'b');
assert.equal(new MIMEType('text/x;a="b c  ').params.get('a'), 'b c');
assert.equal(new MIMEType('text/x;a="b\t"').params.get('a'), 'b\t');

// MIMEParams#set returns undefined (like URLSearchParams#set)
assert.equal(new MIMEType('text/x').params.set('a', 'b'), undefined);

// MIMEType#toString serializes from internal data, ignoring a params.toString override
const ov = new MIMEType('text/x;a=b');
ov.params.toString = () => 'HACKED';
assert.equal(ov.toString(), 'text/x;a=b');

// the constructors require `new`
assert.throws(() => MIMEType('text/plain'), TypeError);
assert.throws(() => MIMEParams(), TypeError);

console.log('ok');
