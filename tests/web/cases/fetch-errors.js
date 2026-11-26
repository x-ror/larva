// What the fetch classes throw, as a page sees it: the error class and its message.
// Split from fetch-classes.js because the messages are Chrome's own text, which the
// shared code does not produce yet.
function show(label, f) {
  try {
    f();
    print(label + ': no throw');
  } catch (e) {
    print(label + ': ' + e.constructor.name + ': ' + e.message + ' code=' + e.code);
  }
}
show('Headers.append name', () => new Headers().append('a b', 'v'));
show('Headers.set value', () => new Headers().set('a', 'x\r\ny'));
show('Headers.get name', () => new Headers().get('a b'));
show('Headers init', () => new Headers([['a']]));
show('Request credentials', () => new Request('http://u:p@x/'));
show('Request GET body', () => new Request('http://x/', { body: 'a' }));
show('Request redirect', () => new Request('http://x/', { redirect: 'nope' }));
show(
  'Request duplex',
  () => new Request('http://x/', { method: 'POST', body: new ReadableStream() }),
);
show('Request bad method', () => new Request('http://x/', { method: 'b d' }));
show('Request forbidden method', () => new Request('http://x/', { method: 'CONNECT' }));
show('Response status', () => new Response('', { status: 99 }));
show('Response null body status', () => new Response('x', { status: 204 }));
show('Response.json BigInt', () => Response.json(1n));
fetch('http://u:p@x/').then(
  () => print('fetch credentials: resolved'),
  (e) => print('fetch credentials: ' + e.constructor.name + ': ' + e.message),
);
