// Web Storage (HTML §12.2): the Storage methods and `length` on localStorage and
// sessionStorage, WebIDL's DOMString conversion of keys and values, and the two areas
// being separate. Each run starts from a fresh profile, so both areas start empty.
function dump(label, s) {
  const keys = [];
  for (let i = 0; i < s.length; i++) keys.push(s.key(i));
  keys.sort();
  print(label + ' length=' + s.length + ' keys=' + JSON.stringify(keys));
}
for (const [label, s] of [
  ['local', localStorage],
  ['session', sessionStorage],
]) {
  dump(label + ' start', s);
  print(s.getItem('missing') === null);
  s.setItem('a', '1');
  s.setItem('b', 2);
  s.setItem('c', { toString: () => 'obj' });
  s.setItem(3, null);
  s.setItem('u', undefined);
  s.setItem('', 'empty key');
  dump(label + ' set', s);
  print(
    JSON.stringify([s.getItem('a'), s.getItem('b'), s.getItem('c'), s.getItem('3'), s.getItem(3)]),
  );
  print(JSON.stringify([s.getItem('u'), s.getItem(undefined), s.getItem(''), s.getItem(null)]));
  s.setItem('a', 'again');
  print(s.getItem('a') + ' ' + s.length);
  s.removeItem('a');
  s.removeItem('not there');
  print(s.getItem('a') + ' ' + s.length);
  print(s.key(-1) + ' ' + s.key(100) + ' ' + s.key(4294967296 + 100));
  print(typeof s.key(0));
  s.setItem('lone', '\ud800x');
  print(JSON.stringify(s.getItem('lone')));
  s.setItem('\udc00k', 'v');
  print(JSON.stringify(s.getItem('\udc00k')));
  s.setItem('nul', 'a\u0000b');
  print(JSON.stringify(s.getItem('nul')));
  print(s.clear());
  dump(label + ' cleared', s);
}
localStorage.setItem('shared', 'L');
print(sessionStorage.getItem('shared'));
print(localStorage === localStorage);
print(sessionStorage === sessionStorage);
print(localStorage !== sessionStorage);
print(localStorage instanceof Storage);
print(Object.prototype.toString.call(localStorage));
print(String(localStorage));
print(Object.getPrototypeOf(localStorage) === Storage.prototype);
localStorage.clear();
// key() and the named properties enumerate the same keys (their order is Chrome's hash
// order, which storage-named-gaps pins as a known gap).
for (const k of ['m', 'b', 'z', 'a', '10', '9', 'B']) localStorage.setItem(k, k);
const viaKey = [];
for (let i = 0; i < localStorage.length; i++) viaKey.push(localStorage.key(i));
print(JSON.stringify(viaKey.sort()));
print(JSON.stringify(Object.keys(localStorage).sort()));
localStorage.clear();
