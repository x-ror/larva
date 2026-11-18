// Hash, Hmac and the one-shot crypto.hash() — where node keeps them:
// lib/internal/crypto/hash.js. Streaming is handled here by accumulating chunks and
// calling the one-shot native primitive once at digest time, so no streaming state has
// to cross the native boundary.
//
// @param {{ hash: Function, hmac: Function }} native node:crypto's bindings (the loader
//   hands this file the same object as node/crypto.js).
(function (require, module, exports, native) {
  'use strict';

  var Buffer = require('buffer').Buffer;
  var P = require('internal/primordials');
  var nodeError = require('internal/errors').nodeError;
  var util = require('internal/crypto/util');
  var toU8 = util.toU8;
  var resolveDigest = util.resolveDigest;
  var unsupportedDigestError = util.unsupportedDigestError;
  var invalidDigestError = util.invalidDigestError;

  function concat(chunks) {
    if (chunks.length === 1) return chunks[0];
    var total = 0,
      i;
    for (i = 0; i < chunks.length; i++) total += chunks[i].length;
    var out = new Uint8Array(total),
      off = 0;
    for (i = 0; i < chunks.length; i++) {
      out.set(chunks[i], off);
      off += chunks[i].length;
    }
    return out;
  }

  function finalizedError() {
    return nodeError(P.Error, 'ERR_CRYPTO_HASH_FINALIZED', 'Digest already called');
  }

  // Hash/Hmac accumulate chunks and call the one-shot native primitive at
  // digest time (no streaming state crosses the boundary). Methods live on the
  // prototype and the constructors are exported so the surface matches Node,
  // where createHash()/createHmac() return Hash/Hmac instances.

  function Hash(algorithm) {
    if (!(this instanceof Hash)) return new Hash(algorithm);
    var algo = resolveDigest(algorithm);
    if (!algo) throw unsupportedDigestError();
    this._algo = algo;
    this._chunks = [];
    this._finalized = false;
  }
  Hash.prototype.update = function (data, encoding) {
    if (this._finalized) throw finalizedError();
    this._chunks.push(toU8(data, encoding));
    return this;
  };
  Hash.prototype.digest = function (encoding) {
    if (this._finalized) throw finalizedError();
    this._finalized = true;
    var out = Buffer.from(native.hash(this._algo, concat(this._chunks)));
    return encoding ? out.toString(encoding) : out;
  };
  Hash.prototype.copy = function () {
    if (this._finalized) throw finalizedError();
    var clone = new Hash(this._algo);
    clone._chunks = this._chunks.slice();
    return clone;
  };

  function Hmac(algorithm, key) {
    if (!(this instanceof Hmac)) return new Hmac(algorithm, key);
    var algo = resolveDigest(algorithm);
    if (!algo) throw invalidDigestError(algorithm);
    this._algo = algo;
    this._key = toU8(key, undefined, 'key');
    this._chunks = [];
    this._finalized = false;
  }
  Hmac.prototype.update = function (data, encoding) {
    if (this._finalized) throw finalizedError();
    this._chunks.push(toU8(data, encoding));
    return this;
  };
  Hmac.prototype.digest = function (encoding) {
    if (this._finalized) {
      var empty = Buffer.alloc(0);
      return encoding ? empty.toString(encoding) : empty;
    }
    this._finalized = true;
    var out = Buffer.from(native.hmac(this._algo, this._key, concat(this._chunks)));
    return encoding ? out.toString(encoding) : out;
  };

  // crypto.hash(algorithm, data[, outputEncoding]) — one-shot digest (Node 21+).
  // outputEncoding defaults to "hex"; "buffer" yields a Buffer.
  function hash(algorithm, data, outputEncoding) {
    var algo = resolveDigest(algorithm);
    if (!algo) throw unsupportedDigestError(algorithm);
    var out = Buffer.from(native.hash(algo, toU8(data)));
    if (outputEncoding === undefined || outputEncoding === 'hex') return out.toString('hex');
    if (outputEncoding === 'buffer') return out;
    return out.toString(outputEncoding);
  }

  module.exports = { Hash: Hash, Hmac: Hmac, hash: hash };
});
