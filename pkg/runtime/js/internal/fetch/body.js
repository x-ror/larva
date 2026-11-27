// The Body mixin Request and Response share, plus the byte/stream plumbing behind it
// (bytes <-> text, chunk coercion, the transport-fed response stream) — the Lava side
// of undici's lib/web/fetch/body.js. The fetch driver (internal/fetch) also takes
// concatChunks/chunkToBytes/makeTransportStream from here, so there is one copy.
//
// Request's and Response's state lives in one record per object, held in a WeakMap
// only these modules reach (newState/stateOf), not in own properties: a page reads
// Blink's attributes off the prototypes and finds nothing on the instance, and the
// record doubles as the brand check every member makes ("Illegal invocation" on a
// foreign receiver, Chrome 158).
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
  var P = require('internal/primordials');
  var StringP = P.String;
  var Uint8ArrayP = P.Uint8Array;
  var ArrayBufferP = P.ArrayBuffer;
  var ArrayBufferIsView = P.ArrayBufferIsView;
  var ArrayPrototypePush1 = P.ArrayPrototypePush1;
  var JSONParse = P.JSONParse;
  var ObjectDefineProperty = P.ObjectDefineProperty;
  var ObjectGetOwnPropertyDescriptor = P.ObjectGetOwnPropertyDescriptor;
  var ReflectOwnKeys = P.ReflectOwnKeys;
  var PromiseReject = P.PromiseReject;
  var PromiseResolve = P.PromiseResolve;
  var StringPrototypeCharCodeAt = P.StringPrototypeCharCodeAt;
  var TypedArrayPrototypeGetBuffer = P.TypedArrayPrototypeGetBuffer;
  var TypedArrayPrototypeGetByteOffset = P.TypedArrayPrototypeGetByteOffset;
  var TypedArrayPrototypeGetByteLength = P.TypedArrayPrototypeGetByteLength;
  var Uint8ArrayPrototypeSet = P.Uint8ArrayPrototypeSet;
  var WeakMapPrototypeGet = P.WeakMapPrototypeGet;
  var WeakMapPrototypeSet = P.WeakMapPrototypeSet;
  var SymbolAsyncIterator = P.Symbol.asyncIterator;
  var UnderlyingSourceStart = 'start';

  var webErrors = require('internal/web_errors');
  var typeError = webErrors.typeError;
  var illegalInvocation = webErrors.illegalInvocation;

  var TEXT_PLAIN = 'text/plain;charset=UTF-8';
  var FORM_URLENCODED = 'application/x-www-form-urlencoded;charset=UTF-8';

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

  // --- per-object state --------------------------------------------------------------

  var states = new P.WeakMap();

  // newState registers `target` as a `kind` ('Request' or 'Response') and returns its
  // record; stateOf answers the record, or undefined for any other object.
  function newState(target, kind) {
    var state = {
      __proto__: null,
      kind: kind,
      bodyStream: null,
      bodyBytes: null,
      bodyUsed: false,
      headers: null,
    };
    WeakMapPrototypeSet(states, target, state);
    return state;
  }

  function stateOf(target, kind) {
    if (target === null || (typeof target !== 'object' && typeof target !== 'function')) {
      return undefined;
    }

    var state = WeakMapPrototypeGet(states, target);
    return state !== undefined && state.kind === kind ? state : undefined;
  }

  // --- extracting a body -------------------------------------------------------------

  function isBlob(value) {
    return require('internal/blob').isBlob(value);
  }

  function isURLSearchParams(value) {
    return value instanceof require('internal/url').URLSearchParams;
  }

  // The Content-Type the fetch standard's "extract a body" gives `body`: a string's,
  // a URLSearchParams', or a Blob's own type when it has one; null otherwise (bytes,
  // streams, an absent body). Chrome 158: tests/web/cases/fetch-body-utf8,
  // fetch-classes, fetch-network.
  function extractContentType(body) {
    if (body === null || body === undefined) return null;
    if (typeof body === 'string') return TEXT_PLAIN;
    if (isBlob(body)) {
      var type = require('internal/blob').typeOf(body);
      return type === '' ? null : type;
    }

    if (isURLSearchParams(body)) return FORM_URLENCODED;
    if (body instanceof ArrayBufferP || ArrayBufferIsView(body)) return null;
    if (streamInternal.isReadableStream(body)) return null;
    // A Lava-only async-iterable request body (isStreamLikeBody) carries no type.
    if (typeof body === 'object' && typeof body[SymbolAsyncIterator] === 'function') return null;
    // Anything else is stringified (WebIDL's USVString arm of BodyInit).
    return TEXT_PLAIN;
  }

  // Body storage stays byte-exact; request bodies and response bytes must not
  // round-trip through latin1 text.
  function bodyToBytes(body) {
    if (body === null || body === undefined) return null;
    if (body instanceof Uint8ArrayP) return body;
    if (body instanceof ArrayBufferP) return new Uint8ArrayP(body);
    if (ArrayBufferIsView(body)) {
      return new Uint8ArrayP(
        TypedArrayPrototypeGetBuffer(body),
        TypedArrayPrototypeGetByteOffset(body),
        TypedArrayPrototypeGetByteLength(body),
      );
    }

    // A Blob/File body: join its in-memory chunks synchronously. Lava's Blob keeps
    // its bytes in memory, so no async read is needed; an empty Blob is an absent body.
    // Branded by its private field (internal/blob), not `instanceof` the replaceable
    // global. A Blob used as a *request* body instead takes Request's async
    // streamBody path and never reaches here.
    var blobBytes = require('internal/blob').blobBytes(body);
    if (blobBytes !== null) return blobBytes.length === 0 ? null : blobBytes;
    var text = typeof body === 'string' ? body : StringP(body);
    // An empty string (passed directly or produced by String(body)) has no
    // bytes — treat it as an absent body.
    if (text === '') return null;
    var encoder = getEncoder();
    if (encoder) return encoder.encode(text);
    var bytes = new Uint8ArrayP(text.length);
    for (var i = 0; i < text.length; i++) bytes[i] = StringPrototypeCharCodeAt(text, i) & 0xff;
    return bytes;
  }

  // initBody stores `bodyInit` on `state`: EITHER an in-memory byte body (bodyBytes,
  // the fast path for JS-constructed bodies and buffered request bodies) OR a
  // streaming body (bodyStream, fed by the transport or handed in by the page). The
  // buffered readers drain the stream when present, so streaming and buffering share
  // one consumption path and a body is consumed at most once.
  function initBody(state, bodyInit) {
    if (streamInternal.isReadableStream(bodyInit)) {
      state.bodyStream = bodyInit;
      state.bodyBytes = undefined;
    } else {
      state.bodyStream = null;
      state.bodyBytes = bodyToBytes(bodyInit); // Uint8Array | null
    }

    state.bodyUsed = false;
  }

  // bytesToText UTF-8 decodes stored bytes (matches Node's Body.text(); a latin1
  // fallback keeps things working if TextDecoder is somehow unavailable).
  function bytesToText(bytes) {
    if (bytes === null || bytes === undefined) return '';
    var decoder = getDecoder();
    if (decoder) return decoder.decode(bytes);
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += StringP.fromCharCode(bytes[i]);
    return s;
  }

  // concatChunks joins an array of Uint8Array chunks into one. Returns null for an
  // empty list (an absent body) and the single chunk as-is when there is only one.
  function concatChunks(chunks) {
    if (chunks.length === 0) return null;
    if (chunks.length === 1) return chunks[0];
    var total = 0;
    for (var i = 0; i < chunks.length; i++) total += chunks[i].length;
    var out = new Uint8ArrayP(total);
    var off = 0;
    for (var j = 0; j < chunks.length; j++) {
      Uint8ArrayPrototypeSet(out, chunks[j], off);
      off += chunks[j].length;
    }
    return out;
  }

  // chunkToBytes coerces a value yielded by a streaming request body (string,
  // ArrayBuffer, typed-array view, or Uint8Array) to bytes.
  function chunkToBytes(chunk) {
    if (chunk instanceof Uint8ArrayP) return chunk;
    if (chunk instanceof ArrayBufferP) return new Uint8ArrayP(chunk);
    if (ArrayBufferIsView(chunk)) {
      return new Uint8ArrayP(
        TypedArrayPrototypeGetBuffer(chunk),
        TypedArrayPrototypeGetByteOffset(chunk),
        TypedArrayPrototypeGetByteLength(chunk),
      );
    }

    var encoder = getEncoder();
    var text = typeof chunk === 'string' ? chunk : StringP(chunk);
    if (encoder) return encoder.encode(text);
    var bytes = new Uint8ArrayP(text.length);
    for (var i = 0; i < text.length; i++) bytes[i] = StringPrototypeCharCodeAt(text, i) & 0xff;
    return bytes;
  }

  // isStreamLikeBody recognizes a request body that cannot be turned into bytes
  // synchronously: a Blob, a ReadableStream, or an async iterable. These are collected
  // asynchronously in fetch() before the request is sent.
  function isStreamLikeBody(b) {
    if (b === null || b === undefined || typeof b === 'string') return false;
    if (b instanceof ArrayBufferP || ArrayBufferIsView(b)) return false;
    if (isBlob(b)) return true;
    if (streamInternal.isReadableStream(b)) return true;
    if (typeof b === 'object' && typeof b[SymbolAsyncIterator] === 'function') return true;
    return false;
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
    var source = { __proto__: null };
    source[UnderlyingSourceStart] = function (controller) {
      if (bytes !== null && bytes !== undefined && bytes.length > 0) controller.enqueue(bytes);
      controller.close();
    };
    return new ReadableStream(source);
  }

  // The body stream a page sees (`body`), made on first read for an in-memory body.
  function bodyStreamOf(state) {
    if (state.bodyStream) return state.bodyStream;
    if (state.bodyBytes === null || state.bodyBytes === undefined) return null;
    state.bodyStream = streamFromBytes(state.bodyBytes);
    return state.bodyStream;
  }

  // The fetch standard's "unusable": the body was read, or its stream disturbed.
  function bodyUsedOf(state) {
    if (state.bodyUsed) return true;
    if (state.bodyStream) return state.bodyStream._disturbed;
    return false;
  }

  // Takes the body for one of the readers and settles with `finish` applied to its
  // bytes (Uint8Array, or null for an empty body). A used or locked body is a rejection
  // made now, not after a tick, which is when Chrome's settles (a foreign receiver's
  // rejection, made just as early, must not overtake it).
  function consume(state, op, finish) {
    if (bodyUsedOf(state)) {
      return PromiseReject(typeError(state.kind, op, 'body stream already read'));
    }

    if (state.bodyStream && state.bodyStream._reader !== undefined) {
      return PromiseReject(typeError(state.kind, op, 'body stream is locked'));
    }

    state.bodyUsed = true;
    if (state.bodyStream) return drain(state.bodyStream, finish);
    try {
      return PromiseResolve(finish(state.bodyBytes));
    } catch (e) {
      // Invalid JSON rejects (WHATWG fetch semantics).
      return PromiseReject(e);
    }
  }

  async function drain(stream, finish) {
    var reader = stream.getReader();
    var chunks = [];
    try {
      for (;;) {
        var r = await reader.read();
        if (r.done) break;
        ArrayPrototypePush1(chunks, r.value);
      }
    } finally {
      reader.releaseLock();
    }
    return finish(concatChunks(chunks));
  }

  function copyBytes(bytes) {
    if (bytes === null || bytes === undefined) return new Uint8ArrayP(0);
    var copy = new Uint8ArrayP(bytes.length);
    Uint8ArrayPrototypeSet(copy, bytes, 0);
    return copy;
  }

  function toArrayBuffer(bytes) {
    return TypedArrayPrototypeGetBuffer(copyBytes(bytes));
  }

  function toJSON(bytes) {
    return JSONParse(bytesToText(bytes));
  }

  function rejectReceiver(iface, op) {
    return PromiseReject(typeError(iface, op, 'Illegal invocation'));
  }

  /**
   * Defines the Body mixin's members (fetch standard) on `proto`, the prototype of
   * the `iface` interface ('Request' or 'Response'): the `body` and `bodyUsed`
   * attributes and the arrayBuffer/blob/bytes/json/text readers. Each member is its
   * own function per interface, as WebIDL defines a mixin's members on each interface
   * that includes it, so a foreign receiver is named in the interface it was called on.
   * @param {object} proto
   * @param {string} iface
   * @throws {TypeError} `Illegal invocation` from the attributes, and as a rejection
   *   `Failed to execute 'text' on 'Response': Illegal invocation` from the readers,
   *   for a receiver that is not an `iface`; `… body stream already read` /
   *   `… body stream is locked` for an unusable body.
   * @node Chrome 158 (tests/web/cases/fetch-webidl): the rejections, their text and
   *   their order.
   * @deviates formData() and textStream() are absent (no FormData in Larva;
   *   shape-fetch's known gap).
   */
  function defineBody(proto, iface) {
    var members = {
      get body() {
        var state = stateOf(this, iface);
        if (state === undefined) throw illegalInvocation();
        return bodyStreamOf(state);
      },
      get bodyUsed() {
        var state = stateOf(this, iface);
        if (state === undefined) throw illegalInvocation();
        return bodyUsedOf(state);
      },
      arrayBuffer() {
        var state = stateOf(this, iface);
        if (state === undefined) return rejectReceiver(iface, 'arrayBuffer');
        return consume(state, 'arrayBuffer', toArrayBuffer);
      },
      // The body as a Blob typed by the Content-Type header ('' without one), as the
      // fetch standard's "consume body" does for blob(). Late-bound: internal/blob's
      // class is the implementation, not the replaceable global.
      blob() {
        var state = stateOf(this, iface);
        if (state === undefined) return rejectReceiver(iface, 'blob');
        var type = require('internal/fetch/headers').getRaw(state.headers, 'content-type');
        return consume(state, 'blob', function (bytes) {
          var BlobCtor = require('internal/blob').BlobImpl;
          return new BlobCtor(bytes === null || bytes === undefined ? [] : [bytes], {
            __proto__: null,
            type: type === null ? '' : type,
          });
        });
      },
      bytes() {
        var state = stateOf(this, iface);
        if (state === undefined) return rejectReceiver(iface, 'bytes');
        return consume(state, 'bytes', copyBytes);
      },
      json() {
        var state = stateOf(this, iface);
        if (state === undefined) return rejectReceiver(iface, 'json');
        return consume(state, 'json', toJSON);
      },
      text() {
        var state = stateOf(this, iface);
        if (state === undefined) return rejectReceiver(iface, 'text');
        return consume(state, 'text', bytesToText);
      },
    };
    var keys = ReflectOwnKeys(members);
    for (var i = 0; i < keys.length; i++) {
      ObjectDefineProperty(proto, keys[i], ObjectGetOwnPropertyDescriptor(members, keys[i]));
    }
  }

  module.exports = {
    newState: newState,
    stateOf: stateOf,
    initBody: initBody,
    defineBody: defineBody,
    extractContentType: extractContentType,
    isStreamLikeBody: isStreamLikeBody,
    isBlob: isBlob,
    bodyStreamOf: bodyStreamOf,
    bodyUsedOf: bodyUsedOf,
    chunkToBytes: chunkToBytes,
    concatChunks: concatChunks,
    makeTransportStream: makeTransportStream,
  };
});
