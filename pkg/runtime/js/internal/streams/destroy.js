// Teardown shared by Readable, Writable and Duplex — node's
// lib/internal/streams/destroy.js. Both state objects are consulted, so one
// implementation serves every stream shape.
(function (require, module) {
  'use strict';

  var nextTick = process.nextTick;

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

  module.exports = {
    destroyImpl: destroyImpl,
    undestroy: undestroy,
    errorOrDestroy: errorOrDestroy,
  };
});
