// Timers with the same delay fire in the order they were created.
// Ported from tests/runtime/eventloop/cases/03-timer-fifo.js.
const events = [];
setTimeout(() => events.push(1), 0);
setTimeout(() => events.push(2), 0);
setTimeout(() => events.push(3), 0);
setTimeout(() => print(events.join(',')), 10);
