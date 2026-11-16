// Request: input/init merging, URL and redirect-mode validation, and the split
// between buffered and streaming request bodies — the Lava side of undici's
// lib/web/fetch/request.js.
(function (require, module) {
  'use strict';

  var Headers = require('internal/fetch/headers').Headers;
  var bodyModule = require('internal/fetch/body');
  var Body = bodyModule.Body;
  var applyBlobContentType = bodyModule.applyBlobContentType;

  // isStreamLikeBody recognizes a request body that cannot be turned into bytes
  // synchronously: a Blob, a ReadableStream (anything with getReader), or an async
  // iterable. These are collected asynchronously in fetch() before the request is
  // sent (see the v1 limitation note in reference/node-compatibility.md).
  function isStreamLikeBody(b) {
    if (b === null || b === undefined || typeof b === 'string') return false;
    if (b instanceof Uint8Array || b instanceof ArrayBuffer || ArrayBuffer.isView(b)) return false;
    if (typeof Blob !== 'undefined' && b instanceof Blob) return true;
    if (typeof b.getReader === 'function') return true;
    if (typeof b[Symbol.asyncIterator] === 'function') return true;
    return false;
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

  module.exports = { Request: Request };
});
