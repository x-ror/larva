// The HTML timer nesting clamp, read by order rather than by clock: a timer created by a
// timer task nested more than 5 deep waits at least 4 ms. Each level of a chain of 0 ms
// timers creates a 4 ms timer and then a 0 ms one. Unclamped, the 0 ms one fires first;
// clamped, both wait 4 ms and fire in creation order. The chain starts in a timer, so
// level n runs at nesting level n: levels 1-5 print zero,four and levels 6-8 four,zero.
// Level 7 also creates a 3 ms timer last, clamped too, so it fires after both.
const rows = [];
let finished = 0;
function level(n) {
  const ev = [];
  const done = () => {
    if (ev.length < (n === 7 ? 3 : 2)) return;
    rows[n] = n + ' ' + ev.join(',');
    if (++finished === 8) print(rows.slice(1).join('\n'));
  };
  setTimeout(() => {
    ev.push('four');
    done();
  }, 4);
  setTimeout(() => {
    ev.push('zero');
    done();
    if (n < 8) level(n + 1);
  }, 0);
  if (n === 7) {
    setTimeout(() => {
      ev.push('three');
      done();
    }, 3);
  }
}
setTimeout(() => level(1), 0);
