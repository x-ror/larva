/**
 * @fileoverview XMLHttpRequest (XHR Standard), XMLHttpRequestEventTarget,
 * XMLHttpRequestUpload and ProgressEvent, installed as globals at module-eval (#13).
 *
 * The transport is fetch's: send() builds a RequestInit and calls the same fetch
 * operation a page reaches (internal/fetch), then reads the Response's state and body
 * stream through the fetch modules' internal functions — no native of its own. What
 * XHR adds is the state machine on top: readyState, the event sequence, the timeout,
 * and the response decoders.
 *
 * The oracle is Chrome 158 (tests/web/cases/xhr-basic, xhr-events, xhr-errors,
 * shape-xhr). Where Chrome and the standard part ways, this follows Chrome:
 *   - an abort or a timeout fires `<type>` and `loadend` at the upload object
 *     whenever the upload has not completed, a body-less GET included, where the
 *     standard marks a null-body upload complete at send(); a network error of a
 *     body-less request fires nothing there;
 *   - `readystatechange` fires once on entering LOADING, and `progress` on the first
 *     body chunk, then at most every 50 ms, then once more at the end of the body when
 *     bytes arrived since the last one.
 *
 * Instantiated eagerly (the loader names it after internal/url), so every capture
 * below is pristine.
 *
 * @module lava/internal/xhr
 */

