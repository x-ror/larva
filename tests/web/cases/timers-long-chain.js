// The loop keeps turning past any fixed iteration ceiling: a chain of 1100 timers,
// each created by the last, runs to the end. Ported from
// tests/node-compat/cases/21-long-running-loop.js, whose setImmediate chain is a
// timer chain here (Chrome clamps nested timers to 4 ms, so it stays at 1100 turns).
const N = 1100;
let count = 0;
function tick() {
  count++;
  if (count < N) setTimeout(tick, 0);
  else print('done ' + count);
}
setTimeout(tick, 0);
