// What a stack shows of the platform when a Web API throws to the page (#114): no
// frame of Lava's own sources, whether the error was made by the API, raised by the
// engine inside it (a receiver that is not an instance), or thrown by the page's own
// callback the API called — and the page's own frame is still there. Errors-stack.js
// covers the errors the API makes itself; this one the other two. Messages and the
// frame format are engine traits and are not printed.
function show(label, f) {
  try {
    f();
    print(label + ': no throw');
  } catch (e) {
    const stack = typeof e.stack === 'string' ? e.stack : '';
    print(
      label +
        ': internal ' +
        /node:internal|lava:|internal\//.test(stack) +
        ' page ' +
        /shape-stacks\.js/.test(stack),
    );
  }
}
function getter(C, name) {
  return Object.getOwnPropertyDescriptor(C.prototype, name).get;
}
function pageThrow() {
  throw new Error('page');
}
show('URL href on {}', () => getter(URL, 'href').call({}));
show('URL toString on {}', () => URL.prototype.toString.call({}));
show('new URL invalid', () => new URL('x'));
show('new URL page toString', () => new URL({ toString: pageThrow }));
show('URLSearchParams bad pair', () => new URLSearchParams([['a']]));
show('URLSearchParams forEach page', () => new URLSearchParams('a=1').forEach(pageThrow));
show('Headers get on {}', () => Headers.prototype.get.call({}, 'a'));
show('Blob bad parts', () => new Blob(1));
show('TextDecoder bad label', () => new TextDecoder('nope'));
show('TextDecoder decode on {}', () => TextDecoder.prototype.decode.call({}));
show('ReadableStream getReader on {}', () => ReadableStream.prototype.getReader.call({}));
show('CountQueuingStrategy no init', () => new CountQueuingStrategy());
show('queueMicrotask(1)', () => queueMicrotask(1));
show('getRandomValues on {}', () => crypto.getRandomValues.call({}, new Uint8Array(1)));
show('toString on {}', () => Function.prototype.toString.call({}));
show('URL() without new', () => URL('x'));
show('new AbortSignal', () => new AbortSignal());
