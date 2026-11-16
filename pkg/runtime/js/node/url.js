// node:url — the public entry. The WHATWG implementation (parser, `URL`,
// `URLSearchParams`, `fileURLToPath`, `urlToHttpOptions`, `domainToASCII`,
// `domainToUnicode`) lives in internal/url.js, as in node's lib/internal/url.js, so
// its throws frame `node:internal/url` the way node's do. This file keeps what node's
// lib/url.js keeps and frames `node:url`: `pathToFileURL` and `format`.
//
// The module installs the `URL` and `URLSearchParams` globals (preserving the
// `createObjectURL`/`revokeObjectURL` statics that node:buffer attaches) and is
// exported by both `require('url')` and `require('node:url')`. It also keeps the
// `fileURLToPath` the ESM loader and node:sqlite depend on, and adds
// `pathToFileURL`, `urlToHttpOptions`, `format`, `domainToASCII`, `domainToUnicode`.
//
// Deliberate deviations from Node, documented in reference/node-compatibility.md:
//   * IDNA/UTS-46 host processing is approximated (see internal/url.js).
//   * The legacy `url.parse`/`url.resolve`/`url.Url` API is not provided; only the
//     WHATWG surface is.
(function (require, module, _exports) {
  'use strict';

  // Captured at module-eval, which the loader runs before any user code (url is
  // eager, and internal/url with it through the require below), for the same reason
  // internal/url.js gives: these run on caller-supplied paths while user code may
  // have poisoned shared prototypes/globals.
  //
  // NOT a complete rule for this file: the `StringPrototypeReplace(…, /re/, …)`
  // sites below route through the same RegExpExec re-read and are still steerable —
  // and a GLOBAL one spins rather than answering wrongly, because a forged result
  // never advances lastIndex. Tracked in ROADMAP. LEADING_SLASHES_RE is non-global.
  var P = require('internal/primordials');
  var LEADING_SLASHES_RE = /^\/+/;
  var StringPrototypeCharCodeAt = P.StringPrototypeCharCodeAt;
  var StringPrototypeReplace = P.StringPrototypeReplace;
  var StringPrototypeReplaceAll = P.StringPrototypeReplaceAll;
  var ERR_INVALID_ARG_TYPE = require('internal/errors').ERR_INVALID_ARG_TYPE;

  var internalURL = require('internal/url');
  var URL = internalURL.URL;
  var URLSearchParams = internalURL.URLSearchParams;
  var kRecord = internalURL.kRecord;
  var serializePath = internalURL.serializePath;
  var domainToUnicode = internalURL.hostToUnicode;

  // ------------------------------------------------------------------ //
  // node:url helper functions                                          //
  // ------------------------------------------------------------------ //

  function pathToFileURL(filepath) {
    if (typeof filepath !== 'string') {
      throw ERR_INVALID_ARG_TYPE('path', 'string', filepath);
    }
    var path = require('node:path');
    var isWindows = process.platform === 'win32';
    var input = filepath;
    var resolved = path.resolve(input);
    // path.resolve drops a trailing separator; Node preserves it on the URL, so
    // re-append a '/' when the original path ended in one and resolve removed it.
    var lastChar = StringPrototypeCharCodeAt(input, input.length - 1);
    var endedWithSep = lastChar === 0x2f || (isWindows && lastChar === 0x5c);
    if (endedWithSep && resolved[resolved.length - 1] !== path.sep) resolved += '/';
    var url = new URL('file://');
    // Percent-encode the path's special characters, then assign as pathname so the
    // URL machinery normalizes it. We encode %, #, ? and (on POSIX) backslash so
    // they are not reinterpreted; control chars and others are handled by the setter.
    var encoded = resolved
      .replaceAll('%', '%25')
      .replaceAll('\\', isWindows ? '\\' : '%5C')
      .replaceAll('\n', '%0A')
      .replaceAll('\r', '%0D')
      .replaceAll('	', '%09');
    if (isWindows) {
      // Normalize separators for the file URL; UNC paths keep the host.
      encoded = StringPrototypeReplaceAll(encoded, '\\', '/');
      if (encoded.slice(0, 2) === '//') {
        // UNC \\server\share -> file://server/share
        var withoutLead = encoded.slice(2);
        var slash = withoutLead.indexOf('/');
        var serverHost = slash === -1 ? withoutLead : withoutLead.slice(0, slash);
        url.hostname = serverHost;
        url.pathname = slash === -1 ? '/' : withoutLead.slice(slash);
        return url;
      }
      url.pathname = '/' + StringPrototypeReplace(encoded, LEADING_SLASHES_RE, '');
    } else {
      url.pathname = encoded;
    }
    return url;
  }

  function format(urlInput, options) {
    if (!(urlInput instanceof URL)) {
      throw new TypeError('The "url" argument must be an instance of URL.');
    }
    options = options || {};
    var auth = options.auth !== false;
    var fragment = options.fragment !== false;
    var search = options.search !== false;
    var unicode = options.unicode === true;

    var url = urlInput[kRecord];
    var output = url.scheme + ':';
    if (url.host !== null) {
      output += '//';
      var hasCreds = url.username !== '' || url.password !== '';
      if (auth && hasCreds) {
        output += url.username;
        if (url.password !== '') output += ':' + url.password;
        output += '@';
      }
      output += unicode ? domainToUnicode(url.host) : url.host;
      if (url.port !== null) output += ':' + url.port;
    }
    output += serializePath(url);
    if (search && url.query !== null) output += '?' + url.query;
    if (fragment && url.fragment !== null) output += '#' + url.fragment;
    return output;
  }

  // ------------------------------------------------------------------ //
  // Global installation + module exports                               //
  // ------------------------------------------------------------------ //

  // Preserve the object-URL statics node:buffer attaches to globalThis.URL (it may
  // have run first and stubbed URL, or may run after us). Copy any it already set
  // onto the real class so `URL.createObjectURL`/`revokeObjectURL` keep working.
  var priorURL = globalThis.URL;
  if (priorURL && typeof priorURL === 'object') {
    if (typeof priorURL.createObjectURL === 'function') {
      URL.createObjectURL = priorURL.createObjectURL;
    }
    if (typeof priorURL.revokeObjectURL === 'function') {
      URL.revokeObjectURL = priorURL.revokeObjectURL;
    }
  }

  if (typeof globalThis.URL !== 'function') {
    globalThis.URL = URL;
  }
  if (globalThis.URLSearchParams === undefined) {
    globalThis.URLSearchParams = URLSearchParams;
  }

  module.exports = {
    URL: URL,
    URLSearchParams: URLSearchParams,
    fileURLToPath: internalURL.fileURLToPath,
    pathToFileURL: pathToFileURL,
    urlToHttpOptions: internalURL.urlToHttpOptions,
    format: format,
    domainToASCII: internalURL.domainToASCII,
    domainToUnicode: internalURL.domainToUnicode,
  };
});