(function (require, module) {
  'use strict';

  var P = require('internal/primordials');
  var webErrors = require('internal/web_errors');
  var nativeShape = require('internal/native_shape');
  var eventTarget = require('internal/event_target');
  var DOMException = require('internal/domexception').DOMException;
  var blobModule = require('internal/blob');
  var fetchModule = require('internal/fetch');
  var headersModule = require('internal/fetch/headers');
  var requestModule = require('internal/fetch/request');
  var responseModule = require('internal/fetch/response');
  var bodyModule = require('internal/fetch/body');
  var formDataModule = require('internal/formdata');
  var abortModule = require('internal/abort');
  var encoding = require('internal/encoding');
  var urlModule = require('internal/url');
  var webStreams = require('internal/webstreams/index');

  var ArrayBufferP = P.ArrayBuffer;
  var ArrayBufferIsView = P.ArrayBufferIsView;
  var ArrayPrototypeIncludes = P.ArrayPrototypeIncludes;
  var ArrayPrototypePush1 = P.ArrayPrototypePush1;
  var DateNow = Date.now;
  var JSONParse = P.JSONParse;
  var MathTrunc = P.MathTrunc;
  var NumberP = P.Number;
  var NumberIsFinite = P.NumberIsFinite;
  var ObjectGetOwnPropertyDescriptor = P.ObjectGetOwnPropertyDescriptor;
  var ReflectApply = P.ReflectApply;
  var StringP = P.String;
  var StringPrototypeCharCodeAt = P.StringPrototypeCharCodeAt;
  var StringPrototypeIndexOf = P.StringPrototypeIndexOf;
  var StringPrototypeSlice = P.StringPrototypeSlice;
  var StringPrototypeToLowerCase = P.StringPrototypeToLowerCase;
  var StringPrototypeToUpperCase = P.StringPrototypeToUpperCase;
  var TypeErrorP = P.TypeError;
  var TypedArrayPrototypeGetBuffer = P.TypedArrayPrototypeGetBuffer;
  var TypedArrayPrototypeGetByteLength = P.TypedArrayPrototypeGetByteLength;
  var TypedArrayPrototypeGetByteOffset = P.TypedArrayPrototypeGetByteOffset;
  var Uint8ArrayP = P.Uint8Array;
  var Uint8ArrayPrototypeSet = P.Uint8ArrayPrototypeSet;

  var argumentsRequired = webErrors.argumentsRequired;
  var attributeContext = webErrors.attributeContext;
  var context = webErrors.context;
  var illegalInvocation = webErrors.illegalInvocation;
  var pageError = webErrors.pageError;
  var toDOMString = webErrors.toDOMString;
  var typeError = webErrors.typeError;

  var EventImpl = eventTarget.EventImpl;
  var EventTargetImpl = eventTarget.EventTargetImpl;
  var EVENT_INTERNAL = eventTarget.EVENT_INTERNAL;
  var newEventState = eventTarget.newEventState;
  var readEventInit = eventTarget.readEventInit;
  var dispatchTrusted = eventTarget.dispatchTrusted;
  var fireEvent = eventTarget.fireEvent;
  var attachHandler = eventTarget.attachHandler;
  var detachHandler = eventTarget.detachHandler;

  var HeadersImpl = headersModule.Headers;
  var appendRawHeader = headersModule.appendRaw;
  var getRawHeader = headersModule.getRaw;
  var headerEntries = headersModule.entryList;
  var byteString = headersModule.byteString;
  var normalizeHeaderValue = headersModule.normalizeHeaderValue;
  var isValidHeaderName = headersModule.isValidHeaderName;
  var isValidHeaderValue = headersModule.isValidHeaderValue;
  var FORBIDDEN_METHODS = requestModule.FORBIDDEN_METHODS;
  var NORMALIZED_METHODS = requestModule.NORMALIZED_METHODS;
  var responseState = responseModule.responseState;
  var bodyStreamOf = bodyModule.bodyStreamOf;
  var concatChunks = bodyModule.concatChunks;
  var BlobImpl = blobModule.BlobImpl;

  // The operations this module calls on objects it made itself, captured at this
  // eager eval so a page that replaces a prototype member steers none of them. Each
  // is a native_shape wrapper (or an intrinsic) invoked through ReflectApply.
  var fetchOp = fetchModule.fetch;
  var URLCtor = urlModule.URL;
  var URLSearchParamsCtor = urlModule.URLSearchParams;
  var URLHrefGet = ObjectGetOwnPropertyDescriptor(URLCtor.prototype, 'href').get;
  var URLUsernameSet = ObjectGetOwnPropertyDescriptor(URLCtor.prototype, 'username').set;
  var URLPasswordSet = ObjectGetOwnPropertyDescriptor(URLCtor.prototype, 'password').set;
  var AbortControllerCtor = abortModule.AbortController;
  var AbortControllerAbort = AbortControllerCtor.prototype.abort;
  var AbortControllerSignalGet = ObjectGetOwnPropertyDescriptor(
    AbortControllerCtor.prototype,
    'signal',
  ).get;
  var ReadableStreamGetReader = webStreams.ReadableStream.prototype.getReader;
  var ReaderRead = webStreams.ReadableStreamDefaultReader.prototype.read;
  var TextEncoderCtor = encoding.TextEncoder;
  var TextEncoderEncode = TextEncoderCtor.prototype.encode;
  var TextDecoderCtor = encoding.TextDecoder;
  var TextDecoderDecode = TextDecoderCtor.prototype.decode;
  var PromiseThen = P.Promise.prototype.then;
  // The timers are installed natively before the module loader runs.
  var setTimeoutP = setTimeout;
  var clearTimeoutP = clearTimeout;

  var IFACE = 'XMLHttpRequest';
  var UNSENT = 0;
  var OPENED = 1;
  var HEADERS_RECEIVED = 2;
  var LOADING = 3;
  var DONE = 4;
  var STATES = {
    __proto__: null,
    UNSENT: UNSENT,
    OPENED: OPENED,
    HEADERS_RECEIVED: HEADERS_RECEIVED,
    LOADING: LOADING,
    DONE: DONE,
  };
  var STATE_NAMES = ['UNSENT', 'OPENED', 'HEADERS_RECEIVED', 'LOADING', 'DONE'];
  var RESPONSE_TYPES = ['', 'arraybuffer', 'blob', 'document', 'json', 'text'];
  // The XHR Standard's progress-event throttle.
  var PROGRESS_INTERVAL_MS = 50;
  var TEXT_PLAIN = 'text/plain;charset=UTF-8';
  var FORM_URLENCODED = 'application/x-www-form-urlencoded;charset=UTF-8';
  var HANDLER_TYPES = ['loadstart', 'progress', 'abort', 'error', 'load', 'timeout', 'loadend'];

  // The fetch standard's forbidden request-header names (Chromium's list, which still
  // holds user-agent), and the prefixes. A page's setRequestHeader of one is ignored
  // without an error, as Chrome does (Chrome logs to its DevTools console only).
  var FORBIDDEN_HEADERS = {
    __proto__: null,
    'accept-charset': true,
    'accept-encoding': true,
    'access-control-request-headers': true,
    'access-control-request-method': true,
    'access-control-request-private-network': true,
    connection: true,
    'content-length': true,
    cookie: true,
    cookie2: true,
    date: true,
    dnt: true,
    expect: true,
    host: true,
    'keep-alive': true,
    origin: true,
    referer: true,
    'set-cookie': true,
    te: true,
    trailer: true,
    'transfer-encoding': true,
    upgrade: true,
    'user-agent': true,
    via: true,
  };
  // Names whose value is a method: forbidden when that method is.
  var METHOD_OVERRIDE_HEADERS = {
    __proto__: null,
    'x-http-method': true,
    'x-http-method-override': true,
    'x-method-override': true,
  };

  // Hands internal arguments to the constructors below. Module-private: no page
  // argument is it.
  var INTERNAL = { __proto__: null };

  // Brand readers, assigned in the static blocks below.
  var handlersOf;
  var xhrState;
  var progressOf;

  function domError(message, name) {
    return pageError(new DOMException(message, name));
  }

  function invalidState(prefix, detail) {
    return domError(prefix + detail, 'InvalidStateError');
  }

  // WebIDL `unsigned long` (no [EnforceRange]): ToNumber, truncated, modulo 2^32.
  function toUnsignedLong(value) {
    var n = NumberP(value);
    if (!NumberIsFinite(n)) return 0;
    n = MathTrunc(n) % 4294967296;
    return n < 0 ? n + 4294967296 : n;
  }

  // WebIDL `double` (restricted): ToNumber, refusing NaN and the infinities.
  function toRestrictedDouble(value, member) {
    var n = NumberP(value);
    if (!NumberIsFinite(n)) {
      throw typeError(
        'ProgressEvent',
        undefined,
        attributeContext('ProgressEventInit', member, false) +
          'The provided double value is non-finite.',
      );
    }

    return n;
  }

  /**
   * new ProgressEvent(type, eventInitDict)
   * @param {*} type DOMString.
   * @param {{bubbles?: boolean, cancelable?: boolean, composed?: boolean,
   *   lengthComputable?: boolean, loaded?: number, total?: number}} [eventInitDict]
   * @throws {TypeError} as Event's, with `ProgressEvent` in the context and
   *   `ProgressEventInit` as the dictionary; `… Failed to read the 'loaded' property
   *   from 'ProgressEventInit': The provided double value is non-finite.`
   * @node Chrome 158 (tests/web/cases/xhr-events, xhr-errors): `loaded` and `total`
   *   are doubles, kept as given (5.9, -1); the members are read bubbles, cancelable,
   *   composed, lengthComputable, loaded, total.
   * @deviates none
   */
  class ProgressEvent extends EventImpl {
    #lengthComputable;
    #loaded;
    #total;

    constructor(type, eventInitDict) {
      var state;
      var lengthComputable = false;
      var loaded = 0;
      var total = 0;
      if (type === INTERNAL) {
        // eventInitDict is the platform's {type, lengthComputable, loaded, total}.
        state = newEventState(eventInitDict.type);
        lengthComputable = eventInitDict.lengthComputable;
        loaded = eventInitDict.loaded;
        total = eventInitDict.total;
      } else {
        if (arguments.length < 1) {
          throw typeError('ProgressEvent', undefined, argumentsRequired(1, 0));
        }

        state = newEventState(toDOMString(type, 'ProgressEvent'));
        readEventInit(state, eventInitDict, 'ProgressEvent', 'ProgressEventInit');
        if (eventInitDict !== undefined && eventInitDict !== null) {
          lengthComputable = !!eventInitDict.lengthComputable;
          var l = eventInitDict.loaded;
          if (l !== undefined) loaded = toRestrictedDouble(l, 'loaded');
          var t = eventInitDict.total;
          if (t !== undefined) total = toRestrictedDouble(t, 'total');
        }
      }

      super(EVENT_INTERNAL, state);
      this.#lengthComputable = lengthComputable;
      this.#loaded = loaded;
      this.#total = total;
    }

    get lengthComputable() {
      return progressOf(this).#lengthComputable;
    }

    get loaded() {
      return progressOf(this).#loaded;
    }

    get total() {
      return progressOf(this).#total;
    }

    static {
      progressOf = function (o) {
        if (typeof o !== 'object' || o === null || !(#loaded in o)) throw illegalInvocation();
        return o;
      };
    }
  }

  // Fires a trusted ProgressEvent at `target`.
  function fireProgress(target, type, lengthComputable, loaded, total) {
    var event = new ProgressEvent(INTERNAL, {
      __proto__: null,
      type: type,
      lengthComputable: lengthComputable,
      loaded: loaded,
      total: total,
    });
    dispatchTrusted(target, event);
  }

  // One reader per handler type, for attachHandler: the current handler, or null.
  var HANDLER_READERS = { __proto__: null };
  for (var h = 0; h < HANDLER_TYPES.length; h++)
    HANDLER_READERS[HANDLER_TYPES[h]] = readerFor(HANDLER_TYPES[h]);
  HANDLER_READERS.readystatechange = readerFor('readystatechange');

  function readerFor(type) {
    return function (target) {
      var entry = handlersOf(target)[type];
      return entry === undefined ? null : entry.fn;
    };
  }

  function getHandler(target, type) {
    var entry = handlersOf(target)[type];
    return entry === undefined ? null : entry.fn;
  }

  // HTML's event handler IDL attribute: a non-function is null; the listener takes
  // its place in the list when first set and keeps it while the handler changes
  // (internal/event_target attachHandler), as internal/abort's onabort.
  function setHandler(target, type, fn) {
    var handlers = handlersOf(target);
    var value = typeof fn === 'function' ? fn : null;
    var entry = handlers[type];
    if (value === null) {
      if (entry !== undefined) {
        detachHandler(target, type, entry.listener);
        delete handlers[type];
      }

      return;
    }

    if (entry === undefined) {
      handlers[type] = {
        __proto__: null,
        fn: value,
        listener: attachHandler(target, type, HANDLER_READERS[type]),
      };
    } else {
      entry.fn = value;
    }
  }

  /**
   * XMLHttpRequestEventTarget: the event handler attributes XMLHttpRequest and its
   * upload object share. A page cannot construct one ("Illegal constructor").
   * @node Chrome 158 (tests/web/cases/shape-xhr, xhr-events): a handler is a function
   *   or null; it runs in its place among the listeners.
   * @deviates An object that is not callable reads back as null, where Chrome keeps it
   *   ([LegacyTreatNonObjectAsNull]); internal/abort's onabort does the same.
   */
  class XMLHttpRequestEventTarget extends EventTargetImpl {
    // type -> {fn, listener}, for each handler attribute that is set.
    #handlers = { __proto__: null };

    constructor(token) {
      if (token !== INTERNAL) throw new TypeErrorP('Illegal constructor');
      super();
    }

    get onloadstart() {
      return getHandler(this, 'loadstart');
    }

    set onloadstart(fn) {
      setHandler(this, 'loadstart', fn);
    }

    get onprogress() {
      return getHandler(this, 'progress');
    }

    set onprogress(fn) {
      setHandler(this, 'progress', fn);
    }

    get onabort() {
      return getHandler(this, 'abort');
    }

    set onabort(fn) {
      setHandler(this, 'abort', fn);
    }

    get onerror() {
      return getHandler(this, 'error');
    }

    set onerror(fn) {
      setHandler(this, 'error', fn);
    }

    get onload() {
      return getHandler(this, 'load');
    }

    set onload(fn) {
      setHandler(this, 'load', fn);
    }

    get ontimeout() {
      return getHandler(this, 'timeout');
    }

    set ontimeout(fn) {
      setHandler(this, 'timeout', fn);
    }

    get onloadend() {
      return getHandler(this, 'loadend');
    }

    set onloadend(fn) {
      setHandler(this, 'loadend', fn);
    }

    static {
      handlersOf = function (o) {
        if (typeof o !== 'object' || o === null || !(#handlers in o)) throw illegalInvocation();
        return o.#handlers;
      };
    }
  }

  /**
   * XMLHttpRequestUpload: `xhr.upload`, the target of the request body's events.
   * @node Chrome 158 (tests/web/cases/xhr-events): loadstart in send(), then progress,
   *   load and loadend once the body is sent, before readystatechange to
   *   HEADERS_RECEIVED; a request error fires its type and loadend here first.
   * @deviates The upload events fire whether or not the upload object had a listener
   *   when send() ran (the standard's "upload listener flag"): a listener added after
   *   send() still hears them. Upload progress is one event at the end of the body,
   *   since the transport reports none in between.
   */
  class XMLHttpRequestUpload extends XMLHttpRequestEventTarget {
    constructor(token) {
      super(token);
    }
  }

  function newRecord(upload) {
    return {
      __proto__: null,
      upload: upload,
      state: UNSENT,
      // Bumped by open(), abort() and a request error: an async step that started
      // under an older generation has been overtaken and does nothing.
      gen: 0,
      sendFlag: false,
      sync: false,
      method: 'GET',
      url: '',
      headers: null,
      timeout: 0,
      timer: null,
      sendTime: 0,
      withCredentials: false,
      responseType: '',
      overrideMime: null,
      controller: null,
      uploadBody: false,
      uploadTotal: 0,
      uploadComplete: false,
      // The response: null until the head arrives, and after a network error.
      response: null,
      chunks: [],
      loaded: 0,
      total: 0,
      lengthComputable: false,
      progressTime: -Infinity,
      progressLoaded: 0,
      // The response object, made once for a non-text responseType.
      object: undefined,
      textCache: '',
      textLoaded: -1,
    };
  }

  function resetResponse(x) {
    x.response = null;
    x.chunks = [];
    x.loaded = 0;
    x.total = 0;
    x.lengthComputable = false;
    x.progressTime = -Infinity;
    x.progressLoaded = 0;
    x.object = undefined;
    x.textCache = '';
    x.textLoaded = -1;
  }

  // Stops whatever the current fetch is doing, without any event: the transport is
  // torn down and every pending step of it is made stale.
  function terminate(x) {
    x.gen++;
    if (x.timer !== null) {
      clearTimeoutP(x.timer);
      x.timer = null;
    }

    var controller = x.controller;
    if (controller !== null) {
      x.controller = null;
      ReflectApply(AbortControllerAbort, controller, []);
    }
  }

  /**
   * new XMLHttpRequest()
   * @node Chrome 158 (tests/web/cases/xhr-basic, xhr-events, xhr-errors, shape-xhr):
   *   the readyState walk and the event order of a load, an abort at each state, a
   *   network error and a timeout; getAllResponseHeaders() lowercased, sorted and
   *   combined, without Set-Cookie; Blink's error text for every refusal.
   * @deviates Synchronous requests (`open(…, false)`) are refused by send() with a
   *   NotSupportedError, where Chrome blocks the page until the response is in: a
   *   known gap, tests/web/cases/xhr-sync. responseXML is always null and
   *   responseType 'document' answers null: Larva builds no Document from a response.
   *   No CORS: a cross-origin request is sent as a same-origin one, and
   *   withCredentials is stored only (no cookie jar). A relative URL resolves against
   *   the embedder's origin (`lava run --origin=`), not the document's URL.
   *   responseText decodes with the response's charset, else UTF-8 — no HTML or XML
   *   encoding sniffing. setPrivateToken() checks its argument count only.
   */
  class XMLHttpRequest extends XMLHttpRequestEventTarget {
    #x;

    constructor() {
      super(INTERNAL);
      this.#x = newRecord(new XMLHttpRequestUpload(INTERNAL));
    }

    get onreadystatechange() {
      xhrState(this);
      return getHandler(this, 'readystatechange');
    }

    set onreadystatechange(fn) {
      xhrState(this);
      setHandler(this, 'readystatechange', fn);
    }

    get readyState() {
      return xhrState(this).state;
    }

    get timeout() {
      return xhrState(this).timeout;
    }

    set timeout(value) {
      var x = xhrState(this);
      var ms = toUnsignedLong(value);
      if (x.sync) {
        throw domError(
          attributeContext(IFACE, 'timeout', true) +
            'Timeouts cannot be set for synchronous requests made from a document.',
          'InvalidAccessError',
        );
      }

      x.timeout = ms;
      // The standard measures the timeout from send(): a change while the request is
      // in flight applies to the time already spent.
      if (x.sendFlag) scheduleTimeout(this, x);
    }

    get withCredentials() {
      return xhrState(this).withCredentials;
    }

    set withCredentials(value) {
      var x = xhrState(this);
      var flag = !!value;
      if ((x.state !== UNSENT && x.state !== OPENED) || x.sendFlag) {
        throw invalidState(
          attributeContext(IFACE, 'withCredentials', true),
          "The value may only be set if the object's state is UNSENT or OPENED.",
        );
      }

      x.withCredentials = flag;
    }

    get upload() {
      return xhrState(this).upload;
    }

    get responseURL() {
      var x = xhrState(this);
      if (x.response === null) return '';
      var url = x.response.url;
      var hash = StringPrototypeIndexOf(url, '#', 0);
      return hash === -1 ? url : StringPrototypeSlice(url, 0, hash);
    }

    get status() {
      var x = xhrState(this);
      return x.response === null ? 0 : x.response.status;
    }

    get statusText() {
      var x = xhrState(this);
      return x.response === null ? '' : x.response.statusText;
    }

    get responseType() {
      return xhrState(this).responseType;
    }

    set responseType(value) {
      var x = xhrState(this);
      var type = toDOMString(value, IFACE);
      // An enum value outside the list is ignored before the setter runs (WebIDL).
      if (!ArrayPrototypeIncludes(RESPONSE_TYPES, type)) return;
      if (x.state === LOADING || x.state === DONE) {
        throw invalidState(
          attributeContext(IFACE, 'responseType', true),
          "The response type cannot be set if the object's state is LOADING or DONE.",
        );
      }

      if (x.sync) {
        throw domError(
          attributeContext(IFACE, 'responseType', true) +
            'The response type cannot be changed for synchronous requests made from a document.',
          'InvalidAccessError',
        );
      }

      x.responseType = type;
    }

    get response() {
      var x = xhrState(this);
      var type = x.responseType;
      if (type === '' || type === 'text') return responseText(x);
      if (x.state !== DONE || x.response === null) return null;
      if (x.object !== undefined) return x.object;
      var bytes = bodyBytes(x);
      if (type === 'arraybuffer') {
        var buffer = new ArrayBufferP(bytes.length);
        Uint8ArrayPrototypeSet(new Uint8ArrayP(buffer), bytes, 0);
        x.object = buffer;
      } else if (type === 'blob') {
        x.object = new BlobImpl([bytes], { __proto__: null, type: finalMime(x) });
      } else if (type === 'json') {
        x.object = parseJSON(decode(bytes, 'utf-8'));
      } else {
        x.object = null;
      }

      return x.object;
    }

    get responseText() {
      var x = xhrState(this);
      var type = x.responseType;
      if (type !== '' && type !== 'text') {
        throw invalidState(
          attributeContext(IFACE, 'responseText', false),
          "The value is only accessible if the object's 'responseType' is '' or 'text' (was '" +
            type +
            "').",
        );
      }

      return responseText(x);
    }

    get responseXML() {
      var x = xhrState(this);
      var type = x.responseType;
      if (type !== '' && type !== 'document') {
        throw invalidState(
          attributeContext(IFACE, 'responseXML', false),
          "The value is only accessible if the object's 'responseType' is '' or 'document' (was '" +
            type +
            "').",
        );
      }

      return null;
    }

    abort() {
      var x = xhrState(this);
      terminate(x);
      if (
        (x.state === OPENED && x.sendFlag) ||
        x.state === HEADERS_RECEIVED ||
        x.state === LOADING
      ) {
        requestError(this, x, 'abort');
      }

      if (x.state === DONE) {
        x.state = UNSENT;
        resetResponse(x);
      }
    }

    getAllResponseHeaders() {
      var x = xhrState(this);
      if (x.response === null || x.state < HEADERS_RECEIVED) return '';
      var entries = headerEntries(x.response.headers);
      var out = '';
      for (var i = 0; i < entries.length; i++) {
        var name = entries[i][0];
        if (name === 'set-cookie' || name === 'set-cookie2') continue;
        out += name + ': ' + entries[i][1] + '\r\n';
      }

      return out;
    }

    getResponseHeader(name) {
      var x = xhrState(this);
      if (arguments.length < 1) {
        throw typeError(IFACE, 'getResponseHeader', argumentsRequired(1, 0));
      }

      var key = StringPrototypeToLowerCase(byteString(name, context(IFACE, 'getResponseHeader')));
      if (x.response === null || x.state < HEADERS_RECEIVED) return null;
      if (key === 'set-cookie' || key === 'set-cookie2') return null;
      return getRawHeader(x.response.headers, key);
    }

    open(method, url) {
      var x = xhrState(this);
      var ctx = context(IFACE, 'open');
      if (arguments.length < 2) {
        throw typeError(IFACE, 'open', argumentsRequired(2, arguments.length));
      }

      method = byteString(method, ctx);
      url = toDOMString(url, IFACE, 'open');
      // WebIDL's overloads: open(method, url) is async; with a third argument it is
      // that argument converted, so `undefined` means synchronous (Chrome 158).
      var async = arguments.length < 3 ? true : !!arguments[2];
      var username = arguments.length > 3 ? arguments[3] : undefined;
      var password = arguments.length > 4 ? arguments[4] : undefined;
      if (username !== undefined && username !== null)
        username = toDOMString(username, IFACE, 'open');
      if (password !== undefined && password !== null)
        password = toDOMString(password, IFACE, 'open');

      if (!isValidHeaderName(method)) {
        throw domError(ctx + "'" + method + "' is not a valid HTTP method.", 'SyntaxError');
      }

      var upper = StringPrototypeToUpperCase(method);
      if (ArrayPrototypeIncludes(FORBIDDEN_METHODS, upper)) {
        throw domError(ctx + "'" + method + "' HTTP method is unsupported.", 'SecurityError');
      }

      if (ArrayPrototypeIncludes(NORMALIZED_METHODS, upper)) method = upper;
      var parsed;
      try {
        var base = blobModule.pageURL();
        parsed = base === '' ? new URLCtor(url) : new URLCtor(url, base);
      } catch {
        throw domError(ctx + 'Invalid URL', 'SyntaxError');
      }

      if (username !== undefined && username !== null)
        ReflectApply(URLUsernameSet, parsed, [username]);
      if (password !== undefined && password !== null)
        ReflectApply(URLPasswordSet, parsed, [password]);

      if (!async) {
        if (x.timeout !== 0) {
          throw domError(
            ctx + 'Synchronous requests must not set a timeout.',
            'InvalidAccessError',
          );
        }

        if (x.responseType !== '') {
          throw domError(
            ctx + 'Synchronous requests from a document must not set a response type.',
            'InvalidAccessError',
          );
        }
      }

      terminate(x);
      x.sendFlag = false;
      x.sync = !async;
      x.method = method;
      x.url = ReflectApply(URLHrefGet, parsed, []);
      x.headers = new HeadersImpl();
      resetResponse(x);
      if (x.state !== OPENED) {
        x.state = OPENED;
        fireEvent(this, 'readystatechange');
      }
    }

    overrideMimeType(mime) {
      var x = xhrState(this);
      if (arguments.length < 1) {
        throw typeError(IFACE, 'overrideMimeType', argumentsRequired(1, 0));
      }

      mime = toDOMString(mime, IFACE, 'overrideMimeType');
      if (x.state === LOADING || x.state === DONE) {
        throw invalidState(
          context(IFACE, 'overrideMimeType'),
          'MimeType cannot be overridden when the state is LOADING or DONE.',
        );
      }

      // A string that is no MIME type (no '/') overrides to application/octet-stream.
      x.overrideMime =
        StringPrototypeIndexOf(mime, '/', 0) === -1 ? 'application/octet-stream' : mime;
    }

    send(body) {
      var x = xhrState(this);
      if (x.state !== OPENED || x.sendFlag) {
        throw invalidState(context(IFACE, 'send'), "The object's state must be OPENED.");
      }

      if (x.sync) {
        throw domError(
          context(IFACE, 'send') + 'Synchronous requests are not supported.',
          'NotSupportedError',
        );
      }

      var extracted = null;
      if (x.method !== 'GET' && x.method !== 'HEAD' && body !== undefined && body !== null) {
        extracted = extractBody(body);
      }

      if (
        extracted !== null &&
        extracted.type !== null &&
        getRawHeader(x.headers, 'content-type') === null
      ) {
        appendRawHeader(x.headers, 'content-type', extracted.type);
      }

      if (getRawHeader(x.headers, 'accept') === null) appendRawHeader(x.headers, 'accept', '*/*');
      x.uploadBody = extracted !== null;
      x.uploadTotal = extracted === null ? 0 : extracted.bytes.length;
      x.uploadComplete = false;
      x.sendFlag = true;
      x.sendTime = DateNow();
      resetResponse(x);
      var gen = x.gen;
      fireProgress(this, 'loadstart', false, 0, 0);
      if (x.uploadBody && x.gen === gen)
        fireProgress(x.upload, 'loadstart', true, 0, x.uploadTotal);
      // A loadstart listener may have called abort() or open().
      if (x.gen !== gen || x.state !== OPENED || !x.sendFlag) return;
      scheduleTimeout(this, x);
      startFetch(this, x, extracted === null ? null : extracted.bytes);
    }

    setRequestHeader(name, value) {
      var x = xhrState(this);
      var ctx = context(IFACE, 'setRequestHeader');
      if (arguments.length < 2) {
        throw typeError(IFACE, 'setRequestHeader', argumentsRequired(2, arguments.length));
      }

      // Both arguments are converted before any check, as Blink does.
      name = byteString(name, ctx);
      value = byteString(value, ctx);
      if (x.state !== OPENED || x.sendFlag) {
        throw invalidState(ctx, "The object's state must be OPENED.");
      }

      value = normalizeHeaderValue(value);
      if (!isValidHeaderName(name)) {
        throw domError(
          ctx + "'" + name + "' is not a valid HTTP header field name.",
          'SyntaxError',
        );
      }

      if (!isValidHeaderValue(value)) {
        throw domError(
          ctx + "'" + value + "' is not a valid HTTP header field value.",
          'SyntaxError',
        );
      }

      var key = StringPrototypeToLowerCase(name);
      if (isForbiddenHeader(key, value)) return;
      // A repeated name joins its values with ', ' (the author request headers' combine).
      appendRawHeader(x.headers, key, value);
    }

    /**
     * Private State Tokens (a Chrome API).
     * @deviates Checks the argument count only: Larva has no token issuance, so the
     *   token is never attached to the request.
     */
    setPrivateToken(privateToken) {
      xhrState(this);
      if (arguments.length < 1) {
        throw typeError(IFACE, 'setPrivateToken', argumentsRequired(1, 0));
      }
    }

    static {
      xhrState = function (o) {
        if (typeof o !== 'object' || o === null || !(#x in o)) throw illegalInvocation();
        return o.#x;
      };
    }
  }

  // The fetch standard's "forbidden request-header" for a lowercased name and its
  // value.
  function isForbiddenHeader(key, value) {
    if (FORBIDDEN_HEADERS[key] === true) return true;
    if (
      StringPrototypeSlice(key, 0, 6) === 'proxy-' ||
      StringPrototypeSlice(key, 0, 4) === 'sec-'
    ) {
      return true;
    }

    if (METHOD_OVERRIDE_HEADERS[key] !== true) return false;
    // Any comma-separated method in the value that is forbidden forbids the header.
    var start = 0;
    while (start <= value.length) {
      var comma = StringPrototypeIndexOf(value, ',', start);
      var end = comma === -1 ? value.length : comma;
      var method = StringPrototypeToUpperCase(
        normalizeHeaderValue(StringPrototypeSlice(value, start, end)),
      );
      if (ArrayPrototypeIncludes(FORBIDDEN_METHODS, method)) return true;
      if (comma === -1) break;
      start = comma + 1;
    }

    return false;
  }

  // XMLHttpRequestBodyInit, extracted to bytes and the Content-Type it implies: a
  // Blob, a BufferSource (copied, as send() does), a FormData, a URLSearchParams, and
  // anything else converted to a string (USVString), sent as UTF-8.
  function extractBody(body) {
    var blobBytes = blobModule.blobBytes(body);
    if (blobBytes !== null) {
      var blobType = blobModule.typeOf(body);
      return { __proto__: null, bytes: blobBytes, type: blobType === '' ? null : blobType };
    }

    if (body instanceof ArrayBufferP) {
      return { __proto__: null, bytes: copyBytes(new Uint8ArrayP(body)), type: null };
    }

    if (ArrayBufferIsView(body)) {
      var view = new Uint8ArrayP(
        TypedArrayPrototypeGetBuffer(body),
        TypedArrayPrototypeGetByteOffset(body),
        TypedArrayPrototypeGetByteLength(body),
      );
      return { __proto__: null, bytes: copyBytes(view), type: null };
    }

    var form = formDataModule.extractFormData(body);
    if (form !== null) return { __proto__: null, bytes: form.bytes, type: form.type };
    if (body instanceof URLSearchParamsCtor) {
      return { __proto__: null, bytes: encode(StringP(body)), type: FORM_URLENCODED };
    }

    return { __proto__: null, bytes: encode(toDOMString(body, IFACE, 'send')), type: TEXT_PLAIN };
  }

  function copyBytes(view) {
    var out = new Uint8ArrayP(view.length);
    Uint8ArrayPrototypeSet(out, view, 0);
    return out;
  }

  var sharedEncoder = null;
  function encode(text) {
    if (sharedEncoder === null) sharedEncoder = new TextEncoderCtor();
    return ReflectApply(TextEncoderEncode, sharedEncoder, [text]);
  }

  // Decodes the body with `label`, falling back to UTF-8 for a label the Encoding
  // Standard does not know.
  function decode(bytes, label) {
    var decoder;
    try {
      decoder = new TextDecoderCtor(label);
    } catch {
      decoder = new TextDecoderCtor('utf-8');
    }

    return ReflectApply(TextDecoderDecode, decoder, [bytes]);
  }

  function bodyBytes(x) {
    var bytes = concatChunks(x.chunks);
    if (bytes === null) return new Uint8ArrayP(0);
    // Joined once: the next read reuses the single chunk.
    x.chunks = [bytes];
    return bytes;
  }

  // The standard's "text response": empty before LOADING, else the bytes so far,
  // decoded with the final charset. Cached per byte count, as a page polling
  // responseText during LOADING reads it once per event.
  function responseText(x) {
    if (x.state !== LOADING && x.state !== DONE) return '';
    if (x.response === null) return '';
    if (x.textLoaded === x.loaded) return x.textCache;
    x.textCache = decode(bodyBytes(x), charsetOf(finalMime(x)));
    x.textLoaded = x.loaded;
    return x.textCache;
  }

  function parseJSON(text) {
    if (text === '') return null;
    try {
      return JSONParse(text);
    } catch {
      return null;
    }
  }

  // The override MIME type, else the response's Content-Type, else ''.
  function finalMime(x) {
    if (x.overrideMime !== null) return x.overrideMime;
    var type = x.response === null ? null : getRawHeader(x.response.headers, 'content-type');
    return type === null ? '' : type;
  }

  // The `charset` parameter of a MIME type, lowercased and unquoted; 'utf-8' without
  // one. A code-unit scan, not a RegExp (CLAUDE.md §5).
  function charsetOf(mime) {
    var lower = StringPrototypeToLowerCase(mime);
    var at = StringPrototypeIndexOf(lower, 'charset=', 0);
    if (at === -1) return 'utf-8';
    var start = at + 8;
    var end = start;
    while (end < lower.length) {
      var c = StringPrototypeCharCodeAt(lower, end);
      if (c === 0x3b || c === 0x20 || c === 0x09) break; // ; space tab
      end++;
    }

    var value = StringPrototypeSlice(lower, start, end);
    if (value.length >= 2 && StringPrototypeCharCodeAt(value, 0) === 0x22) {
      value = StringPrototypeSlice(value, 1, value.length - 1);
    }

    return value === '' ? 'utf-8' : value;
  }

  // Content-Length as a number of bytes, or -1 when absent or not one.
  function contentLength(headers) {
    var value = getRawHeader(headers, 'content-length');
    if (value === null || value.length === 0) return -1;
    for (var i = 0; i < value.length; i++) {
      var c = StringPrototypeCharCodeAt(value, i);
      if (c < 0x30 || c > 0x39) return -1;
    }

    return NumberP(value);
  }

  function scheduleTimeout(xhr, x) {
    if (x.timer !== null) {
      clearTimeoutP(x.timer);
      x.timer = null;
    }

    if (x.timeout === 0) return;
    var gen = x.gen;
    var remaining = x.timeout - (DateNow() - x.sendTime);
    x.timer = setTimeoutP(
      function () {
        x.timer = null;
        if (x.gen !== gen || !x.sendFlag) return;
        terminate(x);
        requestError(xhr, x, 'timeout');
      },
      remaining > 0 ? remaining : 0,
    );
  }

  // The standard's "request error steps": DONE with a network error, then
  // readystatechange, the upload's `type` and loadend unless it completed, and the
  // request's.
  function requestError(xhr, x, type) {
    x.state = DONE;
    x.sendFlag = false;
    resetResponse(x);
    fireEvent(xhr, 'readystatechange');
    // Chrome 158 fires the upload's events for an abort or a timeout of a body-less
    // request too, but not for its network error (xhr-events).
    if (!x.uploadComplete && (x.uploadBody || type !== 'error')) {
      x.uploadComplete = true;
      fireProgress(x.upload, type, false, 0, 0);
      fireProgress(x.upload, 'loadend', false, 0, 0);
    }

    fireProgress(xhr, type, false, 0, 0);
    fireProgress(xhr, 'loadend', false, 0, 0);
  }

  function startFetch(xhr, x, bytes) {
    var gen = x.gen;
    var controller = new AbortControllerCtor();
    x.controller = controller;
    var init = {
      __proto__: null,
      method: x.method,
      headers: x.headers,
      body: bytes,
      signal: ReflectApply(AbortControllerSignalGet, controller, []),
    };
    var promise = fetchOp(x.url, init);
    ReflectApply(PromiseThen, promise, [
      function (response) {
        if (x.gen !== gen) return;
        onHead(xhr, x, gen, responseState(response));
      },
      function () {
        if (x.gen !== gen) return;
        terminate(x);
        requestError(xhr, x, 'error');
      },
    ]);
  }

  // The response head is in: the upload is complete, then HEADERS_RECEIVED.
  function onHead(xhr, x, gen, response) {
    if (x.uploadBody && !x.uploadComplete) {
      x.uploadComplete = true;
      var n = x.uploadTotal;
      fireProgress(x.upload, 'progress', true, n, n);
      if (x.gen === gen) fireProgress(x.upload, 'load', true, n, n);
      if (x.gen === gen) fireProgress(x.upload, 'loadend', true, n, n);
      if (x.gen !== gen) return;
    }

    // A body-less request's upload never completes: an abort after the head still
    // fires the upload's abort and loadend (Chrome 158, xhr-events "abort at headers").
    x.response = response;
    var length = contentLength(response.headers);
    x.lengthComputable = length !== -1;
    x.total = length === -1 ? 0 : length;
    x.state = HEADERS_RECEIVED;
    fireEvent(xhr, 'readystatechange');
    if (x.gen !== gen) return;
    var stream = bodyStreamOf(response);
    if (stream === null) {
      endOfBody(xhr, x, gen);
      return;
    }

    var reader = ReflectApply(ReadableStreamGetReader, stream, []);
    readBody(xhr, x, gen, reader);
  }

  function readBody(xhr, x, gen, reader) {
    ReflectApply(PromiseThen, ReflectApply(ReaderRead, reader, []), [
      function (result) {
        if (x.gen !== gen) return;
        if (result.done) {
          endOfBody(xhr, x, gen);
          return;
        }

        onChunk(xhr, x, gen, result.value);
        if (x.gen === gen) readBody(xhr, x, gen, reader);
      },
      function () {
        if (x.gen !== gen) return;
        terminate(x);
        requestError(xhr, x, 'error');
      },
    ]);
  }

  function onChunk(xhr, x, gen, bytes) {
    ArrayPrototypePush1(x.chunks, bytes);
    x.loaded += bytes.length;
    if (x.state === HEADERS_RECEIVED) {
      x.state = LOADING;
      fireEvent(xhr, 'readystatechange');
      if (x.gen !== gen) return;
    }

    var now = DateNow();
    if (now - x.progressTime >= PROGRESS_INTERVAL_MS) {
      x.progressTime = now;
      x.progressLoaded = x.loaded;
      fireProgress(xhr, 'progress', x.lengthComputable, x.loaded, x.total);
    }
  }

  function endOfBody(xhr, x, gen) {
    if (x.loaded !== x.progressLoaded) {
      x.progressLoaded = x.loaded;
      fireProgress(xhr, 'progress', x.lengthComputable, x.loaded, x.total);
      if (x.gen !== gen) return;
    }

    if (x.timer !== null) {
      clearTimeoutP(x.timer);
      x.timer = null;
    }

    x.controller = null;
    x.state = DONE;
    x.sendFlag = false;
    fireEvent(xhr, 'readystatechange');
    if (x.gen !== gen) return;
    fireProgress(xhr, 'load', x.lengthComputable, x.loaded, x.total);
    if (x.gen !== gen) return;
    fireProgress(xhr, 'loadend', x.lengthComputable, x.loaded, x.total);
  }

  // The interface objects a page sees (internal/native_shape), in Blink's member order
  // (Chrome 158, tests/web/cases/shape-xhr.expected).
  var PublicXMLHttpRequestEventTarget = nativeShape.defineInterface({
    name: 'XMLHttpRequestEventTarget',
    impl: XMLHttpRequestEventTarget,
    length: 0,
    illegal: true,
    parent: eventTarget.EventTarget,
    members: [
      'onloadstart',
      'onprogress',
      'onabort',
      'onerror',
      'onload',
      'ontimeout',
      'onloadend',
      'constructor',
      '@@toStringTag',
    ],
  });
  var PublicXMLHttpRequest = nativeShape.defineInterface({
    name: 'XMLHttpRequest',
    impl: XMLHttpRequest,
    length: 0,
    parent: PublicXMLHttpRequestEventTarget,
    constants: STATES,
    statics: STATE_NAMES,
    members: [
      'onreadystatechange',
      'readyState',
      'timeout',
      'withCredentials',
      'upload',
      'responseURL',
      'status',
      'statusText',
      'responseType',
      'response',
      'responseText',
      'UNSENT',
      'OPENED',
      'HEADERS_RECEIVED',
      'LOADING',
      'DONE',
      'abort:0',
      'getAllResponseHeaders:0',
      'getResponseHeader:1',
      'open:2',
      'overrideMimeType:1',
      'send:0',
      'setRequestHeader:2',
      'constructor',
      'responseXML',
      'setPrivateToken:1',
      '@@toStringTag',
    ],
  });
  var PublicXMLHttpRequestUpload = nativeShape.defineInterface({
    name: 'XMLHttpRequestUpload',
    impl: XMLHttpRequestUpload,
    length: 0,
    illegal: true,
    parent: PublicXMLHttpRequestEventTarget,
    members: ['constructor', '@@toStringTag'],
  });
  var PublicProgressEvent = nativeShape.defineInterface({
    name: 'ProgressEvent',
    impl: ProgressEvent,
    length: 1,
    parent: eventTarget.Event,
    members: ['lengthComputable', 'loaded', 'total', 'constructor', '@@toStringTag'],
  });

  module.exports = P.ObjectFreeze({
    __proto__: null,
    XMLHttpRequest: PublicXMLHttpRequest,
    XMLHttpRequestEventTarget: PublicXMLHttpRequestEventTarget,
    XMLHttpRequestUpload: PublicXMLHttpRequestUpload,
    ProgressEvent: PublicProgressEvent,
  });
});
