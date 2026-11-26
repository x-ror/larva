// AbortController/AbortSignal behavior: aborted, reason, the abort event,
// throwIfAborted, a custom reason, AbortSignal.abort() and AbortSignal.timeout().
// Ported from tests/node-compat/cases/10-abort-timers.js; node:timers/promises has no
// page counterpart, so the abortable delay is built from setTimeout and the signal.
function delay(ms, value, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(signal.reason);
    const t = setTimeout(() => resolve(value), ms);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        reject(signal.reason);
      });
    }
  });
}
// Only the reason's name here; its DOMException shape is abort-reason-shape.js.
const describe = (e) => String(e && e.name);

async function main() {
  print('types ' + typeof AbortController + ' ' + typeof AbortSignal);
  print('delay ' + (await delay(5, 'done')));

  const controller = new AbortController();
  const pending = delay(50, 'x', controller.signal);
  controller.abort();
  await pending.then(
    () => print('aborted delay resolved'),
    (e) => print('aborted delay rejected ' + describe(e)),
  );

  await delay(5, 'y', AbortSignal.abort()).then(
    () => print('pre-aborted resolved'),
    (e) => print('pre-aborted rejected ' + describe(e)),
  );

  const timeout = AbortSignal.timeout(5);
  print('timeout aborted at first ' + timeout.aborted);
  await delay(1000, 'z', timeout).then(
    () => print('timeout resolved'),
    (e) => print('timeout rejected ' + describe(e)),
  );

  const c2 = new AbortController();
  print('aborted before ' + c2.signal.aborted + ' reason ' + c2.signal.reason);
  let fired = 0;
  let eventType = '';
  c2.signal.addEventListener('abort', (ev) => {
    fired += 1;
    eventType = ev.type + ' ' + (ev.target === c2.signal);
  });
  c2.signal.onabort = () => (fired += 100);
  c2.abort();
  c2.abort();
  print('aborted after ' + c2.signal.aborted + ' fired ' + fired + ' event ' + eventType);
  print('reason ' + describe(c2.signal.reason));
  try {
    c2.signal.throwIfAborted();
    print('throwIfAborted did not throw');
  } catch (e) {
    print('throwIfAborted threw the reason ' + (e === c2.signal.reason));
  }
  new AbortController().signal.throwIfAborted();
  print('throwIfAborted on a live signal returns');

  const c3 = new AbortController();
  const custom = new TypeError('custom');
  c3.abort(custom);
  print('custom reason kept ' + (c3.signal.reason === custom) + ' ' + c3.signal.reason.message);
  print('AbortSignal.abort(reason) ' + AbortSignal.abort(7).reason);
  print('signal is EventTarget ' + (c3.signal instanceof EventTarget));
  print('tag ' + Object.prototype.toString.call(c3.signal));
}

main().catch((e) => print('FAILED ' + e));
