// A handler that is not a function is converted to a string and run as a classic script
// when the timer fires, in the global scope; the delay is still converted at the call.
// The string is converted before the delay.
const log = [];
globalThis.ran = [];
setTimeout('ran.push("timeout " + typeof log)', 0);
const id = setInterval('ran.push("interval"); if (ran.length === 3) clearInterval(intervalId)', 0);
globalThis.intervalId = id;
setTimeout(
  { toString: () => (log.push('handler'), 'ran.push("object")') },
  { valueOf: () => (log.push('delay'), 1) },
);
setTimeout(() => {
  print(log.join(','));
  print(ran.join(','));
}, 50);
