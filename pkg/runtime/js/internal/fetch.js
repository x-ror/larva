// Fetch surface — Headers, Request, Response, and a global `fetch`. Installs
// the WHATWG globals (Node exposes them without a require). This is the pure-JS
// half: Headers/Request/Response/Body machinery lives here, exactly as Node
// keeps it in JS; the actual `http://` network transport is Odin-backed and
// reached through the `native` bindings (native.request), mirroring how
// crypto/buffer receive their Odin primitives as the factory's fourth argument.
(function (require, module, exports, native) {
  'use strict';

  // The public Web Streams implementation (js/internal/streams.js). fetch builds
  // response bodies and consumes request bodies through this same ReadableStream
  // type, so `response.body` is a real, standard ReadableStream — not a fetch-only
  // fork. The `_internal` helpers let the transport drive a stream's controller
  // (enqueue/close/error + desiredSize backpressure) without re-implementing the
  // controller plumbing here.
  var webStreams = require('node:stream/web');
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

  function normalizeName(name) {
    return String(name).toLowerCase();
  }

  // Header names must be non-empty HTTP tokens (RFC 7230 tchar); values must not
  // carry CR, LF, or NUL. Node (undici) throws on either — at append/set/get/
  // has/delete time — so `new Headers(...)` and, because Request builds its
  // Headers eagerly, `fetch(input, {headers})` reject instead of silently
  // emitting a header-split or otherwise malformed request. The token class
  // rejects spaces, ':' (which would forge a second header on the wire), control
  // chars, and non-ASCII alike. Wire (response) headers arrive pre-framed via
  // _append and skip this, matching undici.
  // Header-name validation over caller-controlled text — a CRLF that gets through
  // here is header injection on the wire. NOT `re.test(...)`: `RegExp.prototype.exec`
  // is a writable data property and RegExpExec re-reads it off the receiver, so an
  // ordinary assignment steers `test` too. primordials deliberately exports no
  // `RegExpPrototypeTest` for that reason; `RegExpMatches` (a captured `exec`
  // compared against null) is the only sound spelling.
  //
  // The value half is closed too, and differently: `normalizeHeaderValue` below is
  // now a charCode trim rather than a global `replaceAll`, because a global regex
  // does not merely answer wrongly under a forged `exec` — it never terminates.
  // `assertValidHeaderValue` was already a hand-rolled charCode scan.
  var P = require('primordials');
  var reTest = P.RegExpMatches;
  var StringPrototypeCharCodeAt = P.StringPrototypeCharCodeAt;
  var StringPrototypeSlice = P.StringPrototypeSlice;
  var VALID_HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
  function assertValidHeaderName(name) {
    if (!reTest(VALID_HEADER_NAME, name)) {
      throw new TypeError('Invalid header name: "' + name + '"');
    }
  }
  function assertValidHeaderValue(name, value) {
    for (var i = 0; i < value.length; i++) {
      // The CAPTURED read, not `value.charCodeAt(i)`. `String.prototype.charCodeAt`
      // is a writable data property like any other, so a hand-rolled scan is only
      // as sound as the primitive it scans with — routing this file's validators
      // off RegExp said nothing about that. A gadget reporting 0x41 for CR and LF
      // is enough: measured, node rejects and Lava accepted
      // `a\r\nInjected: yes` as a header value. Pinned by `cc-value=` in
      // cmd/lava/regexp_pollution_test.odin (and the fetch.js mutation-manifest
      // entry). The same gadget on the HTTP response path is pinned by the
      // charcodeat phase of run-http-smoke.sh against http.js.
      var code = StringPrototypeCharCodeAt(value, i);
      if (code === 0 || code === 10 || code === 13) {
        throw new TypeError('Invalid header value for "' + name + '": "' + value + '"');
      }
    }
  }

  // Fetch spec "normalize a byte sequence" (https://fetch.spec.whatwg.org/#concept-header-value-normalize):
  // strip leading/trailing HTTP whitespace — tab (0x09), LF (0x0A), CR (0x0D),
  // space (0x20) — from a header value. undici applies this on the public
  // append/set path BEFORE validating, so a value like "\r\nfoo" normalizes to
  // "foo" and is accepted, while an interior CR/LF ("foo\r\nbar") survives the
  // trim and is then rejected by assertValidHeaderValue. Vertical tab / form
  // feed are not HTTP whitespace and are preserved. Wire (response) headers
  // arrive via _append and are not re-normalized — the transport already trims
  // OWS around values — matching undici, which fills response headers verbatim.
  //
  // A charCode trim, not `replaceAll(/…/g, '')`. The regex form was a live method
  // read on the RECEIVER, and a GLOBAL one: `RegExp.prototype[Symbol.replace]`
  // loops on RegExpExec and only advances `lastIndex` on an EMPTY match, so a
  // forged non-empty result never terminates. Measured on `bin/lava` before this
  // change: with `RegExp.prototype.exec` replaced, `new Headers().set('X-Ok','v')`
  // — a perfectly valid header — never returned, and a URL parse on the same path
  // reached 1.4 GB RSS in 4 s. That is a remote-triggerable DoS, because it runs
  // BEFORE assertValidHeaderName on every append and set.
  // Routing it through a captured `exec` would fix the steering but not the spin;
  // removing the RegExp removes both, and there is nothing left to poison.
  function normalizeHeaderValue(value) {
    var start = 0;
    var end = value.length;
    while (start < end && isHttpWhitespace(StringPrototypeCharCodeAt(value, start))) start++;
    while (end > start && isHttpWhitespace(StringPrototypeCharCodeAt(value, end - 1))) end--;
    return start === 0 && end === value.length ? value : StringPrototypeSlice(value, start, end);
  }

  // Tab, LF, CR, space — HTTP whitespace per the fetch spec. Vertical tab and form
  // feed are deliberately absent; they are not HTTP whitespace and must survive.
  function isHttpWhitespace(c) {
    return c === 0x09 || c === 0x0a || c === 0x0d || c === 0x20;
  }

  // Shared by Headers.append and Headers.set, which performed the identical
  // normalize→validate→coerce dance. Order matches undici: trim the value,
  // then reject a bad name, then reject a bad (trimmed) value. Returns the
  // cleaned name/value pair ready to store.
  function normalizeAndValidate(name, value) {
    var text = normalizeHeaderValue(String(value));
    var key = String(name);
    assertValidHeaderName(key);
    assertValidHeaderValue(key, text);
    return { name: key, value: text };
  }

  class Headers {
    constructor(init) {
      this._map = new Map();
      // Set-Cookie is the one header that must NOT be comma-joined: each
      // Set-Cookie is its own list entry (cookie Expires= values themselves
      // contain commas, so a join is lossy and corrupts them). It is held apart
      // from _map and exposed individually via getSetCookie(). See _append.
      this._cookies = [];
      if (init instanceof Headers) {
        init.forEach((value, key) => this.append(key, value));
      } else if (Array.isArray(init)) {
        for (var i = 0; i < init.length; i++) this.append(init[i][0], init[i][1]);
      } else if (init && typeof init === 'object') {
        var keys = Object.keys(init);
        for (var j = 0; j < keys.length; j++) this.append(keys[j], init[keys[j]]);
      }
    }
    append(name, value) {
      var header = normalizeAndValidate(name, value);
      this._append(header.name, header.value);
    }
    // _append stores without validation — for response headers parsed off the
    // wire, which the transport has already framed line-by-line. Set-Cookie is
    // appended to its own list (never comma-joined) so getSetCookie() can return
    // each cookie intact.
    _append(name, value) {
      var key = normalizeName(name);
      if (key === 'set-cookie') {
        this._cookies.push(String(value));
        return;
      }
      var existing = this._map.get(key);
      this._map.set(key, existing === undefined ? String(value) : existing + ', ' + value);
    }
    set(name, value) {
      var header = normalizeAndValidate(name, value);
      var key = normalizeName(header.name);
      if (key === 'set-cookie') {
        this._cookies = [header.value];
        return;
      }
      this._map.set(key, header.value);
    }
    get(name) {
      assertValidHeaderName(String(name));
      var key = normalizeName(name);
      // get('set-cookie') returns the cookies joined by ', ' (Node parity); the
      // separation is preserved only through getSetCookie().
      if (key === 'set-cookie') return this._cookies.length ? this._cookies.join(', ') : null;
      var v = this._map.get(key);
      return v === undefined ? null : v;
    }
    // getSetCookie returns each Set-Cookie value as its own string, uncorrupted
    // by comma-joining (WHATWG Headers.getSetCookie()).
    getSetCookie() {
      return this._cookies.slice();
    }
    has(name) {
      assertValidHeaderName(String(name));
      var key = normalizeName(name);
      if (key === 'set-cookie') return this._cookies.length > 0;
      return this._map.has(key);
    }
    delete(name) {
      assertValidHeaderName(String(name));
      var key = normalizeName(name);
      if (key === 'set-cookie') {
        this._cookies = [];
        return;
      }
      this._map.delete(key);
    }
    // _entryList snapshots all header entries — the comma-joined _map values plus
    // one entry per individual Set-Cookie — so iteration surfaces every cookie
    // separately (the spec does not combine Set-Cookie in the iterator).
    _entryList() {
      var out = [];
      this._map.forEach((value, key) => out.push([key, value]));
      for (var i = 0; i < this._cookies.length; i++) out.push(['set-cookie', this._cookies[i]]);
      return out;
    }
    forEach(callback, thisArg) {
      var entries = this._entryList();
      for (var i = 0; i < entries.length; i++) {
        callback.call(thisArg, entries[i][1], entries[i][0], this);
      }
    }
    keys() {
      return this._entryList()
        .map((e) => e[0])
        [Symbol.iterator]();
    }
    values() {
      return this._entryList()
        .map((e) => e[1])
        [Symbol.iterator]();
    }
    entries() {
      return this._entryList()[Symbol.iterator]();
    }
    [Symbol.iterator]() {
      return this._entryList()[Symbol.iterator]();
    }
  }

  // Body storage stays byte-exact; request bodies and response bytes must not
  // round-trip through latin1 text.
  function bodyToBytes(body) {
    if (body === null || body === undefined) return null;
    if (body instanceof Uint8Array) return body;
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    // A Blob/File body: join its in-memory chunks synchronously. Lava's Blob keeps
    // its bytes in memory (_parts), so no async read is needed; concatChunks yields
    // null for an empty Blob (absent body). A Blob used as a *request* body instead
    // takes Request's async _streamBody path and never reaches here.
    if (typeof Blob !== 'undefined' && body instanceof Blob) return concatChunks(body._parts || []);
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
  }

  class Response extends Body {
    constructor(body, init) {
      super(body);
      init = init || {};
      this.status = init.status === undefined ? 200 : init.status;
      this.statusText = init.statusText === undefined ? '' : init.statusText;
      this.headers = new Headers(init.headers);
      applyBlobContentType(this.headers, body);
      this.ok = this.status >= 200 && this.status < 300;
      this.redirected = false;
      this.type = 'default';
      this.url = init.url || '';
    }
    clone() {
      if (this.bodyUsed) throw new TypeError('Response body is already used');
      var clonedBody;
      if (this._bodyStream) {
        // Tee the live stream so both responses can be read independently.
        var branches = this._bodyStream.tee();
        this._bodyStream = branches[0];
        clonedBody = branches[1];
      } else {
        // In-memory body: share the Uint8Array (all reads are non-mutating —
        // text/json, and arrayBuffer/bytes copy out).
        clonedBody = this._bodyBytes;
      }
      var cloned = new Response(clonedBody, {
        status: this.status,
        statusText: this.statusText,
        headers: this.headers,
        url: this.url,
      });
      // The constructor resets these to their defaults (redirected=false,
      // type='default'); a clone must mirror the source's observable metadata —
      // e.g. a response produced by a followed redirect has redirected=true.
      cloned.redirected = this.redirected;
      cloned.type = this.type;
      return cloned;
    }
  }

  Response.json = function (data, init) {
    init = init || {};
    var headers = new Headers(init.headers);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    return new Response(JSON.stringify(data), {
      status: init.status,
      statusText: init.statusText,
      headers: headers,
    });
  };

  Response.error = function () {
    return new Response(null, { status: 0 });
  };

  // isStreamLikeBody recognizes a request body that cannot be turned into bytes
  // synchronously: a Blob, a ReadableStream (anything with getReader), or an async
  // iterable. These are collected asynchronously in fetch() before the request is
  // sent.
  function isStreamLikeBody(b) {
    if (b === null || b === undefined || typeof b === 'string') return false;
    if (b instanceof Uint8Array || b instanceof ArrayBuffer || ArrayBuffer.isView(b)) return false;
    if (typeof Blob !== 'undefined' && b instanceof Blob) return true;
    if (typeof b.getReader === 'function') return true;
    if (typeof b[Symbol.asyncIterator] === 'function') return true;
    return false;
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

  class Request extends Body {
    constructor(input, init) {
      init = init || {};
      // When input is another Request, its method/headers/body seed the new
      // one and init.* overrides them (WHATWG fetch). A string/URL input
      // contributes only the URL. We treat input as a Request when it carries
      // a string `url`, so URL objects (which stringify to their href) stay on
      // the string path.
      var src = input && typeof input === 'object' && typeof input.url === 'string' ? input : null;
      // Per spec, init.body overrides only when present and non-null; a null
      // or absent init.body keeps the source Request's body. A source's body may
      // be a streaming body (held in _streamBody, with _bodyBytes null), so
      // inherit that too — otherwise fetch(new Request(req)) would silently send
      // an empty body. (v1 caveat: the stream reference is shared, not teed, so
      // fetching both the source and the derived request is not supported.)
      var initBodyGiven = init.body !== undefined && init.body !== null;
      var bodyInit = initBodyGiven
        ? init.body
        : src
          ? src._streamBody != null
            ? src._streamBody
            : src._bodyBytes
          : init.body;

      // A streaming body (Blob / ReadableStream / async iterable) is held as-is
      // and materialized to bytes in fetch(); only buffered bodies go to Body.
      var streamBody = bodyInit != null && isStreamLikeBody(bodyInit) ? bodyInit : null;
      if (streamBody) {
        super(null);
        this._streamBody = streamBody;
        // Node requires duplex:'half' for a ReadableStream / async-iterable body;
        // a Blob is a known-length body and is exempt. The check is at construction
        // (where the duplex option lives) — only for a NEW init.body stream; a body
        // inherited from a source Request was already validated when it was built.
        this._streamNeedsDuplex = !(typeof Blob !== 'undefined' && streamBody instanceof Blob);
        if (this._streamNeedsDuplex && initBodyGiven && init.duplex !== 'half') {
          throw new TypeError('fetch: a streaming request body requires init.duplex to be "half"');
        }
      } else {
        super(bodyInit);
        this._streamBody = null;
        this._streamNeedsDuplex = false;
      }

      // Parse the URL through the WHATWG parser (Node parity): an absent base
      // means relative URLs, a non-numeric or out-of-range port, and other
      // malformed inputs all throw a TypeError here rather than silently
      // falling back to a default port in the native layer. A source Request's
      // url is already an absolute href, so this normalizes idempotently.
      var rawUrl = src ? src.url : String(input);
      // WHATWG fetch forbids credentials in a request URL. new URL() preserves any
      // userinfo (and the native parser silently drops it), so reject it here for
      // Node parity rather than connect to a host the visible URL can disguise
      // (e.g. "http://example.com@127.0.0.1/"). This also covers redirect-created
      // requests, since buildRedirectRequest resolves Location through new Request.
      var parsedUrl = new URL(rawUrl);
      if (parsedUrl.username || parsedUrl.password) {
        throw new TypeError('fetch: request URL cannot contain credentials');
      }
      this.url = parsedUrl.href;
      // redirect mode: 'follow' (default) | 'manual' | 'error'. init overrides a
      // source Request's mode (WHATWG fetch); fetch() consults it per response. The
      // value is coerced to a string (Web IDL enum semantics — Node accepts a String
      // object or any toString-able), a symbol throws (ToString throws), and an
      // unrecognized mode is a TypeError, not a silent 'follow'.
      var redirect = init.redirect !== undefined ? init.redirect : src ? src.redirect : 'follow';
      if (typeof redirect === 'symbol') throw new TypeError('fetch: invalid redirect mode');
      redirect = String(redirect);
      if (redirect !== 'follow' && redirect !== 'manual' && redirect !== 'error') {
        throw new TypeError("fetch: invalid redirect mode '" + redirect + "'");
      }
      this.redirect = redirect;
      var method = init.method !== undefined ? init.method : src ? src.method : 'GET';
      this.method = String(method || 'GET').toUpperCase();
      // A GET/HEAD request cannot carry a body, whether that body came from
      // init or was inherited from a source Request (WHATWG fetch).
      if (
        (this.method === 'GET' || this.method === 'HEAD') &&
        (this._bodyBytes != null || this._streamBody)
      ) {
        throw new TypeError('Request with GET/HEAD method cannot have body.');
      }
      var headersInit = init.headers !== undefined ? init.headers : src ? src.headers : undefined;
      this.headers = new Headers(headersInit);
      applyBlobContentType(this.headers, bodyInit);
    }
  }

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
    var req;
    try {
      req = new Request(input, init);
    } catch (error) {
      return Promise.reject(error);
    }

    if (!native || typeof native.request !== 'function') {
      return Promise.reject(new TypeError('fetch: native network backend unavailable'));
    }

    // Extract signal from init (not from the Request object, which doesn't
    // carry it — only the raw init dict does per the WHATWG fetch spec).
    var signal = init && init.signal != null ? init.signal : null;

    // Pre-aborted fast path: reject synchronously without touching the network.
    if (signal && signal.aborted) {
      return Promise.reject(signal.reason);
    }

    return runFetch(req, signal, 0, false);
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
  // Content-Length / Connection / Transfer-Encoding) the native side sets itself.
  function serializeHeaders(headers) {
    var headerLines = '';
    headers.forEach(function (value, key) {
      if (TRANSPORT_OWNED_HEADERS[key]) return;
      // Names/values were CR/LF/NUL-validated when set (see Headers.append), so a
      // header cannot split the request line here.
      headerLines += key + ': ' + String(value) + '\r\n';
    });
    return headerLines;
  }

  // sendOne issues a single HTTP exchange (no redirect handling) and resolves
  // with its Response. The body-framing branch matches fetch()'s contract:
  //   - a Blob (known length) keeps the buffered Content-Length fast path;
  //   - a ReadableStream / async-iterable (duplex:'half') streams as chunked;
  //   - any other body is sent buffered.
  function sendOne(req, signal) {
    var headerLines = serializeHeaders(req.headers);
    if (req._streamBody) {
      if (!req._streamNeedsDuplex) {
        return collectStreamBody(req._streamBody, signal).then(function (bytes) {
          return startFetch(req, headerLines, bytes, null, signal);
        });
      }
      return startFetch(req, headerLines, null, req._streamBody, signal);
    }
    return startFetch(req, headerLines, req._bodyBytes, null, signal);
  }

  // cancelBody discards a response body we will not surface (an intermediate
  // redirect): cancel() tears the transport stream down; a rejected teardown is
  // swallowed so it never surfaces as an unhandled rejection.
  function cancelBody(response) {
    if (!response.body) return;
    try {
      var canceled = response.body.cancel();
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
    return sendOne(req, signal).then(function (response) {
      if (!REDIRECT_STATUSES[response.status] || !response.headers.has('location')) {
        response.redirected = redirected;
        return response;
      }
      if (req.redirect === 'manual') {
        response.redirected = redirected;
        return response;
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
      var nextReq = buildRedirectRequest(req, response, response.headers.get('location'));
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

    var headers = new Headers(req.headers);
    if (dropBody) {
      for (var i = 0; i < BODY_HEADERS.length; i++) headers.delete(BODY_HEADERS[i]);
    }
    // Cross-origin redirect: strip credentials (WHATWG drops Authorization; undici
    // also drops Cookie / Proxy-Authorization when the origin changes).
    if (new URL(nextUrl).origin !== new URL(req.url).origin) {
      headers.delete('authorization');
      headers.delete('cookie');
      headers.delete('proxy-authorization');
    }

    var nextInit = { method: method, headers: headers, redirect: req.redirect };

    // A method-preserving redirect (307/308 with a body) must resend it. A Blob is
    // a known-length, replayable body — its bytes are read non-mutatingly (see
    // collectStreamBody), so resend the Blob itself; Node likewise resends it. A
    // ReadableStream / async-iterable was consumed by the first hop and cannot be
    // replayed, so the redirect fails (matching Node).
    if (!dropBody && method !== 'GET' && method !== 'HEAD') {
      if (req._streamBody) {
        if (typeof Blob !== 'undefined' && req._streamBody instanceof Blob) {
          nextInit.body = req._streamBody;
        } else {
          throw new TypeError(
            'fetch: cannot follow a redirect that resends a streaming request body',
          );
        }
      } else if (req._bodyBytes != null) {
        nextInit.body = req._bodyBytes;
      }
    }
    return new Request(nextUrl, nextInit);
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
        for (var i = 0; i + 1 < pairs.length; i += 2) headers._append(pairs[i], pairs[i + 1]);

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
          new Response(bodyArg, {
            status: raw.status,
            statusText: raw.statusText,
            headers: headers,
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

  if (globalThis.Headers === undefined) globalThis.Headers = Headers;
  if (globalThis.Request === undefined) globalThis.Request = Request;
  if (globalThis.Response === undefined) globalThis.Response = Response;
  if (globalThis.fetch === undefined) globalThis.fetch = fetch;

  module.exports = { fetch: fetch, Headers: Headers, Request: Request, Response: Response };
});
