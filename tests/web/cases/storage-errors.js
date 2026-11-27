// Storage's WebIDL errors: argument counts, the receiver check, conversion order, and
// the QuotaExceededError when an area would grow past its quota.
const s = localStorage;
s.clear();
function attempt(label, f) {
  try {
    const v = f();
    print(label + ': ok ' + JSON.stringify(v));
  } catch (e) {
    print(label + ': ' + e.constructor.name + ' ' + e.name + ' ' + e.code + ': ' + e.message);
  }
}
attempt('getItem()', () => s.getItem());
attempt('setItem()', () => s.setItem());
attempt('setItem(a)', () => s.setItem('a'));
attempt('removeItem()', () => s.removeItem());
attempt('key()', () => s.key());
attempt('getItem symbol', () => s.getItem(Symbol('x')));
attempt('setItem symbol key', () => s.setItem(Symbol('x'), 'v'));
attempt('setItem symbol value', () => s.setItem('k', Symbol('x')));
attempt('removeItem symbol', () => s.removeItem(Symbol('x')));
attempt('key symbol', () => s.key(Symbol('x')));
attempt('key bigint', () => s.key(1n));
attempt('key string', () => s.key('0'));
attempt('named symbol value', () => {
  s.sym = Symbol('x');
});
attempt('call getItem on {}', () => Storage.prototype.getItem.call({}, 'a'));
attempt('call setItem on {}', () => Storage.prototype.setItem.call({}, 'a', 'b'));
attempt('call clear on {}', () => Storage.prototype.clear.call({}));
attempt('length on proto', () => Storage.prototype.length);
attempt('length on {}', () =>
  Object.getOwnPropertyDescriptor(Storage.prototype, 'length').get.call({}),
);
attempt('new Storage', () => new Storage());
attempt('Storage()', () => Storage());
attempt('getItem on sessionStorage via local', () =>
  Storage.prototype.getItem.call(sessionStorage, 'x'),
);
// Conversion order: the key converts before the value; the receiver before both.
const log = [];
const k = {
  toString() {
    log.push('key');
    return 'k';
  },
};
const v = {
  toString() {
    log.push('value');
    return 'v';
  },
};
attempt('order', () => s.setItem(k, v));
print(log.join(','));
log.length = 0;
attempt('order receiver', () => Storage.prototype.setItem.call({}, k, v));
print(log.join(','));
log.length = 0;
attempt('order throwing key', () =>
  s.setItem(
    {
      toString() {
        throw new RangeError('k');
      },
    },
    v,
  ),
);
print(log.join(','));
s.clear();
// Quota.
const MB = 1024 * 1024;
function probe(label, key, n) {
  s.clear();
  attempt(label, () => {
    s.setItem(key, 'x'.repeat(n));
    return s.getItem(key).length;
  });
}
probe('5MB-1 value, 1-char key', 'a', 5 * MB - 1);
probe('5MB value, 1-char key', 'a', 5 * MB);
probe('5MB value, empty key', '', 5 * MB);
probe('5MB+1 value, empty key', '', 5 * MB + 1);
probe('10MB-1 value', 'a', 10 * MB - 1);
probe('10MB value, empty key', '', 10 * MB);
probe('10MB+1 value, empty key', '', 10 * MB + 1);
s.clear();
s.setItem('a', 'x'.repeat(5 * MB - 10));
attempt('fill rest', () => s.setItem('b', 'y'.repeat(20)));
attempt('fill exact', () => s.setItem('b', 'y'.repeat(8)));
attempt('replace same size', () => s.setItem('a', 'z'.repeat(5 * MB - 10)));
attempt('length', () => s.length);
s.clear();
attempt('named over quota', () => {
  s.big = 'x'.repeat(10 * MB + 1);
});
print(s.length);
try {
  s.setItem('a', 'x'.repeat(10 * MB + 1));
} catch (e) {
  print(e instanceof DOMException);
  print(typeof QuotaExceededError === 'function' && e instanceof QuotaExceededError);
  print(Object.getPrototypeOf(e) === DOMException.prototype);
  print(JSON.stringify(Object.keys(e)));
  print('quota' in e ? e.quota + ' ' + e.requested : 'no quota');
}
// The two areas have separate quotas.
s.clear();
s.setItem('a', 'x'.repeat(4 * MB));
attempt('session independent', () => {
  sessionStorage.setItem('a', 'x'.repeat(4 * MB));
  return sessionStorage.length;
});
s.clear();
sessionStorage.clear();
