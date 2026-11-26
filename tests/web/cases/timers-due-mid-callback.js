// A timer that falls due while another timer's callback runs fires before a 0 ms
// timer that callback creates: the order follows the deadlines. A is due at +10 and
// B at +210; A spins 400 ms, which puts the clock 200 ms past B's deadline, then
// queues C. Ported from tests/runtime/eventloop/cases/12-timer-due-mid-phase-waits.js,
// whose setImmediate has no page counterpart; C is the 0 ms timer in its place.
// The spins read the clock inside a timer callback, which Chrome's virtual time
// freezes; recorded in real time:
// web-oracle: real-time 1500
const events = [];
setTimeout(() => {
  events.push('A');
  const end = performance.now() + 400;
  while (performance.now() < end);
  setTimeout(() => events.push('C'), 0);
}, 10);
setTimeout(() => events.push('B'), 210);
setTimeout(() => print(events.join(',')), 700);
