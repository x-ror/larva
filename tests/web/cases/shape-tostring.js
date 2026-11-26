// Function.prototype.toString as a page probes it (#114). Lava replaces the intrinsic
// (internal/native_shape) so its Web APIs print `[native code]`; none of that may show:
// not in the replacement's own descriptor, name, length, keys, constructibility or
// text, not in Function.prototype's key order, not in what it prints for a script
// function, a JSC built-in, a bound function or a getter, and not in what it throws.
const ts = Function.prototype.toString;
function src(f) {
  try {
    return JSON.stringify(ts.call(f));
  } catch (e) {
    return 'throws ' + e.constructor.name + ': ' + e.message;
  }
}
function desc(o, k) {
  const d = Object.getOwnPropertyDescriptor(o, k);
  return [typeof d.value, d.writable, d.enumerable, d.configurable].join('/');
}
print('descriptor ' + desc(Function.prototype, 'toString'));
print('same ' + (Object.getOwnPropertyDescriptor(Function.prototype, 'toString').value === ts));
print('name ' + ts.name + ' length ' + ts.length + ' own ' + Reflect.ownKeys(ts).join());
print('prototype ' + Object.hasOwn(ts, 'prototype') + ' ' + typeof ts.prototype);
try {
  new ts();
  print('new: no throw');
} catch (e) {
  print('new: ' + e.constructor.name);
}
print('self ' + src(ts));
print('self.self ' + src(ts.toString));
print('Function.prototype keys ' + Reflect.ownKeys(Function.prototype).map(String).join());
print(
  'script ' +
    src(function f(a, b) {
      return a + b;
    }),
);
print('arrow ' + src((a) => a * 2));
print(
  'class ' +
    src(
      class A {
        m() {}
      },
    ),
);
print(
  'method ' +
    src(
      {
        m(x) {
          return x;
        },
      }.m,
    ),
);
print('native ' + src(Array.prototype.push));
print('native getter ' + src(Object.getOwnPropertyDescriptor(Map.prototype, 'size').get));
print('native setter ' + src(Object.getOwnPropertyDescriptor(Object.prototype, '__proto__').set));
print('bound ' + src(function g() {}.bind(null)));
print('bound native ' + src(Array.prototype.push.bind(null)));
print('proxy ' + src(new Proxy(function h() {}, {})));
print('Symbol ' + src(Symbol) + ' Promise ' + src(Promise));
print('String(atob) ' + JSON.stringify(String(atob)));
print('template ' + JSON.stringify(`${URL}`));
print('concat ' + JSON.stringify('' + URLSearchParams.prototype.get));
print('a namesake script function ' + src(function atob() {}));
print('subclass ' + src(class MyURL extends URL {}));
print('receiver {} ' + src({}));
print('receiver 1 ' + src(1));
print('receiver undefined ' + src(undefined));
print('receiver symbol ' + src(Symbol('s')));
// Renaming a built-in does not change what it prints, in Chrome.
Object.defineProperty(atob, 'name', { value: 'renamed' });
print('renamed atob ' + src(atob) + ' name ' + atob.name);
