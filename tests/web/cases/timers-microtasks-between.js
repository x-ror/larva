// A microtask queued by one timer callback runs before the next timer's callback.
// Ported from tests/runtime/eventloop/cases/04-microtasks-between-timers.js.
const events = [];
setTimeout(() => {
  events.push('timer-1');
  queueMicrotask(() => events.push('microtask-from-timer-1'));
}, 0);
setTimeout(() => events.push('timer-2'), 0);
setTimeout(() => print(events.join(',')), 10);
