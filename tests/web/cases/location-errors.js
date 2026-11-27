// Blink's errors from Location, History, DOMStringList, Navigator and Screen: argument
// counts, conversions (a Symbol), the state's structured clone, pushState's same-origin
// rule, invalid URLs, receivers that are not instances, and construction. A message
// naming the page's origin prints it as `ORIGIN`; an invalid URL prints only the
// error's name, since Blink's text quotes its own partial parse of the input.
const strip = (s) => String(s).split(ORIGIN).join('ORIGIN');
function report(label, f) {
  try {
    f();
    print(label + ': no throw');
  } catch (e) {
    print(label + ': ' + e.constructor.name + ' ' + e.name + ': ' + strip(e.message));
  }
}
function reportName(label, f) {
  try {
    f();
    print(label + ': no throw');
  } catch (e) {
    print(label + ': ' + e.constructor.name + ' ' + e.name);
  }
}
const L0 = history.length;

report('pushState()', () => history.pushState());
report('pushState(1)', () => history.pushState(1));
report('replaceState(1)', () => history.replaceState(1));
report('pushState cross-origin', () => history.pushState(null, '', 'http://example.com/x'));
try {
  history.replaceState(null, '', 'https://' + location.host + '/');
  print('replaceState other scheme: no throw');
} catch (e) {
  print(
    'replaceState other scheme: ' +
      e.name +
      ': ' +
      strip(e.message).split(location.host).join('HOST'),
  );
}
report('pushState other port', () =>
  history.pushState(null, '', 'http://' + location.hostname + ':1/'),
);
reportName('pushState invalid url', () => history.pushState(null, '', 'http://['));
report('pushState function state', () => history.pushState(function f() {}, ''));
report('pushState symbol state', () => history.pushState(Symbol('s'), ''));
report('pushState symbol title', () => history.pushState(null, Symbol()));
report('pushState symbol url', () => history.pushState(null, '', Symbol()));
// The state is serialized before the URL is checked.
report('pushState bad state and url', () => history.pushState(() => {}, '', 'http://example.com/'));
print('length unchanged ' + (history.length === L0) + ' ' + strip(location.href));
report('scrollRestoration symbol', () => {
  history.scrollRestoration = Symbol();
});

report('assign()', () => location.assign());
report('replace()', () => location.replace());
reportName('assign invalid', () => location.assign('http://['));
reportName('replace invalid', () => location.replace('http://['));
reportName('href invalid', () => {
  location.href = 'http://[';
});
reportName('location invalid', () => {
  location = 'http://[';
});
report('assign symbol', () => location.assign(Symbol()));
report('href symbol', () => {
  location.href = Symbol();
});
report('hash symbol', () => {
  location.hash = Symbol();
});
print('href unchanged ' + strip(location.href));

report('contains()', () => location.ancestorOrigins.contains());
report('item()', () => location.ancestorOrigins.item());

const get = (o, k) => Object.getOwnPropertyDescriptor(o, k).get;
report('Location href receiver', () => get(location, 'href').call({}));
report('Location toString receiver', () => location.toString.call({}));
report('Location assign receiver', () => location.assign.call({}, '#x'));
report('History length receiver', () => get(History.prototype, 'length').call({}));
report('History pushState receiver', () => History.prototype.pushState.call({}, null, ''));
report('History back receiver', () => History.prototype.back.call(location));
report('DOMStringList length receiver', () => get(DOMStringList.prototype, 'length').call([]));
report('Navigator userAgent receiver', () => get(Navigator.prototype, 'userAgent').call({}));
report('Navigator javaEnabled receiver', () => Navigator.prototype.javaEnabled.call({}));
report('Screen width receiver', () => get(Screen.prototype, 'width').call(navigator));

for (const C of [Location, History, DOMStringList, Navigator, Screen]) {
  report('new ' + C.name, () => new C());
  report(C.name + '()', () => C());
}
