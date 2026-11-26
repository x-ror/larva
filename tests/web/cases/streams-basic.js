// Web Streams: the classes as globals, readers, async iteration, pull with a count
// high-water mark, cancel, tee, locking, pipeTo/pipeThrough, error propagation,
// writers, queuing strategies, an early break, and a 2000-chunk drain in FIFO order.
// Errors are compared by constructor name; their messages are engine text.
// Ported from tests/node-compat/cases/25-web-streams.js (node:stream/web dropped).
const log = (...parts) => print(parts.join(' '));
function enc(s) {
  return new TextEncoder().encode(s);
}
function dec(u) {
  return new TextDecoder().decode(u);
}

async function main() {
  // --- the stream classes are globals ---
  for (const name of [
    'ReadableStream',
    'WritableStream',
    'TransformStream',
    'ReadableStreamDefaultReader',
    'ReadableStreamBYOBReader',
    'ReadableStreamDefaultController',
    'WritableStreamDefaultWriter',
    'WritableStreamDefaultController',
    'TransformStreamDefaultController',
    'ByteLengthQueuingStrategy',
    'CountQueuingStrategy',
  ]) {
    log('global', name, typeof globalThis[name]);
  }
  // --- new ReadableStream + getReader().read() ---
  {
    const rs = new ReadableStream({
      start(c) {
        c.enqueue(enc('a'));
        c.enqueue(enc('b'));
        c.close();
      },
    });
    log('locked before', rs.locked);
    const reader = rs.getReader();
    log('locked after', rs.locked);
    let out = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec(value);
    }
    log('getReader:', out);
  }

  // --- async iteration ---
  {
    const rs = new ReadableStream({
      start(c) {
        c.enqueue(1);
        c.enqueue(2);
        c.enqueue(3);
        c.close();
      },
    });
    const vals = [];
    for await (const v of rs) vals.push(v);
    log('asyncIterator:', JSON.stringify(vals));
  }

  // --- pull-driven source with count high-water mark (backpressure) ---
  {
    let pulls = 0;
    const rs = new ReadableStream(
      {
        pull(c) {
          pulls++;
          if (pulls <= 3) c.enqueue(pulls);
          else c.close();
        },
      },
      new CountQueuingStrategy({ highWaterMark: 1 }),
    );
    const vals = [];
    for await (const v of rs) vals.push(v);
    log('pull:', JSON.stringify(vals));
  }

  // --- cancel() reaches the underlying source and resolves the reader ---
  {
    let canceledWith = null;
    const rs = new ReadableStream({
      start(c) {
        c.enqueue(1);
      },
      cancel(reason) {
        canceledWith = reason;
      },
    });
    const reader = rs.getReader();
    await reader.read();
    await reader.cancel('done-here');
    log('cancel:', canceledWith);
    const after = await reader.read();
    log('cancel after:', after.done);
  }

  // --- tee(): both branches read the full stream independently ---
  {
    const rs = new ReadableStream({
      start(c) {
        c.enqueue(enc('xy'));
        c.enqueue(enc('z'));
        c.close();
      },
    });
    const [a, b] = rs.tee();
    async function drain(s) {
      let out = '';
      for await (const chunk of s) out += dec(chunk);
      return out;
    }
    const [sa, sb] = await Promise.all([drain(a), drain(b)]);
    log('tee:', sa, sb, sa === sb);
  }

  // --- locking: a second reader on a locked stream throws ---
  {
    const rs = new ReadableStream({ start: (c) => c.close() });
    rs.getReader();
    let name = '';
    try {
      rs.getReader();
    } catch (e) {
      name = e.constructor.name;
    }
    log('double lock:', name);
  }

  // --- pipeTo() drains into a WritableStream sink ---
  {
    const chunks = [];
    const rs = new ReadableStream({
      start(c) {
        c.enqueue(enc('pipe-'));
        c.enqueue(enc('to'));
        c.close();
      },
    });
    const ws = new WritableStream({
      write(chunk) {
        chunks.push(dec(chunk));
      },
    });
    await rs.pipeTo(ws);
    log('pipeTo:', chunks.join(''));
  }

  // --- pipeThrough() a TransformStream (with a trailing flush chunk) ---
  {
    const rs = new ReadableStream({
      start(c) {
        c.enqueue('a');
        c.enqueue('b');
        c.close();
      },
    });
    const ts = new TransformStream({
      transform(chunk, controller) {
        controller.enqueue(chunk.toUpperCase());
      },
      flush(controller) {
        controller.enqueue('!');
      },
    });
    const vals = [];
    for await (const v of rs.pipeThrough(ts)) vals.push(v);
    log('pipeThrough:', JSON.stringify(vals));
  }

  // --- error propagation: a controller.error() rejects pending reads ---
  {
    const rs = new ReadableStream({
      start(c) {
        c.enqueue(1);
      },
      pull(c) {
        c.error(new Error('boom'));
      },
    });
    const reader = rs.getReader();
    log('err read1:', (await reader.read()).value);
    let name = '';
    try {
      await reader.read();
    } catch (e) {
      name = e.constructor.name;
    }
    log('err read2:', name);
  }

  // --- a transform that throws errors the readable side ---
  {
    const rs = new ReadableStream({
      start(c) {
        c.enqueue(1);
        c.enqueue(2);
        c.close();
      },
    });
    const ts = new TransformStream({
      transform(chunk, controller) {
        if (chunk === 2) throw new Error('xform');
        controller.enqueue(chunk * 10);
      },
    });
    const vals = [];
    let name = '';
    try {
      for await (const v of rs.pipeThrough(ts)) vals.push(v);
    } catch (e) {
      name = e.constructor.name;
    }
    log('transform throw:', JSON.stringify(vals), name);
  }

  // --- WritableStream writer: ordered writes + close ---
  {
    const writes = [];
    const ws = new WritableStream(
      {
        write(chunk) {
          writes.push(chunk);
        },
      },
      new CountQueuingStrategy({ highWaterMark: 2 }),
    );
    const w = ws.getWriter();
    await w.write('1');
    await w.write('2');
    await w.close();
    log('writable:', JSON.stringify(writes));
  }

  // --- queuing strategy shapes ---
  {
    const c = new CountQueuingStrategy({ highWaterMark: 5 });
    log('count strategy:', c.highWaterMark, c.size());
    const b = new ByteLengthQueuingStrategy({ highWaterMark: 16 });
    log('byte strategy:', b.highWaterMark, b.size(enc('hello')));
  }

  // --- a byob reader on a non-byte stream throws TypeError ---
  {
    const rs = new ReadableStream({ start: (c) => c.close() });
    let name = '';
    try {
      rs.getReader({ mode: 'byob' });
    } catch (e) {
      name = e.constructor.name;
    }
    log('byob reader:', name, typeof ReadableStreamBYOBReader);
  }

  // --- async iterator early-break cancels the underlying source ---
  {
    let canceled = false;
    const rs = new ReadableStream({
      start(c) {
        c.enqueue(1);
        c.enqueue(2);
      },
      cancel() {
        canceled = true;
      },
    });
    let first;
    for await (const v of rs) {
      first = v;
      break;
    }
    log('iter break:', first, canceled);
  }

  // --- many-chunk drain: the internal chunk queue must stay efficient (no
  // O(n^2) Array.prototype.shift) and preserve FIFO order across a large number
  // of small chunks — the shape a byte-sized fetch body or a pipe under
  // fine-grained network chunking produces. ---
  {
    const N = 2000;
    const rs = new ReadableStream({
      start(c) {
        for (let i = 0; i < N; i++) c.enqueue(i);
        c.close();
      },
    });
    const reader = rs.getReader();
    let count = 0;
    let ordered = true;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== count) ordered = false;
      count += 1;
    }
    log('many-chunk drain:', count === N, ordered);
  }
}

main()
  .then(() => log('WEB STREAMS OK'))
  .catch((e) => print('FAILED ' + e));
