const assert = require('node:assert/strict');

// Node drains the ENTIRE process.nextTick queue before any promise job, even a
// nextTick queued *after* the promise (absolute nextTick priority).
//
// KNOWN LAVA GAP (see issue #16 and js/bootstrap/microtasks.js): Lava layers
// nextTick on JSC's promise-microtask queue, which it cannot reorder ahead of a
// promise job already enqueued earlier in the turn — so Lava reports
// ['promise', 'nextTick'] here. This case is listed in known-lava-gaps.txt so it
// is skipped under `make test-lava` but still validated against Node; remove the
// skip once the ordering can be matched.
(async () => {
  const events = [];

  Promise.resolve().then(() => events.push('promise'));
  process.nextTick(() => events.push('nextTick'));

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(events, ['nextTick', 'promise']);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
