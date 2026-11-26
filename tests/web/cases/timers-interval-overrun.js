// An interval whose callback overruns several periods fires once more at once, then
// returns to its schedule grid: before each callback it re-arms for the first multiple
// of its period, counted from the scheduled time, that is still ahead of the clock. A
// 200 ms interval's first fire (200) spins 700 ms: it fires again at 900 (the missed
// 400 beat, once), skips 600 and 800, and fires at 1000, between sentinels at 950 and
// 1050: I1,I2,S0,I3,S1. Re-arming from the clock before the callback (node) puts I3
// after S1, from the clock after it puts I2 after S1, and catching up every missed
// beat puts I3 before S0.
// The spin reads the clock inside a timer callback, which Chrome's virtual time
// freezes; recorded in real time:
// web-oracle: real-time 2000
const ev = [];
let fires = 0;
const id = setInterval(() => {
  ev.push('I' + ++fires);
  if (fires === 1) {
    const end = performance.now() + 700;
    while (performance.now() < end);
  }
  if (fires === 3) clearInterval(id);
}, 200);
setTimeout(() => ev.push('S0'), 950);
setTimeout(() => ev.push('S1'), 1050);
setTimeout(() => print(ev.join(',')), 1400);
