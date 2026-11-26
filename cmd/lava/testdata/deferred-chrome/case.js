// What a page sees of FinalizationRegistry and WebAssembly.compile/instantiate once the
// engine's RunLoop is driven (#91, #97). Run as-is by record-chrome.py (Chrome, the
// Window profile's oracle) and by cmd/lava/runloop_drive_test.odin (a `.Web` page);
// expected.txt is Chrome's output. Each runtime defines `collect()` before this script:
// a full GC, then a turn for the cleanups it scheduled. The report lands in
// `globalThis.report` as one line per fact.
//
// Engine traits are left out on purpose, not normalised: error messages, the order in
// which one registry's cleanups are delivered, and whether WebAssembly has the
// streaming entry points (Chrome's are the embedder's, given a Response).
(async () => {
  const out = [];
  const desc = (o, k) => {
    const x = Object.getOwnPropertyDescriptor(o, k);
    return x ? [typeof x.value, x.writable, x.enumerable, x.configurable].join('/') : 'none';
  };
  const threw = (f) => {
    try {
      f();
      return 'no throw';
    } catch (e) {
      return e.constructor.name;
    }
  };
  const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);

  out.push('FR ' + typeof FinalizationRegistry + ' ' + FinalizationRegistry.name + ' ' + FinalizationRegistry.length);
  out.push('FR global ' + desc(globalThis, 'FinalizationRegistry'));
  out.push('FR proto.constructor ' + (FinalizationRegistry.prototype.constructor === FinalizationRegistry));
  out.push('FR proto.constructor desc ' + desc(FinalizationRegistry.prototype, 'constructor'));
  const fr = new FinalizationRegistry(() => {});
  out.push(
    'FR instance ' +
      (fr instanceof FinalizationRegistry) +
      ' ' +
      (Object.getPrototypeOf(fr) === FinalizationRegistry.prototype) +
      ' ' +
      Object.prototype.toString.call(fr),
  );
  class Sub extends FinalizationRegistry {}
  const sub = new Sub(() => {});
  out.push(
    'FR subclass ' +
      (sub instanceof Sub) +
      ' ' +
      (sub instanceof FinalizationRegistry) +
      ' ' +
      (Object.getPrototypeOf(sub) === Sub.prototype),
  );
  out.push('FR non-callable ' + threw(() => new FinalizationRegistry(1)));
  out.push('FR no new ' + threw(() => FinalizationRegistry(() => {})));
  out.push('FR no args ' + threw(() => new FinalizationRegistry()));
  out.push('FR register ' + fr.register({}, 1) + ' unregister ' + fr.unregister({}));

  for (const k of ['compile', 'instantiate', 'validate']) {
    const f = WebAssembly[k];
    out.push('wasm ' + k + ' ' + typeof f + ' ' + f.name + ' ' + f.length + ' ' + desc(WebAssembly, k));
  }
  const pending = WebAssembly.compile(bytes);
  out.push('wasm compile returns ' + (pending instanceof Promise) + ' ' + (Object.getPrototypeOf(pending) === Promise.prototype));
  out.push('wasm compile -> ' + ((await pending) instanceof WebAssembly.Module));
  const both = await WebAssembly.instantiate(bytes);
  out.push(
    'wasm instantiate(bytes) -> ' +
      Object.keys(both).join(',') +
      ' ' +
      (both.module instanceof WebAssembly.Module) +
      ' ' +
      (both.instance instanceof WebAssembly.Instance),
  );
  out.push('wasm instantiate(module) -> ' + ((await WebAssembly.instantiate(both.module)) instanceof WebAssembly.Instance));
  try {
    await WebAssembly.compile(new Uint8Array([1, 2, 3]));
    out.push('wasm bad bytes resolved');
  } catch (e) {
    out.push('wasm bad bytes -> ' + e.constructor.name + ' ' + (e instanceof WebAssembly.CompileError));
  }
  try {
    await WebAssembly.compile(5);
    out.push('wasm non-buffer resolved');
  } catch (e) {
    out.push('wasm non-buffer -> ' + e.constructor.name);
  }

  // Cleanups: each gets its held value as its only argument and `this` undefined, every
  // dead target gets one, and one registry's cleanups run as one task — the microtasks
  // they queue run after the last of them.
  const log = [];
  const calls = [];
  const reg = new FinalizationRegistry(function (held) {
    'use strict';
    calls.push(arguments.length + ':' + (this === undefined));
    log.push('c' + held);
    Promise.resolve().then(() => log.push('m' + held));
  });
  (function () {
    for (let i = 0; i < 3; i++) reg.register({}, i);
  })();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await collect();
  const cleaned = log.filter((x) => x[0] === 'c');
  out.push('cleanups ' + cleaned.slice().sort().join(','));
  out.push('cleanup calls ' + calls.join(' '));
  out.push('cleanups before their microtasks ' + (log.length === 6 && log.slice(0, 3).every((x) => x[0] === 'c')));

  globalThis.report = out.join('\n');
})().catch((e) => {
  globalThis.report = 'case threw: ' + e;
});
