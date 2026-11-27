// Micro-benchmark harness for `lava run`, Window globals only.
//
// Not a module: since the Node profile went (#130) a page has no `require`, so
// bench/run.mjs PREPENDS this file to each bench/micro/*.js and runs the
// concatenation as one classic script. It defines two script-scope bindings,
// `bench` and `benchAsync`, and nothing else the bench files rely on.
//
// bench(name, fn, opts) / benchAsync(name, fn, opts) only REGISTER a benchmark. The
// registered list runs from one timer task after the bench file's top level has
// finished, in declaration order, so an async benchmark (Blob#text, which settles
// on the event loop) and a sync one share the same runner and never overlap.
//
// Each benchmark warms up, then times `iterations` calls of fn over `reps`
// repetitions and reports the BEST (minimum) repetition: best-of-K drops GC and
// scheduler spikes inside one process. Launch-to-launch variance is bench/run.mjs's
// job (median over launches). benchAsync awaits every call, so its number includes
// one promise-resolution turn per iteration on both binaries alike.
//
// Output is one "##BENCH## {json}" line per benchmark, then "##BENCH-DONE##".
// bench/run.mjs refuses a run without the DONE line, so a bench that throws midway
// cannot be read as a short, fast run. fn's last result escapes to a script-scope
// sink each rep, so a pure loop cannot be dead-code eliminated.

var bench, benchAsync, __benchSink;

(() => {
  const queue = [];
  const register = (isAsync) => (name, fn, opts) => {
    queue.push({ name, fn, isAsync, opts: opts || {} });
  };
  bench = register(false);
  benchAsync = register(true);

  const report = (name, iterations, reps, best) => {
    const result = {
      name,
      iterations,
      reps,
      ms: Number(best.toFixed(4)),
      nsPerOp: Number(((best * 1e6) / iterations).toFixed(2)),
    };
    console.log('##BENCH## ' + JSON.stringify(result));
  };

  const runSync = ({ name, fn, opts }) => {
    const iterations = opts.iterations ?? 100000;
    const warmup = opts.warmup ?? Math.min(iterations, 1000);
    const reps = opts.reps ?? 5;
    for (let i = 0; i < warmup; i++) fn(i);
    let best = Infinity;
    for (let r = 0; r < reps; r++) {
      let last;
      const t0 = performance.now();
      for (let i = 0; i < iterations; i++) last = fn(i);
      const dt = performance.now() - t0;
      __benchSink = last;
      if (dt < best) best = dt;
    }
    report(name, iterations, reps, best);
  };

  const runAsync = async ({ name, fn, opts }) => {
    const iterations = opts.iterations ?? 10000;
    const warmup = opts.warmup ?? Math.min(iterations, 1000);
    const reps = opts.reps ?? 5;
    for (let i = 0; i < warmup; i++) await fn(i);
    let best = Infinity;
    for (let r = 0; r < reps; r++) {
      let last;
      const t0 = performance.now();
      for (let i = 0; i < iterations; i++) last = await fn(i);
      const dt = performance.now() - t0;
      __benchSink = last;
      if (dt < best) best = dt;
    }
    report(name, iterations, reps, best);
  };

  setTimeout(async () => {
    for (const b of queue) {
      if (b.isAsync) await runAsync(b);
      else runSync(b);
    }
    console.log('##BENCH-DONE##');
  }, 0);
})();
