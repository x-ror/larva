// The WebIDL errors URL and URLSearchParams throw past their parse errors (those are
// url-errors.js): argument counts, Symbol conversion, the base argument's null, the
// order the two arguments convert in, and a member called on a foreign receiver.
function show(label, f) {
  try {
    const v = f();
    print(label + ': no throw ' + JSON.stringify(String(v)));
  } catch (e) {
    print(label + ': ' + e.constructor.name + ': ' + e.message + ' code=' + e.code);
  }
}
const sym = Symbol('s');
show('URL(Symbol)', () => new URL(sym));
show('URL(x, Symbol)', () => new URL('http://a/', sym));
show('URL(x, null)', () => new URL('http://a/', null));
show('URL(x, undefined)', () => new URL('http://a/', undefined));
const order = [];
const tag = (name, s) => ({
  toString() {
    order.push(name);
    return s;
  },
});
show('URL order', () => new URL(tag('input', 'x'), tag('base', 'nope')));
print('order: ' + order.join(','));
show('URL.canParse(Symbol)', () => URL.canParse(sym));
show('URL.canParse(x, null)', () => URL.canParse('http://a/', null));
show('URL.parse(Symbol)', () => URL.parse(sym));
show('URL.parse(x, null)', () => URL.parse('http://a/', null));
show('href = Symbol', () => {
  const u = new URL('http://a/');
  u.href = sym;
  return u;
});
show('search = Symbol', () => {
  const u = new URL('http://a/');
  u.search = sym;
  return u;
});
const hrefDesc = Object.getOwnPropertyDescriptor(URL.prototype, 'href');
show('href getter on {}', () => hrefDesc.get.call({}));
show('href setter on {}', () => hrefDesc.set.call({}, 'http://a/'));
show('URL toString on {}', () => URL.prototype.toString.call({}));
show('URL toJSON on {}', () => URL.prototype.toJSON.call({}));
show('USP(Symbol)', () => new URLSearchParams(sym));
show('USP([[Symbol, 1]])', () => new URLSearchParams([[sym, '1']]));
show('USP({a: Symbol})', () => new URLSearchParams({ a: sym }));
show('USP([[1,2,3]])', () => new URLSearchParams([[1, 2, 3]]));
show('USP([{}])', () => new URLSearchParams([{}]));
show('searchParams on {}', () =>
  Object.getOwnPropertyDescriptor(URL.prototype, 'searchParams').get.call({}),
);
show('host = Symbol on opaque', () => {
  const u = new URL('mailto:x');
  u.host = sym;
  return u;
});
const sp = new URLSearchParams('a=1');
show('append()', () => sp.append());
show('append(a)', () => sp.append('a'));
show('append(Symbol, 1)', () => sp.append(sym, '1'));
show('set(a)', () => sp.set('a'));
show('get()', () => sp.get());
show('getAll()', () => sp.getAll());
show('has()', () => sp.has());
show('delete()', () => sp.delete());
show('get(Symbol)', () => sp.get(sym));
show('forEach()', () => sp.forEach());
show('forEach(1)', () => sp.forEach(1));
show('get on {}', () => URLSearchParams.prototype.get.call({}, 'a'));
show('append on {}', () => URLSearchParams.prototype.append.call({}, 'a', 'b'));
show('USP toString on {}', () => URLSearchParams.prototype.toString.call({}));
show('sort on {}', () => URLSearchParams.prototype.sort.call({}));
show('entries on {}', () => URLSearchParams.prototype.entries.call({}));
const sizeDesc = Object.getOwnPropertyDescriptor(URLSearchParams.prototype, 'size');
show('size on {}', () => sizeDesc.get.call({}));
