// Headers value normalization (Fetch "normalize a byte sequence"): leading and
// trailing HTTP whitespace (tab, LF, CR, space) is stripped on set/append and in the
// constructors; an interior CR/LF is invalid; VT and FF are not whitespace.
// Ported from tests/node-compat/cases/08-fetch.js.
async function main() {
  const response = new Response(JSON.stringify({ ok: true }), {
    headers: { 'content-type': 'application/json' },
    status: 201,
  });
  print('fetch ' + typeof fetch);
  print('status ' + response.status + ' ' + response.headers.get('content-type'));
  print('json ' + JSON.stringify(await response.json()));

  const h = new Headers();
  h.set('x-a', '  spaced value  ');
  print('x-a ' + JSON.stringify(h.get('x-a')));
  print('x-b ' + JSON.stringify(new Headers({ 'x-b': '\tleading-tab' }).get('x-b')));
  print('x-c ' + JSON.stringify(new Headers([['x-c', '  v  ']]).get('x-c')));
  h.set('x-d', '\r\nfoo');
  print('x-d ' + JSON.stringify(h.get('x-d')));
  h.set('x-e', 'foo\r\n');
  print('x-e ' + JSON.stringify(h.get('x-e')));
  h.set('x-f', '\t \r\n trimme  d \r\n \t');
  print('x-f ' + JSON.stringify(h.get('x-f')));
  h.set('x-g', '\t \r\n ');
  print('x-g ' + JSON.stringify(h.get('x-g')));
  try {
    h.set('x-bad', 'foo\r\nbar');
    print('interior CRLF accepted');
  } catch (e) {
    print('interior CRLF threw ' + e.constructor.name);
  }
  h.set('x-h', '\vvtab');
  print('x-h ' + JSON.stringify(h.get('x-h')));
  h.set('x-i', '\f formfeed');
  print('x-i ' + JSON.stringify(h.get('x-i')));

  const h2 = new Headers();
  h2.append('x-k', '  a  ');
  h2.append('x-k', '  b  ');
  print('x-k ' + JSON.stringify(h2.get('x-k')));
  print('missing ' + h2.get('nope') + ' has ' + h2.has('X-K'));
}
main().catch((e) => print('FAILED ' + e));
