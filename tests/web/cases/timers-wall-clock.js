// Timers fire after their delay has passed on the clock the page reads, not at once.
// Only lower bounds are printed, as booleans, so a loaded host cannot change the output.
// Ported from tests/node-compat/cases/15-timer-wall-clock.js.
const DELAY = 60;
const start = Date.now();
setTimeout(() => {
  print('timeout waited ' + (Date.now() - start >= DELAY - 20));
  let ticks = 0;
  const intervalStart = Date.now();
  const id = setInterval(() => {
    if (++ticks === 2) {
      clearInterval(id);
      print('interval waited ' + (Date.now() - intervalStart >= 2 * 20 - 20));
    }
  }, 20);
}, DELAY);
