// util.parseEnv — parse a .env-format string into an object (Node 21+). Matches Node's
// C++ dotenv parser (src/node_dotenv.cc): the `export ` prefix, `#` comment lines,
// single/double/backtick quotes whose matching close may span newlines, double-quote-only
// `\n` -> newline expansion (every other backslash, incl. one before the closing quote, is
// literal; single/backtick are fully literal), an *unterminated* quote falling back to a
// line literal that keeps the opening quote and ignores inline `#`, inline `#` comments on
// unquoted values, and last-wins on duplicate keys. The result is a null-prototype object
// (node 26), so a `__proto__` key is an ordinary own property, and its keys come out
// byte-sorted (Node stores them in a std::map). Pure JS via
// primordials; backs require('node:util').parseEnv. Hidden from the public resolver like
// parse_args.
(function (require, module) {
  'use strict';

  var P = require('internal/primordials');
  var StringPrototypeCharCodeAt = P.StringPrototypeCharCodeAt;
  var StringPrototypeSlice = P.StringPrototypeSlice;
  var StringPrototypeTrim = P.StringPrototypeTrim;
  var ObjectKeys = P.ObjectKeys;
  var ArrayPrototypeSort = P.ArrayPrototypeSort;
  var TypeError = P.TypeError;

  function codedError(code, message) {
    var e = new TypeError(message);
    e.code = code;
    return e;
  }

  // Node's ERR_INVALID_ARG_TYPE "Received ..." clause for a non-string argument: a
  // primitive shows `type <typeof> (<value>)`, null/undefined show as-is, and an object
  // shows `an instance of <constructor>` (e.g. Buffer).
  function received(v) {
    if (v === null) return 'null';
    var t = typeof v;
    if (t === 'undefined') return 'undefined';
    if (t === 'object') {
      var name = v.constructor && v.constructor.name ? v.constructor.name : 'Object';
      return 'an instance of ' + name;
    }
    return 'type ' + t + ' (' + String(v) + ')';
  }

  var CR = 13;
  var LF = 10;
  var SPACE = 32;
  var TAB = 9;
  var HASH = 35; // #
  var EQ = 61; // =
  var DQUOTE = 34; // "
  var SQUOTE = 39; // '
  var BACKTICK = 96; // `
  var BACKSLASH = 92; // \
  var LOWER_N = 110; // n

  function isWs(c) {
    return c === SPACE || c === TAB || c === CR || c === LF;
  }
  function isInlineWs(c) {
    return c === SPACE || c === TAB;
  }

  // std::map key order: compare by UTF-16 code unit, which matches Node's byte order for
  // the ASCII keys env names use in practice.
  function byteCompare(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
  }

  // Node strips every carriage return from the input before parsing (CRLF -> LF, and a
  // lone CR is dropped), so quoted multiline values and separators normalize the same on
  // Windows-authored files. Returns the original string when there is no CR to remove.
  function stripCR(s) {
    var slen = s.length;
    var out = '';
    var seg = 0;
    for (var k = 0; k < slen; k++) {
      if (StringPrototypeCharCodeAt(s, k) === CR) {
        out += StringPrototypeSlice(s, seg, k);
        seg = k + 1;
      }
    }
    return seg === 0 ? s : out + StringPrototypeSlice(s, seg);
  }

  // Double-quoted values expand only `\n` -> newline; Node does a naive left-to-right
  // substring replace, so `\\n` (backslash then `\n`) keeps the first backslash and
  // expands the second pair.
  function expandNewlines(s) {
    var out = '';
    var slen = s.length;
    var seg = 0;
    var j = 0;
    while (j < slen) {
      if (
        StringPrototypeCharCodeAt(s, j) === BACKSLASH &&
        j + 1 < slen &&
        StringPrototypeCharCodeAt(s, j + 1) === LOWER_N
      ) {
        out += StringPrototypeSlice(s, seg, j) + '\n';
        j += 2;
        seg = j;
      } else {
        j++;
      }
    }
    out += StringPrototypeSlice(s, seg);
    return out;
  }

  function parseEnv(content) {
    // Node requires a string and throws ERR_INVALID_ARG_TYPE otherwise (Buffers included).
    if (typeof content !== 'string') {
      throw codedError(
        'ERR_INVALID_ARG_TYPE',
        'The "content" argument must be of type string. Received ' + received(content),
      );
    }
    content = stripCR(content);
    var tmp = { __proto__: null };
    var i = 0;
    // Node rtrims the whole input once, so trailing whitespace never reaches a value —
    // an unterminated quote at end-of-input loses it, but spaces before a newline survive.
    var len = content.length;
    while (len > 0 && isWs(StringPrototypeCharCodeAt(content, len - 1))) len--;

    while (i < len) {
      // Skip blank space / newlines between entries.
      while (i < len && isWs(StringPrototypeCharCodeAt(content, i))) i++;
      if (i >= len) break;

      // Comment line.
      if (StringPrototypeCharCodeAt(content, i) === HASH) {
        while (i < len && StringPrototypeCharCodeAt(content, i) !== LF) i++;
        continue;
      }

      // Optional `export ` prefix.
      if (StringPrototypeSlice(content, i, i + 7) === 'export ') {
        i += 7;
        while (i < len && isInlineWs(StringPrototypeCharCodeAt(content, i))) i++;
      }

      // Key: up to '=' (a line with no '=' is skipped).
      var keyStart = i;
      while (
        i < len &&
        StringPrototypeCharCodeAt(content, i) !== EQ &&
        StringPrototypeCharCodeAt(content, i) !== LF
      ) {
        i++;
      }
      if (i >= len || StringPrototypeCharCodeAt(content, i) === LF) continue;
      var key = StringPrototypeTrim(StringPrototypeSlice(content, keyStart, i));
      i++; // skip '='

      // Skip inline whitespace before the value.
      while (i < len && isInlineWs(StringPrototypeCharCodeAt(content, i))) i++;

      var value;
      var q = i < len ? StringPrototypeCharCodeAt(content, i) : 0;
      if (q === DQUOTE || q === SQUOTE || q === BACKTICK) {
        // Look ahead for the matching close quote, which may be many lines away. A
        // backslash never escapes it.
        var close = i + 1;
        while (close < len && StringPrototypeCharCodeAt(content, close) !== q) close++;
        if (close >= len) {
          // Unterminated: keep the opening quote and take the rest of the line literally
          // (no `#` comment handling, no per-value trim — the whole-input rtrim above is
          // the only trailing-whitespace removal).
          var eol = i;
          while (eol < len && StringPrototypeCharCodeAt(content, eol) !== LF) eol++;
          value = StringPrototypeSlice(content, i, eol);
          i = eol;
        } else {
          var raw = StringPrototypeSlice(content, i + 1, close);
          value = q === DQUOTE ? expandNewlines(raw) : raw;
          i = close + 1;
          // Ignore the rest of the line after a quoted value.
          while (i < len && StringPrototypeCharCodeAt(content, i) !== LF) i++;
        }
      } else {
        // Unquoted: up to a newline or a '#' comment; trimmed.
        var valStart = i;
        while (
          i < len &&
          StringPrototypeCharCodeAt(content, i) !== LF &&
          StringPrototypeCharCodeAt(content, i) !== HASH
        ) {
          i++;
        }
        value = StringPrototypeTrim(StringPrototypeSlice(content, valStart, i));
        while (i < len && StringPrototypeCharCodeAt(content, i) !== LF) i++;
      }

      // `tmp` has no prototype, so `__proto__` here is a plain key, not the setter.
      if (key.length > 0) tmp[key] = value;
    }

    // Node returns the keys in std::map (byte-sorted) order. From node 26 the object has
    // a null prototype and keeps `__proto__` as an own data property; node 24 returned a
    // plain object and dropped the key. Null prototype on `result` too, so the
    // `__proto__` assignment below defines a property instead of calling the setter.
    var keys = ObjectKeys(tmp);
    ArrayPrototypeSort(keys, byteCompare);
    var result = { __proto__: null };
    for (var k = 0; k < keys.length; k++) result[keys[k]] = tmp[keys[k]];
    return result;
  }

  module.exports = { parseEnv: parseEnv };
});
