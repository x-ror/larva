// DOMException as a page sees it: the interface object, the prototype's accessors and
// legacy code constants, construction and its argument coercion, and the
// QuotaExceededError subclass with its options. Messages that are not thrown (the
// `message` an instance carries) are data here; the TypeErrors these throw are in
// domexception-errors.js.
const desc = (o, k) => {
  const d = Object.getOwnPropertyDescriptor(o, k);
  if (!d) return 'absent';
  const kind =
    'value' in d ? 'value ' + typeof d.value : 'get ' + typeof d.get + ' set ' + typeof d.set;
  return kind + ' e' + +d.enumerable + ' c' + +d.configurable + ' w' + +!!d.writable;
};
const show = (label, e) =>
  print(
    label +
      ': ' +
      e.constructor.name +
      ' name ' +
      JSON.stringify(e.name) +
      ' code ' +
      e.code +
      ' message ' +
      JSON.stringify(e.message) +
      ' string ' +
      JSON.stringify(String(e)) +
      ' tag ' +
      Object.prototype.toString.call(e),
  );

print('typeof ' + typeof DOMException + ' ' + typeof QuotaExceededError);
print('length ' + DOMException.length + ' name ' + DOMException.name);
print('global ' + desc(globalThis, 'DOMException'));
print(
  'ctor proto is Function.prototype ' +
    (Object.getPrototypeOf(DOMException) === Function.prototype),
);
print(
  'proto proto is Error.prototype ' +
    (Object.getPrototypeOf(DOMException.prototype) === Error.prototype),
);
for (const k of ['name', 'message', 'code', 'constructor'])
  print('prototype.' + k + ' ' + desc(DOMException.prototype, k));
print(
  'toStringTag ' +
    desc(DOMException.prototype, Symbol.toStringTag) +
    ' ' +
    DOMException.prototype[Symbol.toStringTag],
);
const constants = Object.getOwnPropertyNames(DOMException).filter((k) => /_ERR$/.test(k));
print('constants ' + constants.map((k) => k + '=' + DOMException[k]).join(' '));
print(
  'constant ' +
    desc(DOMException, 'ABORT_ERR') +
    ' on prototype ' +
    desc(DOMException.prototype, 'ABORT_ERR'),
);
print(
  'prototype constants match ' +
    constants.every((k) => DOMException.prototype[k] === DOMException[k]),
);

show('()', new DOMException());
show('(m)', new DOMException('m'));
show('(m, AbortError)', new DOMException('m', 'AbortError'));
show('(m, Bogus)', new DOMException('m', 'Bogus'));
show('(undefined, undefined)', new DOMException(undefined, undefined));
show('(null, null)', new DOMException(null, null));
show('(1, {})', new DOMException(1, {}));
show('(toString objects)', new DOMException({ toString: () => 'tm' }, { toString: () => 'tn' }));
const order = [];
new DOMException(
  { toString: () => (order.push('message'), 'm') },
  { toString: () => (order.push('name'), 'n') },
);
print('coercion order ' + order.join(','));

const names = [
  'IndexSizeError',
  'HierarchyRequestError',
  'WrongDocumentError',
  'InvalidCharacterError',
  'NoModificationAllowedError',
  'NotFoundError',
  'NotSupportedError',
  'InUseAttributeError',
  'InvalidStateError',
  'SyntaxError',
  'InvalidModificationError',
  'NamespaceError',
  'InvalidAccessError',
  'TypeMismatchError',
  'SecurityError',
  'NetworkError',
  'AbortError',
  'URLMismatchError',
  'QuotaExceededError',
  'TimeoutError',
  'InvalidNodeTypeError',
  'DataCloneError',
  'EncodingError',
  'NotReadableError',
  'DataError',
  'OperationError',
  'DOMStringSizeErr',
  'ValidationError',
  'NoDataAllowedError',
  'constructor',
  '__proto__',
];
print('codes ' + names.map((n) => n + '=' + new DOMException('', n).code).join(' '));

const e = new DOMException('a', 'b');
e.name = 'z';
e.message = 'y';
e.code = 99;
print('assignment ignored ' + e.name + ' ' + e.message + ' ' + e.code);
print('instanceof Error ' + (e instanceof Error) + ' DOMException ' + (e instanceof DOMException));
print('isError ' + (typeof Error.isError === 'function' ? Error.isError(e) : 'n/a'));
class Sub extends DOMException {}
show('subclass', new Sub('s', 'NotFoundError'));

print('QuotaExceededError length ' + QuotaExceededError.length);
print(
  'extends ' +
    (Object.getPrototypeOf(QuotaExceededError) === DOMException) +
    ' ' +
    (Object.getPrototypeOf(QuotaExceededError.prototype) === DOMException.prototype),
);
for (const k of ['quota', 'requested'])
  print('QuotaExceededError.prototype.' + k + ' ' + desc(QuotaExceededError.prototype, k));
print('QuotaExceededError toStringTag ' + QuotaExceededError.prototype[Symbol.toStringTag]);
print(
  'QuotaExceededError statics ' +
    JSON.stringify(Object.getOwnPropertyNames(QuotaExceededError).sort()),
);
const q = new QuotaExceededError();
show('quota ()', q);
print('quota () ' + q.quota + ' ' + q.requested);
const q2 = new QuotaExceededError('m', { quota: 5, requested: 7 });
show('quota (m, {5, 7})', q2);
print('quota (m, {5, 7}) ' + q2.quota + ' ' + q2.requested);
const q3 = new QuotaExceededError('m', { quota: '1.5', requested: -2 });
print('quota coerced ' + q3.quota + ' ' + q3.requested);
const q4 = new QuotaExceededError('m', null);
print(
  'quota null options ' + q4.quota + ' ' + q4.requested + ' name ' + q4.name + ' code ' + q4.code,
);
const reads = [];
new QuotaExceededError('m', {
  get requested() {
    reads.push('requested');
    return 1;
  },
  get quota() {
    reads.push('quota');
    return 2;
  },
});
print('options read order ' + reads.join(','));
