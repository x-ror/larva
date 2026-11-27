// Headers and the name/value validation and normalization behind it — the Lava side
// of undici's lib/web/fetch/headers.js (node bundles undici, so its frames read
// node:internal/deps/undici/undici; ours read node:internal/fetch/headers).
//
// Errors follow the profile (docs/LARVA.md decision 1). On `.Web` they are Blink's:
// the ByteString conversion first ("String contains non ISO-8859-1 code point."), then
// "Invalid name" / "Invalid value" behind the WebIDL context of the operation that ran —
// `Failed to execute 'append' on 'Headers': `, or the constructor's, or Request's or
// fetch's when they fill a Headers from their init (Chrome 158,
// tests/web/cases/fetch-errors, fetch-webidl). `.Node` keeps undici's text until S5b
// deletes that arm.
(function (require, module) {
  'use strict';

  // Header names must be non-empty HTTP tokens (RFC 7230 tchar); values must not
  // carry CR, LF, or NUL. Node (undici) throws on either — at append/set/get/
  // has/delete time — so `new Headers(...)` and, because Request builds its
  // Headers eagerly, `fetch(input, {headers})` reject instead of silently
  // emitting a header-split or otherwise malformed request. The token class
  // rejects spaces, ':' (which would forge a second header on the wire), control
  // chars, and non-ASCII alike. Wire (response) headers arrive pre-framed via
  // appendRaw and skip this, matching undici.
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
  var P = require('internal/primordials');
  var reTest = P.RegExpMatches;
  var StringP = P.String;
  var TypeErrorP = P.TypeError;
  var ObjectCreate = P.ObjectCreate;
  var ObjectKeys = P.ObjectKeys;
  var ObjectHasOwn = P.ObjectHasOwn;
  var ArrayFrom = P.ArrayFrom;
  var ArrayPrototypePush1 = P.ArrayPrototypePush1;
  var ArrayPrototypeSlice = P.ArrayPrototypeSlice;
  var ArrayPrototypeJoin = P.ArrayPrototypeJoin;
  var ArrayPrototypeSort = P.ArrayPrototypeSort;
  var ArrayPrototypeMap = P.ArrayPrototypeMap;
  var ReflectApply = P.ReflectApply;
  var StringPrototypeCharCodeAt = P.StringPrototypeCharCodeAt;
  var StringPrototypeSlice = P.StringPrototypeSlice;
  var StringPrototypeToLowerCase = P.StringPrototypeToLowerCase;
  var SymbolIterator = P.Symbol.iterator;
  var ArrayPrototypeValues = P.uncurryThis(P.Array.prototype.values);

  var webErrors = require('internal/web_errors');
  var context = webErrors.context;
  var pageError = webErrors.pageError;

  var VALID_HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

  // The WebIDL contexts a Headers operation reports under; Request and fetch pass
  // their own when they fill one from an init.
  var CTX_CONSTRUCT = context('Headers');
  var CTX_APPEND = context('Headers', 'append');
  var CTX_SET = context('Headers', 'set');
  var CTX_GET = context('Headers', 'get');
  var CTX_HAS = context('Headers', 'has');
  var CTX_DELETE = context('Headers', 'delete');
  var CTX_FOR_EACH = context('Headers', 'forEach');
  var HEADERS_INIT_TYPE =
    "The provided value is not of type '(record<ByteString, ByteString> or sequence<sequence<ByteString>>)'.";

  // A TypeError for a page (`ctx` + Blink's detail) or, on `.Node`, undici's text.
  function headerError(ctx, detail) {
    return pageError(new TypeErrorP(ctx + detail));
  }

  // WebIDL ByteString: ToString (a Symbol throws), then every code unit must fit a
  // byte. Blink converts both arguments before the operation runs, so this message
  // wins over "Invalid name"/"Invalid value".
  function byteString(value, ctx) {
    if (typeof value === 'symbol') {
      throw headerError(ctx, 'Cannot convert a Symbol value to a string');
    }

    var s = StringP(value);
    for (var i = 0; i < s.length; i++) {
      var code = StringPrototypeCharCodeAt(s, i);
      if (code > 0xff) {
        throw headerError(ctx, 'String contains non ISO-8859-1 code point.');
      }
    }

    return s;
  }

  function assertValidHeaderName(name, ctx) {
    if (!reTest(VALID_HEADER_NAME, name)) {
      throw headerError(ctx, 'Invalid name');
    }
  }

  function assertValidHeaderValue(name, value, ctx) {
    for (var i = 0; i < value.length; i++) {
      // The CAPTURED read, not `value.charCodeAt(i)`. `String.prototype.charCodeAt`
      // is a writable data property like any other, so a hand-rolled scan is only
      // as sound as the primitive it scans with — routing this file's validators
      // off RegExp said nothing about that. A gadget reporting 0x41 for CR and LF
      // is enough: measured, node rejects and Lava accepted
      // `a\r\nInjected: yes` as a header value. Pinned by `cc-value=` in
      // cmd/lava/regexp_pollution_test.odin (and the headers.js mutation-manifest
      // entry). The same gadget on the HTTP response path is pinned by the
      // charcodeat phase of run-http-smoke.sh against http.js.
      var code = StringPrototypeCharCodeAt(value, i);
      if (code === 0 || code === 10 || code === 13) {
        throw headerError(ctx, 'Invalid value');
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
  // arrive via appendRaw and are not re-normalized — the transport already trims
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

  // Shared by append, set and the init fill. Order matches Blink: both arguments
  // through the ByteString conversion (name first), then the value trimmed, then a bad
  // name rejected, then a bad (trimmed) value. Returns the lowercased name and the
  // cleaned value, ready to store.
  function normalizeAndValidate(name, value, ctx) {
    var key = byteString(name, ctx);
    var text = normalizeHeaderValue(byteString(value, ctx));
    assertValidHeaderName(key, ctx);
    assertValidHeaderValue(key, text, ctx);
    return { __proto__: null, name: StringPrototypeToLowerCase(key), value: text };
  }

  // A name argument of get/has/delete: converted and validated, then lowercased.
  function checkedName(name, ctx) {
    var key = byteString(name, ctx);
    assertValidHeaderName(key, ctx);
    return StringPrototypeToLowerCase(key);
  }

  function assertMutable(headers, ctx) {
    if (headers._guard === IMMUTABLE) throw headerError(ctx, 'Headers are immutable');
  }

  var IMMUTABLE = 'immutable';

  // The internal operations are functions, not methods: a page reads every own key
  // of Headers.prototype, and Chrome's has neither (tests/web/cases/shape-fetch). They
  // also run no page-replaceable method, so the fetch driver reaches a Headers through
  // them rather than through Headers.prototype.
  //
  // appendRaw stores without validation — for response headers parsed off the wire,
  // which the transport has already framed line-by-line. Set-Cookie is appended to its
  // own list (never comma-joined) so getSetCookie() can return each cookie intact.
  function appendRaw(headers, name, value) {
    var key = StringPrototypeToLowerCase(StringP(name));
    if (key === 'set-cookie') {
      ArrayPrototypePush1(headers._cookies, StringP(value));
      return;
    }

    var map = headers._map;
    map[key] = ObjectHasOwn(map, key) ? map[key] + ', ' + value : StringP(value);
  }

  // getRaw / removeRaw: get and delete for internal callers, by a lowercase name.
  function getRaw(headers, key) {
    if (key === 'set-cookie') {
      return headers._cookies.length ? ArrayPrototypeJoin(headers._cookies, ', ') : null;
    }

    return ObjectHasOwn(headers._map, key) ? headers._map[key] : null;
  }

  function removeRaw(headers, key) {
    if (key === 'set-cookie') {
      headers._cookies = [];
      return;
    }

    delete headers._map[key];
  }

  // Makes `headers` refuse append/set/delete, as the fetch standard's "immutable"
  // guard: Response.error(), Response.redirect() and a fetched Response's headers.
  function freezeHeaders(headers) {
    headers._guard = IMMUTABLE;
    return headers;
  }

  // entryList is the fetch standard's "sort and combine": every name lowercased and
  // sorted by code unit, each with its comma-joined value — except Set-Cookie, one
  // entry per cookie in the order they were added (Chrome 158 and undici alike,
  // tests/web/cases/fetch-classes). A snapshot: the iterators over it do not see a
  // later change.
  function entryList(headers) {
    var names = ObjectKeys(headers._map);
    var cookies = headers._cookies;
    if (cookies.length > 0) ArrayPrototypePush1(names, 'set-cookie');
    ArrayPrototypeSort(names);
    var out = [];
    for (var i = 0; i < names.length; i++) {
      var key = names[i];
      if (key === 'set-cookie') {
        for (var j = 0; j < cookies.length; j++) out[out.length] = ['set-cookie', cookies[j]];
      } else {
        out[out.length] = [key, headers._map[key]];
      }
    }

    return out;
  }

  // Fills `headers` from a HeadersInit — a Headers, a sequence of pairs (anything
  // iterable) or a record — reporting under `ctx` (the constructor's, Request's or
  // fetch's). Pairs and records go through the validating append.
  function fillHeaders(headers, init, ctx) {
    if (init === undefined) return;
    if (isHeaders(init)) {
      var names = ObjectKeys(init._map);
      for (var n = 0; n < names.length; n++) headers._map[names[n]] = init._map[names[n]];
      headers._cookies = ArrayPrototypeSlice(init._cookies);
      return;
    }

    if (init === null || (typeof init !== 'object' && typeof init !== 'function')) {
      throw headerError(ctx, HEADERS_INIT_TYPE);
    }

    if (typeof init[SymbolIterator] === 'function') {
      var pairs = ArrayFrom(init);
      for (var i = 0; i < pairs.length; i++) {
        var pair = pairs[i];
        if (pair === null || (typeof pair !== 'object' && typeof pair !== 'function')) {
          throw headerError(ctx, HEADERS_INIT_TYPE);
        }

        pair = ArrayFrom(pair);
        if (pair.length !== 2) {
          throw headerError(ctx, 'Invalid value');
        }

        appendChecked(headers, pair[0], pair[1], ctx);
      }

      return;
    }

    var keys = ObjectKeys(init);
    for (var k = 0; k < keys.length; k++) appendChecked(headers, keys[k], init[keys[k]], ctx);
  }

  function appendChecked(headers, name, value, ctx) {
    var header = normalizeAndValidate(name, value, ctx);
    appendRaw(headers, header.name, header.value);
  }

  /**
   * Headers (fetch standard). Reached by a page through internal/native_shape's
   * interface object, which wraps every member.
   * @node Chrome 158: names iterate lowercased and sorted, Set-Cookie one entry per
   *       cookie (tests/web/cases/fetch-classes); errors in fetch-errors, fetch-webidl.
   * @deviates The iterators are Array iterators over a snapshot, where Blink's are a
   *   live "Headers Iterator".
   */
  // Bound in Headers' static block, the only code that can test its private brand: a
  // page object built on Headers.prototype is not a Headers.
  var isHeaders;

  class Headers {
    #brand = true;

    static {
      isHeaders = function (value) {
        return value !== null && typeof value === 'object' && #brand in value;
      };
    }

    constructor(init) {
      // Lowercased name -> comma-joined value, on a null prototype so a header named
      // `__proto__` or `constructor` is an ordinary key.
      this._map = ObjectCreate(null);
      // Set-Cookie is the one header that must NOT be comma-joined: each
      // Set-Cookie is its own list entry (cookie Expires= values themselves
      // contain commas, so a join is lossy and corrupts them). It is held apart
      // from _map and exposed individually via getSetCookie(). See appendRaw.
      this._cookies = [];
      this._guard = 'none';
      fillHeaders(this, init, CTX_CONSTRUCT);
    }
    append(name, value) {
      var header = normalizeAndValidate(name, value, CTX_APPEND);
      assertMutable(this, CTX_APPEND);
      appendRaw(this, header.name, header.value);
    }
    set(name, value) {
      var header = normalizeAndValidate(name, value, CTX_SET);
      assertMutable(this, CTX_SET);
      if (header.name === 'set-cookie') {
        this._cookies = [header.value];
        return;
      }

      this._map[header.name] = header.value;
    }
    get(name) {
      // get('set-cookie') returns the cookies joined by ', ' (Chrome and node); the
      // separation is preserved only through getSetCookie().
      return getRaw(this, checkedName(name, CTX_GET));
    }
    // getSetCookie returns each Set-Cookie value as its own string, uncorrupted
    // by comma-joining (WHATWG Headers.getSetCookie()).
    getSetCookie() {
      return ArrayPrototypeSlice(this._cookies);
    }
    has(name) {
      return getRaw(this, checkedName(name, CTX_HAS)) !== null;
    }
    delete(name) {
      var key = checkedName(name, CTX_DELETE);
      assertMutable(this, CTX_DELETE);
      removeRaw(this, key);
    }
    forEach(callback, thisArg) {
      if (typeof callback !== 'function') {
        throw headerError(CTX_FOR_EACH, 'The callback provided as parameter 1 is not a function.');
      }

      var entries = entryList(this);
      for (var i = 0; i < entries.length; i++) {
        ReflectApply(callback, thisArg, [entries[i][1], entries[i][0], this]);
      }
    }
    keys() {
      return ArrayPrototypeValues(ArrayPrototypeMap(entryList(this), entryName));
    }
    values() {
      return ArrayPrototypeValues(ArrayPrototypeMap(entryList(this), entryValue));
    }
    entries() {
      return ArrayPrototypeValues(entryList(this));
    }
  }

  function entryName(e) {
    return e[0];
  }

  function entryValue(e) {
    return e[1];
  }

  module.exports = {
    Headers: Headers,
    isHeaders: isHeaders,
    appendRaw: appendRaw,
    getRaw: getRaw,
    removeRaw: removeRaw,
    entryList: entryList,
    fillHeaders: fillHeaders,
    freezeHeaders: freezeHeaders,
  };
});
