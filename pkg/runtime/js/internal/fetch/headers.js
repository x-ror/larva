// Headers and the name/value validation and normalization behind it — the Lava side
// of undici's lib/web/fetch/headers.js (node bundles undici, so its frames read
// node:internal/deps/undici/undici; ours read node:internal/fetch/headers).
(function (require, module) {
  'use strict';

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
  var P = require('internal/primordials');
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
      // cmd/lava/regexp_pollution_test.odin (and the headers.js mutation-manifest
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

  // The two internal operations are functions, not methods: a page reads every own key
  // of Headers.prototype, and Chrome's has neither (tests/web/cases/shape-fetch).
  //
  // appendRaw stores without validation — for response headers parsed off the wire,
  // which the transport has already framed line-by-line. Set-Cookie is appended to its
  // own list (never comma-joined) so getSetCookie() can return each cookie intact.
  function appendRaw(headers, name, value) {
    var key = normalizeName(name);
    if (key === 'set-cookie') {
      headers._cookies.push(String(value));
      return;
    }
    var existing = headers._map.get(key);
    headers._map.set(key, existing === undefined ? String(value) : existing + ', ' + value);
  }

  // entryList snapshots all header entries — the comma-joined _map values plus one
  // entry per individual Set-Cookie — so iteration surfaces every cookie separately (the
  // spec does not combine Set-Cookie in the iterator).
  function entryList(headers) {
    var out = [];
    headers._map.forEach((value, key) => out.push([key, value]));
    for (var i = 0; i < headers._cookies.length; i++) out.push(['set-cookie', headers._cookies[i]]);
    return out;
  }

  class Headers {
    constructor(init) {
      this._map = new Map();
      // Set-Cookie is the one header that must NOT be comma-joined: each
      // Set-Cookie is its own list entry (cookie Expires= values themselves
      // contain commas, so a join is lossy and corrupts them). It is held apart
      // from _map and exposed individually via getSetCookie(). See appendRaw.
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
      appendRaw(this, header.name, header.value);
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
    forEach(callback, thisArg) {
      var entries = entryList(this);
      for (var i = 0; i < entries.length; i++) {
        callback.call(thisArg, entries[i][1], entries[i][0], this);
      }
    }
    keys() {
      return entryList(this)
        .map((e) => e[0])
        [Symbol.iterator]();
    }
    values() {
      return entryList(this)
        .map((e) => e[1])
        [Symbol.iterator]();
    }
    entries() {
      return entryList(this)[Symbol.iterator]();
    }
    [Symbol.iterator]() {
      return entryList(this)[Symbol.iterator]();
    }
  }

  module.exports = { Headers: Headers, appendRaw: appendRaw };
});
