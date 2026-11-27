// Storage's named properties (WebIDL legacy platform object): a stored key reads as a
// property, an assignment stores, delete removes, `in` and Object.keys see the keys —
// except where the prototype chain has the name.
const s = localStorage;
s.clear();
s.foo = 1;
print(JSON.stringify(s.getItem('foo')) + ' ' + typeof s.foo + ' ' + s.foo);
s.setItem('bar', 'B');
print(s.bar + ' ' + ('bar' in s) + ' ' + ('nope' in s) + ' ' + s.nope);
print(JSON.stringify(Object.keys(s).sort()));
print(JSON.stringify(Object.getOwnPropertyNames(s).sort()));
print(JSON.stringify(Object.getOwnPropertyDescriptor(s, 'bar')));
print(Object.getOwnPropertyDescriptor(s, 'nope'));
print(s.hasOwnProperty('bar') + ' ' + Object.hasOwn(s, 'foo'));
print(delete s.bar);
print(s.getItem('bar') + ' ' + ('bar' in s));
print(delete s.nothing);
const seen = [];
for (const k in s) seen.push(k);
print(JSON.stringify(seen.filter((k) => k === 'foo')));
print(seen.includes('getItem') + ' ' + seen.includes('length'));
print(JSON.stringify(Object.entries(s)));
print(JSON.stringify(s));
print(JSON.stringify({ ...s }));
// Names the prototype chain holds stay the methods; the item is still stored.
s.setItem('getItem', 'shadow');
print(typeof s.getItem + ' ' + s.getItem('getItem'));
print(Object.getOwnPropertyDescriptor(s, 'getItem'));
s.setItem('length', '99');
print(s.length);
s.setItem('toString', 'x');
print(typeof s.toString);
s.setItem('__proto__', 'p');
print(Object.getPrototypeOf(s) === Storage.prototype);
print(s.getItem('__proto__'));
s.clear();
// An assignment to a name the prototype has: stored as an item, the method stays.
s.key = 'k';
print(typeof s.key + ' ' + s.getItem('key'));
s.length = 7;
print(s.length + ' ' + s.getItem('length'));
s.clear();
// Numeric-looking keys.
s[0] = 'zero';
s['1'] = 'one';
print(s[0] + ' ' + s.getItem('0') + ' ' + s[1] + ' ' + s.length);
print(JSON.stringify(Object.keys(s).sort()));
s.clear();
// Object.defineProperty: a data descriptor stores its value, an accessor is refused.
Object.defineProperty(s, 'dp', { value: 5 });
print(JSON.stringify(s.getItem('dp')));
try {
  Object.defineProperty(s, 'acc', { get() {} });
  print('no throw');
} catch (e) {
  print(e.constructor.name);
}
print(Reflect.defineProperty(s, 'dp2', { value: 'v', writable: false, enumerable: false }));
print(JSON.stringify(Object.getOwnPropertyDescriptor(s, 'dp2')));
print(Reflect.set(s, 'rs', 'R') + ' ' + s.getItem('rs'));
print(Reflect.deleteProperty(s, 'rs') + ' ' + s.getItem('rs'));
// Symbols are ordinary properties.
const sym = Symbol('t');
s[sym] = 1;
print(s[sym] + ' ' + s.length + ' ' + Object.getOwnPropertySymbols(s).length);
print(delete s[sym]);
print(Object.isExtensible(s));
print(Reflect.preventExtensions(s));
print(Object.isExtensible(s));
try {
  Object.preventExtensions(s);
  print('no throw');
} catch (e) {
  print(e.constructor.name);
}
try {
  Object.freeze(s);
  print('no throw');
} catch (e) {
  print(e.constructor.name);
}
print(Object.isFrozen(s));
// Strict mode: a refused delete or define throws.
(function () {
  'use strict';
  s.setItem('getItem', 'g');
  try {
    delete s.getItem;
    print('delete getItem ok ' + typeof s.getItem);
  } catch (e) {
    print(e.constructor.name);
  }
  s.strict = 'yes';
  print(s.getItem('strict'));
  print(delete s.strict);
})();
// A sub-object's [[Set]]: the receiver differs, so the property lands on the sub-object.
const child = Object.create(s);
child.own = 'x';
print(Object.hasOwn(child, 'own') + ' ' + s.getItem('own'));
s.setItem('inherited', 'i');
print(child.inherited);
s.clear();
sessionStorage.n = 'session';
print(sessionStorage.n + ' ' + localStorage.n);
sessionStorage.clear();
