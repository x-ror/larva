// Where an interval re-arms from when a slow timer ahead of it, and its own slow
// callback, delay it. A and the interval both fall due at +300, A first; A spins
// 200 ms. The interval's first callback schedules sentinels at +200 and +400 from
// itself, spins 200 ms, and its second fire lands somewhere among them.
// Ported from tests/runtime/eventloop/cases/13-interval-rearms-from-callback-start.js.
// The spins read the clock inside a timer callback, which Chrome's virtual time
// freezes; recorded in real time:
// web-oracle: real-time 2500
const events = [];
const spin = (ms) => {
  const end = performance.now() + ms;
  while (performance.now() < end);
};
setTimeout(() => {
  events.push('A');
  spin(200);
}, 300);
let fires = 0;
const interval = setInterval(() => {
  fires++;
  events.push('interval' + fires);
  if (fires === 1) {
    setTimeout(() => events.push('early'), 200);
    setTimeout(() => events.push('late'), 400);
    spin(200);
    setTimeout(() => {}, 0);
  } else {
    clearInterval(interval);
  }
}, 300);
setTimeout(() => print(events.join(',')), 1400);
