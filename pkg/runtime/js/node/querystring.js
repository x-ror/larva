// node:querystring — the legacy query-string parser/serializer (the WHATWG
// URLSearchParams in url.js is the modern surface; this is kept for Node parity).
//
// Fidelity notes vs Node:
//   - stringify percent-encodes via encodeURIComponent semantics, so a space becomes
//     %20 (Node's querystring.escape, not '+').
//   - parse's default decoder converts '+' to a space first (Node's unescape), then
//     percent-decodes, falling back to the raw token on a malformed sequence.
//   - repeated keys collapse to an array, in first-seen order.
//   - maxKeys defaults to 1000; 0 disables the cap.
(function (require, module, exports) {
  'use strict';

  var replaceCharAll = require('internal/primordials').replaceCharAll;

  var hasOwn = Object.prototype.hasOwnProperty;

  function escape(str) {
    return encodeURIComponent(String(str));
  }

  function unescape(str) {
    // Standalone unescape percent-decodes only; '+' is NOT mapped to space here
    // (Node parity — only parse() does that, see decodeComponent).
    try {
      return decodeURIComponent(str);
    } catch {
      return str;
    }
  }

  function stringifyPrimitive(v) {
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return isFinite(v) ? '' + v : '';
    if (typeof v === 'bigint') return '' + v;
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    return '';
  }

  function stringify(obj, sep, eq, options) {
    sep = sep || '&';
    eq = eq || '=';
    var encode = (options && options.encodeURIComponent) || escape;
    if (obj === null || typeof obj !== 'object') return '';

    var keys = Object.keys(obj);
    var out = '';
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var ek = encode(key) + eq;
      var val = obj[key];
      if (Array.isArray(val)) {
        for (var j = 0; j < val.length; j++) {
          if (out) out += sep;
          out += ek + encode(stringifyPrimitive(val[j]));
        }
      } else {
        if (out) out += sep;
        out += ek + encode(stringifyPrimitive(val));
      }
    }
    return out;
  }

  function parse(qs, sep, eq, options) {
    sep = sep || '&';
    eq = eq || '=';
    var decode = (options && options.decodeURIComponent) || unescape;
    var maxKeys = options && typeof options.maxKeys === 'number' ? options.maxKeys : 1000;

    var obj = Object.create(null);
    if (typeof qs !== 'string' || qs.length === 0) return obj;

    var pairs = qs.split(sep);
    var limit = maxKeys > 0 ? Math.min(pairs.length, maxKeys) : pairs.length;

    for (var i = 0; i < limit; i++) {
      var pair = pairs[i];
      if (pair === '') continue;

      var idx = pair.indexOf(eq);
      var key, val;
      if (idx >= 0) {
        key = pair.slice(0, idx);
        val = pair.slice(idx + eq.length);
      } else {
        key = pair;
        val = '';
      }

      key = decodeComponent(key, decode);
      val = decodeComponent(val, decode);

      if (!hasOwn.call(obj, key)) {
        obj[key] = val;
      } else if (Array.isArray(obj[key])) {
        obj[key].push(val);
      } else {
        obj[key] = [obj[key], val];
      }
    }
    return obj;
  }

  function decodeComponent(s, decode) {
    if (s.length === 0) return s;
    // The query-string convention maps '+' to a space. Node rewrites '+' to '%20'
    // (not a literal space) before decoding, so the default decoder turns it into a
    // space AND a custom decodeURIComponent still sees an encoded space.
    //
    // No regex: this was `s.replace(/\+/g, '%20')`, and a GLOBAL replace under a forged
    // `RegExp.prototype.exec` never returns — it is the most remote-reachable instance
    // of that class in the tree, because `parse` is public `node:querystring` and a
    // single '+' in a query string is the whole trigger. A server doing
    // `parse(req.url.split('?')[1])` wedged on a crafted request. node answers correctly
    // under the same poison, so this was a Lava-only defect; pinned by
    // tests/node-compat/cases/59-global-replace-hangs.js. replaceCharAll returns `s`
    // unchanged when there is no '+', which is why the old indexOf guard is gone.
    s = replaceCharAll(s, '+', '%20');
    try {
      return decode(s);
    } catch {
      return s;
    }
  }

  module.exports = {
    parse: parse,
    stringify: stringify,
    encode: stringify, // legacy aliases (Node keeps both)
    decode: parse,
    escape: escape,
    unescape: unescape,
  };
});
