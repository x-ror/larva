// Where Larva's Storage (a Proxy over a null-prototype dictionary) cannot answer as
// Chrome's (a V8 interceptor over a hash map): a known gap, pinned to Lava's output.
const s = localStorage;
s.clear();
// 1. Chrome lists its items in hash-table order; Lava in property order (array
//    indices ascending, then insertion).
for (const k of ['m', 'b', 'z', 'a', '10', '9', 'B']) s.setItem(k, k);
const viaKey = [];
for (let i = 0; i < s.length; i++) viaKey.push(s.key(i));
print(JSON.stringify(viaKey));
print(JSON.stringify(Object.keys(s)));
s.clear();
// 2. An item whose name the prototype has: Chrome lists it in Object.keys although it
//    has no own property descriptor; Lava follows the descriptor (WebIDL's named
//    property visibility) and leaves it out.
s.setItem('getItem', 'x');
s.setItem('foo', '1');
print(JSON.stringify(Object.keys(s)));
print(Object.getOwnPropertyDescriptor(s, 'getItem'));
s.clear();
// 3. A non-configurable data descriptor: Chrome stores the value and reports success; a
//    Proxy cannot report a non-configurable property its target lacks, so Lava refuses.
print(Reflect.defineProperty(s, 'nc', { value: 'v', configurable: false }));
print(s.getItem('nc'));
try {
  Object.defineProperty(s, 'nc2', { value: 'w', configurable: false });
  print('no throw');
} catch (e) {
  print(e.constructor.name);
}
print(s.getItem('nc2'));
s.clear();
// 4. An accessor descriptor through Reflect.defineProperty: Chrome answers true (its
//    interceptor only throws when the caller wants a throw) and stores nothing; Lava
//    answers false, as WebIDL's [[DefineOwnProperty]] does.
print(Reflect.defineProperty(s, 'acc', { get() {} }));
print(s.getItem('acc') + ' ' + s.length + ' ' + Object.hasOwn(s, 'acc'));
s.clear();
