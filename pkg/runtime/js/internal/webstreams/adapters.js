// Bridges between classic streams and Web Streams — the Lava side of node's
// lib/internal/webstreams/adapters.js, which is where node implements Readable/Writable
// .fromWeb/.toWeb too (its function names are kept). Required late, from those statics,
// so a script that never bridges never compiles it.
(function (require, module) {
  'use strict';

  var Readable = require('internal/streams/readable').Readable;
  var Writable = require('internal/streams/writable').Writable;
  var errorOrDestroy = require('internal/streams/destroy').errorOrDestroy;

  function newStreamReadableFromReadableStream(webStream, options) {
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
  }

  function newReadableStreamFromStreamReadable(nodeReadable) {
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
  }

  function newStreamWritableFromWritableStream(webStream, options) {
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
  }

  function newWritableStreamFromStreamWritable(nodeWritable) {
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
  }

  module.exports = {
    newStreamReadableFromReadableStream: newStreamReadableFromReadableStream,
    newReadableStreamFromStreamReadable: newReadableStreamFromStreamReadable,
    newStreamWritableFromWritableStream: newStreamWritableFromWritableStream,
    newWritableStreamFromStreamWritable: newWritableStreamFromStreamWritable,
  };
});
