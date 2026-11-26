// The TypeErrors AbortSignal and AbortController throw for misuse, with Chrome's
// WebIDL text and no `code`: constructing an AbortSignal, calling AbortController
// without `new`, and AbortSignal.any() over a non-iterable. Also throwIfAborted, which
// throws the default reason itself (abort-reason-shape.js pins its shape).
function show(label, f) {
  try {
    f();
    print(label + ': no throw');
  } catch (e) {
    print(
      label +
        ': ' +
        e.constructor.name +
        ' ' +
        e.name +
        ' ' +
        JSON.stringify(e.message) +
        ' own code ' +
        Object.prototype.hasOwnProperty.call(e, 'code'),
    );
  }
}
show('new AbortSignal()', () => new AbortSignal());
show('AbortController()', () => AbortController());
show('AbortSignal.any(1)', () => AbortSignal.any(1));
show('AbortSignal.any({})', () => AbortSignal.any({}));
const c = new AbortController();
c.abort();
show('throwIfAborted', () => c.signal.throwIfAborted());
show('throwIfAborted custom', () => AbortSignal.abort('why').throwIfAborted());
