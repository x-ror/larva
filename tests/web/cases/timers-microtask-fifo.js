// queueMicrotask and promise jobs share one FIFO queue, at a fresh macrotask boundary.
// Ported from tests/runtime/eventloop/cases/09-nexttick-microtask-interleave.js; its
// process.nextTick scenarios have no page counterpart and are not ported.
setTimeout(() => {
  const ev = [];
  queueMicrotask(() => ev.push('qm1'));
  Promise.resolve().then(() => ev.push('p1'));
  queueMicrotask(() => ev.push('qm2'));
  Promise.resolve().then(() => ev.push('p2'));
  setTimeout(() => print(ev.join(',')), 0);
}, 0);
