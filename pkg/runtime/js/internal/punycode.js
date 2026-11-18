// internal/punycode — the RFC 3492 Punycode codec behind the URL Standard's IDNA
// step (internal/idna). Not node's public `punycode` module: that one is
// js/node/punycode.js, the userland punycode.js surface, which throws node's
// error strings and deliberately reads Math.floor/String.fromCharCode live (see its
// header). This one stays the minimal pair the host parser needs, captured at
// module-eval like the rest of the URL path. Not publicly requireable.
//
// encode throws nothing; decode throws a RangeError on malformed input, which its
// one caller (internal/idna's domainToUnicode) catches and turns into "keep the
// label as is", so no throw from here ever reaches user code.
(function (require, module, _exports) {
  'use strict';

  // Eager through internal/url (the loader instantiates url before user code), so
  // these module-eval captures are pristine — see internal/url's header.
  var P = require('internal/primordials');
  var ArrayPrototypePush = P.ArrayPrototypePush;
  var ArrayPrototypeSplice = P.ArrayPrototypeSplice;
  var StringPrototypeCharCodeAt = P.StringPrototypeCharCodeAt;
  var StringPrototypeCodePointAt = P.StringPrototypeCodePointAt;
  var StringFromCharCode = String.fromCharCode;
  var StringFromCodePoint = String.fromCodePoint;
  var MathFloor = Math.floor;

  var PUNY_BASE = 36;
  var PUNY_TMIN = 1;
  var PUNY_TMAX = 26;
  var PUNY_SKEW = 38;
  var PUNY_DAMP = 700;
  var PUNY_INITIAL_BIAS = 72;
  var PUNY_INITIAL_N = 128;

  function punyAdapt(delta, numPoints, firstTime) {
    delta = firstTime ? MathFloor(delta / PUNY_DAMP) : delta >> 1;
    delta += MathFloor(delta / numPoints);
    var k = 0;
    while (delta > ((PUNY_BASE - PUNY_TMIN) * PUNY_TMAX) >> 1) {
      delta = MathFloor(delta / (PUNY_BASE - PUNY_TMIN));
      k += PUNY_BASE;
    }
    return k + MathFloor(((PUNY_BASE - PUNY_TMIN + 1) * delta) / (delta + PUNY_SKEW));
  }

  function punyEncodeDigit(d) {
    // 0..25 -> a..z, 26..35 -> 0..9
    return d + 22 + (d < 26 ? 75 : 0);
  }
  function punyDecodeDigit(cp) {
    if (cp - 48 < 10) return cp - 22; // 0..9
    if (cp - 65 < 26) return cp - 65; // A..Z
    if (cp - 97 < 26) return cp - 97; // a..z
    return PUNY_BASE;
  }

  function punycodeEncode(input) {
    var output = [];
    var codePoints = [];
    for (var s = 0; s < input.length; s++) {
      var cp = StringPrototypeCodePointAt(input, s);
      if (cp > 0xffff) s++;
      ArrayPrototypePush(codePoints, cp);
    }
    var n = PUNY_INITIAL_N;
    var delta = 0;
    var bias = PUNY_INITIAL_BIAS;
    var basicLength = 0;
    var i;
    for (i = 0; i < codePoints.length; i++) {
      if (codePoints[i] < 0x80) {
        ArrayPrototypePush(output, codePoints[i]);
        basicLength++;
      }
    }
    var handled = basicLength;
    if (basicLength > 0) ArrayPrototypePush(output, 0x2d); // '-'
    while (handled < codePoints.length) {
      var m = 0x7fffffff;
      for (i = 0; i < codePoints.length; i++) {
        if (codePoints[i] >= n && codePoints[i] < m) m = codePoints[i];
      }
      delta += (m - n) * (handled + 1);
      n = m;
      for (i = 0; i < codePoints.length; i++) {
        var c = codePoints[i];
        if (c < n) delta++;
        if (c === n) {
          var q = delta;
          for (var k = PUNY_BASE; ; k += PUNY_BASE) {
            var t = k <= bias ? PUNY_TMIN : k >= bias + PUNY_TMAX ? PUNY_TMAX : k - bias;
            if (q < t) break;
            ArrayPrototypePush(output, punyEncodeDigit(t + ((q - t) % (PUNY_BASE - t))));
            q = MathFloor((q - t) / (PUNY_BASE - t));
          }
          ArrayPrototypePush(output, punyEncodeDigit(q));
          bias = punyAdapt(delta, handled + 1, handled === basicLength);
          delta = 0;
          handled++;
        }
      }
      delta++;
      n++;
    }
    var str = '';
    for (i = 0; i < output.length; i++) str += StringFromCharCode(output[i]);
    return str;
  }

  function punycodeDecode(input) {
    var output = [];
    var n = PUNY_INITIAL_N;
    var bias = PUNY_INITIAL_BIAS;
    var i = 0;
    var basic = input.lastIndexOf('-');
    if (basic < 0) basic = 0;
    for (var j = 0; j < basic; j++) {
      if (StringPrototypeCharCodeAt(input, j) >= 0x80) throw new RangeError('Invalid input');
      ArrayPrototypePush(output, StringPrototypeCharCodeAt(input, j));
    }
    var index = basic > 0 ? basic + 1 : 0;
    while (index < input.length) {
      var oldi = i;
      var w = 1;
      for (var k = PUNY_BASE; ; k += PUNY_BASE) {
        if (index >= input.length) throw new RangeError('Invalid input');
        var digit = punyDecodeDigit(StringPrototypeCharCodeAt(input, index++));
        if (digit >= PUNY_BASE) throw new RangeError('Invalid input');
        i += digit * w;
        var t = k <= bias ? PUNY_TMIN : k >= bias + PUNY_TMAX ? PUNY_TMAX : k - bias;
        if (digit < t) break;
        w *= PUNY_BASE - t;
      }
      var outLen = output.length + 1;
      bias = punyAdapt(i - oldi, outLen, oldi === 0);
      n += MathFloor(i / outLen);
      i %= outLen;
      ArrayPrototypeSplice(output, i, 0, n);
      i++;
    }
    var str = '';
    for (var o = 0; o < output.length; o++) str += StringFromCodePoint(output[o]);
    return str;
  }

  module.exports = {
    encode: punycodeEncode,
    decode: punycodeDecode,
  };
});
