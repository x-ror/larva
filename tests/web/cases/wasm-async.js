// WebAssembly.compile / instantiate on a page (#97): what the functions look like, that
// the promise settles in a later task, what it settles with, when an instantiate's start
// function runs, and the error kinds a rejection carries. The messages are
// wasm-errors.js's; nothing here depends on a full collection.
const EMPTY = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
// (module (import "m" "f" (func)) (start 0))
const START = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 0x60, 0, 0, 2, 7, 1, 1, 0x6d, 1, 0x66, 0, 0, 8, 1, 0,
]);

function nativeSource(f, name) {
  return new RegExp('^function ' + name + '\\(\\) \\{\\s*\\[native code\\]\\s*\\}$').test(
    Function.prototype.toString.call(f),
  );
}
function desc(o, k) {
  const d = Object.getOwnPropertyDescriptor(o, k);
  return [typeof d.value, d.writable, d.enumerable, d.configurable].join('/');
}
function clean(e) {
  const s = String(e && e.stack);
  return !/internal\/|ReflectApply|ProxyObject|apply@|construct@/.test(s + String(e && e.message));
}

for (const k of ['compile', 'instantiate']) {
  const f = WebAssembly[k];
  print(k + ' ' + typeof f + ' ' + f.name + ' ' + f.length + ' ' + desc(WebAssembly, k));
  print(k + ' native source ' + nativeSource(f, k));
  print(k + ' own keys ' + Object.getOwnPropertyNames(f).join(','));
  let threw = 'no throw';
  try {
    new f(EMPTY);
  } catch (e) {
    threw = e.constructor.name;
  }
  print(k + ' with new ' + threw);
}

(async () => {
  let settled = false;
  const p = WebAssembly.compile(EMPTY);
  print('returns a Promise ' + (Object.getPrototypeOf(p) === Promise.prototype));
  p.then(() => {
    settled = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  print('settled within the calling task ' + settled);
  const m = await p;
  print('compile -> Module ' + (m instanceof WebAssembly.Module));

  const both = await WebAssembly.instantiate(EMPTY);
  print(
    'instantiate(bytes) -> ' +
      Object.keys(both).join(',') +
      ' ' +
      (both.module instanceof WebAssembly.Module) +
      ' ' +
      (both.instance instanceof WebAssembly.Instance) +
      ' ' +
      (Object.getPrototypeOf(both) === Object.prototype),
  );
  print(
    'instantiate(module) -> Instance ' +
      ((await WebAssembly.instantiate(m)) instanceof WebAssembly.Instance),
  );

  const order = [];
  const started = WebAssembly.instantiate(START, {
    m: {
      f() {
        order.push('start');
      },
    },
  }).then(() => order.push('resolved'));
  order.push('returned');
  await started;
  print('start function order ' + order.join(','));

  const cases = [
    ['compile()', () => WebAssembly.compile()],
    ['compile(5)', () => WebAssembly.compile(5)],
    ['compile(bad bytes)', () => WebAssembly.compile(new Uint8Array([1, 2, 3]))],
    ['instantiate(5)', () => WebAssembly.instantiate(5)],
    ['instantiate(bytes, 5)', () => WebAssembly.instantiate(EMPTY, 5)],
    ['instantiate(start, {})', () => WebAssembly.instantiate(START, {})],
    ['instantiate(start, {m: {}})', () => WebAssembly.instantiate(START, { m: {} })],
  ];
  for (const [label, run] of cases) {
    let r;
    try {
      r = run();
    } catch (e) {
      print(label + ' threw synchronously ' + e.constructor.name);
      continue;
    }
    try {
      await r;
      print(label + ' resolved');
    } catch (e) {
      print(label + ' rejected ' + e.constructor.name + ' clean ' + clean(e));
    }
  }

  // A page that poisons Object.prototype.then still ends: nothing is held for it.
  Object.prototype.then = function () {};
  WebAssembly.compile(EMPTY);
  print('end');
})();
