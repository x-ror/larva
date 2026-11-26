// The TypeErrors DOMException and QuotaExceededError throw, with Chrome's WebIDL text:
// a Symbol where a DOMString is converted, an accessor called on a foreign receiver,
// and a QuotaExceededErrorOptions that is not a dictionary or holds a non-finite
// double. Calling either constructor without `new` is not printed: that message is the
// engine's (CLAUDE.md §5).
function show(label, f) {
  try {
    f();
    print(label + ': no throw');
  } catch (e) {
    print(
      label +
        ': ' +
        e.constructor.name +
        ' ' +
        JSON.stringify(e.message) +
        ' own code ' +
        Object.prototype.hasOwnProperty.call(e, 'code'),
    );
  }
}
show('Symbol message', () => new DOMException(Symbol('s')));
show('Symbol name', () => new DOMException('m', Symbol('s')));
show('name on the prototype', () => DOMException.prototype.name);
show('code on an Error', () =>
  Object.getOwnPropertyDescriptor(DOMException.prototype, 'code').get.call(new Error('x')),
);
show('message on a plain object', () =>
  Object.getOwnPropertyDescriptor(DOMException.prototype, 'message').get.call({}),
);
show('quota on a DOMException', () =>
  Object.getOwnPropertyDescriptor(QuotaExceededError.prototype, 'quota').get.call(
    new DOMException('m'),
  ),
);
show('quota NaN', () => new QuotaExceededError('m', { quota: NaN }));
show('requested Infinity', () => new QuotaExceededError('m', { requested: Infinity }));
show('options 5', () => new QuotaExceededError('m', 5));
show('options string', () => new QuotaExceededError('m', 'x'));
show('options function', () => new QuotaExceededError('m', () => {}));
show('negative quota', () => new QuotaExceededError('m', { quota: -1 }));
show('requested below quota', () => new QuotaExceededError('m', { quota: 5, requested: 2 }));
