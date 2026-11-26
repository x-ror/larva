// The delay is a WebIDL `long`, converted when setTimeout is called: ToNumber (a
// throwing valueOf, a Symbol or a BigInt throws out of setTimeout and schedules
// nothing), then truncation modulo 2^32 read as signed, and anything below 0 is 0. So
// NaN, Infinity, -1 and 2^31 are 0 ms, 2^32 + 5 is 5 ms and 2^32 - 1 is 0 ms, while
// 2^31 - 1 and 1e10 stay far off (cleared at the end). A 0 ms delay is not raised to 1:
// the 1 ms timer created first still fires after every 0 ms one.
const ev = [];
const log = [];
const ids = [];
const mk = (n) => () => ev.push(n);
ids.push(setTimeout(mk('1'), 1));
ids.push(setTimeout(mk('3'), 3));
ids.push(setTimeout(mk('2^32+5'), 2 ** 32 + 5));
ids.push(setTimeout(mk('2^31'), 2 ** 31));
ids.push(setTimeout(mk('-1'), -1));
ids.push(setTimeout(mk('NaN'), NaN));
ids.push(setTimeout(mk('Infinity'), Infinity));
ids.push(setTimeout(mk('"6"'), '6'));
ids.push(setTimeout(mk('4.9'), 4.9));
ids.push(setTimeout(mk('-4.9'), -4.9));
ids.push(setTimeout(mk('undefined'), undefined));
ids.push(setTimeout(mk('null'), null));
ids.push(setTimeout(mk('valueOf'), { valueOf: () => (log.push('valueOf'), 2) }));
ids.push(setTimeout(mk('[7]'), [7]));
ids.push(setTimeout(mk('2^31-1'), 2 ** 31 - 1));
ids.push(setTimeout(mk('2^32-1'), 2 ** 32 - 1));
ids.push(setTimeout(mk('1e10'), 1e10));
ids.push(setTimeout(mk('true'), true));
log.push('after');
const attempt = (label, f) => {
  try {
    f();
    log.push(label + ' no throw');
  } catch (e) {
    log.push(label + ' ' + e.constructor.name);
  }
};
attempt('throwing valueOf', () =>
  setTimeout(mk('thrown'), {
    valueOf() {
      throw new RangeError('x');
    },
  }),
);
attempt('Symbol', () => setTimeout(mk('Symbol'), Symbol()));
attempt('BigInt', () => setTimeout(mk('BigInt'), 1n));
attempt('setInterval BigInt', () => setInterval(mk('interval BigInt'), 1n));
setTimeout(() => {
  print(log.join(','));
  print(ev.join(','));
  for (const id of ids) clearTimeout(id);
}, 100);
