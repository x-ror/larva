// hkdf/hkdfSync — where node keeps them: lib/internal/crypto/hkdf.js.
//
// @param {{ hkdf: Function }} native node:crypto's bindings (the loader hands this file
//   the same object as node/crypto.js).
(function (require, module, exports, native) {
  'use strict';

  var util = require('internal/crypto/util');
  var toU8 = util.toU8;
  var resolveDigest = util.resolveDigest;
  var invalidDigestError = util.invalidDigestError;

  // hkdfSync(digest, ikm, salt, info, keylen) — RFC 5869 HKDF over the native
  // crypto primitive. Returns an ArrayBuffer, matching Node.
  function hkdfSync(digest, ikm, salt, info, keylen) {
    var algo = resolveDigest(digest);
    if (!algo) throw invalidDigestError(digest);
    return native.hkdf(algo, toU8(ikm), toU8(salt), toU8(info), keylen).buffer;
  }

  function hkdf(digest, ikm, salt, info, keylen, callback) {
    if (typeof callback !== 'function') throw new TypeError('Callback must be a function');
    setImmediate(function () {
      var key;
      try {
        key = hkdfSync(digest, ikm, salt, info, keylen);
      } catch (err) {
        callback(err);
        return;
      }
      callback(null, key);
    });
  }

  module.exports = { hkdf: hkdf, hkdfSync: hkdfSync };
});
