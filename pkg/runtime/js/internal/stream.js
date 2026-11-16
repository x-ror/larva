// node:stream — classic Node streams: Readable, Writable, Duplex, Transform,
// PassThrough, plus finished() and pipeline(). This is the base layer node:net,
// node:http, and the npm ecosystem compose on (pipe, drain-based backpressure,
// async iteration). Web Streams (stream/web) remain a separate spec surface;
// Readable/Writable.fromWeb/toWeb bridge the two worlds.
//
// Scope notes (vs Node): no writev batching (writev is called per-chunk through
// _write), and byte streams only decode via string_decoder when setEncoding is
// used. Ordering of the observable events — 'data' synchronous from flow, cb /
// 'drain' / 'finish' / 'end' / 'close' deferred a tick — follows Node so the
// oracle cases diff clean.
(function (require, module) {
  'use strict';

  var EventEmitter = require('events');
  var bufferModule = require('buffer');
  var Buffer = bufferModule.Buffer;
  // node's "Received …" clause, shared rather than re-derived — see the non-enumerable
  // export in buffer.js for why this is not a seventh local copy.
  var describeType = bufferModule.describeType;
  var BufferIsEncoding = Buffer.isEncoding;

  // Through primordials, NOT captured here: this module is lazy, so a module-eval capture
  // runs after user code and is steerable (#333). `ArrayBuffer.isView` in particular is a
  // security decision — read live, `globalThis.ArrayBuffer = {isView: () => true}` walks a
  // plain object straight into the byte path.
  var StreamPrimordials = require('primordials');
  var ArrayBufferIsView = StreamPrimordials.ArrayBufferIsView;
  var ErrorG = StreamPrimordials.Error;
  var TypeErrorG = StreamPrimordials.TypeError;
  var ObjectGetPrototypeOf = StreamPrimordials.ObjectGetPrototypeOf;
  var DataViewPrototype = StreamPrimordials.DataViewPrototype;
  var DataViewPrototypeGetBuffer = StreamPrimordials.DataViewPrototypeGetBuffer;
  var DataViewPrototypeGetByteOffset = StreamPrimordials.DataViewPrototypeGetByteOffset;
  var DataViewPrototypeGetByteLength = StreamPrimordials.DataViewPrototypeGetByteLength;
  var TypedArrayPrototypeGetBuffer = StreamPrimordials.TypedArrayPrototypeGetBuffer;
  var TypedArrayPrototypeGetByteOffset = StreamPrimordials.TypedArrayPrototypeGetByteOffset;
  var TypedArrayPrototypeGetByteLength = StreamPrimordials.TypedArrayPrototypeGetByteLength;
  var StringDecoder = require('string_decoder').StringDecoder;
  var nextTick = process.nextTick;
  // Captured at module eval, before user code runs (§5) — `pipe` needs to reach
  // `process.stdout`/`stderr` at call time, but must not read the `process` global live.
  // The properties are read late on purpose: they are lazy getters installed after this
  // module loads, so there is nothing to capture here yet.
  var processRef = process;

  // --- Node-shaped coded errors -------------------------------------------------

  function codedError(Ctor, code, message) {
    var err = new Ctor(message);
    err.code = code;
    return err;
  }
  function errWriteAfterEnd() {
    return codedError(ErrorG, 'ERR_STREAM_WRITE_AFTER_END', 'write after end');
  }
  function errDestroyed(what) {
    return codedError(
      Error,
      'ERR_STREAM_DESTROYED',
      'Cannot call ' + what + ' after a stream was destroyed',
    );
  }
  function errNullValues() {
    return codedError(TypeErrorG, 'ERR_STREAM_NULL_VALUES', 'May not write null values to stream');
  }
  function errMethodNotImplemented(name) {
    return codedError(
      Error,
      'ERR_METHOD_NOT_IMPLEMENTED',
      'The ' + name + ' method is not implemented',
    );
  }
  function errPrematureClose() {
    return codedError(ErrorG, 'ERR_STREAM_PREMATURE_CLOSE', 'Premature close');
  }
  function errInvalidArg(name, expected, actual) {
    return codedError(
      TypeError,
      'ERR_INVALID_ARG_TYPE',
      'The "' + name + '" argument must be ' + expected + '. Received ' + describeType(actual),
    );
  }
  function errUnknownEncoding(encoding) {
    return codedError(TypeErrorG, 'ERR_UNKNOWN_ENCODING', 'Unknown encoding: ' + encoding);
  }

  // node's chunk contract, verified on 24.18.1: a string, or ANY ArrayBuffer view —
  // Buffer, every TypedArray, and DataView. `instanceof Uint8Array` is wrong in both
  // directions: it rejects DataView and Int16Array, which node accepts, and it accepts
  // `Object.create(Uint8Array.prototype)`, which node rejects. ArrayBuffer.isView is the
  // whole test, and it also refuses a bare ArrayBuffer.
  var CHUNK_EXPECTED = 'of type string or an instance of Buffer, TypedArray, or DataView';
  function isBytesChunk(chunk) {
    return ArrayBufferIsView(chunk);
  }

  function isDataViewChunk(value) {
    // Prototype-chain walk rather than `instanceof` (forgeable through Symbol.hasInstance)
    // or a try/catch around a getter (an exception per write on the hot path).
    var proto = ObjectGetPrototypeOf(value);
    while (proto !== null) {
      if (proto === DataViewPrototype) return true;
      proto = ObjectGetPrototypeOf(proto);
    }
    return false;
  }

  // THE STEP WHOSE ABSENCE CAUSED #326's REGRESSION. node hands `_write` a Buffer with
  // encoding 'buffer' for every view, so widening the accept set without converting left
  // `chunk.length` undefined for a DataView: `writableLength` went NaN, `'drain'` could
  // never fire again (NaN === 0 is false), and pipe() stalled forever.
  //
  // The two getter families are NOT interchangeable — a %TypedArray% getter throws on a
  // DataView receiver, which is exactly what the in-flight fix hit last time — so the
  // brand decides which set to read the window through.
  function bytesToBuffer(chunk) {
    if (isDataViewChunk(chunk)) {
      return Buffer.from(
        DataViewPrototypeGetBuffer(chunk),
        DataViewPrototypeGetByteOffset(chunk),
        DataViewPrototypeGetByteLength(chunk),
      );
    }
    return Buffer.from(
      TypedArrayPrototypeGetBuffer(chunk),
      TypedArrayPrototypeGetByteOffset(chunk),
      TypedArrayPrototypeGetByteLength(chunk),
    );
  }

  // node validates an EXPLICIT encoding before it looks at the chunk, which is why
  // `write(5, 'bogus')` reports the encoding and not the chunk type. 'buffer' is node's
  // internal marker and is always allowed through.
  function validateEncoding(encoding) {
    if (encoding !== 'buffer' && !BufferIsEncoding(encoding)) throw errUnknownEncoding(encoding);
  }

  // --- Stream base ---------------------------------------------------------------

  function Stream(opts) {
    EventEmitter.call(this);
  }
  Stream.prototype = Object.create(EventEmitter.prototype);
  Stream.prototype.constructor = Stream;

  // --- Readable ------------------------------------------------------------------

  function ReadableState(options, objectModeDefault) {
    options = options || {};
    this.objectMode = !!options.objectMode || !!objectModeDefault;
    this.highWaterMark =
      options.highWaterMark !== undefined ? options.highWaterMark : this.objectMode ? 16 : 65536;
    this.buffer = []; // chunks (Buffer | string | any in objectMode)
    this.length = 0; // bytes (or chunk count in objectMode)
    this.flowing = null; // null: undecided, true: 'data' flow, false: paused
    this.ended = false; // push(null) seen
    this.endEmitted = false;
    this.reading = false; // a _read() is in flight
    this.sync = false; // inside a synchronous _read call
    this.needReadable = false;
    this.emittedReadable = false;
    this.destroyed = false;
    this.errored = null;
    this.errorEmitted = false;
    this.closeEmitted = false;
    this.autoDestroy = options.autoDestroy !== false;
    this.emitClose = options.emitClose !== false;
    this.defaultEncoding = options.defaultEncoding || 'utf8';
    this.decoder = null;
    this.encoding = null;
    this.pipes = [];
    this.awaitDrainWriters = 0;
  }

  function Readable(options) {
    if (!(this instanceof Readable)) return new Readable(options);
    Stream.call(this);
    this._readableState = new ReadableState(options);
    if (options) {
      if (typeof options.read === 'function') this._read = options.read;
      if (typeof options.destroy === 'function') this._destroy = options.destroy;
      if (options.encoding) this.setEncoding(options.encoding);
      if (options.signal) addAbortSignal(options.signal, this);
    }
  }
  Readable.prototype = Object.create(Stream.prototype);
  Readable.prototype.constructor = Readable;

  Object.defineProperty(Readable.prototype, 'readable', {
    get: function () {
      var s = this._readableState;
      return !!s && !s.destroyed && !s.endEmitted;
    },
  });
  Object.defineProperty(Readable.prototype, 'destroyed', {
    get: function () {
      return this._readableState ? this._readableState.destroyed : false;
    },
    set: function (v) {
      if (this._readableState) this._readableState.destroyed = v;
    },
  });
  Object.defineProperty(Readable.prototype, 'readableEnded', {
    get: function () {
      return this._readableState ? this._readableState.endEmitted : false;
    },
  });
  Object.defineProperty(Readable.prototype, 'readableFlowing', {
    get: function () {
      return this._readableState ? this._readableState.flowing : null;
    },
  });
  Object.defineProperty(Readable.prototype, 'readableLength', {
    get: function () {
      return this._readableState ? this._readableState.length : 0;
    },
  });
  Object.defineProperty(Readable.prototype, 'readableHighWaterMark', {
    get: function () {
      return this._readableState ? this._readableState.highWaterMark : 0;
    },
  });
  Object.defineProperty(Readable.prototype, 'readableObjectMode', {
    get: function () {
      return this._readableState ? this._readableState.objectMode : false;
    },
  });

  Readable.prototype._read = function () {
    throw errMethodNotImplemented('_read()');
  };

  Readable.prototype.push = function (chunk, encoding) {
    var s = this._readableState;
    if (chunk === null) {
      s.reading = false;
      onEofChunk(this, s);
      return false;
    }
    if (!s.objectMode) {
      if (typeof chunk === 'string') {
        encoding = encoding || s.defaultEncoding;
        chunk = Buffer.from(chunk, encoding);
      } else if (isBytesChunk(chunk)) {
        // The readable half must accept exactly what the writable half does, or a
        // PassThrough takes a view on one side and errors on the other — which is how the
        // first attempt at this shipped.
        chunk = bytesToBuffer(chunk);
      } else {
        // Unlike write(), a bad push is an ASYNC 'error' on node, not a throw. The
        // asymmetry is node's; do not "fix" it into a throw.
        errorOrDestroy(this, errInvalidArg('chunk', CHUNK_EXPECTED, chunk));
        return false;
      }
      if (s.decoder) chunk = s.decoder.write(chunk);
    }
    s.reading = false;
    var size = s.objectMode ? 1 : chunk.length;
    if (s.decoder && !s.objectMode) size = chunk.length; // decoded string length
    if (s.flowing && s.length === 0 && !s.sync && this.listenerCount('data') > 0) {
      // Fast path: nothing buffered and a flowing consumer — deliver directly.
      this.emit('data', chunk);
    } else {
      s.buffer.push(chunk);
      s.length += size;
      if (s.needReadable) emitReadable(this);
    }
    maybeReadMore(this, s);
    return s.length < s.highWaterMark;
  };

  Readable.prototype.unshift = function (chunk, encoding) {
    var s = this._readableState;
    if (chunk === null) {
      onEofChunk(this, s);
      return false;
    }
    if (!s.objectMode) {
      if (typeof chunk === 'string') chunk = Buffer.from(chunk, encoding || s.defaultEncoding);
      if (s.decoder) chunk = s.decoder.write(chunk);
    }
    s.buffer.unshift(chunk);
    s.length += s.objectMode ? 1 : chunk.length;
    if (s.needReadable) emitReadable(this);
    return s.length < s.highWaterMark;
  };

  function onEofChunk(stream, s) {
    if (s.ended) return;
    if (s.decoder) {
      var tail = s.decoder.end();
      if (tail && tail.length) {
        s.buffer.push(tail);
        s.length += tail.length;
      }
    }
    s.ended = true;
    if (s.length === 0) {
      emitReadable(stream); // a final zero-data 'readable' announces EOF
      endReadableMaybe(stream);
    } else if (s.needReadable) {
      emitReadable(stream);
    }
  }

  function emitReadable(stream) {
    var s = stream._readableState;
    s.needReadable = false;
    if (s.emittedReadable) return;
    s.emittedReadable = true;
    nextTick(function () {
      s.emittedReadable = false;
      if (s.destroyed) return;
      if (s.length || s.ended) stream.emit('readable');
      flow(stream);
    });
  }

  function maybeReadMore(stream, s) {
    if (!s.reading && !s.ended && s.length < s.highWaterMark && s.flowing !== false) {
      // Keep the pump primed while below HWM (mirrors Node's read(0) loop).
      nextTick(function () {
        if (!s.reading && !s.ended && !s.destroyed && s.length < s.highWaterMark) {
          stream.read(0);
        }
      });
    }
  }

  Readable.prototype.read = function (n) {
    var s = this._readableState;
    if (s.destroyed) return null;
    if (n === undefined || n === null || isNaN(n)) n = -1; // "all"

    if (n === 0 && s.ended && s.length === 0) {
      endReadableMaybe(this);
      return null;
    }

    // Trigger a _read when the buffer can absorb more (or is empty).
    var doRead = false;
    if (!s.ended && !s.reading && (s.length === 0 || s.length < s.highWaterMark)) doRead = true;
    if (doRead) {
      s.reading = true;
      s.sync = true;
      try {
        this._read(s.highWaterMark);
      } catch (err) {
        errorOrDestroy(this, err);
      }
      s.sync = false;
    }

    var ret = null;
    if (n === 0) {
      s.needReadable = s.length === 0 && !s.ended;
      return null;
    }
    if (s.objectMode) {
      ret = s.length > 0 ? s.buffer.shift() : null;
      if (ret !== null) s.length -= 1;
    } else if (n < 0) {
      if (s.length > 0) {
        if (s.flowing || s.buffer.length === 1) {
          // Flowing mode delivers chunk-at-a-time (Node's howMuchToRead returns
          // the first chunk's length when flowing), so 'data' events preserve
          // the producer's chunk boundaries.
          ret = s.buffer.shift();
          s.length -= ret.length;
        } else if (typeof s.buffer[0] === 'string') {
          ret = s.buffer.join('');
          s.buffer.length = 0;
          s.length = 0;
        } else {
          ret = Buffer.concat(s.buffer);
          s.buffer.length = 0;
          s.length = 0;
        }
      }
    } else {
      if (s.length >= n) {
        ret = takeBytes(s, n);
      } else if (s.ended && s.length > 0) {
        ret = takeBytes(s, s.length);
      }
    }

    if (ret === null) {
      s.needReadable = true;
    }
    if (s.ended && s.length === 0) endReadableMaybe(this);
    // Node emits 'data' from read() itself — explicit reads and the flow loop
    // share one delivery point.
    if (ret !== null) this.emit('data', ret);
    return ret;
  };

  function takeBytes(s, n) {
    // Byte-accurate extraction across buffered chunks (strings when a decoder is
    // set: n then counts code units, matching Node's decoded reads).
    var first = s.buffer[0];
    if (typeof first === 'string') {
      if (first.length <= n) {
        s.buffer.shift();
        s.length -= first.length;
        return first;
      }
      s.buffer[0] = first.slice(n);
      s.length -= n;
      return first.slice(0, n);
    }
    if (first.length === n) {
      s.buffer.shift();
      s.length -= n;
      return first;
    }
    if (first.length > n) {
      s.buffer[0] = first.subarray(n);
      s.length -= n;
      return first.subarray(0, n);
    }
    var out = Buffer.allocUnsafe(n);
    var off = 0;
    while (off < n && s.buffer.length) {
      var c = s.buffer[0];
      var want = n - off;
      if (c.length <= want) {
        out.set(c, off);
        off += c.length;
        s.buffer.shift();
      } else {
        out.set(c.subarray(0, want), off);
        s.buffer[0] = c.subarray(want);
        off += want;
      }
    }
    s.length -= n;
    return out;
  }

  function endReadableMaybe(stream) {
    var s = stream._readableState;
    if (s.endEmitted || !s.ended || s.length > 0) return;
    s.endEmitted = true;
    nextTick(function () {
      if (!s.errored) stream.emit('end');
      if (s.autoDestroy) {
        // End of a Duplex only auto-destroys once the write side finished too.
        var w = stream._writableState;
        if (!w || (w.finished && w.autoDestroy) || !w) stream.destroy();
      }
    });
  }

  Readable.prototype.setEncoding = function (enc) {
    var s = this._readableState;
    var decoder = new StringDecoder(enc);
    s.decoder = decoder;
    s.encoding = enc;
    // Re-decode anything already buffered into one string chunk.
    if (s.buffer.length) {
      var content = '';
      for (var i = 0; i < s.buffer.length; i++) content += decoder.write(s.buffer[i]);
      s.buffer.length = 0;
      if (content !== '') s.buffer.push(content);
      s.length = content.length;
    }
    return this;
  };

  Readable.prototype.pause = function () {
    var s = this._readableState;
    if (s.flowing !== false) {
      s.flowing = false;
      this.emit('pause');
    }
    return this;
  };

  Readable.prototype.resume = function () {
    var s = this._readableState;
    if (!s.flowing) {
      s.flowing = true;
      var self = this;
      nextTick(function () {
        self.emit('resume');
        flow(self);
      });
    }
    return this;
  };

  Readable.prototype.isPaused = function () {
    return this._readableState.flowing === false;
  };

  function flow(stream) {
    // read() emits 'data' itself; the loop just drains until pause or empty.
    var s = stream._readableState;
    while (s.flowing && stream.read() !== null) {}
  }

  Readable.prototype.on = function (ev, fn) {
    var res = Stream.prototype.on.call(this, ev, fn);
    var s = this._readableState;
    if (ev === 'data') {
      if (s.flowing !== false) this.resume();
    } else if (ev === 'readable') {
      if (!s.endEmitted) {
        s.needReadable = true;
        if (s.length || s.ended) emitReadable(this);
        else if (!s.reading) {
          var self = this;
          nextTick(function () {
            if (!s.destroyed && !s.ended && !s.reading) self.read(0);
          });
        }
      }
    }
    return res;
  };
  Readable.prototype.addListener = Readable.prototype.on;

  Readable.prototype.pipe = function (dest, pipeOpts) {
    var src = this;
    var s = this._readableState;
    s.pipes.push(dest);
    // node excludes the stdio singletons from the automatic `dest.end()`, and the
    // omission is not cosmetic: `src.pipe(process.stdout)` is the most common pipe in
    // Node, and ending stdout ends it for the whole process — every later write is
    // dropped and raises 'write after end'.
    //
    // Identity, exactly as node does it (`dest !== process.stdout && dest !==
    // process.stderr`), rather than testing a `_isStdio` property: an absent-property
    // read walks Object.prototype, so `Object.prototype._isStdio = true` would stop
    // pipe() from ending ANY destination — §5's uncounted-vector case. Reading the getter
    // builds the stdout stream on first pipe even when piping elsewhere; node pays the
    // same cost, it is once per process, and the getter caches.
    var doEnd =
      (!pipeOpts || pipeOpts.end !== false) &&
      dest !== processRef.stdout &&
      dest !== processRef.stderr;

    function ondata(chunk) {
      var ret = dest.write(chunk);
      if (ret === false) {
        s.awaitDrainWriters++;
        src.pause();
      }
    }
    function ondrain() {
      if (s.awaitDrainWriters > 0) s.awaitDrainWriters--;
      if (s.awaitDrainWriters === 0) src.resume();
    }
    function onend() {
      if (doEnd) dest.end();
    }
    function onerror(er) {
      unpipeAll();
      if (dest.listenerCount('error') === 0) errorOrDestroy(dest, er);
    }
    function onclose() {
      unpipeAll();
    }
    function unpipeAll() {
      src.removeListener('data', ondata);
      dest.removeListener('drain', ondrain);
      src.removeListener('end', onend);
      src.removeListener('error', onerror);
      dest.removeListener('close', onclose);
      var idx = s.pipes.indexOf(dest);
      if (idx !== -1) s.pipes.splice(idx, 1);
      dest.emit('unpipe', src);
    }

    src.on('data', ondata);
    dest.on('drain', ondrain);
    src.on('end', onend);
    src.on('error', onerror);
    dest.on('close', onclose);
    dest.on('unpipe-request', unpipeAll);
    dest.emit('pipe', src);
    return dest;
  };

  Readable.prototype.unpipe = function (dest) {
    var s = this._readableState;
    if (dest === undefined) {
      var all = s.pipes.slice();
      for (var i = 0; i < all.length; i++) all[i].emit('unpipe-request');
      return this;
    }
    if (s.pipes.indexOf(dest) !== -1) dest.emit('unpipe-request');
    return this;
  };

  Readable.prototype.destroy = function (err, cb) {
    return destroyImpl(this, err, cb);
  };
  Readable.prototype._destroy = function (err, cb) {
    cb(err);
  };

  Readable.prototype[Symbol.asyncIterator] = function () {
    var stream = this;
    var s = this._readableState;
    return {
      next: function () {
        return new Promise(function (resolve, reject) {
          if (s.errored) return reject(s.errored);
          var chunk = stream.read();
          if (chunk !== null) return resolve({ value: chunk, done: false });
          if (s.endEmitted || (s.ended && s.length === 0)) {
            endReadableMaybe(stream);
            return resolve({ value: undefined, done: true });
          }
          function cleanup() {
            stream.removeListener('readable', onreadable);
            stream.removeListener('end', onend);
            stream.removeListener('error', onerror);
            stream.removeListener('close', onclose);
          }
          function onreadable() {
            cleanup();
            var c = stream.read();
            if (c !== null) resolve({ value: c, done: false });
            else if (s.ended) resolve({ value: undefined, done: true });
            else attach();
          }
          function onend() {
            cleanup();
            resolve({ value: undefined, done: true });
          }
          function onerror(er) {
            cleanup();
            reject(er);
          }
          function onclose() {
            cleanup();
            resolve({ value: undefined, done: true });
          }
          function attach() {
            stream.once('readable', onreadable);
            stream.once('end', onend);
            stream.once('error', onerror);
            stream.once('close', onclose);
          }
          attach();
        });
      },
      return: function () {
        stream.destroy();
        return Promise.resolve({ value: undefined, done: true });
      },
      [Symbol.asyncIterator]: function () {
        return this;
      },
    };
  };

  Readable.from = function (iterable, options) {
    var readable = new Readable(
      Object.assign({ objectMode: true }, options, {
        read: function () {
          pump();
        },
      }),
    );
    var iterator = null;
    var pumping = false;
    function getIterator() {
      if (iterator) return iterator;
      if (iterable && typeof iterable[Symbol.asyncIterator] === 'function') {
        iterator = iterable[Symbol.asyncIterator]();
      } else if (iterable && typeof iterable[Symbol.iterator] === 'function') {
        iterator = iterable[Symbol.iterator]();
      } else {
        throw errInvalidArg('iterable', 'an iterable', iterable);
      }
      return iterator;
    }
    function pump() {
      if (pumping) return;
      pumping = true;
      Promise.resolve()
        .then(function step() {
          return Promise.resolve(getIterator().next()).then(function (res) {
            if (res.done) {
              readable.push(null);
              pumping = false;
              return;
            }
            if (readable.destroyed) {
              pumping = false;
              return;
            }
            if (readable.push(res.value)) return step();
            pumping = false;
          });
        })
        .catch(function (err) {
          pumping = false;
          errorOrDestroy(readable, err);
        });
    }
    return readable;
  };

  // --- Writable ------------------------------------------------------------------

  function WritableState(options, objectModeDefault) {
    options = options || {};
    this.objectMode = !!options.objectMode || !!objectModeDefault;
    this.highWaterMark =
      options.highWaterMark !== undefined ? options.highWaterMark : this.objectMode ? 16 : 65536;
    this.decodeStrings = options.decodeStrings !== false;
    this.defaultEncoding = options.defaultEncoding || 'utf8';
    this.buffered = []; // {chunk, encoding, cb}
    this.length = 0;
    this.writing = false;
    this.corked = 0;
    this.sync = true; // inside the synchronous span of a _write call
    this.needDrain = false;
    this.ending = false;
    this.ended = false;
    this.finished = false;
    this.prefinished = false;
    this.destroyed = false;
    this.errored = null;
    this.errorEmitted = false;
    this.closeEmitted = false;
    this.autoDestroy = options.autoDestroy !== false;
    this.emitClose = options.emitClose !== false;
    this.writecb = null;
    this.writelen = 0;
  }

  function Writable(options) {
    if (!(this instanceof Writable)) return new Writable(options);
    Stream.call(this);
    this._writableState = new WritableState(options);
    if (options) {
      if (typeof options.write === 'function') this._write = options.write;
      if (typeof options.writev === 'function') this._writev = options.writev;
      if (typeof options.final === 'function') this._final = options.final;
      if (typeof options.destroy === 'function') this._destroy = options.destroy;
      if (options.signal) addAbortSignal(options.signal, this);
    }
  }
  Writable.prototype = Object.create(Stream.prototype);
  Writable.prototype.constructor = Writable;

  Object.defineProperty(Writable.prototype, 'writable', {
    get: function () {
      var w = this._writableState;
      return !!w && !w.destroyed && !w.ending;
    },
  });
  Object.defineProperty(Writable.prototype, 'destroyed', {
    get: function () {
      return this._writableState ? this._writableState.destroyed : false;
    },
    set: function (v) {
      if (this._writableState) this._writableState.destroyed = v;
    },
  });
  Object.defineProperty(Writable.prototype, 'writableEnded', {
    get: function () {
      return this._writableState ? this._writableState.ending : false;
    },
  });
  Object.defineProperty(Writable.prototype, 'writableFinished', {
    get: function () {
      return this._writableState ? this._writableState.finished : false;
    },
  });
  Object.defineProperty(Writable.prototype, 'writableLength', {
    get: function () {
      return this._writableState ? this._writableState.length : 0;
    },
  });
  Object.defineProperty(Writable.prototype, 'writableHighWaterMark', {
    get: function () {
      return this._writableState ? this._writableState.highWaterMark : 0;
    },
  });
  Object.defineProperty(Writable.prototype, 'writableObjectMode', {
    get: function () {
      return this._writableState ? this._writableState.objectMode : false;
    },
  });
  Object.defineProperty(Writable.prototype, 'writableNeedDrain', {
    get: function () {
      var w = this._writableState;
      return !!w && !w.destroyed && !w.ending && w.needDrain;
    },
  });

  Writable.prototype._write = function () {
    throw errMethodNotImplemented('_write()');
  };

  Writable.prototype.write = function (chunk, encoding, cb) {
    if (typeof encoding === 'function') {
      cb = encoding;
      encoding = null;
    }
    var w = this._writableState;
    // An explicit encoding is validated FIRST — before null, before the chunk type. That
    // ordering is node's and it is observable: `write(5, 'bogus')` reports the encoding.
    if (encoding) validateEncoding(encoding);
    encoding = encoding || w.defaultEncoding;
    if (typeof cb !== 'function') cb = noop;

    // node THROWS both of these synchronously rather than reporting them on the stream.
    // Routing them through writeErrorNextTick delivered the right code on the wrong turn,
    // so `assert.throws(() => s.write(null))` passed under node and failed here.
    if (chunk === null) throw errNullValues();
    if (!w.objectMode) {
      if (typeof chunk === 'string') {
        if (w.decodeStrings) {
          chunk = Buffer.from(chunk, encoding);
          encoding = 'buffer';
        }
      } else if (isBytesChunk(chunk)) {
        // Normalize every view to a Buffer, as node does, so downstream length accounting
        // and `_write` see the same shape they always have.
        chunk = bytesToBuffer(chunk);
        encoding = 'buffer';
      } else {
        throw errInvalidArg('chunk', CHUNK_EXPECTED, chunk);
      }
    }
    if (w.ending) {
      var endErr = errWriteAfterEnd();
      writeErrorNextTick(this, endErr, cb);
      return false;
    }
    if (w.destroyed) {
      var dErr = errDestroyed('write');
      writeErrorNextTick(this, dErr, cb);
      return false;
    }

    var len = w.objectMode ? 1 : chunk.length;
    w.length += len;

    if (w.writing || w.corked > 0 || w.errored) {
      w.buffered.push({ chunk: chunk, encoding: encoding, cb: cb });
    } else {
      doWrite(this, w, chunk, len, encoding, cb);
    }

    var ret = w.length < w.highWaterMark && !w.errored;
    if (!ret) w.needDrain = true;
    return ret;
  };

  function writeErrorNextTick(stream, err, cb) {
    nextTick(function () {
      cb(err);
      errorOrDestroy(stream, err);
    });
  }

  function doWrite(stream, w, chunk, len, encoding, cb) {
    w.writing = true;
    w.writecb = cb;
    w.writelen = len;
    w.sync = true;
    try {
      stream._write(chunk, encoding, function (err) {
        onwriteDone(stream, w, err);
      });
    } catch (err) {
      onwriteDone(stream, w, err);
    }
    w.sync = false;
  }

  function onwriteDone(stream, w, err) {
    var cb = w.writecb || noop;
    var len = w.writelen;
    w.writing = false;
    w.writecb = null;
    w.writelen = 0;
    w.length -= len;

    if (err) {
      if (w.sync) {
        nextTick(function () {
          cb(err);
          errorOrDestroy(stream, err);
        });
      } else {
        cb(err);
        errorOrDestroy(stream, err);
      }
      return;
    }

    if (w.sync) {
      // The user cb (and everything that may cascade from it) runs on a clean
      // stack, matching Node's afterWrite deferral for synchronous _write.
      nextTick(function () {
        afterWrite(stream, w, cb);
      });
    } else {
      afterWrite(stream, w, cb);
    }
  }

  function afterWrite(stream, w, cb) {
    cb();
    if (!w.writing && w.corked === 0 && w.buffered.length > 0 && !w.destroyed) {
      var entry = w.buffered.shift();
      doWrite(
        stream,
        w,
        entry.chunk,
        w.objectMode ? 1 : entry.chunk.length,
        entry.encoding,
        entry.cb,
      );
      return; // drain/finish decisions re-run after the queue empties
    }
    if (w.needDrain && w.length === 0 && !w.ending && !w.destroyed) {
      w.needDrain = false;
      stream.emit('drain');
    }
    finishMaybe(stream, w);
  }

  Writable.prototype.cork = function () {
    this._writableState.corked++;
  };
  Writable.prototype.uncork = function () {
    var w = this._writableState;
    if (w.corked > 0) {
      w.corked--;
      if (w.corked === 0 && !w.writing && w.buffered.length > 0) {
        var entry = w.buffered.shift();
        doWrite(
          this,
          w,
          entry.chunk,
          w.objectMode ? 1 : entry.chunk.length,
          entry.encoding,
          entry.cb,
        );
      }
    }
  };

  Writable.prototype.setDefaultEncoding = function (encoding) {
    validateEncoding(encoding);
    this._writableState.defaultEncoding = encoding;
    return this;
  };

  Writable.prototype.end = function (chunk, encoding, cb) {
    if (typeof chunk === 'function') {
      cb = chunk;
      chunk = null;
      encoding = null;
    } else if (typeof encoding === 'function') {
      cb = encoding;
      encoding = null;
    }
    var w = this._writableState;
    if (chunk !== null && chunk !== undefined) this.write(chunk, encoding);
    if (w.ending || w.destroyed) {
      if (typeof cb === 'function') {
        var err = w.finished
          ? codedError(
              Error,
              'ERR_STREAM_ALREADY_FINISHED',
              'end() called after stream was finished',
            )
          : w.destroyed
            ? errDestroyed('end')
            : null;
        if (err) nextTick(cb, err);
        else if (w.finished) nextTick(cb);
        else this.once('finish', cb);
      }
      return this;
    }
    w.ending = true;
    if (typeof cb === 'function') this.once('finish', cb);
    finishMaybe(this, w);
    return this;
  };

  function finishMaybe(stream, w) {
    if (!w.ending || w.finished || w.writing || w.buffered.length > 0 || w.errored || w.destroyed)
      return;
    if (!w.prefinished) {
      w.prefinished = true;
      stream.emit('prefinish');
      if (typeof stream._final === 'function') {
        try {
          stream._final(function (err) {
            if (err) {
              errorOrDestroy(stream, err);
              return;
            }
            emitFinish(stream, w);
          });
        } catch (err) {
          errorOrDestroy(stream, err);
        }
        return;
      }
    }
    emitFinish(stream, w);
  }

  function emitFinish(stream, w) {
    if (w.finished) return;
    w.finished = true;
    w.ended = true;
    nextTick(function () {
      stream.emit('finish');
      if (w.autoDestroy) {
        // A Duplex only auto-destroys once the read side ended too.
        var r = stream._readableState;
        if (!r || r.endEmitted || !r.ended) {
          if (!r || r.endEmitted) stream.destroy();
        }
      }
    });
  }

  Writable.prototype.destroy = function (err, cb) {
    return destroyImpl(this, err, cb);
  };
  Writable.prototype._destroy = function (err, cb) {
    cb(err);
  };

  // --- shared destroy / error ----------------------------------------------------

  // `_undestroy` takes a teardown back: the stream has already emitted its 'finish' /
  // 'close' and run its callbacks, and this returns it to a usable state. Node exposes it
  // on both prototypes (internal/streams/destroy.js's `undestroy`; verified present on
  // node 26.13.0's Writable, Readable AND process.stdout, so it is reachable API, not an
  // invention here). It has exactly one caller shape — a `_destroy` that wants the
  // teardown undone — which is how node keeps the stdio singletons alive across an
  // `end()`; see js/internal/stdio.js. Nothing in this file calls it, so an existing
  // stream is unaffected by its presence.
  //
  // The reset list mirrors node's: enough to make the stream writable/readable again and
  // to let a later 'close' emit, without touching buffers, encodings or the high-water
  // mark, which the stream keeps across the round trip.
  function undestroy() {
    var r = this._readableState;
    var w = this._writableState;
    if (r) {
      r.destroyed = false;
      r.closeEmitted = false;
      r.errored = null;
      r.errorEmitted = false;
      r.reading = false;
      r.ended = false;
      r.endEmitted = false;
    }
    if (w) {
      w.destroyed = false;
      w.closeEmitted = false;
      w.errored = null;
      w.errorEmitted = false;
      w.prefinished = false;
      w.ended = false;
      w.ending = false;
      w.finished = false;
    }
  }
  Readable.prototype._undestroy = undestroy;
  Writable.prototype._undestroy = undestroy;

  function noop() {}

  function errorOrDestroy(stream, err) {
    var r = stream._readableState;
    var w = stream._writableState;
    if ((r && r.destroyed) || (w && w.destroyed)) {
      // Already torn down (e.g. write-after-end on an auto-destroyed stream):
      // the error must still surface exactly once.
      if ((r && r.errorEmitted) || (w && w.errorEmitted)) return;
      if (r) r.errorEmitted = true;
      if (w) w.errorEmitted = true;
      nextTick(function () {
        stream.emit('error', err);
      });
      return;
    }
    stream.destroy(err);
  }

  function destroyImpl(stream, err, cb) {
    var r = stream._readableState;
    var w = stream._writableState;
    if ((r && r.destroyed) || (w && w.destroyed)) {
      if (typeof cb === 'function') nextTick(cb, err || null);
      return stream;
    }
    if (r) {
      r.destroyed = true;
      if (err) r.errored = err;
    }
    if (w) {
      w.destroyed = true;
      if (err) w.errored = err;
    }
    stream._destroy(err || null, function (er) {
      er = er || err || null;
      if (typeof cb === 'function') nextTick(cb, er);
      nextTick(function () {
        var emitClose = (!r || r.emitClose) && (!w || w.emitClose);
        var alreadyEmitted = (r && r.errorEmitted) || (w && w.errorEmitted);
        if (er && !alreadyEmitted && (!cb || typeof cb !== 'function')) {
          if (r) r.errorEmitted = true;
          if (w) w.errorEmitted = true;
          stream.emit('error', er);
        }
        if (emitClose) {
          var closed = (r && r.closeEmitted) || (w && w.closeEmitted);
          if (!closed) {
            if (r) r.closeEmitted = true;
            if (w) w.closeEmitted = true;
            stream.emit('close');
          }
        }
      });
    });
    return stream;
  }

  function addAbortSignal(signal, stream) {
    if (signal.aborted) {
      nextTick(function () {
        stream.destroy(codedError(ErrorG, 'ABORT_ERR', 'The operation was aborted'));
      });
      return;
    }
    signal.addEventListener('abort', function () {
      stream.destroy(codedError(ErrorG, 'ABORT_ERR', 'The operation was aborted'));
    });
  }

  // --- Duplex / Transform / PassThrough -------------------------------------------

  function Duplex(options) {
    if (!(this instanceof Duplex)) return new Duplex(options);
    Stream.call(this);
    this._readableState = new ReadableState(options, options && options.readableObjectMode);
    this._writableState = new WritableState(options, options && options.writableObjectMode);
    if (options) {
      if (typeof options.read === 'function') this._read = options.read;
      if (typeof options.write === 'function') this._write = options.write;
      if (typeof options.writev === 'function') this._writev = options.writev;
      if (typeof options.final === 'function') this._final = options.final;
      if (typeof options.destroy === 'function') this._destroy = options.destroy;
      if (options.encoding) this.setEncoding(options.encoding);
      if (options.readable === false) {
        this._readableState.ended = true;
        this._readableState.endEmitted = true;
      }
      if (options.writable === false) {
        this._writableState.ending = true;
        this._writableState.ended = true;
        this._writableState.finished = true;
      }
      if (options.signal) addAbortSignal(options.signal, this);
    }
  }
  Duplex.prototype = Object.create(Readable.prototype);
  Duplex.prototype.constructor = Duplex;
  // Mix in the Writable API (own-property methods + accessors).
  (function mixinWritable() {
    var keys = Object.getOwnPropertyNames(Writable.prototype);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k === 'constructor') continue;
      if (!Object.prototype.hasOwnProperty.call(Duplex.prototype, k)) {
        Object.defineProperty(
          Duplex.prototype,
          k,
          Object.getOwnPropertyDescriptor(Writable.prototype, k),
        );
      }
    }
    // destroy must tear down BOTH sides; Readable's prototype copy already
    // delegates to the shared destroyImpl, which handles both states.
  })();

  function Transform(options) {
    if (!(this instanceof Transform)) return new Transform(options);
    Duplex.call(this, options);
    this._transformCallback = null;
    if (options && typeof options.transform === 'function') this._transform = options.transform;
    if (options && typeof options.flush === 'function') this._flush = options.flush;
  }
  Transform.prototype = Object.create(Duplex.prototype);
  Transform.prototype.constructor = Transform;

  Transform.prototype._transform = function () {
    throw errMethodNotImplemented('_transform()');
  };

  Transform.prototype._write = function (chunk, encoding, cb) {
    var stream = this;
    var r = this._readableState;
    this._transform(chunk, encoding, function (err, data) {
      if (err) return cb(err);
      if (data !== null && data !== undefined) stream.push(data);
      // Read-side backpressure: hold the write pipeline until the consumer
      // drains the readable buffer below HWM (Node's Transform contract).
      if (r.length < r.highWaterMark || r.destroyed) cb();
      else stream._transformCallback = cb;
    });
  };

  Transform.prototype._read = function () {
    var cb = this._transformCallback;
    if (cb) {
      this._transformCallback = null;
      cb();
    }
  };

  Transform.prototype._final = function (cb) {
    var stream = this;
    if (typeof this._flush === 'function') {
      this._flush(function (err, data) {
        if (err) return cb(err);
        if (data !== null && data !== undefined) stream.push(data);
        stream.push(null);
        cb();
      });
    } else {
      stream.push(null);
      cb();
    }
  };

  function PassThrough(options) {
    if (!(this instanceof PassThrough)) return new PassThrough(options);
    Transform.call(this, options);
  }
  PassThrough.prototype = Object.create(Transform.prototype);
  PassThrough.prototype.constructor = PassThrough;
  PassThrough.prototype._transform = function (chunk, encoding, cb) {
    cb(null, chunk);
  };

  // --- finished / pipeline ---------------------------------------------------------

  function isStreamLike(s) {
    return s !== null && typeof s === 'object' && typeof s.on === 'function';
  }

  function finished(stream, opts, cb) {
    if (typeof opts === 'function') {
      cb = opts;
      opts = {};
    }
    opts = opts || {};
    if (!isStreamLike(stream)) throw errInvalidArg('stream', 'a Stream', stream);

    var readable =
      opts.readable !== false && typeof stream.readable === 'boolean' ? stream.readable : false;
    var writable =
      opts.writable !== false && typeof stream.writable === 'boolean' ? stream.writable : false;
    // Streams that predate the state objects (or foreign ones): fall back to
    // listening for everything and settling on the first terminal event.
    var r = stream._readableState;
    var w = stream._writableState;
    var readableEnded = !readable || (r && r.endEmitted);
    var writableFinished = !writable || (w && w.finished);
    var called = false;

    function done(err) {
      if (called) return;
      called = true;
      cleanup();
      cb.call(stream, err || null);
    }
    function onend() {
      readableEnded = true;
      if (writableFinished) done();
    }
    function onfinish() {
      writableFinished = true;
      if (readableEnded) done();
    }
    function onerror(err) {
      done(err);
    }
    function onclose() {
      if (readable && !readableEnded && !(r && r.endEmitted)) return done(errPrematureClose());
      if (writable && !writableFinished && !(w && w.finished)) return done(errPrematureClose());
      done();
    }
    function cleanup() {
      stream.removeListener('end', onend);
      stream.removeListener('finish', onfinish);
      stream.removeListener('error', onerror);
      stream.removeListener('close', onclose);
    }
    if (readableEnded && writableFinished) {
      nextTick(done);
    } else {
      stream.on('end', onend);
      stream.on('finish', onfinish);
      stream.on('error', onerror);
      stream.on('close', onclose);
    }
    return cleanup;
  }

  function pipeline() {
    var args = [];
    for (var i = 0; i < arguments.length; i++) args[i] = arguments[i];
    var cb = args.pop();
    if (typeof cb !== 'function') throw errInvalidArg('callback', 'of type function', cb);
    if (Array.isArray(args[0]) && args.length === 1) args = args[0];
    if (args.length < 2) {
      throw codedError(ErrorG, 'ERR_MISSING_ARGS', 'The "streams" argument is required');
    }

    var streams = args;
    var called = false;
    function done(err) {
      if (called) return;
      called = true;
      // On failure every stream in the chain is torn down (Node parity).
      if (err) {
        for (var j = 0; j < streams.length; j++) {
          if (typeof streams[j].destroy === 'function') streams[j].destroy();
        }
      }
      cb(err || null);
    }

    for (var k = 0; k < streams.length; k++) {
      if (!isStreamLike(streams[k])) throw errInvalidArg('stream', 'a Stream', streams[k]);
      streams[k].on('error', done);
      if (k > 0) streams[k - 1].pipe(streams[k]);
    }
    finished(streams[streams.length - 1], function (err) {
      done(err);
    });
    return streams[streams.length - 1];
  }

  // --- Web Streams bridges ---------------------------------------------------------

  Readable.fromWeb = function (webStream, options) {
    var reader = webStream.getReader();
    var readable = new Readable(
      Object.assign({}, options, {
        read: function () {
          var self = this;
          reader.read().then(
            function (res) {
              if (res.done) self.push(null);
              else self.push(res.value);
            },
            function (err) {
              errorOrDestroy(self, err);
            },
          );
        },
        destroy: function (err, cb) {
          reader.cancel(err).then(
            function () {
              cb(err);
            },
            function () {
              cb(err);
            },
          );
        },
      }),
    );
    return readable;
  };

  Readable.toWeb = function (nodeReadable) {
    var ReadableStreamCtor = require('stream/web').ReadableStream;
    return new ReadableStreamCtor({
      start: function (controller) {
        nodeReadable.on('data', function (chunk) {
          controller.enqueue(chunk);
          if (controller.desiredSize !== null && controller.desiredSize <= 0) nodeReadable.pause();
        });
        nodeReadable.on('end', function () {
          try {
            controller.close();
          } catch (e) {
            /* already closed */
          }
        });
        nodeReadable.on('error', function (err) {
          controller.error(err);
        });
      },
      pull: function () {
        nodeReadable.resume();
      },
      cancel: function (reason) {
        nodeReadable.destroy(reason instanceof Error ? reason : undefined);
      },
    });
  };

  Writable.fromWeb = function (webStream, options) {
    var writer = webStream.getWriter();
    return new Writable(
      Object.assign({}, options, {
        write: function (chunk, encoding, cb) {
          writer.write(chunk).then(
            function () {
              cb();
            },
            function (err) {
              cb(err);
            },
          );
        },
        final: function (cb) {
          writer.close().then(
            function () {
              cb();
            },
            function (err) {
              cb(err);
            },
          );
        },
        destroy: function (err, cb) {
          writer.abort(err).then(
            function () {
              cb(err);
            },
            function () {
              cb(err);
            },
          );
        },
      }),
    );
  };

  Writable.toWeb = function (nodeWritable) {
    var WritableStreamCtor = require('stream/web').WritableStream;
    return new WritableStreamCtor({
      write: function (chunk) {
        return new Promise(function (resolve, reject) {
          var ok = nodeWritable.write(chunk, function (err) {
            if (err) reject(err);
          });
          if (ok) resolve();
          else nodeWritable.once('drain', resolve);
        });
      },
      close: function () {
        return new Promise(function (resolve, reject) {
          nodeWritable.end(function () {
            resolve();
          });
          nodeWritable.once('error', reject);
        });
      },
      abort: function (reason) {
        nodeWritable.destroy(reason instanceof Error ? reason : undefined);
      },
    });
  };

  // --- exports ---------------------------------------------------------------------

  Stream.Stream = Stream;
  Stream.Readable = Readable;
  Stream.Writable = Writable;
  Stream.Duplex = Duplex;
  Stream.Transform = Transform;
  Stream.PassThrough = PassThrough;
  Stream.finished = finished;
  Stream.pipeline = pipeline;
  Stream.addAbortSignal = function (signal, stream) {
    addAbortSignal(signal, stream);
    return stream;
  };
  Stream.isReadable = function (s) {
    return !!(
      s &&
      typeof s.read === 'function' &&
      s.readable !== false &&
      !(s._readableState && s._readableState.endEmitted)
    );
  };
  Stream.isWritable = function (s) {
    return !!(
      s &&
      typeof s.write === 'function' &&
      s.writable !== false &&
      !(s._writableState && s._writableState.finished)
    );
  };

  module.exports = Stream;
});
