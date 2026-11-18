// pbkdf2/pbkdf2Sync — where node keeps them: lib/internal/crypto/pbkdf2.js.
//
// @param {{ pbkdf2: Function }} native node:crypto's bindings (the loader hands this
//   file the same object as node/crypto.js).
(function (require, module, exports, native) {
  'use strict';

  var Buffer = require('buffer').Buffer;
  var util = require('internal/crypto/util');
  var invalidArgType = util.invalidArgType;
  var validateInt32 = util.validateInt32;
  var toU8 = util.toU8;
  var resolveDigest = util.resolveDigest;
  var invalidDigestError = util.invalidDigestError;

  function pbkdf2Sync(password, salt, iterations, keylen, digest) {
    if (typeof digest !== 'string') throw invalidArgType('digest', 'string', digest);
    var algo = resolveDigest(digest);
    if (!algo) throw invalidDigestError(digest);
    var pw = toU8(password, undefined, 'password');
    var slt = toU8(salt, undefined, 'salt');
    // Node validates iterations as 1..2^31-1 and keylen as 0..2^31-1. The old
    // `iterations >>> 0` turned -1 into 4294967295 (a permanent sync hang) and
    // wrapped values >= 2^32 to a different derived key.
    validateInt32(iterations, 'iterations', 1);
    validateInt32(keylen, 'keylen', 0);
    var out = native.pbkdf2(algo, pw, slt, iterations, keylen);
    return Buffer.from(out);
  }

  function pbkdf2(password, salt, iterations, keylen, digest, callback) {
    if (typeof callback !== 'function') throw new TypeError('Callback must be a function');
    setImmediate(function () {
      var key;
      try {
        key = pbkdf2Sync(password, salt, iterations, keylen, digest);
      } catch (err) {
        callback(err);
        return;
      }
      callback(null, key);
    });
  }

  module.exports = { pbkdf2: pbkdf2, pbkdf2Sync: pbkdf2Sync };
});
