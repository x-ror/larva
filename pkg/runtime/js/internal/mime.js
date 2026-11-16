// util.MIMEType / util.MIMEParams — a WHATWG MIME type parser, matching Node. Parsing
// lowercases the type, subtype and parameter names (values keep their case); serialization
// re-quotes a value only when it is empty or not an HTTP token. Internal state is held on
// Symbol-keyed slots (like URLSearchParams in url.js), not #private fields. Hidden from the
// public resolver; util.MIMEType / util.MIMEParams are the public surface.
(function (require, module) {
  'use strict';

  // Captured for encodeValue, which replaced a global-flag replace reachable from a
  // remote Content-Type. This file is not otherwise hardened — see the ratchet baseline.
  var P = require('internal/primordials');
  var StringPrototypeCharCodeAt = P.StringPrototypeCharCodeAt;
  var StringPrototypeSlice = P.StringPrototypeSlice;
  var RegExpMatches = P.RegExpMatches;

  // Taken off the primordials table, not the live globals: this module is LAZY (its factory
  // runs on the user's first require of util), so a module-eval `Symbol(...)` here reads
  // whatever user code left on globalThis — #426, pinned by
  // tests/node-compat/cases/75-lazy-global-capture.js.
  var SymbolG = P.Symbol;
  var ObjectDefineProperties = P.ObjectDefineProperties;

  var kData = SymbolG('data'); // MIMEParams: the Map of name -> value
  var kType = SymbolG('type');
  var kSubtype = SymbolG('subtype');
  var kParams = SymbolG('params');

  // An HTTP token code point (RFC 9110): the chars allowed unquoted in a type/subtype/name.
  var NotHTTPTokenCodePoint = /[^!#$%&'*+\-.^_`|~A-Za-z0-9]/;
  // An HTTP quoted-string code point: tab, the printable ASCII range (U+0020..U+007E), and
  // the Latin-1 high range (U+0080..U+00FF). Anything else (other controls, newline) cannot
  // appear even inside quotes. A literal with escapes rather than the `new RegExp(String.
  // fromCharCode(...))` it used to be: same class, and no read of a replaceable global.
  var NotHTTPQuotedStringCodePoint = /[^\t\x20-\x7E\x80-\xFF]/;
  // Node's HTTP whitespace is tab, LF, CR and space — NOT form-feed (U+000C), unlike the
  // looser WHATWG set: a leading/trailing `\f` makes the type invalid rather than being
  // stripped, and a `\f` in a value keeps it (so the value fails the quoted-string check).
  var LEADING_HTTP_WS = /^[\t\n\r ]+/;
  var TRAILING_HTTP_WS = /[\t\n\r ]+$/;

  function isHTTPWhitespace(c) {
    return c === '\t' || c === '\n' || c === '\r' || c === ' ';
  }

  // asciiLower folds A-Z only, as Node's MIME code does; String#toLowerCase would also
  // fold non-ASCII (KELVIN SIGN U+212A -> "k"), turning an invalid name into a valid one.
  // Returns the input itself when nothing needs folding, the common case. The lowercase
  // letter is sliced from a literal rather than built with String.fromCharCode, which a
  // lazily loaded module like this one could only read live (CLAUDE.md §5).
  var ASCII_LOWER = 'abcdefghijklmnopqrstuvwxyz';
  function asciiLower(str) {
    var out = '';
    var from = 0;
    for (var i = 0; i < str.length; i++) {
      var c = StringPrototypeCharCodeAt(str, i);
      if (c < 0x41 || c > 0x5a) continue;
      out +=
        StringPrototypeSlice(str, from, i) + StringPrototypeSlice(ASCII_LOWER, c - 0x41, c - 0x40);
      from = i + 1;
    }
    return from === 0 ? str : out + StringPrototypeSlice(str, from);
  }

  var nodeError = require('internal/errors').nodeError;
  var TypeErrorP = P.TypeError;

  function mimeError(production, input, index) {
    var msg = 'The MIME syntax for a ' + production + ' in "' + input + '" is invalid';
    if (index !== undefined && index !== -1) msg += ' at ' + index;
    return nodeError(TypeErrorP, 'ERR_INVALID_MIME_SYNTAX', msg);
  }

  // Validate a token production (type/subtype/parameter name). `input` is the string shown
  // in the error. The reported index is relative to `value`, not to `input`: node 26.13.0 says
  // `The MIME syntax for a subtype in "text/p@in" is invalid at 1`.
  function validateToken(production, value, input) {
    if (value.length === 0) throw mimeError(production, input, -1);
    var bad = value.search(NotHTTPTokenCodePoint);
    if (bad !== -1) throw mimeError(production, input, bad);
  }

  function parse(str) {
    // The whole input is trimmed at both ends first (WHATWG mimesniff step 1), so an
    // unterminated `a="b\t` loses the tab — node 26 does this; node 24 trimmed only the
    // leading end and kept it. Subtype and unquoted values are still trimmed per
    // component, since whitespace before a ';' is not at the end of the input. Errors
    // quote the input as given, as node does.
    var input = str;
    str = str.replace(LEADING_HTTP_WS, '');
    var end = str.length;
    while (end > 0 && isHTTPWhitespace(str[end - 1])) end--;
    str = StringPrototypeSlice(str, 0, end);
    var slash = str.indexOf('/');
    if (slash === -1) throw mimeError('type', input, -1);
    var type = str.slice(0, slash);
    validateToken('type', type, input);

    var rest = str.slice(slash + 1);
    var semi = rest.indexOf(';');
    var subtype = (semi === -1 ? rest : rest.slice(0, semi)).replace(TRAILING_HTTP_WS, '');
    validateToken('subtype', subtype, input);

    var params = new Map();
    if (semi !== -1) parseParameters(rest.slice(semi + 1), params);
    return { type: asciiLower(type), subtype: asciiLower(subtype), params: params };
  }

  // WHATWG "parse a MIME type"'s parameters loop, over the text after the first ';'.
  function parseParameters(str, params) {
    var position = 0;
    var len = str.length;
    while (position < len) {
      while (position < len && isHTTPWhitespace(str[position])) position++;
      var nameStart = position;
      while (position < len && str[position] !== ';' && str[position] !== '=') position++;
      var name = asciiLower(str.slice(nameStart, position));

      if (position < len && str[position] === ';') {
        position++;
        continue; // a bare name with no '=' is skipped
      }
      if (position >= len) break;
      position++; // skip '='

      var value;
      var quoted = false;
      if (position < len && str[position] === '"') {
        quoted = true;
        position++;
        var buf = '';
        while (position < len) {
          var ch = str[position];
          if (ch === '\\') {
            if (position + 1 < len) {
              buf += str[position + 1];
              position += 2;
              continue;
            }
            buf += '\\';
            position++;
            break;
          }
          if (ch === '"') {
            position++;
            break;
          }
          buf += ch;
          position++;
        }
        value = buf;
        // Everything after the closing quote up to the next ';' is discarded (WHATWG
        // mimesniff, node 26): `a="b" c=d` keeps only a. node 24 resumed one char past
        // the quote and kept c=d.
        while (position < len && str[position] !== ';') position++;
      } else {
        var valStart = position;
        while (position < len && str[position] !== ';') position++;
        value = str.slice(valStart, position).replace(TRAILING_HTTP_WS, '');
      }
      if (position < len) position++; // step past the ';'

      // Keep only well-formed, non-duplicate parameters (first wins). An empty value is
      // dropped only when it was unquoted; a quoted "" is a valid empty value, matching
      // Node/WHATWG (the empty-value skip applies to the unquoted collection only).
      if (
        name.length > 0 &&
        (quoted || value.length > 0) &&
        !NotHTTPTokenCodePoint.test(name) &&
        !NotHTTPQuotedStringCodePoint.test(value) &&
        !params.has(name)
      ) {
        params.set(name, value);
      }
    }
  }

  // escapeQuoted is `value.replace(/[\\"]/g, '\\$&')` without the RegExp. A GLOBAL
  // replace under a forged `RegExp.prototype.exec` never returns — it only advances
  // `lastIndex` on an empty match — and this one is reachable from a remote
  // `Content-Type`: `new MIMEType(header)` then `String(m)` wedged the process. node
  // answers correctly under the same poison, so it was a Lava-only defect.
  //
  // It also fires more often than it looks: the `NotHTTPTokenCodePoint.test` guard on
  // the caller is itself forced truthy under the poison, so EVERY parameter took the
  // quoting branch, not just values that need quotes.
  //
  // Two escaped units, so `replaceCharAll` (single needle) does not fit; a scan is the
  // straightforward shape and avoids two passes over the value.
  function escapeQuoted(value) {
    var out = '';
    var from = 0;
    for (var i = 0; i < value.length; i++) {
      var c = StringPrototypeCharCodeAt(value, i);
      if (c !== 0x5c && c !== 0x22) continue; // \ "
      if (i > from) out += StringPrototypeSlice(value, from, i);
      out += '\\' + StringPrototypeSlice(value, i, i + 1);
      from = i + 1;
    }
    if (from === 0) return value;
    return from < value.length ? out + StringPrototypeSlice(value, from) : out;
  }

  function encodeValue(value) {
    if (value.length === 0 || RegExpMatches(NotHTTPTokenCodePoint, value)) {
      return '"' + escapeQuoted(value) + '"';
    }
    return value;
  }

  // Serialize a parameter Map to `name=value;name=value`. Shared so MIMEType#toString can
  // serialize from the internal data directly instead of dispatching through the public
  // MIMEParams#toString (which user code may override or replace).
  function serializeParams(data) {
    var parts = [];
    data.forEach(function (value, name) {
      parts.push(name + '=' + encodeValue(value));
    });
    return parts.join(';');
  }

  function MIMEParams() {
    if (new.target === undefined) {
      throw new TypeError("Class constructor MIMEParams cannot be invoked without 'new'");
    }
    this[kData] = new Map();
  }

  // Every name-taking method folds the name the way parse does, so a parsed `charset`
  // is reachable as get('Charset') and set('Charset') replaces it rather than adding a
  // second parameter (since node 24.21; re-verified on 26.13.0; node 22 compared names as
  // given). The fold
  // happens before validation, so a syntax error quotes the folded name.
  MIMEParams.prototype.get = function get(name) {
    var data = this[kData];
    name = asciiLower(`${name}`);
    return data.has(name) ? data.get(name) : null;
  };
  MIMEParams.prototype.has = function has(name) {
    return this[kData].has(asciiLower(`${name}`));
  };
  MIMEParams.prototype.set = function set(name, value) {
    var data = this[kData];
    name = asciiLower(`${name}`);
    value = `${value}`;
    if (name.length === 0) throw mimeError('parameter name', name, -1);
    var badName = name.search(NotHTTPTokenCodePoint);
    if (badName !== -1) throw mimeError('parameter name', name, badName);
    var badValue = value.search(NotHTTPQuotedStringCodePoint);
    if (badValue !== -1) throw mimeError('parameter value', value, badValue);
    data.set(name, value);
    // Node's MIMEParams#set returns undefined (like URLSearchParams#set), not `this`.
  };
  MIMEParams.prototype.delete = function del(name) {
    this[kData].delete(asciiLower(`${name}`));
  };
  MIMEParams.prototype.entries = function entries() {
    return this[kData].entries();
  };
  MIMEParams.prototype.keys = function keys() {
    return this[kData].keys();
  };
  MIMEParams.prototype.values = function values() {
    return this[kData].values();
  };
  MIMEParams.prototype.toString = function toString() {
    return serializeParams(this[kData]);
  };
  MIMEParams.prototype.toJSON = MIMEParams.prototype.toString;
  MIMEParams.prototype[SymbolG.iterator] = MIMEParams.prototype.entries;

  function MIMEType(string) {
    if (new.target === undefined) {
      throw new TypeError("Class constructor MIMEType cannot be invoked without 'new'");
    }
    var parsed = parse(`${string}`);
    this[kType] = parsed.type;
    this[kSubtype] = parsed.subtype;
    var params = new MIMEParams();
    params[kData] = parsed.params;
    this[kParams] = params;
  }

  ObjectDefineProperties(MIMEType.prototype, {
    type: {
      configurable: true,
      enumerable: true,
      get: function () {
        return this[kType];
      },
      set: function (value) {
        value = `${value}`;
        validateToken('type', value, value);
        this[kType] = value.toLowerCase();
      },
    },
    subtype: {
      configurable: true,
      enumerable: true,
      get: function () {
        return this[kSubtype];
      },
      set: function (value) {
        value = `${value}`;
        validateToken('subtype', value, value);
        this[kSubtype] = value.toLowerCase();
      },
    },
    essence: {
      configurable: true,
      enumerable: true,
      get: function () {
        return this[kType] + '/' + this[kSubtype];
      },
    },
    params: {
      configurable: true,
      enumerable: true,
      get: function () {
        return this[kParams];
      },
    },
  });

  MIMEType.prototype.toString = function toString() {
    // Serialize from the internal parameter data, not via this[kParams].toString(), so a
    // user-overridden MIMEParams#toString cannot change or break MIMEType serialization.
    var paramStr = serializeParams(this[kParams][kData]);
    return this[kType] + '/' + this[kSubtype] + (paramStr.length > 0 ? ';' + paramStr : '');
  };
  MIMEType.prototype.toJSON = MIMEType.prototype.toString;

  module.exports = { MIMEType: MIMEType, MIMEParams: MIMEParams };
});
