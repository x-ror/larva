// The Body mixin Request and Response share, plus the byte/stream plumbing behind it
// (bytes <-> text, chunk coercion, the transport-fed response stream) — the Lava side
// of undici's lib/web/fetch/body.js. The fetch driver (internal/fetch) also takes
// concatChunks/chunkToBytes/makeTransportStream from here, so there is one copy.
(function (require, module) {
  'use strict';

  // The public Web Streams implementation (internal/webstreams/index.js). fetch builds
  // response bodies and consumes request bodies through this same ReadableStream
  // type, so `response.body` is a real, standard ReadableStream — not a fetch-only
  // fork. The `_internal` helpers let the transport drive a stream's controller
  // (enqueue/close/error + desiredSize backpressure) without re-implementing the
  // controller plumbing here.
  var webStreams = require('internal/webstreams/index');
  var ReadableStream = webStreams.ReadableStream;
  var streamInternal = webStreams._internal;

  // Shared, lazily-created codecs. TextEncoder.encode / TextDecoder.decode
  // (non-streaming) are stateless across calls, so a single instance each is
  // reused across every body conversion instead of allocating one per call —
  // the previous per-call `new TextEncoder()/new TextDecoder()` sat on the hot
  // path (every Request/Response body, every .text()/.json()). They are created
  // on first use rather than at load time: loader.js may eager-require this
  // module before encoding.js installs the TextEncoder/TextDecoder globals, so
  // capturing them at load time would cache null and silently fall back to a
  // (wrong) latin1 round-trip (issue #43). getEncoder/getDecoder return null
  // only if the global never appears, in which case the latin1 fallbacks apply.
  var sharedEncoder = null;
  var sharedDecoder = null;
  function getEncoder() {
    if (sharedEncoder === null && typeof TextEncoder !== 'undefined')
      sharedEncoder = new TextEncoder();
    return sharedEncoder;
  }
  function getDecoder() {
    if (sharedDecoder === null && typeof TextDecoder !== 'undefined')
      sharedDecoder = new TextDecoder();
    return sharedDecoder;
  }

  // Body storage stays byte-exact; request bodies and response bytes must not
  // round-trip through latin1 text.
  function bodyToBytes(body) {
    if (body === null || body === undefined) return null;
    if (body instanceof Uint8Array) return body;
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    // A Blob/File body: join its in-memory chunks synchronously. Lava's Blob keeps
    // its bytes in memory, so no async read is needed; an empty Blob is an absent body.
    // Branded by its private field (internal/blob), not `instanceof` the replaceable
    // global. A Blob used as a *request* body instead takes Request's async
    // _streamBody path and never reaches here.
    var blobBytes = require('internal/blob').blobBytes(body);
    if (blobBytes !== null) return blobBytes.length === 0 ? null : blobBytes;
    var text = typeof body === 'string' ? body : String(body);
    // An empty string (passed directly or produced by String(body)) has no
    // bytes — treat it as an absent body.
    if (text === '') return null;
    var encoder = getEncoder();
    if (encoder) return encoder.encode(text);
    var bytes = new Uint8Array(text.length);
    for (var i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
    return bytes;
  }

  // bytesToText UTF-8 decodes stored bytes (matches Node's Body.text(); a latin1
  // fallback keeps things working if TextDecoder is somehow unavailable).
  function bytesToText(bytes) {
    if (bytes === null) return '';
    var decoder = getDecoder();
    if (decoder) return decoder.decode(bytes);
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  // concatChunks joins an array of Uint8Array chunks into one. Returns null for an
  // empty list (an absent body) and the single chunk as-is when there is only one.
  function concatChunks(chunks) {
    if (chunks.length === 0) return null;
    if (chunks.length === 1) return chunks[0];
    var total = 0;
    for (var i = 0; i < chunks.length; i++) total += chunks[i].length;
    var out = new Uint8Array(total);
    var off = 0;
    for (var j = 0; j < chunks.length; j++) {
      out.set(chunks[j], off);
      off += chunks[j].length;
    }
    return out;
  }

  // chunkToBytes coerces a value yielded by a streaming request body (string,
  // ArrayBuffer, typed-array view, or Uint8Array) to bytes.
  function chunkToBytes(chunk) {
    if (chunk instanceof Uint8Array) return chunk;
    if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
    if (ArrayBuffer.isView(chunk))
      return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    var encoder = getEncoder();
    var text = typeof chunk === 'string' ? chunk : String(chunk);
    if (encoder) return encoder.encode(text);
    var bytes = new Uint8Array(text.length);
    for (var i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
    return bytes;
  }

  // BODY_HWM is the response-body high-water mark in bytes. When more than this
  // many undelivered bytes are queued in the response ReadableStream, its
  // controller.desiredSize goes non-positive and the native transport pauses the
  // socket read until the consumer drains below it (backpressure).
  var BODY_HWM = 64 * 1024;

  // byteSizeAlgorithm sizes a queued response chunk by its byte length, so the
  // response-body high-water mark (BODY_HWM) is measured in bytes — the unit the
  // native transport pauses/resumes on.
  function byteSizeAlgorithm(chunk) {
    return chunk && chunk.byteLength ? chunk.byteLength : 0;
  }

  // makeTransportStream builds a response-body ReadableStream fed by the native
  // transport. It returns the public stream plus push handles the transport's
  // sink uses: enqueue(bytes) returns whether to keep reading (desiredSize > 0),
  // close() / error(err) settle the stream. enqueue/close are guarded because a
  // late chunk can arrive after the consumer cancelled (stream no longer
  // readable); the guard turns that into a harmless no-op rather than a throw.
  function makeTransportStream(hooks) {
    var captured = streamInternal.createReadableStreamWithController(
      {
        // pull resumes a paused socket read; a no-op when not paused, so it is
        // safe for the controller to call it on every drained read.
        pull: hooks.pull,
        cancel: hooks.cancel,
      },
      BODY_HWM,
      byteSizeAlgorithm,
    );
    var controller = captured.controller;
    return {
      stream: captured.stream,
      enqueue: function (bytes) {
        try {
          controller.enqueue(bytes);
        } catch {
          return false;
        }
        return controller.desiredSize > 0;
      },
      close: function () {
        try {
          controller.close();
        } catch {}
      },
      error: function (err) {
        controller.error(err);
      },
    };
  }

  // streamFromBytes wraps an in-memory body in a one-shot ReadableStream so .body
  // is a real ReadableStream (Node parity). Enqueuing happens inside start(),
  // which does not mark the stream disturbed, so merely reading `.body` does not
  // flip bodyUsed.
  function streamFromBytes(bytes) {
    return new ReadableStream({
      start: function (controller) {
        if (bytes !== null && bytes !== undefined && bytes.length > 0) controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  // Body backs Request and Response. It holds EITHER an in-memory byte body
  // (_bodyBytes, the fast path for JS-constructed bodies and buffered request
  // bodies) OR a streaming body (_bodyStream, fed by the transport). The buffered
  // accessors (text/json/arrayBuffer/bytes) drain the stream when present, so
  // streaming and buffering share one consumption path and a body is consumed at
  // most once.
  class Body {
    constructor(bodyInit) {
      if (streamInternal.isReadableStream(bodyInit)) {
        this._bodyStream = bodyInit;
        this._bodyBytes = undefined;
      } else {
        this._bodyStream = null;
        this._bodyBytes = bodyToBytes(bodyInit); // Uint8Array | null
      }
      this._bodyUsed = false;
    }
    get bodyUsed() {
      if (this._bodyUsed) return true;
      if (this._bodyStream) return this._bodyStream._disturbed;
      return false;
    }
    get body() {
      if (this._bodyStream) return this._bodyStream;
      if (this._bodyBytes === null || this._bodyBytes === undefined) return null;
      this._bodyStream = streamFromBytes(this._bodyBytes);
      return this._bodyStream;
    }
    async _consume() {
      if (this.bodyUsed) throw new TypeError('Body is unusable: Body has already been read');
      if (this._bodyStream && this._bodyStream.locked)
        throw new TypeError('Body is unusable: ReadableStream is locked');
      this._bodyUsed = true;
      if (this._bodyStream) {
        var reader = this._bodyStream.getReader();
        var chunks = [];
        try {
          for (;;) {
            var r = await reader.read();
            if (r.done) break;
            chunks.push(r.value);
          }
        } finally {
          reader.releaseLock();
        }
        return concatChunks(chunks);
      }
      return this._bodyBytes; // Uint8Array | null
    }
    text() {
      return this._consume().then(function (bytes) {
        return bytesToText(bytes);
      });
    }
    json() {
      // Parse inside the chain so invalid JSON rejects (WHATWG fetch semantics).
      return this._consume().then(function (bytes) {
        return JSON.parse(bytesToText(bytes));
      });
    }
    arrayBuffer() {
      return this._consume().then(function (bytes) {
        if (bytes === null || bytes === undefined) return new ArrayBuffer(0);
        var copy = new Uint8Array(bytes.length);
        copy.set(bytes);
        return copy.buffer;
      });
    }
    bytes() {
      return this._consume().then(function (bytes) {
        if (bytes === null || bytes === undefined) return new Uint8Array(0);
        var copy = new Uint8Array(bytes.length);
        copy.set(bytes);
        return copy;
      });
    }
    // The body as a Blob typed by the Content-Type header ('' without one), as the
    // fetch standard's "consume body" does for blob(). Late-bound: internal/blob's
    // class is the implementation, not the replaceable global.
    async blob() {
      var type = this.headers ? this.headers.get('content-type') : null;
      var bytes = await this._consume();
      var BlobCtor = require('internal/blob').Blob;
      return new BlobCtor(bytes === null || bytes === undefined ? [] : [bytes], {
        type: type === null ? '' : type,
      });
    }
  }

  // Per WHATWG, extracting a body from a Blob contributes a Content-Type equal to
  // the Blob's `type` (when non-empty) — applied only if the caller didn't already
  // set one via init.headers (or an inherited source Request's headers).
  function applyBlobContentType(headers, body) {
    if (
      typeof Blob !== 'undefined' &&
      body instanceof Blob &&
      body.type &&
      !headers.has('content-type')
    ) {
      headers.set('content-type', body.type);
    }
  }

  module.exports = {
    Body: Body,
    applyBlobContentType: applyBlobContentType,
    chunkToBytes: chunkToBytes,
    concatChunks: concatChunks,
    makeTransportStream: makeTransportStream,
  };
});
