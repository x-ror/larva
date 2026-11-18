// Response and its statics (Response.json, Response.error) — the Lava side of undici's
// lib/web/fetch/response.js.
(function (require, module) {
  'use strict';

  var Headers = require('internal/fetch/headers').Headers;
  var bodyModule = require('internal/fetch/body');
  var Body = bodyModule.Body;
  var applyBlobContentType = bodyModule.applyBlobContentType;

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

  module.exports = { Response: Response };
});
