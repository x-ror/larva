// clearTimeout before the timer fires cancels it; a sibling timer still fires.
// Ported from tests/runtime/eventloop/cases/02-timer-cancellation.js.
const events = [];
const timer = setTimeout(() => events.push('cancelled'), 0);
clearTimeout(timer);
setTimeout(() => events.push('kept'), 0);
setTimeout(() => print(events.join(',')), 10);
