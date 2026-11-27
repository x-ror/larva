// Response and its statics (Response.json, Response.error, Response.redirect) — the
// Lava side of undici's lib/web/fetch/response.js.
//
// Errors follow the profile (docs/LARVA.md decision 1). On `.Web` they are Blink's,
// behind `Failed to construct 'Response': ` or the static's own context (Chrome 158,
// tests/web/cases/fetch-errors, fetch-webidl). `.Node` keeps the text it had and takes
// undici's for the checks it never made, until S5b deletes that arm.
(function (require, module) {
  'use strict';

  var P = require('internal/primordials');
  var StringP = P.String;
  var NumberP = P.Number;
  var TypeErrorP = P.TypeError;
  var RangeErrorP = P.RangeError;
  var ArrayPrototypeIncludes = P.ArrayPrototypeIncludes;
  var JSONStringify = P.JSONStringify;
  var MathFloor = P.MathFloor;
  var StringPrototypeCharCodeAt = P.StringPrototypeCharCodeAt;

  var headersModule = require('internal/fetch/headers');
  var Headers = headersModule.Headers;
  var fillHeaders = headersModule.fillHeaders;
  var getRaw = headersModule.getRaw;
  var appendRaw = headersModule.appendRaw;
  var freezeHeaders = headersModule.freezeHeaders;
  var bodyModule = require('internal/fetch/body');
  var newState = bodyModule.newState;
  var stateOf = bodyModule.stateOf;
  var initBody = bodyModule.initBody;
  var bodyUsedOf = bodyModule.bodyUsedOf;
  var extractContentType = bodyModule.extractContentType;
  var extractFormData = bodyModule.extractFormData;

  var webErrors = require('internal/web_errors');
  var context = webErrors.context;
  var pageError = webErrors.pageError;
  var illegalInvocation = webErrors.illegalInvocation;

  // The constructor's third argument, which a page cannot name (the interface object
  // forwards only what the page passed): INTERNAL builds a Response the platform made
  // — a fetched one, an error, a clone — skipping the init checks and taking
  // `type`/`url`/`redirected` and an adopted Headers; JSON runs the checks under
  // Response.json's context.
  var INTERNAL = { __proto__: null };
  var JSON_VIA = { __proto__: null };
  var CTX_RESPONSE = context('Response');
  var CTX_JSON = context('Response', 'json');
  var CTX_REDIRECT = context('Response', 'redirect');
  var CTX_CLONE = context('Response', 'clone');

  var NULL_BODY_STATUSES = [101, 103, 204, 205, 304];
  var REDIRECT_STATUSES = [301, 302, 303, 307, 308];
  // JSC's text for a BigInt in JSON.stringify, and V8's, which Chrome puts behind
  // Response.json's context.
  var JSC_BIGINT_MESSAGE = 'JSON.stringify cannot serialize BigInt.';
  var V8_BIGINT_MESSAGE = 'Do not know how to serialize a BigInt';

  function responseError(Ctor, ctx, detail) {
    return pageError(new Ctor(ctx + detail));
  }

  // WebIDL unsigned short: ToNumber, truncated, modulo 2^16.
  function toUnsignedShort(value) {
    var n = NumberP(value);
    if (n !== n || n === Infinity || n === -Infinity) return 0;
    n = n < 0 ? -MathFloor(-n) : MathFloor(n);
    n = n % 65536;
    return n < 0 ? n + 65536 : n;
  }

  // RFC 9110 reason-phrase: HTAB, SP, VCHAR and obs-text.
  function isReasonPhrase(text) {
    for (var i = 0; i < text.length; i++) {
      var c = StringPrototypeCharCodeAt(text, i);
      if (c !== 0x09 && (c < 0x20 || c === 0x7f || c > 0xff)) return false;
    }

    return true;
  }

  function responseState(target) {
    var state = stateOf(target, 'Response');
    if (state === undefined) throw illegalInvocation();
    return state;
  }

  /**
   * Response (fetch standard). Reached by a page through internal/native_shape's
   * interface object; the platform builds its own with INTERNAL as `via`.
   * @param {*} [body] BodyInit; a string gives Content-Type text/plain;charset=UTF-8.
   * @param {object} [init] ResponseInit: status (unsigned short), statusText, headers.
   * @throws {RangeError} `… The status provided (99) is outside the range [200, 599].`
   * @throws {TypeError} `… Invalid statusText`; `… Response with null body status
   *   cannot have body` — for any non-null body, '' included.
   * @node Chrome 158 (tests/web/cases/fetch-errors, fetch-webidl, fetch-classes).
   * @deviates A fetched Response's `type` is 'default' (Larva has no page origin to
   *   tell 'basic' from 'cors').
   */
  class Response {
    constructor(body, init, via) {
      var state = newState(this, 'Response');
      if (via === INTERNAL) {
        initBody(state, body);
        state.status = init.status;
        state.statusText = init.statusText === undefined ? '' : init.statusText;
        state.headers = init.headers;
        state.type = init.type === undefined ? 'default' : init.type;
        state.url = init.url === undefined ? '' : init.url;
        state.redirected = init.redirected === true;
        return;
      }

      var ctx = via === JSON_VIA ? CTX_JSON : CTX_RESPONSE;
      if (init === undefined || init === null) init = { __proto__: null };
      // ResponseInit's members in WebIDL's order: headers, status, statusText.
      var headersInit = init.headers;
      var status = init.status;
      status = status === undefined ? 200 : toUnsignedShort(status);
      var statusText = init.statusText;
      statusText = statusText === undefined ? '' : StringP(statusText);
      if (status < 200 || status > 599) {
        throw responseError(
          RangeErrorP,
          ctx,
          'The status provided (' + status + ') is outside the range [200, 599].',
        );
      }

      if (!isReasonPhrase(statusText)) {
        throw responseError(TypeErrorP, ctx, 'Invalid statusText');
      }

      var headers = new Headers();
      if (headersInit !== undefined) fillHeaders(headers, headersInit, ctx);
      var form = extractFormData(body);
      if (form !== null) body = form.bytes;
      if (body !== undefined && body !== null) {
        if (ArrayPrototypeIncludes(NULL_BODY_STATUSES, status)) {
          throw responseError(TypeErrorP, ctx, 'Response with null body status cannot have body');
        }

        // Response.json's body is typed application/json, any other the way the fetch
        // standard's "extract a body" types it.
        var type =
          via === JSON_VIA
            ? 'application/json'
            : form !== null
              ? form.type
              : extractContentType(body);
        if (type !== null && getRaw(headers, 'content-type') === null) {
          appendRaw(headers, 'content-type', type);
        }
      }

      initBody(state, body);
      state.status = status;
      state.statusText = statusText;
      state.headers = headers;
      state.type = 'default';
      state.url = '';
      state.redirected = false;
    }

    get type() {
      return responseState(this).type;
    }

    get url() {
      return responseState(this).url;
    }

    get redirected() {
      return responseState(this).redirected;
    }

    get status() {
      return responseState(this).status;
    }

    get ok() {
      var status = responseState(this).status;
      return status >= 200 && status < 300;
    }

    get statusText() {
      return responseState(this).statusText;
    }

    get headers() {
      return responseState(this).headers;
    }

    clone() {
      var state = stateOf(this, 'Response');
      if (state === undefined) {
        throw responseError(TypeErrorP, CTX_CLONE, 'Illegal invocation');
      }

      if (bodyUsedOf(state)) {
        throw responseError(TypeErrorP, CTX_CLONE, 'Response body is already used');
      }

      var clonedBody;
      if (state.bodyStream) {
        // Tee the live stream so both responses can be read independently.
        var branches = state.bodyStream.tee();
        state.bodyStream = branches[0];
        clonedBody = branches[1];
      } else {
        // In-memory body: share the Uint8Array (all reads are non-mutating —
        // text/json, and arrayBuffer/bytes copy out).
        clonedBody = state.bodyBytes;
      }

      var headers = new Headers();
      fillHeaders(headers, state.headers, CTX_CLONE);
      headers._guard = state.headers._guard;
      return makeResponse(clonedBody, {
        __proto__: null,
        status: state.status,
        statusText: state.statusText,
        headers: headers,
        type: state.type,
        url: state.url,
        redirected: state.redirected,
      });
    }

    /**
     * Response.error(): a network error — status 0, type 'error', immutable headers.
     * @node Chrome 158, tests/web/cases/fetch-classes.
     */
    static error() {
      return makeResponse(null, {
        __proto__: null,
        status: 0,
        headers: freezeHeaders(new Headers()),
        type: 'error',
      });
    }

    /**
     * Response.json(data, init): `data` serialized, Content-Type application/json
     * unless init sets one, init checked as the constructor does under json's context.
     * @throws {TypeError} `Failed to execute 'json' on 'Response': The data is not
     *   JSON serializable` (undefined, a function); JSON.stringify's own error
     *   otherwise, behind the same context.
     * @node Chrome 158 (tests/web/cases/fetch-errors).
     * @deviates A serialization error other than a BigInt's (a cycle) carries JSC's
     *   message, not V8's: only the BigInt text is mapped, since it is the one a case
     *   pins and V8's cycle text names the path through the object.
     */
    static json(data, init) {
      var text;
      try {
        text = JSONStringify(data);
      } catch (e) {
        var message = StringP(e && e.message);
        throw responseError(
          TypeErrorP,
          CTX_JSON,
          message === JSC_BIGINT_MESSAGE ? V8_BIGINT_MESSAGE : message,
        );
      }

      if (text === undefined) {
        throw responseError(TypeErrorP, CTX_JSON, 'The data is not JSON serializable');
      }

      return new Response(text, init, JSON_VIA);
    }

    /**
     * Response.redirect(url, status = 302): a redirect to `url` with immutable headers.
     * @throws {TypeError} `Failed to execute 'redirect' on 'Response': Failed to parse
     *   URL from <url>`.
     * @throws {RangeError} `… Invalid status code` for a status that is not a redirect.
     * @node Chrome 158, probed: status, Location, type 'default', url '', body null.
     * @deviates `url` does not resolve against the page's base URL (no document URL).
     */
    static redirect(url, status) {
      var text = StringP(url);
      var parsed;
      try {
        parsed = new (require('internal/url').URL)(text);
      } catch (e) {
        throw responseError(TypeErrorP, CTX_REDIRECT, 'Failed to parse URL from ' + text);
      }

      var code = status === undefined ? 302 : toUnsignedShort(status);
      if (!ArrayPrototypeIncludes(REDIRECT_STATUSES, code)) {
        throw responseError(RangeErrorP, CTX_REDIRECT, 'Invalid status code');
      }

      var headers = new Headers();
      appendRaw(headers, 'location', parsed.href);
      return makeResponse(null, {
        __proto__: null,
        status: code,
        headers: freezeHeaders(headers),
      });
    }
  }

  /**
   * Builds a Response the platform made: `opts.headers` is adopted as is and no init
   * check runs. `opts`: status, statusText, headers, type, url, redirected.
   */
  function makeResponse(body, opts) {
    return new Response(body, opts, INTERNAL);
  }

  bodyModule.defineBody(Response.prototype, 'Response');

  module.exports = {
    Response: Response,
    makeResponse: makeResponse,
    responseState: responseState,
  };
});
