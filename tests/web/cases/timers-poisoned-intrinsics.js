// The scheduler keeps working after a page replaces common intrinsics: queueMicrotask
// and setTimeout must not depend on the live Array/Promise prototype methods.
// Ported from tests/runtime/eventloop/cases/11-scheduler-hardening.js (its
// process.nextTick half has no page counterpart).
// The poison is lifted inside the last callback, before printing: the scheduler runs
// every callback under it, and print's own path is not what this case is about
// (robust-console-poisoned.js is).
let hits = 0;
const saved = [];
const poison = (owner, key) => {
  saved[saved.length] = [owner, key, owner[key]];
  owner[key] = function () {
    throw new Error(key + ' poisoned');
  };
};
poison(Array.prototype, 'push');
poison(Array.prototype, 'shift');
poison(Array.prototype, 'slice');
poison(Promise, 'resolve');
poison(Promise.prototype, 'then');

queueMicrotask(() => {
  hits += 10;
});
setTimeout(
  (a, b) => {
    if (a + b === 'xy') hits += 1;
    for (let i = 0; i < saved.length; i++) saved[i][0][saved[i][1]] = saved[i][2];
    print('hits ' + hits);
  },
  0,
  'x',
  'y',
);
