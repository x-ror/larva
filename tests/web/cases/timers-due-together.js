// Two timers that fall due in the same turn, the first of which queues a microtask
// and a 0 ms timer: the microtask runs right after the first, and where the 0 ms timer
// lands relative to the second is the browser's timer ordering. The outer timer spins
// 8 ms, so both 5 ms timers are already due when its turn ends.
// Ported from tests/runtime/eventloop/cases/14-timers-before-immediate.js, whose
// setImmediate has no page counterpart.
// The spin reads the clock inside a timer callback, which Chrome's virtual time
// freezes; recorded in real time:
// web-oracle: real-time 1000
const events = [];
setTimeout(() => {
  setTimeout(() => {
    events.push('t1');
    setTimeout(() => events.push('t0'), 0);
    Promise.resolve().then(() => events.push('micro'));
  }, 5);
  setTimeout(() => events.push('t2'), 5);
  const end = performance.now() + 8;
  while (performance.now() < end);
}, 1);
setTimeout(() => print(events.join(',')), 50);
