// The Performance API: a monotonic now() and a timeOrigin that, added to now(),
// tracks Date.now(). Relationships only, so no timing value is printed.
// Ported from tests/node-compat/cases/19-performance.js.
print(
  'types ' +
    typeof performance +
    ' ' +
    typeof performance.now +
    ' ' +
    typeof performance.timeOrigin,
);
const a = performance.now();
let s = 0;
for (let i = 0; i < 1e6; i++) s += i;
const b = performance.now();
print('monotonic ' + (b >= a) + ' number ' + typeof a);
print('timeOrigin positive ' + (performance.timeOrigin > 0));
print(
  'tracks Date.now ' + (Math.abs(performance.timeOrigin + performance.now() - Date.now()) < 5000),
);
print('tag ' + Object.prototype.toString.call(performance));
print('toJSON timeOrigin ' + (performance.toJSON().timeOrigin === performance.timeOrigin));
