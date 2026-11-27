// console.context(), console.createTask() and console.memory: what a page can read and
// call. The logging itself is not observed (print writes through console.log on Lava);
// memory's numbers are not printed, only the relations Chrome's hold to.
function t(label, f) {
  try {
    print(label + ' ' + f());
  } catch (e) {
    print(label + ' THREW ' + e.constructor.name + ': ' + e.message);
  }
}
const fnToString = Function.prototype.toString;
const desc = (o) =>
  Reflect.ownKeys(o)
    .map((k) => {
      const d = Object.getOwnPropertyDescriptor(o, k);
      if (!('value' in d))
        return String(k) + ':accessor' + (d.enumerable ? 'e' : '') + (d.configurable ? 'c' : '');
      const flags =
        (d.writable ? 'w' : '') + (d.enumerable ? 'e' : '') + (d.configurable ? 'c' : '');
      const v = d.value;
      return (
        String(k) +
        ':' +
        flags +
        (typeof v === 'function' ? '/' + v.name + '/' + v.length + '/' + fnToString.call(v) : '')
      );
    })
    .join(' ');

const c = console.context('n');
print(
  'context ' +
    Object.prototype.toString.call(c) +
    ' ' +
    (Object.getPrototypeOf(c) === Object.prototype),
);
print('context keys ' + desc(c));
print('context fresh ' + (console.context() !== console.context()) + ' ' + (c.log !== console.log));
t('context name converted', () =>
  console.context({
    toString() {
      throw new RangeError('boom');
    },
  }),
);

t('createTask()', () => console.createTask());
t('createTask empty', () => console.createTask(''));
t('createTask number', () => console.createTask(5));
const task = console.createTask('work');
const proto = Object.getPrototypeOf(task);
print('task ' + Object.prototype.toString.call(task) + ' ' + desc(task));
print('task proto ' + desc(proto) + ' ' + (Object.getPrototypeOf(proto) === Object.prototype));
t('run', () =>
  task.run(function () {
    return 'ran ' + arguments.length + ' ' + (this === globalThis);
  }, 1),
);
t('run result', () => task.run(() => 7));
t('run throws', () =>
  task.run(() => {
    throw new RangeError('inner');
  }),
);
t('run non-function', () => task.run(5));
t('run nothing', () => task.run());

const m = console.memory;
const mp = Object.getPrototypeOf(m);
print('memory ' + Object.prototype.toString.call(m) + ' own [' + desc(m) + ']');
print(
  'memory proto ' +
    Reflect.ownKeys(mp).map(String).join(',') +
    ' ' +
    (Object.getPrototypeOf(mp) === Object.prototype),
);
print('memory fresh ' + (console.memory !== m) + ' ' + typeof MemoryInfo);
print(
  'memory values ' +
    [
      typeof m.usedJSHeapSize,
      m.usedJSHeapSize > 0,
      m.totalJSHeapSize >= m.usedJSHeapSize,
      m.jsHeapSizeLimit > m.totalJSHeapSize,
    ].join(),
);
t('memory foreign', () => Object.getOwnPropertyDescriptor(mp, 'usedJSHeapSize').get.call({}));
t('memory assigned', () => {
  console.memory = 5;
  return Object.prototype.toString.call(console.memory);
});
