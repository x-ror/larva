// A timer found due between two tasks is queued right there: behind what is already
// queued, ahead of what the next task queues. T (10 ms) falls due while X spins 100 ms;
// X queues Z (0 ms), the loop then finds T due, and Y queues W: X,Y,Z,T,W. Looking for
// due timers once per turn would put T behind W, ordering by deadline ahead of Z.
// The spin reads the clock inside a timer callback, which Chrome's virtual time
// freezes; recorded in real time:
// web-oracle: real-time 1000
const ev = [];
setTimeout(() => ev.push('T'), 10);
setTimeout(() => {
  ev.push('X');
  const end = performance.now() + 100;
  while (performance.now() < end);
  setTimeout(() => ev.push('Z'), 0);
}, 0);
setTimeout(() => {
  ev.push('Y');
  setTimeout(() => ev.push('W'), 0);
}, 0);
setTimeout(() => print(ev.join(',')), 300);
