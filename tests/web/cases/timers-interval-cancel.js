// clearInterval from inside the interval's own callback stops it after that fire.
// Ported from tests/runtime/eventloop/cases/06-interval-cancellation.js.
const events = [];
const interval = setInterval(() => {
  events.push('tick');
  if (events.length === 2) clearInterval(interval);
}, 0);
setTimeout(() => print(events.join(',')), 20);
