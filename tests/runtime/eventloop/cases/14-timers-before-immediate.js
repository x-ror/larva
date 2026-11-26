const assert = require('node:assert/strict');

// Every timer due in a turn runs before that turn's immediates, including an immediate
// queued by the first of them: node runs the whole timers phase, then check. t1 and t2
// fall due in one turn; t1 queues a microtask, an immediate and a 0 ms timer. The
// microtask runs right after t1, the immediate after t2, and the 0 ms timer next turn.
//
// The page runner may suspend a turn between two due timers once its CPU quantum is
// spent (#35); a slice that fell through to check instead printed t1,micro,imm,t2.
// A single `lava run` never slices, so cmd/lava/page_runner_slice_test.odin runs this
// case as a runner page with a quantum small enough to yield after t1.
//
// The outer timer spins 8 ms, so both 5 ms timers are already due when its turn ends.
(async () => {
  const events = [];

  setTimeout(() => {
    setTimeout(() => {
      events.push('t1');
      setImmediate(() => events.push('imm'));
      setTimeout(() => events.push('t0'), 0);
      Promise.resolve().then(() => events.push('micro'));
    }, 5);
    setTimeout(() => events.push('t2'), 5);

    const end = performance.now() + 8;

    while (performance.now() < end);
  }, 1);

  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.deepEqual(events, ['t1', 'micro', 't2', 'imm', 't0']);
  console.log(events.join(','));
})();
