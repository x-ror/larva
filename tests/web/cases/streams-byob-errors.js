// What readable byte streams throw, as a page sees them: the underlying-source and
// strategy conversions for `type: 'bytes'`, getReader's mode enum, the BYOB reader's
// constructor and read(view, {min}) checks, the byte controller's enqueue/close/error
// state checks, the BYOB request's respond/respondWithNewView range checks, the
// constructors a page cannot call, and the receiver brand checks.
// Each line prints the error's class and message (a page's errors have no `code`).
function show(label, f) {
  try {
    const v = f();
    if (v && typeof v.then === 'function') {
      return v.then(
        (r) => print(label + ': resolved ' + describe(r)),
        (e) => print(label + ': rejected ' + e.constructor.name + ': ' + e.message),
      );
    }
    print(label + ': no throw ' + describe(v));
  } catch (e) {
    print(label + ': ' + e.constructor.name + ': ' + e.message + ' code=' + e.code);
  }
}
function describe(v) {
  if (v && typeof v === 'object' && 'done' in v) {
    const value = v.value;
    return (
      'done=' +
      v.done +
      ' value=' +
      (value === undefined ? 'undefined' : value.constructor.name + '(' + value.byteLength + ')')
    );
  }
  return typeof v === 'string' ? JSON.stringify(v) : String(v);
}

