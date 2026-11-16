// Readable and its state — node's lib/internal/streams/readable.js. Readable.from is
// defined here too (node splits its body into internal/streams/from.js); fromWeb/toWeb
// are thin wrappers over internal/webstreams/adapters.js, as in node.
(function (require, module) {
  'use strict';

  var Stream = require('internal/streams/legacy').Stream;
  var Buffer = require('buffer').Buffer;
  var StringDecoder = require('string_decoder').StringDecoder;
  var ERR_INVALID_ARG_TYPE = require('internal/errors').ERR_INVALID_ARG_TYPE;
  var utils = require('internal/streams/utils');
  var CHUNK_EXPECTED = utils.CHUNK_EXPECTED;
  var isBytesChunk = utils.isBytesChunk;
  var bytesToBuffer = utils.bytesToBuffer;
  var errMethodNotImplemented = utils.errMethodNotImplemented;
  var destroy = require('internal/streams/destroy');
  var destroyImpl = destroy.destroyImpl;
  var errorOrDestroy = destroy.errorOrDestroy;
  var addAbortSignal = require('internal/streams/add-abort-signal').addAbortSignal;
  var nextTick = process.nextTick;
  // Captured at module eval, before user code runs (§5) — `pipe` needs to reach
  // `process.stdout`/`stderr` at call time, but must not read the `process` global live.
  // The properties are read late on purpose: they are lazy getters installed after this
  // module loads, so there is nothing to capture here yet.
  var processRef = process;

  // The Web Streams bridges live in internal/webstreams/adapters.js, as in node, and
  // that file requires this one at its top level, so the edge back is late-bound: read
  // on the first fromWeb/toWeb call and kept. Every call is cold — one per bridge built.
  //
  // The wrappers below store the result before returning it on purpose: JSC implements
  // ES2015 proper tail calls in strict code, so a bare `return lazyAdapters().x(...)`
  // drops this frame, and node's stack for a bad fromWeb/toWeb argument names both files.
  var adapters = null;
  function lazyAdapters() {
    if (adapters === null) adapters = require('internal/webstreams/adapters');
    return adapters;
  }

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
        errorOrDestroy(this, ERR_INVALID_ARG_TYPE('chunk', CHUNK_EXPECTED, chunk));
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
        throw ERR_INVALID_ARG_TYPE('iterable', 'Iterable', iterable);
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

  Readable.prototype._undestroy = destroy.undestroy;

  Readable.fromWeb = function (webStream, options) {
    var bridged = lazyAdapters().newStreamReadableFromReadableStream(webStream, options);
    return bridged;
  };

  Readable.toWeb = function (nodeReadable) {
    var bridged = lazyAdapters().newReadableStreamFromStreamReadable(nodeReadable);
    return bridged;
  };

  module.exports = { Readable: Readable, ReadableState: ReadableState };
});
