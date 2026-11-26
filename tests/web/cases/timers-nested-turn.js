// A timer created inside a timer callback fires after the timers already due.
// Ported from tests/runtime/eventloop/cases/05-nested-timer-turn.js.
const events = [];
setTimeout(() => {
  events.push(1);
  setTimeout(() => events.push(3), 0);
}, 0);
setTimeout(() => events.push(2), 0);
setTimeout(() => print(events.join(',')), 20);
