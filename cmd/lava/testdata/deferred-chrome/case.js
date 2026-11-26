// What a page sees of FinalizationRegistry cleanups once the engine's RunLoop is driven
// (#91). Run as-is by record-chrome.py (Chrome, the Window profile's oracle) and by
// cmd/lava/runloop_drive_test.odin (a `.Web` page); expected.txt is Chrome's output.
// Each runtime defines `collect()` before this script: a full GC, then a turn for the
// cleanups it scheduled. The report lands in `globalThis.report` as one line per fact.
//
// Why here and not in tests/web: a page cannot ask for a full collection, Chrome only
// gives one under --js-flags=--expose-gc, and Lava's harness has to run it between
// ticks (vm_collect). The constructor's shape, which needs no collection, is
// tests/web/cases/finalization-shape.js.
//
// Engine traits are left out on purpose, not normalised: the order in which one
// registry's cleanups are delivered, and which of two registries goes first.
(async () => {
  const out = [];

  // Each cleanup gets its held value as its only argument and `this` undefined, every
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

  // Two more registries: each is its own task, so each one's microtasks run before the
  // other's cleanups (HTML queues a cleanup task per registry; AAmmBBmm or BBmmAAmm).
  const seq = [];
  const each = (name) =>
    new FinalizationRegistry(() => {
      seq.push(name);
      Promise.resolve().then(() => seq.push('m'));
    });
  const regA = each('A');
  const regB = each('B');
  (function () {
    for (let i = 0; i < 2; i++) {
      regA.register({}, i);
      regB.register({}, i);
    }
  })();

  await new Promise((resolve) => setTimeout(resolve, 0));
  await collect();
  const cleaned = log.filter((x) => x[0] === 'c');
  out.push('cleanups ' + cleaned.slice().sort().join(','));
  out.push('cleanup calls ' + calls.join(' '));
  out.push('cleanups before their microtasks ' + (log.length === 6 && log.slice(0, 3).every((x) => x[0] === 'c')));
  out.push('two registries, one task each ' + /^(A+m+B+m+|B+m+A+m+)$/.test(seq.join('')));

  globalThis.report = out.join('\n');
})().catch((e) => {
  globalThis.report = 'case threw: ' + e;
});
