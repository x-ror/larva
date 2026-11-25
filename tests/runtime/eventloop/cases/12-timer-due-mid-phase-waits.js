const assert = require('node:assert/strict');

// A timer that falls due while the timers phase is running waits for the next turn,
// behind the immediates this turn queued: node's processTimers compares every deadline
// against the `now` it was entered with, not the clock after a slow callback.
//
// A is due at +10 and B at +210, so B is still 200 ms in the future when A's turn
// begins, unless the loop wakes 200 ms late. A then spins 400 ms, which puts the clock
// 200 ms past B's deadline before it queues the immediate. The margins are that wide
// so the order holds on a loaded CI box; a timer-heavy page is what this guards.
(async () => {
  const events = [];

  setTimeout(() => {
    events.push('A');
    const end = performance.now() + 400;

    while (performance.now() < end);

    // A timer created here takes its delay from the fresh clock (node's insert()
    // calls getLibuvNow), which is the call that used to drag the phase's clock along.
    setTimeout(() => {}, 0);
    setImmediate(() => events.push('imm'));
  }, 10);

  setTimeout(() => events.push('B'), 210);

  await new Promise((resolve) => setTimeout(resolve, 700));

  assert.deepEqual(events, ['A', 'imm', 'B']);
})();
