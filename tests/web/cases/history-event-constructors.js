// PopStateEvent and HashChangeEvent as a page constructs them: defaults, the init
// dictionary's conversions and the order its members are read, and Blink's errors.
const show = (f) => {
  try {
    return String(f());
  } catch (e) {
    return 'THREW ' + e.name + ': ' + e.message;
  }
};
const reads = [];
const spy = (fields) => {
  const o = {};
  for (const k of Object.keys(fields)) {
    Object.defineProperty(o, k, {
      get() {
        reads.push(k);
        return fields[k];
      },
    });
  }
  return o;
};

const h0 = new HashChangeEvent('hashchange');
print(
  'hash default ' +
    JSON.stringify([
      h0.type,
      h0.oldURL,
      h0.newURL,
      h0.bubbles,
      h0.cancelable,
      h0.composed,
      h0.isTrusted,
    ]),
);
print('hash proto ' + (h0 instanceof Event) + ' ' + Object.prototype.toString.call(h0));
print('hash own ' + JSON.stringify(Reflect.ownKeys(h0)));
const h1 = new HashChangeEvent(
  'x',
  spy({ newURL: 'n', oldURL: 'o', bubbles: 1, cancelable: 0, composed: 'y' }),
);
print(
  'hash init reads ' +
    reads.join(',') +
    ' -> ' +
    [h1.oldURL, h1.newURL, h1.bubbles, h1.cancelable, h1.composed],
);
reads.length = 0;
print(
  'hash init coerce ' +
    JSON.stringify(new HashChangeEvent('x', { oldURL: 1, newURL: null }).newURL),
);
print(
  'hash init undefined ' + JSON.stringify(new HashChangeEvent('x', { oldURL: undefined }).oldURL),
);
print('hash no args ' + show(() => new HashChangeEvent()));
print('hash bad init ' + show(() => new HashChangeEvent('x', 5)));
print('hash null init ' + show(() => new HashChangeEvent('x', null).oldURL));
print('hash symbol type ' + show(() => new HashChangeEvent(Symbol())));
print('hash symbol url ' + show(() => new HashChangeEvent('x', { newURL: Symbol() })));
print('hash call ' + show(() => HashChangeEvent('x')));
print(
  'hash getter foreign ' +
    show(() =>
      Object.getOwnPropertyDescriptor(HashChangeEvent.prototype, 'oldURL').get.call(new Event('x')),
    ),
);

const p0 = new PopStateEvent('popstate');
print(
  'pop default ' +
    JSON.stringify([
      p0.type,
      p0.state,
      p0.hasUAVisualTransition,
      p0.bubbles,
      p0.cancelable,
      p0.composed,
    ]),
);
print('pop proto ' + (p0 instanceof Event) + ' ' + Object.prototype.toString.call(p0));
print('pop own ' + JSON.stringify(Reflect.ownKeys(p0)));
const st = { k: 1 };
const p1 = new PopStateEvent(
  'x',
  spy({ state: st, hasUAVisualTransition: 'yes', bubbles: true, cancelable: true, composed: 0 }),
);
print(
  'pop init reads ' +
    reads.join(',') +
    ' -> ' +
    [
      p1.state === st,
      p1.state === p1.state,
      p1.hasUAVisualTransition,
      p1.bubbles,
      p1.cancelable,
      p1.composed,
    ],
);
reads.length = 0;
print('pop state undefined ' + new PopStateEvent('x', { state: undefined }).state);
print('pop no args ' + show(() => new PopStateEvent()));
print('pop bad init ' + show(() => new PopStateEvent('x', 'str')));
print('pop call ' + show(() => PopStateEvent('x')));
print(
  'pop getter foreign ' +
    show(() => Object.getOwnPropertyDescriptor(PopStateEvent.prototype, 'state').get.call(h0)),
);

// A page-made event dispatched at the window is untrusted and reaches the handlers.
let got = '';
onhashchange = (e) => {
  got = e.oldURL + '>' + e.newURL + ' ' + e.isTrusted;
};
dispatchEvent(new HashChangeEvent('hashchange', { oldURL: 'a', newURL: 'b' }));
print('dispatched ' + got);
onhashchange = null;
