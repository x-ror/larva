// EventTarget dispatch: every DOM event, AbortSignal and fetch progress path goes
// through it. `event-dispatch` has one listener and `event-dispatch-3` three, which
// separates the per-dispatch cost (Event construction, path setup) from the
// per-listener one.

let count = 0;
const one = new EventTarget();
one.addEventListener('ping', () => {
  count++;
});
const three = new EventTarget();
for (let i = 0; i < 3; i++) {
  three.addEventListener('ping', () => {
    count++;
  });
}

bench('event-dispatch', () => one.dispatchEvent(new Event('ping')) && count, {
  iterations: 50000,
});
bench('event-dispatch-3', () => three.dispatchEvent(new Event('ping')) && count, {
  iterations: 50000,
});
bench(
  'abort-controller',
  () => {
    const c = new AbortController();
    c.abort();
    return c.signal.aborted;
  },
  { iterations: 5000 },
);
