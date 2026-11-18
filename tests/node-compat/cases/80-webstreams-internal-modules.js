// node:stream/web is assembled from internal modules laid out like node's
// lib/internal/webstreams: a throw from ReadableStream code carries a
// `node:internal/webstreams/readablestream` frame, one from WritableStream code
// `node:internal/webstreams/writablestream`, and so on. All of them used to say
// `node:stream/web`, because everything was defined in node/stream/web.js.
//
// Only the frame's SOURCE NAME is compared — never the message, line or column (Lava's
// messages are not node's yet; that is a separate gap). Each site below is one node
// itself attributes to that file (probed on node 26.13.0) AND one that throws
// synchronously on both runtimes. The behavior lines after it are there so a move that
// loses a helper or re-wires an identity fails here and not only in a stack.
'use strict';

const web = require('node:stream/web');
const {
  ReadableStream,
  ReadableStreamDefaultReader,
  ReadableStreamBYOBReader,
  ReadableStreamDefaultController,
  WritableStream,
  WritableStreamDefaultWriter,
  WritableStreamDefaultController,
  TransformStream,
  TransformStreamDefaultController,
  ByteLengthQueuingStrategy,
  CountQueuingStrategy,
} = web;

function frame(label, source, f) {
  let stack = null;
  try {
    f();
  } catch (e) {
    stack = String(e && e.stack);
  }
  if (stack === null) return console.log(label + ': NO THROW');
  // The old source name must be gone too: before the split every one of these frames
  // read `node:stream/web:<line>`.
  console.log(
    label + ': ' + source + ' ' + stack.includes(source),
    stack.includes('node:stream/web:'),
  );
}
const R = 'node:internal/webstreams/readablestream';
const W = 'node:internal/webstreams/writablestream';
const T = 'node:internal/webstreams/transformstream';
const Q = 'node:internal/webstreams/queuingstrategies';
const U = 'node:internal/webstreams/util';

frame('ReadableStream type', R, () => new ReadableStream({ type: 'x!' }));
frame('getReader mode', R, () => new ReadableStream().getReader({ mode: 'x!' }));
frame('pipeThrough(5)', R, () => new ReadableStream().pipeThrough(5));
frame('DefaultReader(5)', R, () => new ReadableStreamDefaultReader(5));
frame('DefaultController()', R, () => new ReadableStreamDefaultController());
frame('BYOBReader(5)', R, () => new ReadableStreamBYOBReader(5));
frame('WritableStream type', W, () => new WritableStream({ type: 'x!' }));
frame('DefaultWriter(5)', W, () => new WritableStreamDefaultWriter(5));
frame('WritableController()', W, () => new WritableStreamDefaultController());
frame('TransformStream readableType', T, () => new TransformStream({ readableType: 'x!' }));
frame('TransformController()', T, () => new TransformStreamDefaultController());
frame(
  'enqueue after terminate',
  T,
  () =>
    new TransformStream({
      start(c) {
        c.terminate();
        c.enqueue(1);
      },
    }),
);
frame('ByteLengthQueuingStrategy()', Q, () => new ByteLengthQueuingStrategy());
frame('CountQueuingStrategy()', Q, () => new CountQueuingStrategy());
frame('readable highWaterMark', U, () => new ReadableStream({}, { highWaterMark: -1 }));
frame('writable highWaterMark', U, () => new WritableStream({}, { highWaterMark: -1 }));
frame('transform highWaterMark', U, () => new TransformStream({}, { highWaterMark: -1 }));
frame('size not a function', U, () => new ReadableStream({}, { size: 5 }));

// --- the assembled module: identities and globals ---------------------------------
const again = require('stream/web');
for (const k of [
  'ReadableStream',
  'ReadableStreamDefaultReader',
  'ReadableStreamBYOBReader',
  'ReadableStreamDefaultController',
  'WritableStream',
  'WritableStreamDefaultWriter',
  'WritableStreamDefaultController',
  'TransformStream',
  'TransformStreamDefaultController',
  'ByteLengthQueuingStrategy',
  'CountQueuingStrategy',
]) {
  console.log(
    'export',
    k,
    typeof web[k],
    web[k] === again[k],
    globalThis[k] === web[k],
    web[k].name,
  );
}
const bl = new ByteLengthQueuingStrategy({ highWaterMark: 16 });
const cq = new CountQueuingStrategy({ highWaterMark: 4 });
console.log(
  'strategies',
  bl.highWaterMark,
  bl.size(new Uint8Array(3)),
  cq.highWaterMark,
  cq.size('abc'),
);

// --- behavior across the file seams --------------------------------------------
// Each round trip prints once it settles; they are collected and printed sorted so the
// case does not pin the relative order of independent pipelines.
const OUTCOMES = 6;
const out = [];
const log = (...a) => {
  out.push(a.join(' '));
  if (out.length === OUTCOMES) console.log(out.sort().join('\n'));
};
const from = (chunks) =>
  new ReadableStream({
    start(c) {
      for (const x of chunks) c.enqueue(x);
      c.close();
    },
  });
const collect = (seen) =>
  new WritableStream({
    write(c) {
      seen.push(String(c));
    },
  });

const piped = [];
from(['p', 'i', 'pe'])
  .pipeTo(collect(piped))
  .then(() => log('pipeTo', piped.join('')));

const upper = new TransformStream({
  transform(c, ctl) {
    ctl.enqueue(String(c).toUpperCase());
  },
  flush(ctl) {
    ctl.enqueue('!');
  },
});
const through = [];
from(['t', 's'])
  .pipeThrough(upper)
  .pipeTo(collect(through))
  .then(() => log('pipeThrough', through.join('')));

const [a, b] = from(['t', 'e', 'e']).tee();
Promise.all([a, b].map((s) => s.getReader().read())).then((rs) =>
  log('tee', rs.map((r) => r.value + r.done).join(',')),
);

(async () => {
  const parts = [];
  for await (const c of from(['it', 'er'])) parts.push(c);
  log('async iteration', parts.join(''));
})();

const ac = new AbortController();
ac.abort(new Error('stop'));
from(['x'])
  .pipeTo(collect([]), { signal: ac.signal })
  .then(
    () => log('abort', 'resolved'),
    (e) => log('abort', e.message),
  );

const w = new WritableStream({}, new CountQueuingStrategy({ highWaterMark: 2 }));
const writer = w.getWriter();
const before = writer.desiredSize;
writer.write('a');
log('writer desiredSize', before, writer.desiredSize);
