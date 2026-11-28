/**
 * @fileoverview The page's side of the cookie jar (pkg/http/cookie through
 * pkg/runtime/cookie.odin): which cookies fetch() and XMLHttpRequest send and store,
 * and what document.cookie reads and writes.
 *
 * The jar is the page's session's, and lives in Odin; this module decides, per the
 * Fetch standard's credentials mode, whether a request takes part at all, and hands the
 * jar a URL already parsed by the page's own URL parser. Same-site is judged against the
 * page's URL (the embedder's `--origin`): a page is its only initiator, with no frame
 * tree and no navigation.
 *
 * Instantiated eagerly (internal/fetch requires it at module-eval), so every capture
 * below is pristine.
 *
 * Deviations (docs/LARVA.md decision 1 asks each to be written down):
 *   - In memory only: the jar lives as long as the page's session and nothing is
 *     persisted (Larva has no profile directory; a non-goal). Pinned by
 *     cmd/lava/cookie_isolation_test.odin.
 *   - No CookieStore (cookieStore, the async API): document.cookie only.
 *
 * @module lava/internal/cookie
 */

(function (require, module, _exports, native) {
  'use strict';

  var P = require('internal/primordials');
  var URLP = require('internal/url').URL;
  var ObjectGetOwnPropertyDescriptor = P.ObjectGetOwnPropertyDescriptor;
  var ReflectApply = P.ReflectApply;
  var EMPTY = [];

  // URL's accessors, captured: the URL interface's prototype is the page's to replace.
  function urlGetter(name) {
    return ObjectGetOwnPropertyDescriptor(URLP.prototype, name).get;
  }
  var urlProtocol = urlGetter('protocol');
  var urlHostname = urlGetter('hostname');
  var urlPathname = urlGetter('pathname');
  var urlOrigin = urlGetter('origin');

  var nativeGet = native.get;
  var nativeSet = native.set;

  function read(getter, url) {
    return ReflectApply(getter, url, EMPTY);
  }

  // parts(href) is what the jar needs of an http(s) URL, or null for any other scheme,
  // which has no cookies (about:blank, data:, blob:).
  function parts(href) {
    var url;
    try {
      url = new URLP(href);
    } catch {
      return null;
    }
    var protocol = read(urlProtocol, url);
    if (protocol !== 'http:' && protocol !== 'https:') return null;
    return {
      __proto__: null,
      https: protocol === 'https:',
      host: read(urlHostname, url),
      path: read(urlPathname, url),
      origin: read(urlOrigin, url),
    };
  }

  // The page's own URL, which fixes its origin and site for the page's life; an opaque
  // origin (no --origin, or a non-http one) is same-origin and same-site with nothing.
  var page = typeof native.url === 'string' ? parts(native.url) : null;
  var pageHttps = page !== null && page.https;
  var pageHost = page !== null ? page.host : '';
  var pageOrigin = page !== null ? page.origin : 'null';

  // includeCredentials (Fetch §4.5): whether a request of this credentials mode sends
  // and stores cookies. XMLHttpRequest maps withCredentials onto 'include' and
  // 'same-origin'.
  function takesPart(target, credentials) {
    if (credentials === 'include') return true;
    return credentials === 'same-origin' && pageOrigin !== 'null' && target.origin === pageOrigin;
  }

  /**
   * The Cookie header value a request carries.
   * @param {string} href The request's URL (one hop of a redirect chain).
   * @param {string} credentials The request's credentials mode.
   * @returns {string} '' for none.
   * @node Chrome 158 (tests/web/cases/cookie-fetch, cookie-xhr): 'omit' sends nothing;
   *       the default 'same-origin' sends to the page's origin, HttpOnly cookies
   *       included; each redirect hop is matched on its own URL.
   * @deviates none
   */
  function forRequest(href, credentials) {
    var target = parts(href);
    if (target === null || !takesPart(target, credentials)) return '';
    return nativeGet(target.https, target.host, target.path, false, pageHttps, pageHost);
  }

  /**
   * Stores a response's Set-Cookie values, in order.
   * @param {string} href The URL that answered.
   * @param {string} credentials The request's credentials mode.
   * @param {string[]} lines The Set-Cookie values.
   * @node Chrome 158 (tests/web/cases/cookie-fetch): 'omit' stores nothing, a
   *       redirect's cookies are stored before the next hop is sent.
   * @deviates none
   */
  function fromResponse(href, credentials, lines) {
    if (lines.length === 0) return;
    var target = parts(href);
    if (target === null || !takesPart(target, credentials)) return;
    for (var i = 0; i < lines.length; i++) {
      nativeSet(target.https, target.host, target.path, lines[i], false, pageHttps, pageHost);
    }
  }

  // The document's URL: location's, which pushState may have moved within the origin.
  function documentURL() {
    return parts(require('internal/location').documentURL());
  }

  /**
   * document.cookie's getter: the cookies of the document's URL, without HttpOnly ones.
   * @returns {string}
   * @node Chrome 158 (tests/dom/cases/cookie-document-*.page).
   * @deviates An opaque-origin document (no --origin) reads '' and ignores a write, as
   *   a top-level about:blank does in Chrome; Chrome throws a SecurityError for a
   *   sandboxed or data: document instead, which Larva never has.
   */
  function documentGet() {
    var doc = documentURL();
    if (doc === null) return '';
    return nativeGet(doc.https, doc.host, doc.path, true, doc.https, doc.host);
  }

  /**
   * document.cookie's setter: one set-cookie-string, as from a script (HttpOnly refused).
   * @param {string} value Already converted to a DOMString by the caller.
   * @node Chrome 158 (tests/dom/cases/cookie-document-*.page).
   * @deviates as documentGet.
   */
  function documentSet(value) {
    var doc = documentURL();
    if (doc === null) return;
    nativeSet(doc.https, doc.host, doc.path, value, true, doc.https, doc.host);
  }

  module.exports = {
    forRequest: forRequest,
    fromResponse: fromResponse,
    documentGet: documentGet,
    documentSet: documentSet,
  };
});
