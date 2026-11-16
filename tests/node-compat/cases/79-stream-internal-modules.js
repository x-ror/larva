// node:stream is assembled from internal modules laid out like node's
// lib/internal/streams (plus internal/webstreams/adapters for the Web Streams bridges):
// an error thrown from inside Readable code carries a `node:internal/streams/readable`
// frame, one from Writable code `node:internal/streams/writable`, and so on. All of
// them used to say `node:stream`, because everything was defined in node/stream.js.
//
// Only the frame's SOURCE NAME is compared — never the message, line or column. Each
// site below is one node itself attributes to that file (probed on node 26.13.0). The
// behavior lines after it are there so a move that loses a helper, breaks a prototype
// chain or re-wires an identity fails here and not only in a stack.
'use strict';

const stream = require('node:stream');
const { Stream, Readable, Writable, Duplex, Transform, PassThrough, finished, pipeline } = stream;

function frame(label, source, f) {
  let stack = null;
  try {
    const r = f();
    if (typeof r === 'string') stack = r;
  } catch (e) {
    stack = String(e && e.stack);
  }
  if (stack === null) return console.log(label + ': NO THROW');
  // The old source name must be gone too: before the split every one of these frames
  // read `node:stream:<line>`.
  console.log(label + ': ' + source + ' ' + stack.includes(source), stack.includes('node:stream:'));
}
const sink = () =>
  new Writable({
    write(c, e, cb) {
      cb();
    },
  });

frame('write(null)', 'node:internal/streams/writable', () => sink().write(null));
frame('setDefaultEncoding', 'node:internal/streams/writable', () =>
  sink().setDefaultEncoding('x!'),
);
frame('Readable#_read', 'node:internal/streams/readable', () => new Readable()._read());
frame(
  'Readable encoding',
  'node:internal/streams/readable',
  () => new Readable({ encoding: 'x!' }),
);
frame('Duplex encoding', 'node:internal/streams/duplex', () => new Duplex({ encoding: 'x!' }));
frame('Transform#_transform', 'node:internal/streams/transform', () =>
  new Transform()._transform(),
);
frame(
  'PassThrough encoding',
  'node:internal/streams/passthrough',
  () => new PassThrough({ encoding: 'x!' }),
);
frame('Stream without this', 'node:internal/streams/legacy', () => Stream.call(undefined));
for (const C of [Readable, Writable]) {
  frame(C.name + ' _destroy', 'node:internal/streams/destroy', () => {
    let st = null;
    new C({
      destroy(err, cb) {
        st = new Error('probe').stack;
        cb(err);
      },
    }).destroy();
    return st;
  });
}
frame('finished(5)', 'node:internal/streams/end-of-stream', () => finished(5, () => {}));
frame('pipeline no cb', 'node:internal/streams/pipeline', () =>
  pipeline(new PassThrough(), sink()),
);
frame('pipeline 1 stream', 'node:internal/streams/pipeline', () =>
  pipeline(new PassThrough(), () => {}),
);
frame('Readable.fromWeb(5)', 'node:internal/webstreams/adapters', () => Readable.fromWeb(5));
frame('Readable.fromWeb(5) wrapper', 'node:internal/streams/readable', () => Readable.fromWeb(5));
frame('Writable.fromWeb(5)', 'node:internal/webstreams/adapters', () => Writable.fromWeb(5));
frame('Writable.fromWeb(5) wrapper', 'node:internal/streams/writable', () => Writable.fromWeb(5));

// --- the assembled module: identities, statics, prototype chains -----------------
const again = require('stream');
for (const k of [
  'Stream',
  'Readable',
  'Writable',
  'Duplex',
  'Transform',
  'PassThrough',
  'finished',
  'pipeline',
  'addAbortSignal',
  'isReadable',
  'isWritable',
]) {
  console.log('export', k, typeof stream[k], stream[k] === again[k]);
}
console.log('module is Stream', stream === Stream, Stream.Stream === Stream);
console.log('promises shares finished/pipeline wiring', typeof require('stream/promises').pipeline);
const P = Object.getPrototypeOf;
console.log('chain Readable', P(Readable.prototype) === Stream.prototype);
console.log('chain Writable', P(Writable.prototype) === Stream.prototype);
console.log('chain Stream', P(Stream.prototype) === require('events').prototype);
console.log('chain Duplex', P(Duplex.prototype) === Readable.prototype);
console.log('chain Transform', P(Transform.prototype) === Duplex.prototype);
console.log('chain PassThrough', P(PassThrough.prototype) === Transform.prototype);
for (const k of ['write', 'end', 'cork', 'uncork', 'setDefaultEncoding', '_undestroy', 'destroy']) {
  console.log('Duplex has', k, typeof Duplex.prototype[k]);
}
for (const k of ['writable', 'writableLength', 'writableFinished', 'writableNeedDrain']) {
  console.log(
    'Duplex accessor',
    k,
    typeof Object.getOwnPropertyDescriptor(Duplex.prototype, k).get,
  );
}
console.log(
  '_undestroy',
  typeof Readable.prototype._undestroy,
  typeof Writable.prototype._undestroy,
);
console.log(
  'statics',
  typeof Readable.from,
  typeof Readable.fromWeb,
  typeof Readable.toWeb,
  typeof Writable.fromWeb,
  typeof Writable.toWeb,
);
console.log('without new', Readable() instanceof Readable, PassThrough() instanceof Transform);
const d = new Duplex({
  read() {},
  write(c, e, cb) {
    cb();
  },
});
console.log('Duplex state', d.writable, d.readable, d.writableLength, d.readableLength);

// --- behavior across the file seams --------------------------------------------
// Event ORDER across independent streams is not what this case pins (it differs from
// node today and is out of scope here), so the seven outcomes are collected and printed
// sorted once the last one lands. A missing outcome prints nothing, which still diffs.
const OUTCOMES = 7;
const out = [];
const log = (...a) => {
  out.push(a.join(' '));
  if (out.length === OUTCOMES) console.log(out.sort().join('\n'));
};
const seen = [];
pipeline(
  Readable.from(['a', 'b', 'c']),
  new Transform({
    transform(c, e, cb) {
      cb(null, String(c).toUpperCase());
    },
  }),
  new Writable({
    write(c, e, cb) {
      seen.push(String(c));
      cb();
    },
  }),
  (err) => log('pipeline done', !err, seen.join('')),
);
const bad = new PassThrough();
pipeline(bad, new PassThrough(), (err) => log('pipeline error', err && err.code, bad.destroyed));
bad.destroy(Object.assign(new Error('boom'), { code: 'EBOOM' }));
const early = new PassThrough();
finished(early, (err) => log('premature', err && err.code));
early.destroy();
const pushed = new Readable({ read() {} });
pushed.on('error', (e) => log('push(5) error', e.code));
pushed.push(5);
const ac = new AbortController();
const aborted = new Readable({ read() {}, signal: ac.signal });
aborted.on('error', (e) => log('abort error', e.code));
ac.abort();
const fw = Readable.fromWeb(
  new ReadableStream({
    start(c) {
      c.enqueue('w');
      c.enqueue('eb');
      c.close();
    },
  }),
);
const webParts = [];
fw.on('data', (c) => webParts.push(String(c)));
fw.on('end', () => log('fromWeb', webParts.join('')));
const tw = Readable.toWeb(Readable.from(['t', 'o']));
(async () => {
  const parts = [];
  for await (const c of tw) parts.push(String(c));
  log('toWeb', parts.join(''));
})();
