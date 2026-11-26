// Microtasks run before the first timer: a promise job and a queueMicrotask callback
// queued at the top level both run ahead of a 0 ms timeout.
// Ported from tests/runtime/eventloop/cases/00-order.js.
const events = [];
Promise.resolve().then(() => events.push('promise'));
queueMicrotask(() => events.push('microtask'));
setTimeout(() => {
  events.push('timer');
  print(events.join(','));
}, 0);
