// setTimeout/setInterval forward trailing arguments to the callback on every fire,
// by identity; with none the callback receives none.
// Ported from tests/node-compat/cases/05-timers.js (its setImmediate part is Node-only).
const events = [];
queueMicrotask(() => events.push('microtask'));
setTimeout(() => {
  events.push('timeout');
  print(events.join(','));
  setTimeout((a, b) => print('timeout args ' + a + ' ' + b), 0, 'a', 'b');
  const obj = { id: 7 };
  const seen = [];
  const id = setInterval(
    (o, label) => {
      seen.push(o === obj ? o.id + ':' + label : 'other');
      if (seen.length === 2) {
        clearInterval(id);
        print('interval args ' + seen.join(','));
        setTimeout((...rest) => print('no args ' + rest.length), 0);
      }
    },
    0,
    obj,
    'tick',
  );
}, 0);
