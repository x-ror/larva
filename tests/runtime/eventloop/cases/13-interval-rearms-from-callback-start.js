const assert = require('node:assert/strict');

// An interval re-arms from a fresh clock read taken just BEFORE its callback runs:
// node's listOnTimeout does `start = getLibuvNow()` ahead of `_onTimeout()` and
// re-inserts the interval with that start. So neither a slow timer ahead of it in the
// same turn (the turn's `now` would fire it early) nor its own slow callback (the clock
// after the callback would fire it late) moves its next fire.
//
// A and the interval both fall due at +300, A first. A spins 200 ms, so the interval's
// first fire starts at ~500 and its next is due at ~800. That first callback schedules
// a sentinel 100 ms either side of 800, spins 200 ms itself and schedules one more timer.
// Re-arming from the turn's `now` would put the interval at ~600, ahead of `early`;
// re-arming from the clock after the callback, at ~1000, behind `late`. Every gap is 100 ms and only the due
// times decide the order, so a loop that wakes late still prints the same sequence.
(async () => {
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
    events.push(`interval${fires}`);

    if (fires === 1) {
      setTimeout(() => events.push('early'), 200);
      setTimeout(() => events.push('late'), 400);
      spin(200);
      // A timer created here takes its delay from the fresh clock (node's insert()
      // calls getLibuvNow), the call that used to drag the interval's re-arm along.
      setTimeout(() => {}, 0);
    } else {
      clearInterval(interval);
    }
  }, 300);

  await new Promise((resolve) => setTimeout(resolve, 1400));

  assert.deepEqual(events, ['A', 'interval1', 'early', 'interval2', 'late']);
  console.log(events.join(','));
})();
