// Writable and its state — node's lib/internal/streams/writable.js. fromWeb/toWeb are
// thin wrappers over internal/webstreams/adapters.js, as in node.
(function (require, module) {
  'use strict';

  var Stream = require('internal/streams/legacy').Stream;
  var Buffer = require('buffer').Buffer;
  var ErrorG = require('internal/primordials').Error;
  var TypeErrorG = require('internal/primordials').TypeError;
  var errors = require('internal/errors');
  var nodeError = errors.nodeError;
  var ERR_INVALID_ARG_TYPE = errors.ERR_INVALID_ARG_TYPE;
  var utils = require('internal/streams/utils');
  var CHUNK_EXPECTED = utils.CHUNK_EXPECTED;
  var isBytesChunk = utils.isBytesChunk;
  var bytesToBuffer = utils.bytesToBuffer;
  var validateEncoding = utils.validateEncoding;
  var errMethodNotImplemented = utils.errMethodNotImplemented;
  var destroy = require('internal/streams/destroy');
  var destroyImpl = destroy.destroyImpl;
  var errorOrDestroy = destroy.errorOrDestroy;
  var addAbortSignal = require('internal/streams/add-abort-signal').addAbortSignal;
  var nextTick = process.nextTick;

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

  function errWriteAfterEnd() {
    return nodeError(ErrorG, 'ERR_STREAM_WRITE_AFTER_END', 'write after end');
  }
  function errDestroyed(what) {
    return nodeError(
      ErrorG,
      'ERR_STREAM_DESTROYED',
      'Cannot call ' + what + ' after a stream was destroyed',
    );
  }
  function errNullValues() {
    return nodeError(TypeErrorG, 'ERR_STREAM_NULL_VALUES', 'May not write null values to stream');
  }

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
        throw ERR_INVALID_ARG_TYPE('chunk', CHUNK_EXPECTED, chunk);
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
          ? nodeError(
              ErrorG,
              'ERR_STREAM_ALREADY_FINISHED',
              'Cannot call end after a stream was finished',
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

  Writable.prototype._undestroy = destroy.undestroy;

  function noop() {}

  Writable.fromWeb = function (webStream, options) {
    var bridged = lazyAdapters().newStreamWritableFromWritableStream(webStream, options);
    return bridged;
  };

  Writable.toWeb = function (nodeWritable) {
    var bridged = lazyAdapters().newWritableStreamFromStreamWritable(nodeWritable);
    return bridged;
  };

  module.exports = { Writable: Writable, WritableState: WritableState };
});
