// Readable byte streams end to end: default and BYOB readers over a `type: 'bytes'`
// source, the queue filling a caller's view (element alignment, `min`, a DataView),
// the BYOB request a pull sees (respond, respondWithNewView, autoAllocateChunkSize),
// buffer transfer on enqueue and read, desiredSize, close/cancel/error with reads
// pending, tee, async iteration and pipeTo. streams-byte.js keeps the minimal case.
const log = (...parts) => print(parts.join(' '));
const tick = () => new Promise((r) => setTimeout(r, 0));
function show(v) {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  return (
    v.constructor.name +
    '(off ' +
    v.byteOffset +
    ' len ' +
    v.byteLength +
    ' buf ' +
    v.buffer.byteLength +
    ')[' +
    Array.from(bytes).join(',') +
    ']'
  );
}
function res(r) {
  return 'done=' + r.done + ' ' + show(r.value);
}

async function main() {
  log('globals', typeof ReadableByteStreamController, typeof ReadableStreamBYOBRequest);

  // A default reader over a byte stream: chunks come back as Uint8Array copies of what
  // was enqueued, and enqueue transfers (detaches) the caller's buffer.
  {
    let ctrl;
    const rs = new ReadableStream({
      type: 'bytes',
      start(c) {
        ctrl = c;
      },
    });
    log('controller', Object.prototype.toString.call(ctrl), 'desiredSize', ctrl.desiredSize);
    const src = new Uint16Array([0x0201, 0x0403]);
    ctrl.enqueue(src);
    log('enqueued buffer detached', src.byteLength, src.buffer.byteLength);
    log('desiredSize after enqueue', ctrl.desiredSize);
    ctrl.enqueue(new Uint8Array([5, 6, 7]).subarray(1));
    const r = rs.getReader();
    log('default read 1', res(await r.read()));
    log('default read 2', res(await r.read()));
    ctrl.close();
    log('default read 3', res(await r.read()));
  }

  // highWaterMark on a byte stream counts bytes.
  {
    let ctrl;
    new ReadableStream(
      {
        type: 'bytes',
        start(c) {
          ctrl = c;
        },
      },
      { highWaterMark: 10 },
    );
    ctrl.enqueue(new Uint8Array(4));
    log('hwm 10 after 4 bytes', ctrl.desiredSize);
  }

  // BYOB reads served from the queue: a view smaller than the queue, a view larger,
  // the transferred buffer, and a done read.
  {
    let ctrl;
    const rs = new ReadableStream({
      type: 'bytes',
      start(c) {
        ctrl = c;
        c.enqueue(new Uint8Array([1, 2, 3, 4, 5]));
      },
    });
    const r = rs.getReader({ mode: 'byob' });
    const view = new Uint8Array(3);
    const a = await r.read(view);
    log('byob small view', res(a), 'original detached', view.byteLength);
    log('byob rest', res(await r.read(new Uint8Array(new ArrayBuffer(8), 2, 4))));
    ctrl.close();
    log('byob after close', res(await r.read(new Uint8Array(4))));
    log('closed resolves', await r.closed);
  }

  // Element alignment: a Uint16Array view only takes whole elements; the odd byte waits.
  {
    let ctrl;
    const rs = new ReadableStream({
      type: 'bytes',
      start(c) {
        ctrl = c;
      },
    });
    const r = rs.getReader({ mode: 'byob' });
    const p = r.read(new Uint16Array(4));
    await tick();
    log('byobRequest view', show(ctrl.byobRequest.view));
    ctrl.enqueue(new Uint8Array([1, 2, 3]));
    log('uint16 read', res(await p));
    const q = r.read(new Uint16Array(2));
    ctrl.enqueue(new Uint8Array([4]));
    log('uint16 read 2', res(await q));
    log(
      'DataView read',
      res(
        await (ctrl.enqueue(new Uint8Array([9, 8, 7])), r.read(new DataView(new ArrayBuffer(2)))),
      ),
    );
    log('queue left', res(await r.read(new Uint8Array(4))));
  }

  // read(view, {min}): the read waits until `min` elements are filled.
  {
    let ctrl;
    const rs = new ReadableStream({
      type: 'bytes',
      start(c) {
        ctrl = c;
      },
    });
    const r = rs.getReader({ mode: 'byob' });
    let settled = false;
    const p = r.read(new Uint8Array(6), { min: 4 }).then((v) => ((settled = true), v));
    ctrl.enqueue(new Uint8Array([1, 2]));
    await tick();
    log('min 4 after 2 bytes settled', settled);
    ctrl.enqueue(new Uint8Array([3, 4, 5]));
    log('min 4 read', res(await p));
    const q = r.read(new Uint16Array(3), { min: 2 });
    ctrl.enqueue(new Uint8Array([6, 7]));
    ctrl.close();
    ctrl.byobRequest.respond(0);
    log('min after close (partial)', res(await q));
  }

  // pull answered through the BYOB request: respond and respondWithNewView.
  {
    const seen = [];
    let n = 0;
    const rs = new ReadableStream({
      type: 'bytes',
      pull(c) {
        const req = c.byobRequest;
        seen.push(req ? show(req.view) : 'null');
        if (n === 0) {
          req.view[0] = 10;
          req.view[1] = 11;
          req.respond(2);
        } else if (n === 1) {
          const v = new Uint8Array(req.view.buffer, req.view.byteOffset, 1);
          v[0] = 12;
          req.respondWithNewView(v);
        } else {
          c.close();
          req.respond(0);
        }
        n++;
      },
    });
    const r = rs.getReader({ mode: 'byob' });
    log('respond', res(await r.read(new Uint8Array(4))));
    log('respondWithNewView', res(await r.read(new Uint8Array(new ArrayBuffer(6), 1, 3))));
    log('respond(0) after close', res(await r.read(new Uint8Array(2))));
    log('pull saw', seen.join(' | '));
  }

  // autoAllocateChunkSize: a default reader's read still gets a BYOB request.
  {
    const seen = [];
    let n = 0;
    const rs = new ReadableStream({
      type: 'bytes',
      autoAllocateChunkSize: 5,
      pull(c) {
        const req = c.byobRequest;
        seen.push(req ? show(req.view) : 'null');
        if (n++ === 0) {
          req.view.set([1, 2, 3]);
          req.respond(3);
        } else {
          c.close();
          req.respond(0);
        }
      },
    });
    const r = rs.getReader();
    log('auto read 1', res(await r.read()));
    log('auto read 2', res(await r.read()));
    log('auto pull saw', seen.join(' | '));
  }

  // Without autoAllocateChunkSize a default reader's pull sees no request.
  {
    let req = 'unset';
    const rs = new ReadableStream({
      type: 'bytes',
      pull(c) {
        req = c.byobRequest;
        c.enqueue(new Uint8Array([42]));
      },
    });
    log('no auto read', res(await rs.getReader().read()), 'request', req);
  }

  // pull and start ordering, with a count of pulls under a highWaterMark.
  {
    const events = [];
    const rs = new ReadableStream(
      {
        type: 'bytes',
        start() {
          events.push('start');
        },
        pull(c) {
          events.push('pull ' + c.desiredSize);
          if (events.length < 4) c.enqueue(new Uint8Array(2));
        },
      },
      { highWaterMark: 3 },
    );
    await tick();
    events.push('read');
    await rs.getReader().read();
    await tick();
    log('pull events', events.join(','));
  }

  // cancel with a BYOB read pending: it resolves done with no value.
  {
    let reason;
    const rs = new ReadableStream({
      type: 'bytes',
      cancel(r) {
        reason = r;
      },
    });
    const r = rs.getReader({ mode: 'byob' });
    const p = r.read(new Uint8Array(4));
    await r.cancel('why');
    log('cancel pending', res(await p), 'reason', reason);
  }

  // error with a BYOB read pending.
  {
    let ctrl;
    const rs = new ReadableStream({
      type: 'bytes',
      start(c) {
        ctrl = c;
      },
    });
    const r = rs.getReader({ mode: 'byob' });
    const p = r.read(new Uint8Array(4)).catch((e) => 'rejected ' + e.message);
    ctrl.error(new Error('broke'));
    log('error pending', await p);
    log('closed rejects', await r.closed.catch((e) => e.message));
  }

  // close with a BYOB read pending resolves it done with an empty view.
  {
    let ctrl;
    const rs = new ReadableStream({
      type: 'bytes',
      start(c) {
        ctrl = c;
      },
    });
    const r = rs.getReader({ mode: 'byob' });
    const p = r.read(new Uint16Array(2));
    await tick();
    ctrl.close();
    ctrl.byobRequest.respond(0);
    log('close pending', res(await p));
  }

  // releaseLock and re-acquire: queued bytes survive, a default reader can follow.
  {
    const rs = new ReadableStream({
      type: 'bytes',
      start(c) {
        c.enqueue(new Uint8Array([1, 2, 3, 4]));
        c.close();
      },
    });
    let r = rs.getReader({ mode: 'byob' });
    log('first', res(await r.read(new Uint8Array(1))));
    r.releaseLock();
    r = rs.getReader();
    log('then default', res(await r.read()));
    log('then default done', res(await r.read()));
  }

  // tee: both branches are byte streams and see the same bytes in their own buffers.
  {
    const rs = new ReadableStream({
      type: 'bytes',
      start(c) {
        c.enqueue(new Uint8Array([1, 2, 3]));
        c.enqueue(new Uint8Array([4]));
        c.close();
      },
    });
    const [a, b] = rs.tee();
    const ra = a.getReader({ mode: 'byob' });
    const rb = b.getReader();
    const x = await ra.read(new Uint8Array(2));
    const y = await rb.read();
    log('tee a', res(x));
    log('tee b', res(y), 'same buffer', x.value.buffer === y.value.buffer);
    log('tee a 2', res(await ra.read(new Uint8Array(4))));
    log('tee b 2', res(await rb.read()));
    log('tee a 3', res(await ra.read(new Uint8Array(4))));
    log('tee b 3', res(await rb.read()));
    log('tee locked', rs.locked);
  }

  // async iteration and pipeTo over a byte stream.
  {
    const rs = new ReadableStream({
      type: 'bytes',
      start(c) {
        c.enqueue(new Uint8Array([1]));
        c.enqueue(new Uint8Array([2, 3]));
        c.close();
      },
    });
    const parts = [];
    for await (const chunk of rs) parts.push(show(chunk));
    log('iterate', parts.join(' '));
  }
  {
    const rs = new ReadableStream({
      type: 'bytes',
      start(c) {
        c.enqueue(new Uint8Array([7, 8]));
        c.close();
      },
    });
    const got = [];
    await rs.pipeTo(
      new WritableStream({
        write(chunk) {
          got.push(show(chunk));
        },
      }),
    );
    log('pipeTo', got.join(' '));
  }

  // The BYOB request's view is a fresh Uint8Array over the pending read's buffer.
  {
    let req;
    const rs = new ReadableStream({
      type: 'bytes',
      pull(c) {
        req = c.byobRequest;
      },
    });
    const r = rs.getReader({ mode: 'byob' });
    const p = r.read(new Uint32Array(new ArrayBuffer(16), 4, 2));
    await tick();
    log('request view', show(req.view), 'same object', req.view === req.view);
    new Uint32Array(req.view.buffer, req.view.byteOffset, 1)[0] = 0x01020304;
    req.respond(4);
    log('uint32 read', res(await p));
  }
}
main().then(
  () => print('end'),
  (e) => print('FAILED ' + e.constructor.name + ': ' + e.message),
);
