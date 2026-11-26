// What an error the platform throws to a page carries besides its message: its own
// property names (sorted — their order is an engine trait) and whether its stack
// names anything but the page. Chrome's stacks hold the page's frames only; Lava's
// throwers are JS, and their frames must not reach the page (internal/web_errors
// pageError). The frame FORMAT differs by engine and is not printed.
function show(label, f) {
  try {
    f();
    print(label + ': no throw');
  } catch (e) {
    report(label, e);
  }
}
function report(label, e) {
  const stack = e.stack;
  print(
    label +
      ': ' +
      e.constructor.name +
      ' own [' +
      Reflect.ownKeys(e).map(String).sort().join(',') +
      '] stack ' +
      typeof stack +
      ' internal ' +
      (typeof stack === 'string' && /internal|web_errors|domexception|primordials/.test(stack)),
  );
}
show('atob', () => atob('*'));
show('btoa', () => btoa('Ā'));
show('atob()', () => atob());
show('getRandomValues Float32Array', () => crypto.getRandomValues(new Float32Array(1)));
show('getRandomValues 70000', () => crypto.getRandomValues(new Uint8Array(70000)));
show('getRandomValues []', () => crypto.getRandomValues([]));
show('getRandomValues receiver', () => crypto.getRandomValues.call({}, new Uint8Array(1)));
show('throwIfAborted', () => AbortSignal.abort().throwIfAborted());
show('AbortSignal.any(1)', () => AbortSignal.any(1));
show('new AbortSignal()', () => new AbortSignal());
show('DOMException(Symbol)', () => new DOMException(Symbol('s')));
show('DOMException getter', () =>
  Object.getOwnPropertyDescriptor(DOMException.prototype, 'name').get.call({}),
);
show('QuotaExceededError options', () => new QuotaExceededError('m', 5));
report('abort reason', AbortSignal.abort().reason);
const t = AbortSignal.timeout(1);
t.addEventListener('abort', () => report('timeout reason', t.reason));
