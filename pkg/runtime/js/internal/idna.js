// internal/idna — the URL Standard's domain-to-ASCII / domain-to-Unicode step,
// laid out like node's lib/internal/idna.js: the IDNA label-separator fold, the
// UTS-46 mapping approximation, and the `xn--` passes over internal/punycode.
// internal/url's host parser calls domainToASCII; format's `unicode` option and the
// public domainToUnicode reach domainToUnicode through internal/url. Not publicly
// requireable.
//
// Nothing here throws: domainToASCII returns FAILURE (exported, so internal/url's
// `=== FAILURE` checks compare against the same object), and domainToUnicode keeps
// a label it cannot decode. Every user-visible throw for a bad host stays in
// internal/url, so this file owns no frame node puts elsewhere.
//
// Deliberate deviation from Node, documented in reference/node-compatibility.md:
// IDNA/UTS-46 host processing is approximated (NFC + lowercase + Punycode) rather
// than the full ICU mapping; common Unicode domains round-trip, but exotic
// mapping/validation edge cases may differ.
(function (require, module, _exports) {
  'use strict';

  // Eager through internal/url (the loader instantiates url before user code), so
  // these module-eval captures are pristine — see internal/url's header.
  var P = require('internal/primordials');
  var ArrayPrototypePush = P.ArrayPrototypePush;
  var ArrayPrototypeJoin = P.ArrayPrototypeJoin;
  var StringPrototypeCharCodeAt = P.StringPrototypeCharCodeAt;
  var StringPrototypeSlice = P.StringPrototypeSlice;
  var StringPrototypeSplit = P.StringPrototypeSplit;
  var StringPrototypeNormalize = P.StringPrototypeNormalize;
  var StringPrototypeToLowerCase = P.StringPrototypeToLowerCase;
  var StringFromCharCode = String.fromCharCode;
  var punycode = require('internal/punycode');
  var punycodeEncode = punycode.encode;
  var punycodeDecode = punycode.decode;

  // A unique sentinel distinct from any valid parser result; using a symbol means
  // it can never collide with a legitimately-produced host string or number.
  var FAILURE = { failure: true };

  // U+3002 IDEOGRAPHIC FULL STOP, U+FF0E FULLWIDTH FULL STOP, U+FF61 HALFWIDTH
  // IDEOGRAPHIC FULL STOP — the IDNA label separators that fold to '.'. Getting
  // this wrong is host confusion, not a cosmetic difference.
  function isIdnaSeparator(c) {
    return c === 0x3002 || c === 0xff0e || c === 0xff61;
  }

  // The fold, not a strip: these three map TO '.', they are not removed.
  function foldIdnaSeparators(s) {
    var n = s.length;
    var i = 0;
    for (; i < n; i++) {
      if (isIdnaSeparator(StringPrototypeCharCodeAt(s, i))) break;
    }
    if (i === n) return s;
    var out = StringPrototypeSlice(s, 0, i);
    for (; i < n; i++) {
      var c = StringPrototypeCharCodeAt(s, i);
      out += isIdnaSeparator(c) ? '.' : StringFromCharCode(c);
    }
    return out;
  }

  function hasNonASCII(str) {
    for (var i = 0; i < str.length; i++) {
      if (StringPrototypeCharCodeAt(str, i) > 0x7f) return true;
    }
    return false;
  }

  // Simplified IDNA ToASCII. Approximates UTS-46 by: normalizing the three IDNA
  // label separators to '.', applying NFKC + lowercasing each Unicode label (so
  // fullwidth/compatibility characters fold the way ICU maps them), and emitting
  // the Punycode "xn--…" form. ASCII labels are just lowercased. Not the full ICU
  // mapping table, but round-trips the overwhelming majority of real domains.
  function domainToASCII(domain) {
    if (domain === '') return '';
    // IDEOGRAPHIC FULL STOP, FULLWIDTH FULL STOP, HALFWIDTH IDEOGRAPHIC FULL STOP.
    // Fold the three IDNA separators to '.', without a RegExp — see stripChars.
    domain = foldIdnaSeparators(domain);
    var labels = StringPrototypeSplit(domain, '.');
    var out = [];
    for (var i = 0; i < labels.length; i++) {
      var label = labels[i];
      if (hasNonASCII(label)) {
        var mapped = (
          label.normalize ? StringPrototypeNormalize(label, 'NFKC') : label
        ).toLowerCase();
        if (!hasNonASCII(mapped)) {
          // The mapping folded the label to pure ASCII (e.g. fullwidth digits).
          ArrayPrototypePush(out, mapped);
          continue;
        }
        try {
          ArrayPrototypePush(out, 'xn--' + punycodeEncode(mapped));
        } catch {
          return FAILURE;
        }
      } else {
        ArrayPrototypePush(out, StringPrototypeToLowerCase(label));
      }
    }
    return ArrayPrototypeJoin(out, '.');
  }

  function domainToUnicode(domain) {
    if (domain === '') return '';
    var labels = StringPrototypeSplit(domain, '.');
    var out = [];
    for (var i = 0; i < labels.length; i++) {
      var label = labels[i];
      if (label.slice(0, 4).toLowerCase() === 'xn--') {
        try {
          ArrayPrototypePush(out, punycodeDecode(label.slice(4)));
        } catch {
          ArrayPrototypePush(out, label);
        }
      } else {
        ArrayPrototypePush(out, label);
      }
    }
    return ArrayPrototypeJoin(out, '.');
  }

  module.exports = {
    FAILURE: FAILURE,
    domainToASCII: domainToASCII,
    domainToUnicode: domainToUnicode,
  };
});