// A byte stream whose controller (and the BYOB request of its first pull) the case keeps.
function byteStream(extra) {
  const box = { controller: null, requests: [] };
  const source = {
    type: 'bytes',
    start(c) {
      box.controller = c;
    },
    pull(c) {
      box.requests.push(c.byobRequest);
    },
  };
  Object.assign(source, extra || {});
  box.stream = new ReadableStream(source);
  return box;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

async function main() {
  // The constructor's underlying source and strategy.
  show('type bogus', () => new ReadableStream({ type: 'bogus' }));
  show('type Symbol', () => new ReadableStream({ type: Symbol('t') }));
  show('type null', () => new ReadableStream({ type: null }));
  show('bytes + size', () => new ReadableStream({ type: 'bytes' }, { size() {} }));
  show('bytes hwm -1', () => new ReadableStream({ type: 'bytes' }, { highWaterMark: -1 }));
  show('bytes hwm NaN', () => new ReadableStream({ type: 'bytes' }, { highWaterMark: NaN }));
  show('autoAllocate 0', () => new ReadableStream({ type: 'bytes', autoAllocateChunkSize: 0 }));
  show('autoAllocate -1', () => new ReadableStream({ type: 'bytes', autoAllocateChunkSize: -1 }));
  show('autoAllocate NaN', () => new ReadableStream({ type: 'bytes', autoAllocateChunkSize: NaN }));
  show(
    'autoAllocate 2^53',
    () => new ReadableStream({ type: 'bytes', autoAllocateChunkSize: 2 ** 53 }),
  );
  show(
    'autoAllocate 1.5',
    () => new ReadableStream({ type: 'bytes', autoAllocateChunkSize: 1.5 }).locked,
  );
  show('pull not callable', () => new ReadableStream({ type: 'bytes', pull: 5 }));
  show(
    'start throws',
    () =>
      new ReadableStream({
        type: 'bytes',
        start() {
          throw new SyntaxError('boom');
        },
      }),
  );
  let order = [];
  show(
    'source member order',
    () =>
      new ReadableStream(
        {
          get autoAllocateChunkSize() {
            order.push('autoAllocateChunkSize');
            return undefined;
          },
          get cancel() {
            order.push('cancel');
            return undefined;
          },
          get pull() {
            order.push('pull');
            return undefined;
          },
          get start() {
            order.push('start');
            return undefined;
          },
          get type() {
            order.push('type');
            return 'bytes';
          },
        },
        {
          get highWaterMark() {
            order.push('highWaterMark');
            return 1;
          },
          get size() {
            order.push('size');
            return undefined;
          },
        },
      ).locked,
  );
  print('order ' + order.join(','));

  // getReader's mode.
  show('getReader mode bogus', () => new ReadableStream().getReader({ mode: 'bogus' }));
  show('getReader byob on default', () => new ReadableStream().getReader({ mode: 'byob' }));
  show('getReader(5)', () => new ReadableStream().getReader(5));
  show('getReader byob locked', () => {
    const s = byteStream().stream;
    s.getReader();
    return s.getReader({ mode: 'byob' });
  });

  // ReadableStreamBYOBReader's constructor.
  show('BYOBReader()', () => new ReadableStreamBYOBReader());
  show('BYOBReader({})', () => new ReadableStreamBYOBReader({}));
  show('BYOBReader(default)', () => new ReadableStreamBYOBReader(new ReadableStream()));
  show('BYOBReader call', () => ReadableStreamBYOBReader(byteStream().stream));
  show('BYOBReader(locked)', () => {
    const s = byteStream().stream;
    s.getReader({ mode: 'byob' });
    return new ReadableStreamBYOBReader(s);
  });

  // read(view, options).
  {
    const r = byteStream().stream.getReader({ mode: 'byob' });
    await show('read()', () => r.read());
    await show('read({})', () => r.read({}));
    await show('read(ArrayBuffer)', () => r.read(new ArrayBuffer(4)));
    await show('read(empty view)', () => r.read(new Uint8Array(0)));
    await show('read(empty buffer)', () => r.read(new Uint8Array(new ArrayBuffer(0))));
    const detached = new Uint8Array(4);
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    await show('read(detached)', () => r.read(detached));
    await show('read min 0', () => r.read(new Uint8Array(4), { min: 0 }));
    await show('read min 5 of 4', () => r.read(new Uint8Array(4), { min: 5 }));
    await show('read min 3 of DataView 2', () =>
      r.read(new DataView(new ArrayBuffer(2)), { min: 3 }),
    );
    await show('read min -1', () => r.read(new Uint8Array(4), { min: -1 }));
    await show('read min NaN', () => r.read(new Uint8Array(4), { min: NaN }));
    await show('read options 5', () => r.read(new Uint8Array(4), 5));
    r.releaseLock();
    await show('read released', () => r.read(new Uint8Array(4)));
    await show('cancel released', () => r.cancel());
    await show('closed released', () => r.closed);
    show('releaseLock again', () => r.releaseLock());
  }

  // releaseLock with a read pending: the read rejects.
  {
    const r = byteStream().stream.getReader({ mode: 'byob' });
    const pending = show('pending read on release', () => r.read(new Uint8Array(4)));
    r.releaseLock();
    await pending;
  }

  // A view whose byte length is not a multiple of its element size cannot finish.
  {
    const box = byteStream();
    const r = box.stream.getReader({ mode: 'byob' });
    const pending = show('close with partial element', () => r.read(new Uint16Array(2)));
    await tick();
    box.controller.enqueue(new Uint8Array([1]));
    show('controller.close partial', () => box.controller.close());
    await pending;
    await show('closed after partial', () => r.closed);
  }

  // The controller's own checks.
  {
    const box = byteStream();
    const c = box.controller;
    show('enqueue()', () => c.enqueue());
    show('enqueue({})', () => c.enqueue({}));
    show('enqueue(ArrayBuffer)', () => c.enqueue(new ArrayBuffer(1)));
    show('enqueue(empty)', () => c.enqueue(new Uint8Array(0)));
    const detached = new Uint8Array(4);
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    show('enqueue(detached)', () => c.enqueue(detached));
    show('desiredSize', () => c.desiredSize);
    show('byobRequest none', () => c.byobRequest);
    show('close', () => c.close());
    show('close twice', () => c.close());
    show('enqueue after close', () => c.enqueue(new Uint8Array(1)));
    show('error after close', () => c.error(new Error('late')));
    show('desiredSize closed', () => c.desiredSize);
  }
  {
    const box = byteStream();
    box.controller.error(new RangeError('bad'));
    show('enqueue errored', () => box.controller.enqueue(new Uint8Array(1)));
    show('close errored', () => box.controller.close());
    show('desiredSize errored', () => box.controller.desiredSize);
    await show('read errored', () =>
      box.stream.getReader({ mode: 'byob' }).read(new Uint8Array(1)),
    );
  }

  // The BYOB request's checks.
  {
    const box = byteStream();
    const r = box.stream.getReader({ mode: 'byob' });
    const pending = show('read for respond', () => r.read(new Uint8Array(4)));
    await tick();
    const req = box.requests[0];
    print(
      'request ' +
        Object.prototype.toString.call(req) +
        ' view ' +
        req.view.constructor.name +
        '(' +
        req.view.byteLength +
        ')',
    );
    show('respond()', () => req.respond());
    show('respond(5)', () => req.respond(5));
    show('respond(-1)', () => req.respond(-1));
    show('respond(0) readable', () => req.respond(0));
    show('respondWithNewView()', () => req.respondWithNewView());
    show('respondWithNewView({})', () => req.respondWithNewView({}));
    show('respondWithNewView offset', () =>
      req.respondWithNewView(new Uint8Array(req.view.buffer, 1, 1)),
    );
    show('respondWithNewView other buffer', () =>
      req.respondWithNewView(new Uint8Array(new ArrayBuffer(8), 0, 2)),
    );
    req.view[0] = 9;
    show('respond(1)', () => req.respond(1));
    await pending;
    show('view after respond', () => req.view);
    show('respond after respond', () => req.respond(1));
    show('respondWithNewView after respond', () => req.respondWithNewView(new Uint8Array(1)));
  }
  {
    const box = byteStream();
    const r = box.stream.getReader({ mode: 'byob' });
    const pending = show('read then close', () => r.read(new Uint8Array(4)));
    await tick();
    const req = box.requests[0];
    box.controller.close();
    show('respond(1) closed', () => req.respond(1));
    show('respondWithNewView non-empty closed', () =>
      req.respondWithNewView(new Uint8Array(req.view.buffer, 0, 1)),
    );
    show('respond(0) closed', () => req.respond(0));
    await pending;
  }
  {
    const box = byteStream();
    const r = box.stream.getReader({ mode: 'byob' });
    const pending = show('enqueue invalidates', () => r.read(new Uint8Array(4)));
    await tick();
    const req = box.requests[0];
    const view = req.view;
    box.controller.enqueue(new Uint8Array([7]));
    await pending;
    show('request view after enqueue', () => req.view);
    show('enqueue detaches the view', () => view.byteLength);
  }

  // close requested with bytes still queued.
  {
    const box = byteStream();
    box.controller.enqueue(new Uint8Array([1]));
    show('close with queue', () => box.controller.close());
    show('close again', () => box.controller.close());
    show('enqueue close requested', () => box.controller.enqueue(new Uint8Array(1)));
    show('desiredSize close requested', () => box.controller.desiredSize);
    const r = box.stream.getReader({ mode: 'byob' });
    await show('read partial element close requested', () => r.read(new Uint16Array(1)));
    await show('closed after partial read', () => r.closed);
  }
  {
    const box = byteStream();
    const r = box.stream.getReader({ mode: 'byob' });
    const pending = show('read for new view', () =>
      r.read(new Uint8Array(new ArrayBuffer(8), 0, 4)),
    );
    await tick();
    const req = box.requests[0];
    show('respond(NaN)', () => req.respond(NaN));
    show('respond(Infinity)', () => req.respond(Infinity));
    show('respondWithNewView empty readable', () =>
      req.respondWithNewView(new Uint8Array(req.view.buffer, 0, 0)),
    );
    show('respondWithNewView past descriptor', () =>
      req.respondWithNewView(new Uint8Array(req.view.buffer, 0, 6)),
    );
    show('respondWithNewView DataView', () =>
      req.respondWithNewView(new DataView(req.view.buffer, 0, 2)),
    );
    await pending;
  }

  // Constructors a page cannot call, and the brand checks.
  show('new ReadableByteStreamController', () => new ReadableByteStreamController());
  show('ReadableByteStreamController()', () => ReadableByteStreamController());
  show('new ReadableStreamBYOBRequest', () => new ReadableStreamBYOBRequest());
  const ctrl = ReadableByteStreamController.prototype;
  const req = ReadableStreamBYOBRequest.prototype;
  const rdr = ReadableStreamBYOBReader.prototype;
  const getter = (p, n) => Object.getOwnPropertyDescriptor(p, n).get;
  show('byobRequest on {}', () => getter(ctrl, 'byobRequest').call({}));
  show('desiredSize on {}', () => getter(ctrl, 'desiredSize').call({}));
  show('close on {}', () => ctrl.close.call({}));
  show('enqueue on {}', () => ctrl.enqueue.call({}, new Uint8Array(1)));
  show('error on {}', () => ctrl.error.call({}));
  show('view on {}', () => getter(req, 'view').call({}));
  show('respond on {}', () => req.respond.call({}, 1));
  show('respondWithNewView on {}', () => req.respondWithNewView.call({}, new Uint8Array(1)));
  await show('closed on {}', () => getter(rdr, 'closed').call({}));
  await show('read on {}', () => rdr.read.call({}, new Uint8Array(1)));
  await show('cancel on {}', () => rdr.cancel.call({}));
  show('releaseLock on {}', () => rdr.releaseLock.call({}));
  // A default controller is not a byte controller, and the other way round.
  {
    let defaultController;
    new ReadableStream({
      start(c) {
        defaultController = c;
      },
    });
    show('byte enqueue on default controller', () =>
      ctrl.enqueue.call(defaultController, new Uint8Array(1)),
    );
    show('default enqueue on byte controller', () =>
      ReadableStreamDefaultController.prototype.enqueue.call(byteStream().controller, 1),
    );
  }
}
main().then(
  () => print('end'),
  (e) => print('FAILED ' + e.constructor.name + ': ' + e.message),
);
