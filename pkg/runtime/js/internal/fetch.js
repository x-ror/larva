// Fetch surface — Headers, Request, Response, and a global `fetch`. Installs
// the WHATWG globals (Node exposes them without a require). This is the pure-JS
// half: Headers/Request/Response/Body machinery is JS, exactly as Node keeps
// it (split across js/internal/fetch/, see below); the actual `http://`
// network transport is Odin-backed and
// reached through the `native` bindings (native.request), mirroring how
// crypto/buffer receive their Odin primitives as the factory's fourth argument.
(function (require, module, exports, native) {
  'use strict';

  // Headers, Body, Request and Response live in js/internal/fetch/ (headers, body,
  // request, response), laid out like undici's lib/web/fetch so each class has its own
  // file and frame name. This module keeps what needs `native`: the fetch() driver —
  // body collection, redirects, and the streaming hand-off to the Odin transport —
  // because the loader keys natives by module id and native.request is bound to
  // `internal/fetch` (globals.odin). It also installs the globals.
  //
  // The driver reaches Request, Response and Headers through their modules' functions
  // and state records, never through a prototype member: a page can redefine every
  // one of those (they are configurable, as in Chrome), and a redefined `headers`
  // getter must not steer what goes on the wire.
  var headersModule = require('internal/fetch/headers');
  var Headers = headersModule.Headers;
  var appendRawHeader = headersModule.appendRaw;
  var getRawHeader = headersModule.getRaw;
  var removeRawHeader = headersModule.removeRaw;
  var fillHeaders = headersModule.fillHeaders;
  var freezeHeaders = headersModule.freezeHeaders;
  var headerEntries = headersModule.entryList;
  var requestModule = require('internal/fetch/request');
  var Request = requestModule.Request;
  var requestState = requestModule.requestState;
  var FETCH = requestModule.FETCH;
  var responseModule = require('internal/fetch/response');
  var Response = responseModule.Response;
  var makeResponse = responseModule.makeResponse;
  var responseState = responseModule.responseState;
  var bodyModule = require('internal/fetch/body');
  var chunkToBytes = bodyModule.chunkToBytes;
  var concatChunks = bodyModule.concatChunks;
  var makeTransportStream = bodyModule.makeTransportStream;
  var bodyStreamOf = bodyModule.bodyStreamOf;
  var isBlob = bodyModule.isBlob;
  // fetchObjectURL's captures (this module is eager, so they are pristine).
  var P = require('internal/primordials');
  var PromiseResolveP = P.PromiseResolve;
  var PromiseRejectP = P.PromiseReject;
  var TypeErrorP = P.TypeError;
  var StringP = P.String;
  var webErrors = require('internal/web_errors');
  // internal/cookie, required on first use: it is instantiated eagerly, but after this
  // module (it needs internal/url, which needs TextEncoder), so not at this module-eval.
  var cookieJar = null;
  function cookies() {
    if (cookieJar === null) cookieJar = require('internal/cookie');
    return cookieJar;
  }
  var ArrayPrototypePush1 = P.ArrayPrototypePush1;
  var StringPrototypeToLowerCase = P.StringPrototypeToLowerCase;

  // collectStreamBody materializes a known-length streaming body (a Blob) to a
  // single Uint8Array so it can be sent with Content-Length framing — matching
  // Node, which treats a Blob as a known-length body (no duplex required).
  // ReadableStream / async-iterable bodies do NOT come here: they stream
  // incrementally as Transfer-Encoding: chunked (see startFetch). An abort signal
  // is honored mid-read so an infinite/slow producer does not keep allocating
  // after the caller cancels.
  async function collectStreamBody(src, signal) {
    if (signal && signal.aborted) throw signal.reason;
    if (typeof Blob !== 'undefined' && src instanceof Blob) {
      var ab = await src.arrayBuffer();
      if (signal && signal.aborted) throw signal.reason;
      return new Uint8Array(ab);
    }
    var chunks = [];
    if (typeof src.getReader === 'function') {
      var reader = src.getReader();
      // An abort can land while reader.read() is pending — for a slow or stalled
      // producer that next chunk may never arrive, so a between-reads
      // signal.aborted check can never wake it and fetch() would hang before the
      // transport even starts. Register a listener that cancels the reader:
      // cancel() both settles the in-flight read (as done, waking the loop) and
      // tears the underlying source down. The reader is always released on the
      // way out so a user-created stream is never left locked.
      var aborted = false;
      var onAbort = null;
      if (signal) {
        onAbort = function () {
          aborted = true;
          try {
            var canceled = reader.cancel(signal.reason);
            if (canceled && typeof canceled.catch === 'function') canceled.catch(function () {});
          } catch {}
        };
        signal.addEventListener('abort', onAbort);
      }
      try {
        for (;;) {
          var r = await reader.read();
          if (r.done) break;
          chunks.push(chunkToBytes(r.value));
        }
      } finally {
        if (onAbort) signal.removeEventListener('abort', onAbort);
        reader.releaseLock();
      }
      // cancel() settles the pending read as done, so the loop exits normally on
      // abort; surface the abort reason rather than a truncated body.
      if (aborted) throw signal.reason;
    } else {
      for await (var chunk of src) {
        if (signal && signal.aborted) throw signal.reason;
        chunks.push(chunkToBytes(chunk));
      }
    }
    var bytes = concatChunks(chunks);
    return bytes === null ? new Uint8Array(0) : bytes;
  }

  // The transport sets these itself from the URL and body length; a caller copy
  // would otherwise be emitted as a duplicate header on the wire.
  var TRANSPORT_OWNED_HEADERS = {
    host: 1,
    'content-length': 1,
    connection: 1,
    'transfer-encoding': 1,
  };

  // fetch(input, init) — build a Request, then hand the method/url/headers/body
  // to the Odin transport. native.request settles by invoking one of the two
  // callbacks we pass: onResponse({status, statusText, headers, body}) on
  // success, or onError(message) on failure. The transport runs on the event
  // loop, so the returned promise resolves on a later tick. http:// and https://
  // (TLS) are both wired; other schemes reject from the native side.
  //
  // init.signal (AbortSignal) is honored: a pre-aborted signal rejects
  // immediately; an abort that fires mid-flight cancels the native transport
  // and rejects with the signal's reason.
  function fetch(input, init) {
    if (arguments.length === 0) {
      var missing = webErrors.argumentsRequired(1, 0);
      return PromiseRejectP(webErrors.typeError('Window', 'fetch', missing));
    }

    var req;
    try {
      // FETCH: the Request's checks report under fetch's context, as Chrome's do.
      req = requestState(new Request(input, init, FETCH));
    } catch (error) {
      return PromiseRejectP(error);
    }

    // A blob: URL never reaches the network: the object-URL registry answers it.
    if (req.url.slice(0, 5) === 'blob:') return fetchObjectURL(req); // primordials-ok: method — req.url is the parser's href, a primitive string

    if (!native || typeof native.request !== 'function') {
      return Promise.reject(new TypeError('fetch: native network backend unavailable'));
    }

    // The signal the Request follows: init's, else the one an input Request carried.
    var signal = req.followSignal != null ? req.followSignal : null;

    // Pre-aborted fast path: reject synchronously without touching the network.
    if (signal && signal.aborted) {
      return Promise.reject(signal.reason);
    }

    return runFetch(req, signal, 0, false);
  }

  /**
   * fetch() of an object URL: the File API's blob URL resolution plus the fetch
   * standard's scheme fetch for `blob:`.
   * @param {Request} req
   * @returns {Promise<Response>} 200 "OK" with the Blob's bytes, Content-Length and
   *   Content-Type; a rejected TypeError "Failed to fetch" (Chrome's network error)
   *   for a URL that names no registered Blob (revoked, or never minted) or a method
   *   other than GET.
   * @node Chrome 158 (tests/web/cases/blob-object-url): the content type is the
   *       Blob's; a File reads back as a Blob of its bytes and type.
   * @deviates none
   */
  function fetchObjectURL(req) {
    var blobModule = require('internal/blob');
    var blob = req.method === 'GET' ? blobModule.resolveForFetch(req.url) : undefined;
    if (blob === undefined) {
      return PromiseRejectP(
        require('internal/web_errors').pageError(new TypeErrorP('Failed to fetch')),
      );
    }

    var bytes = blobModule.blobBytes(blob);
    var headers = new Headers();
    appendRawHeader(headers, 'content-length', StringP(bytes.length));
    appendRawHeader(headers, 'content-type', blobModule.typeOf(blob));
    return PromiseResolveP(
      makeResponse(bytes.length === 0 ? null : bytes, {
        __proto__: null,
        status: 200,
        statusText: 'OK',
        headers: freezeHeaders(headers),
        type: 'basic',
        url: req.url,
      }),
    );
  }

  // Statuses that trigger a redirect when accompanied by a Location header.
  var REDIRECT_STATUSES = { 301: 1, 302: 1, 303: 1, 307: 1, 308: 1 };

  // Request headers dropped when a redirect discards the body (301/302 POST→GET
  // and 303 →GET): the body and everything describing it must not carry over.
  var BODY_HEADERS = [
    'content-length',
    'content-type',
    'content-encoding',
    'content-language',
    'content-location',
  ];

  // serializeHeaders renders a Request's user headers into the wire
  // "Name: Value\r\n" block, dropping the transport-owned headers (Host /
  // Content-Length / Connection / Transfer-Encoding) the native side sets itself, and a
  // page's own `cookie`: Cookie is a forbidden request header, which Chrome drops from
  // what a page sets (tests/web/cases/cookie-fetch); the jar's goes out instead.
  function serializeHeaders(headers) {
    var headerLines = '';
    var entries = headerEntries(headers);
    for (var i = 0; i < entries.length; i++) {
      var key = entries[i][0];
      if (TRANSPORT_OWNED_HEADERS[key] || key === 'cookie') continue;
      // Names/values were CR/LF/NUL-validated when set (see Headers.append), so a
      // header cannot split the request line here.
      headerLines += key + ': ' + entries[i][1] + '\r\n';
    }
    return headerLines;
  }

  // sendOne issues a single HTTP exchange (no redirect handling) and resolves
  // with its Response. The body-framing branch matches fetch()'s contract:
  //   - a Blob (known length) keeps the buffered Content-Length fast path;
  //   - a ReadableStream / async-iterable (duplex:'half') streams as chunked;
  //   - any other body is sent buffered.
  function sendOne(req, signal) {
    var headerLines = serializeHeaders(req.headers);
    // Per hop: a redirect is matched against the jar on its own URL, after the hop
    // before it stored its Set-Cookie (startFetch's onResponse).
    var jarCookies = cookies().forRequest(req.url, req.credentials);
    if (jarCookies !== '') headerLines += 'cookie: ' + jarCookies + '\r\n';
    if (req.streamBody) {
      if (!req.streamNeedsDuplex) {
        return collectStreamBody(req.streamBody, signal).then(function (bytes) {
          return startFetch(req, headerLines, bytes, null, signal);
        });
      }
      return startFetch(req, headerLines, null, req.streamBody, signal);
    }
    return startFetch(req, headerLines, req.bodyBytes, null, signal);
  }

  // cancelBody discards a response body we will not surface (an intermediate
  // redirect): cancel() tears the transport stream down; a rejected teardown is
  // swallowed so it never surfaces as an unhandled rejection.
  function cancelBody(response) {
    var body = bodyStreamOf(response);
    if (!body) return;
    try {
      var canceled = body.cancel();
      if (canceled && typeof canceled.catch === 'function') canceled.catch(function () {});
    } catch {}
  }

  // runFetch performs the request and follows redirects per req.redirect (WHATWG
  // fetch). 'follow' (default) chases up to 20 hops, normalizing the method/body
  // per the 3xx status; 'manual' returns the redirect response untouched; 'error'
  // rejects. `redirected` is propagated onto the final Response.
  function runFetch(req, signal, redirectCount, redirected) {
    // Re-check between hops: an abort that lands after a redirect response has
    // resolved (but before the next hop starts) must stop the chain.
    if (signal && signal.aborted) return Promise.reject(signal.reason);
    return sendOne(req, signal).then(function (publicResponse) {
      var response = responseState(publicResponse);
      var location = getRawHeader(response.headers, 'location');
      if (!REDIRECT_STATUSES[response.status] || location === null) {
        response.redirected = redirected;
        return publicResponse;
      }
      if (req.redirect === 'manual') {
        response.redirected = redirected;
        return publicResponse;
      }
      // From here the 3xx response is never surfaced to the caller — discard its
      // body so the connection does not linger, whether we follow, error, or hit
      // the hop limit.
      cancelBody(response);
      if (req.redirect === 'error') {
        throw new TypeError('fetch: unexpected redirect (redirect mode is "error")');
      }
      if (redirectCount >= 20) {
        throw new TypeError('fetch: too many redirects');
      }
      var nextReq = buildRedirectRequest(req, response, location);
      return runFetch(nextReq, signal, redirectCount + 1, true);
    });
  }

  // buildRedirectRequest constructs the next request for a followed redirect: it
  // resolves Location against the current URL, normalizes the method/body per the
  // 3xx status, and carries the headers (minus body headers when the body is
  // dropped, and minus credentials on a cross-origin hop).
  function buildRedirectRequest(req, response, location) {
    var status = response.status;
    var nextUrl = new URL(location, req.url).href;
    var method = req.method;
    var dropBody = false;

    // 303 → GET (a HEAD stays HEAD); 301/302 turn a POST into a GET. Both drop
    // the request body. 307/308 preserve the method and resend the body.
    if (status === 303 && method !== 'GET' && method !== 'HEAD') {
      method = 'GET';
      dropBody = true;
    } else if ((status === 301 || status === 302) && method === 'POST') {
      method = 'GET';
      dropBody = true;
    }

    var headers = new Headers();
    fillHeaders(headers, req.headers, '');
    if (dropBody) {
      for (var i = 0; i < BODY_HEADERS.length; i++) removeRawHeader(headers, BODY_HEADERS[i]);
    }
    // Cross-origin redirect: strip credentials (WHATWG drops Authorization; undici
    // also drops Cookie / Proxy-Authorization when the origin changes).
    if (new URL(nextUrl).origin !== new URL(req.url).origin) {
      removeRawHeader(headers, 'authorization');
      removeRawHeader(headers, 'cookie');
      removeRawHeader(headers, 'proxy-authorization');
    }

    // The credentials mode carries over, so an 'omit' chain neither sends nor stores
    // cookies on any hop (tests/web/cases/cookie-fetch).
    var nextInit = {
      method: method,
      headers: headers,
      redirect: req.redirect,
      credentials: req.credentials,
    };

    // A method-preserving redirect (307/308 with a body) must resend it. A Blob is
    // a known-length, replayable body — its bytes are read non-mutatingly (see
    // collectStreamBody), so resend the Blob itself; Node likewise resends it. A
    // ReadableStream / async-iterable was consumed by the first hop and cannot be
    // replayed, so the redirect fails (matching Node).
    if (!dropBody && method !== 'GET' && method !== 'HEAD') {
      if (req.streamBody) {
        if (isBlob(req.streamBody)) {
          nextInit.body = req.streamBody;
        } else {
          throw new TypeError(
            'fetch: cannot follow a redirect that resends a streaming request body',
          );
        }
      } else if (req.bodyBytes != null) {
        nextInit.body = req.bodyBytes;
      }
    }
    return requestState(new Request(nextUrl, nextInit, FETCH));
  }

  // startFetch hands the request to the Odin transport and wires its streaming
  // callbacks (see native.request in pkg/runtime/fetch.odin) to a public
  // ReadableStream. onResponse resolves the promise with a Response whose body
  // streams incrementally; onChunk/onEnd feed and finish that stream; onError
  // rejects a pre-headers failure.
  //
  // streamSource (optional) is a ReadableStream / async-iterable request body that
  // is streamed incrementally (Transfer-Encoding: chunked) rather than buffered:
  // the native side pulls one chunk at a time by invoking onBodyDrain, the pump
  // reads the producer and hands each chunk back through handles.pushBody, and
  // signals completion (or a producer error) through handles.endBody. The pull/push
  // protocol holds at most one chunk in flight, so socket write backpressure (the
  // native side defers onBodyDrain until the socket drains) pauses the producer.
  function startFetch(req, headerLines, body, streamSource, signal) {
    return new Promise(function (resolve, reject) {
      var abortListener = null;
      // sink.body is the makeTransportStream handle (enqueue/close/error +
      // .stream) once the response head has arrived; null while still pending.
      var sink = { body: null, ended: false, endErr: null };
      var handles = null;

      // --- request-body producer pump (streamSource only) ---
      var bodyReader = null; // ReadableStream reader, if the source is one
      var bodyIterator = null; // async iterator, otherwise
      var producing = false; // a producer read is in flight
      var producerDone = false; // producer finished, errored, or was torn down
      var sourceReleased = false; // the producer reader/iterator has been released once

      function setupProducer() {
        if (!streamSource) return;
        if (typeof streamSource.getReader === 'function') {
          bodyReader = streamSource.getReader();
        } else {
          bodyIterator = streamSource[Symbol.asyncIterator]();
        }
      }

      function readNextChunk() {
        return bodyReader ? bodyReader.read() : bodyIterator.next();
      }

      function cancelProducer(reason) {
        producerDone = true;
        if (sourceReleased) return; // release the source reader/iterator exactly once
        sourceReleased = true;
        try {
          var p = null;
          if (bodyReader && typeof bodyReader.cancel === 'function') p = bodyReader.cancel(reason);
          else if (bodyIterator && typeof bodyIterator.return === 'function')
            p = bodyIterator.return();
          // cancel()/return() return promises; swallow a rejected teardown so a
          // throwing producer cleanup does not surface as an unhandled rejection.
          if (p && typeof p.catch === 'function') p.catch(function () {});
        } catch {}
      }

      // failProducer aborts the request: cancel the source and tell the native side
      // to tear the in-flight upload down (which rejects the fetch promise).
      function failProducer(err) {
        if (producerDone) return;
        cancelProducer(err);
        var msg =
          err && err.message ? err.message : err === undefined ? 'request body error' : String(err);
        if (handles && typeof handles.endBody === 'function') handles.endBody(msg);
      }

      // pumpBody pulls exactly one chunk from the producer and pushes it to the
      // native transport. The native side calls onBodyDrain to request the next
      // one once the current chunk has drained to the socket (backpressure).
      function pumpBody() {
        if (producing || producerDone) return;
        producing = true;
        var p;
        try {
          p = readNextChunk();
        } catch (e) {
          producing = false;
          failProducer(e);
          return;
        }
        Promise.resolve(p).then(
          function (res) {
            producing = false;
            if (producerDone) return;
            if (res.done) {
              producerDone = true;
              if (handles && typeof handles.endBody === 'function') handles.endBody(null);
              return;
            }
            var bytes;
            try {
              bytes = chunkToBytes(res.value);
            } catch (e) {
              failProducer(e);
              return;
            }
            // An empty chunk frames to nothing on the wire (and a zero-size chunk
            // would be read as the terminator), so skip it and pull the next.
            if (bytes.length === 0) {
              pumpBody();
              return;
            }
            if (handles && typeof handles.pushBody === 'function') handles.pushBody(bytes);
          },
          function (err) {
            producing = false;
            failProducer(err);
          },
        );
      }

      function onBodyDrain() {
        pumpBody();
      }

      function cleanup() {
        if (abortListener && signal) {
          signal.removeEventListener('abort', abortListener);
          abortListener = null;
        }
        producerDone = true; // the request settled — stop pumping the producer
      }

      function onResponse(raw) {
        // NB: do NOT remove the abort listener here. The promise resolves at the
        // head, but the body is still streaming — an abort after headers must
        // still tear the transport down and error the body stream. cleanup runs
        // when the body settles (onEnd), fails (onError), or is cancelled.
        var headers = new Headers();
        var pairs = raw.headers || [];
        var setCookies = [];
        for (var i = 0; i + 1 < pairs.length; i += 2) {
          appendRawHeader(headers, pairs[i], pairs[i + 1]);
          if (StringPrototypeToLowerCase(pairs[i]) === 'set-cookie') {
            ArrayPrototypePush1(setCookies, pairs[i + 1]);
          }
        }
        // Before the promise settles, so a redirect's next hop and the page's next
        // request already see them.
        cookies().fromResponse(req.url, req.credentials, setCookies);

        var bodyArg = null;
        if (raw.hasBody) {
          var bodyHandle = makeTransportStream({
            pull: function () {
              if (handles && typeof handles.resume === 'function') handles.resume();
            },
            cancel: function () {
              cleanup();
              if (handles && typeof handles.cancel === 'function') handles.cancel();
            },
          });
          sink.body = bodyHandle;
          // A terminal signal that arrived before the stream existed (a fully
          // buffered, same-tick body) is replayed here.
          if (sink.ended) {
            if (sink.endErr != null) bodyHandle.error(new TypeError(String(sink.endErr)));
            else bodyHandle.close();
          }
          bodyArg = bodyHandle.stream;
        }
        resolve(
          makeResponse(bodyArg, {
            __proto__: null,
            status: raw.status,
            statusText: raw.statusText,
            headers: freezeHeaders(headers),
            url: req.url,
          }),
        );
      }

      function onError(message) {
        // Release a still-locked producer source on a pre-headers / synchronous
        // failure (e.g. a bad URL rejects before the body is ever pumped); a no-op
        // when there is no stream source or it was already released.
        cancelProducer(new TypeError(String(message)));
        cleanup();
        reject(new TypeError(String(message)));
      }

      // Per body chunk: enqueue and report whether to keep reading (backpressure).
      // enqueue() already maps a non-positive desiredSize (or a closed/cancelled
      // stream) to false, so the transport pauses or stops as appropriate.
      function onChunk(bytes) {
        if (sink.body) return sink.body.enqueue(bytes);
        return true;
      }

      // Body complete: err == null closes the stream cleanly; a string errors it.
      function onEnd(err) {
        cleanup(); // body settled — abort can no longer affect it
        sink.ended = true;
        sink.endErr = err;
        if (sink.body) {
          if (err != null) sink.body.error(new TypeError(String(err)));
          else sink.body.close();
        }
      }

      // Acquire the producer reader before starting the transport so a locked /
      // unusable stream rejects this promise synchronously (executor throw) rather
      // than after the request is already in flight.
      setupProducer();

      handles = native.request(
        req.method,
        req.url,
        headerLines,
        body,
        onResponse,
        onError,
        onChunk,
        onEnd,
        streamSource ? true : false,
        streamSource ? onBodyDrain : null,
      );

      if (signal) {
        abortListener = function () {
          cleanup();
          // Stop the producer and tear down the native transport without invoking
          // onResponse/onError.
          cancelProducer(signal.reason);
          if (handles && typeof handles.cancel === 'function') handles.cancel();
          // Pre-headers: reject the fetch promise. Post-headers (promise already
          // resolved): error the in-flight body stream with the abort reason.
          if (sink.body) sink.body.error(signal.reason);
          reject(signal.reason);
        };
        signal.addEventListener('abort', abortListener);
      }
    });
  }

  // The interface objects and the operation a page sees (internal/native_shape), with
  // the members Lava has in Blink's relative order (Chrome 158,
  // tests/web/cases/shape-fetch.expected): the Body mixin's members laid on each
  // interface, its attributes as prototype getters. textStream() is missing — the gap
  // that case pins.
  var native_shape = require('internal/native_shape');
  var PublicHeaders = native_shape.defineInterface({
    name: 'Headers',
    impl: Headers,
    length: 0,
    members: [
      'append:2',
      'delete:1',
      'get:1',
      'getSetCookie:0',
      'has:1',
      'set:2',
      'entries:0',
      'forEach:1',
      'keys:0',
      'values:0',
      'constructor',
      '@@toStringTag',
      '@@iterator=entries',
    ],
  });
  var PublicRequest = native_shape.defineInterface({
    name: 'Request',
    impl: Request,
    length: 1,
    members: [
      'method',
      'url',
      'headers',
      'destination',
      'referrer',
      'referrerPolicy',
      'mode',
      'credentials',
      'cache',
      'redirect',
      'integrity',
      'keepalive',
      'signal',
      'duplex',
      'isHistoryNavigation',
      'bodyUsed',
      'arrayBuffer:0',
      'blob:0',
      'clone:0',
      'formData:0',
      'json:0',
      'text:0',
      'targetAddressSpace',
      'isReloadNavigation',
      'body',
      'bytes:0',
      'constructor',
      '@@toStringTag',
    ],
  });
  var PublicResponse = native_shape.defineInterface({
    name: 'Response',
    impl: Response,
    length: 0,
    statics: ['error:0', 'json:1', 'redirect:1'],
    members: [
      'type',
      'url',
      'redirected',
      'status',
      'ok',
      'statusText',
      'headers',
      'body',
      'bodyUsed',
      'arrayBuffer:0',
      'blob:0',
      'clone:0',
      'formData:0',
      'json:0',
      'text:0',
      'bytes:0',
      'constructor',
      '@@toStringTag',
    ],
  });
  var publicFetch = native_shape.defineOperation('fetch', fetch, 1);

  module.exports = {
    fetch: publicFetch,
    Headers: PublicHeaders,
    Request: PublicRequest,
    Response: PublicResponse,
  };
});
