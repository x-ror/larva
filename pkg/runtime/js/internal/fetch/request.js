// Request: input/init merging, the RequestInit conversions and checks, and the split
// between buffered and streaming request bodies — the Lava side of undici's
// lib/web/fetch/request.js.
//
// Errors follow the profile (docs/LARVA.md decision 1). On `.Web` they are Blink's,
// behind `Failed to construct 'Request': ` — or `Failed to execute 'fetch' on
// 'Window': ` when fetch() builds the Request, which is how Chrome reports the same
// checks there (Chrome 158, tests/web/cases/fetch-errors, fetch-webidl). `.Node` keeps
// the text it had and takes undici's for the checks it never made, until S5b deletes
// that arm.
(function (require, module) {
  'use strict';

  var P = require('internal/primordials');
  var StringP = P.String;
  var TypeErrorP = P.TypeError;
  var ObjectCreate = P.ObjectCreate;
  var ArrayPrototypeIncludes = P.ArrayPrototypeIncludes;
  var StringPrototypeToUpperCase = P.StringPrototypeToUpperCase;
  var reTest = P.RegExpMatches;

  var headersModule = require('internal/fetch/headers');
  var Headers = headersModule.Headers;
  var fillHeaders = headersModule.fillHeaders;
  var getRaw = headersModule.getRaw;
  var appendRaw = headersModule.appendRaw;
  var bodyModule = require('internal/fetch/body');
  var newState = bodyModule.newState;
  var stateOf = bodyModule.stateOf;
  var initBody = bodyModule.initBody;
  var bodyUsedOf = bodyModule.bodyUsedOf;
  var extractContentType = bodyModule.extractContentType;
  var extractFormData = bodyModule.extractFormData;
  var isStreamLikeBody = bodyModule.isStreamLikeBody;
  var isBlob = bodyModule.isBlob;
  var streamInternal = require('internal/webstreams/index')._internal;

  var webErrors = require('internal/web_errors');
  var context = webErrors.context;
  var pageError = webErrors.pageError;
  var illegalInvocation = webErrors.illegalInvocation;
  var argumentsRequired = webErrors.argumentsRequired;

  // fetch() passes this as the constructor's third argument, so the checks report
  // under fetch's context. A page cannot name it: the interface object forwards what
  // the page passed, and no page value is this object.
  var FETCH = { __proto__: null };
  var CTX_REQUEST = context('Request');
  var CTX_FETCH = context('Window', 'fetch');
  var CTX_CLONE = context('Request', 'clone');

  var MODES = ['same-origin', 'no-cors', 'cors', 'navigate'];
  var CREDENTIALS = ['omit', 'same-origin', 'include'];
  var CACHES = ['default', 'no-store', 'reload', 'no-cache', 'force-cache', 'only-if-cached'];
  var REDIRECTS = ['follow', 'error', 'manual'];
  var DUPLEXES = ['half'];
  var REFERRER_POLICIES = [
    '',
    'no-referrer',
    'no-referrer-when-downgrade',
    'same-origin',
    'origin',
    'strict-origin',
    'origin-when-cross-origin',
    'strict-origin-when-cross-origin',
    'unsafe-url',
  ];
  // The fetch standard's forbidden methods, and the ones it normalizes to upper case
  // (any other method keeps its case: `patch` stays `patch`, Chrome 158).
  var FORBIDDEN_METHODS = ['CONNECT', 'TRACE', 'TRACK'];
  var NORMALIZED_METHODS = ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'POST', 'PUT'];
  var METHOD_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
  var EMPTY_INIT = { __proto__: null };

  // A TypeError for a page: `ctx` + Blink's detail.
  function requestError(ctx, detail) {
    return pageError(new TypeErrorP(ctx + detail));
  }

  // RequestInit's enum members: the values each allows and its IDL type.
  var ENUMS = {
    __proto__: null,
    cache: [CACHES, 'RequestCache'],
    credentials: [CREDENTIALS, 'RequestCredentials'],
    duplex: [DUPLEXES, 'RequestDuplex'],
    mode: [MODES, 'RequestMode'],
    redirect: [REDIRECTS, 'RequestRedirect'],
    referrerPolicy: [REFERRER_POLICIES, 'ReferrerPolicy'],
  };

  // Reads the enum member `member` of `init` as WebIDL converts it: absent stays
  // undefined, anything else goes through ToString and must be one of its values.
  function enumMember(init, member, ctx) {
    var value = init[member];
    if (value === undefined) return undefined;
    var spec = ENUMS[member];
    var prefix = "Failed to read the '" + member + "' property from 'RequestInit': ";
    if (typeof value === 'symbol') {
      var symbol = 'Cannot convert a Symbol value to a string';
      throw requestError(ctx, prefix + symbol);
    }

    var s = StringP(value);
    if (!ArrayPrototypeIncludes(spec[0], s)) {
      var detail =
        "The provided value '" + s + "' is not a valid enum value of type " + spec[1] + '.';
      throw requestError(ctx, prefix + detail);
    }

    return s;
  }

  function toUSVString(value, ctx) {
    if (typeof value === 'symbol') {
      throw requestError(ctx, 'Cannot convert a Symbol value to a string');
    }

    return StringP(value);
  }

  // The method member: a token, not a forbidden method, normalized when it is one of
  // the six the fetch standard upper-cases.
  function checkMethod(value, ctx) {
    var method = toUSVString(value, ctx);
    if (!reTest(METHOD_TOKEN, method)) {
      var invalid = "'" + method + "' is not a valid HTTP method.";
      throw requestError(ctx, invalid);
    }

    var upper = StringPrototypeToUpperCase(method);
    if (ArrayPrototypeIncludes(FORBIDDEN_METHODS, upper)) {
      var forbidden = "'" + method + "' HTTP method is unsupported.";
      throw requestError(ctx, forbidden);
    }

    return ArrayPrototypeIncludes(NORMALIZED_METHODS, upper) ? upper : method;
  }

  // A request URL is parsed against the page's URL, as Fetch's "API base URL" is the
  // document's (`fetch('/data')` on https://a.example/x asks https://a.example/data);
  // without one (`lava run` with no --origin) a relative URL fails, as before.
  function parseURL(text) {
    try {
      var URLCtor = require('internal/url').URL;
      var base = require('internal/blob').pageURL();
      return base === '' ? new URLCtor(text) : new URLCtor(text, base);
    } catch {
      return null;
    }
  }

  function requestState(target) {
    var state = stateOf(target, 'Request');
    if (state === undefined) throw illegalInvocation();
    return state;
  }

  /**
   * Request (fetch standard). Reached by a page through internal/native_shape's
   * interface object; fetch() constructs it directly with FETCH as `via`.
   * @param {Request|string} input
   * @param {object} [init] RequestInit, its members read in WebIDL's (lexicographic)
   *   order.
   * @throws {TypeError} Blink's text behind the constructor's (or fetch's) context:
   *   an enum member out of range, a URL that does not parse or carries credentials,
   *   a method that is not a token or is forbidden, mode 'navigate', 'only-if-cached'
   *   outside 'same-origin', a body on GET/HEAD, a used source Request, a stream body
   *   without `duplex`.
   * @node Chrome 158 (tests/web/cases/fetch-errors, fetch-webidl, fetch-classes):
   *   defaults mode 'cors', credentials 'same-origin', cache 'default', referrer
   *   'about:client', targetAddressSpace 'unknown'.
   * @deviates A relative URL does not resolve against the page's base URL (Larva has
   *   no document URL yet); `signal` follows init's signal but is a new signal, as
   *   Chrome's, made on first read. Headers have no "request" guard: a forbidden
   *   request header is kept, not dropped.
   */
  class Request {
    constructor(input, init, via) {
      var ctx = via === FETCH ? CTX_FETCH : CTX_REQUEST;
      if (arguments.length === 0) {
        throw requestError(ctx, argumentsRequired(1, 0));
      }

      var src = stateOf(input, 'Request');
      var inputString = src === undefined ? toUSVString(input, ctx) : null;
      if (init === undefined || init === null) {
        init = EMPTY_INIT;
      } else if (typeof init !== 'object' && typeof init !== 'function') {
        throw requestError(ctx, "The provided value is not of type 'RequestInit'.");
      }

      // The dictionary conversion, which Blink runs before the constructor body: every
      // member read once, in lexicographic order, its enum checked as it is read.
      var bodyInit = init.body;
      var cache = enumMember(init, 'cache', ctx);
      var credentials = enumMember(init, 'credentials', ctx);
      var duplex = enumMember(init, 'duplex', ctx);
      var headersInit = init.headers;
      var integrity = init.integrity;
      if (integrity !== undefined) {
        integrity = toUSVString(integrity, ctx);
      }

      var keepalive = init.keepalive;
      var method = init.method;
      if (method !== undefined) {
        method = toUSVString(method, ctx);
      }

      var mode = enumMember(init, 'mode', ctx);
      var redirect = enumMember(init, 'redirect', ctx);
      var referrer = init.referrer;
      if (referrer !== undefined) {
        referrer = toUSVString(referrer, ctx);
      }

      var referrerPolicy = enumMember(init, 'referrerPolicy', ctx);
      var signal = init.signal;

      // The URL: a source Request's, or the input parsed. WHATWG fetch forbids
      // credentials in a request URL; new URL() preserves any userinfo (and the
      // native parser silently drops it), so reject it here rather than connect to a
      // host the visible URL can disguise ("http://example.com@127.0.0.1/"). This also
      // covers redirect-created requests, since buildRedirectRequest resolves Location
      // through new Request.
      var url;
      if (src !== undefined) {
        url = src.url;
      } else {
        var parsed = parseURL(inputString);
        if (parsed === null) {
          throw requestError(ctx, 'Failed to parse URL from ' + inputString);
        }

        if (parsed.username || parsed.password) {
          throw requestError(
            ctx,
            'Request cannot be constructed from a URL that includes credentials: ' + inputString,
          );
        }

        url = parsed.href;
      }

      if (mode === 'navigate') {
        var navigate =
          "Cannot construct a Request with a RequestInit whose mode member is set as 'navigate'.";
        throw requestError(ctx, navigate);
      }

      if (mode === undefined) mode = src !== undefined ? src.mode : 'cors';
      if (credentials === undefined) {
        credentials = src !== undefined ? src.credentials : 'same-origin';
      }

      if (cache === undefined) cache = src !== undefined ? src.cache : 'default';
      if (cache === 'only-if-cached' && mode !== 'same-origin') {
        var cached = "'only-if-cached' can be set only with 'same-origin' mode";
        throw requestError(ctx, cached);
      }

      if (redirect === undefined) redirect = src !== undefined ? src.redirect : 'follow';
      method =
        method !== undefined ? checkMethod(method, ctx) : src !== undefined ? src.method : 'GET';

      var headers = new Headers();
      if (headersInit !== undefined) fillHeaders(headers, headersInit, ctx);
      else if (src !== undefined) fillHeaders(headers, src.headers, ctx);

      // The body: init's when present and non-null, else the source Request's. A
      // streaming source body (held in streamBody) is inherited too — otherwise
      // fetch(new Request(req)) would silently send an empty body. (v1 caveat: the
      // stream reference is shared, not teed, so fetching both the source and the
      // derived request is not supported.)
      var initBodyGiven = bodyInit !== undefined && bodyInit !== null;
      // A FormData is its multipart bytes from here on; its type carries the boundary.
      var form = initBodyGiven ? extractFormData(bodyInit) : null;
      if (form !== null) bodyInit = form.bytes;
      var inputBody =
        src === undefined ? null : src.streamBody !== null ? src.streamBody : src.bodyBytes;
      if (inputBody === undefined) inputBody = null;
      if ((initBodyGiven || inputBody !== null) && (method === 'GET' || method === 'HEAD')) {
        var getBody = 'Request with GET/HEAD method cannot have body.';
        throw requestError(ctx, getBody);
      }

      if (!initBodyGiven && inputBody !== null && bodyUsedOf(src)) {
        var used = 'Cannot construct a Request with a Request object that has already been used.';
        throw requestError(ctx, used);
      }

      var body = initBodyGiven ? bodyInit : inputBody;
      // A streaming body (Blob / ReadableStream / async iterable) is held as-is and
      // materialized in fetch(). A ReadableStream or async iterable needs duplex
      // 'half'; a Blob is a known-length body and is exempt. Checked only for a NEW
      // init.body: an inherited one was checked when its Request was built.
      var streamBody = body !== null && isStreamLikeBody(body) ? body : null;
      var needsDuplex = streamBody !== null && !isBlob(streamBody);
      if (needsDuplex && initBodyGiven && duplex !== 'half') {
        throw requestError(
          ctx,
          'The `duplex` member must be specified for a request with a streaming body',
        );
      }

      if (initBodyGiven) {
        var type = form !== null ? form.type : extractContentType(bodyInit);
        if (type !== null && getRaw(headers, 'content-type') === null) {
          appendRaw(headers, 'content-type', type);
        }
      }

      var state = newState(this, 'Request');
      // The readers see a Blob's bytes and a ReadableStream itself; a Lava-only async
      // iterable is reachable through fetch() alone.
      initBody(
        state,
        streamBody !== null && !isBlob(streamBody) && !streamInternal.isReadableStream(streamBody)
          ? null
          : body,
      );
      state.headers = headers;
      state.streamBody = streamBody;
      state.streamNeedsDuplex = needsDuplex;
      state.url = url;
      state.method = method;
      state.mode = mode;
      state.credentials = credentials;
      state.cache = cache;
      state.redirect = redirect;
      state.integrity =
        integrity !== undefined ? integrity : src !== undefined ? src.integrity : '';
      state.keepalive =
        keepalive !== undefined ? !!keepalive : src !== undefined ? src.keepalive : false;
      state.referrerPolicy =
        referrerPolicy !== undefined ? referrerPolicy : src !== undefined ? src.referrerPolicy : '';
      state.referrer = referrerOf(referrer, src);
      // The signal this Request follows (init's, else the source's); `signal` makes
      // the Request's own on first read.
      state.followSignal =
        signal !== undefined ? signal : src !== undefined ? src.followSignal : null;
      state.signal = null;
    }

    get method() {
      return requestState(this).method;
    }

    get url() {
      return requestState(this).url;
    }

    get headers() {
      return requestState(this).headers;
    }

    get destination() {
      requestState(this);
      return '';
    }

    get referrer() {
      return requestState(this).referrer;
    }

    get referrerPolicy() {
      return requestState(this).referrerPolicy;
    }

    get mode() {
      return requestState(this).mode;
    }

    get credentials() {
      return requestState(this).credentials;
    }

    get cache() {
      return requestState(this).cache;
    }

    get redirect() {
      return requestState(this).redirect;
    }

    get integrity() {
      return requestState(this).integrity;
    }

    get keepalive() {
      return requestState(this).keepalive;
    }

    get signal() {
      var state = requestState(this);
      if (state.signal === null) {
        var AbortSignal = require('internal/abort').AbortSignal;
        state.signal =
          state.followSignal !== null && state.followSignal !== undefined
            ? AbortSignal.any([state.followSignal])
            : AbortSignal.any([]);
      }

      return state.signal;
    }

    get duplex() {
      requestState(this);
      return 'half';
    }

    get isHistoryNavigation() {
      requestState(this);
      return false;
    }

    clone() {
      var state = stateOf(this, 'Request');
      if (state === undefined) throw requestError(CTX_CLONE, 'Illegal invocation');
      if (bodyUsedOf(state)) {
        throw requestError(CTX_CLONE, 'Request body is already used');
      }

      var copy = ObjectCreate(Request.prototype);
      var next = newState(copy, 'Request');
      var keys = COPIED_FIELDS;
      for (var i = 0; i < keys.length; i++) next[keys[i]] = state[keys[i]];
      next.headers = new Headers();
      fillHeaders(next.headers, state.headers, CTX_CLONE);
      next.signal = null;
      next.followSignal = state.signal !== null ? state.signal : state.followSignal;
      if (state.bodyStream) {
        // Tee the stream so both requests can be read independently.
        var branches = state.bodyStream.tee();
        state.bodyStream = branches[0];
        next.bodyStream = branches[1];
        if (state.streamBody !== null && streamInternal.isReadableStream(state.streamBody)) {
          state.streamBody = branches[0];
          next.streamBody = branches[1];
        }
      }

      return copy;
    }

    get targetAddressSpace() {
      requestState(this);
      return 'unknown';
    }

    get isReloadNavigation() {
      requestState(this);
      return false;
    }
  }

  var COPIED_FIELDS = [
    'bodyBytes',
    'bodyStream',
    'streamBody',
    'streamNeedsDuplex',
    'url',
    'method',
    'mode',
    'credentials',
    'cache',
    'redirect',
    'integrity',
    'keepalive',
    'referrerPolicy',
    'referrer',
  ];

  // The referrer attribute: '' for "no-referrer", 'about:client' by default, else the
  // parsed URL. Without a page origin there is no same-origin check to fall back on.
  function referrerOf(referrer, src) {
    if (referrer === undefined) return src !== undefined ? src.referrer : 'about:client';
    if (referrer === '') return '';
    var parsed = parseURL(referrer);
    return parsed === null ? 'about:client' : parsed.href;
  }

  bodyModule.defineBody(Request.prototype, 'Request');

  module.exports = {
    Request: Request,
    FETCH: FETCH,
    requestState: requestState,
    // For XMLHttpRequest's open() (internal/xhr), which reports its own errors.
    FORBIDDEN_METHODS: FORBIDDEN_METHODS,
    NORMALIZED_METHODS: NORMALIZED_METHODS,
  };
});
