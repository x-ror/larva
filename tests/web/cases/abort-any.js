// AbortSignal.any: the combined signal follows the first source to abort, takes its
// reason, starts aborted for a pre-aborted source, and validates its argument.
// Ported from tests/node-compat/cases/24-internals-parity.js (its fileURLToPath and
// node:timers/promises parts are Node-only).
const ac1 = new AbortController();
const ac2 = new AbortController();
const combined = AbortSignal.any([ac1.signal, ac2.signal]);
let events = 0;
combined.addEventListener('abort', () => events++);
print('combined before ' + combined.aborted);
ac1.abort('first');
print('combined after ' + combined.aborted + ' reason ' + combined.reason + ' events ' + events);
ac2.abort('second');
print('second abort keeps ' + combined.reason + ' events ' + events);

const pre = AbortSignal.any([new AbortController().signal, AbortSignal.abort('pre')]);
print('pre-aborted ' + pre.aborted + ' ' + pre.reason);
print('empty ' + AbortSignal.any([]).aborted);

for (const bad of [null, 42, [{}]]) {
  try {
    AbortSignal.any(bad);
    print('any(' + JSON.stringify(bad) + ') did not throw');
  } catch (e) {
    print('any(' + JSON.stringify(bad) + ') threw ' + e.constructor.name);
  }
}
