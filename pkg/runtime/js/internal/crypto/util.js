// Shared node:crypto helpers — argument validators and byte-source coercion — where node
// keeps them: lib/internal/crypto/util.js and lib/internal/validators.js. Every other file
// under internal/crypto/ requires this one; it requires none of them back.
(function (require, module) {
  'use strict';

  // node:buffer on the Node surface only: `.Web` instantiates no node/ module, and only
  // node:crypto's string inputs (toU8) reach it. Captured at module-eval — this file is
  // eager through internal/crypto/random — so the capture is pristine.
  var Buffer = require('internal/web_errors').web ? null : require('buffer').Buffer;

  // Argument-validation helpers mirroring Node's internal validators, so bad
  // input fails with Node's error class + code instead of being silently
  // coerced (a zero-filled buffer, a clamped range). The errors themselves come
  // from internal/errors (CLAUDE.md §5).
  var errors = require('internal/errors');
  var invalidArgType = errors.ERR_INVALID_ARG_TYPE;
  var outOfRange = errors.ERR_OUT_OF_RANGE;
  // A byte count (randomBytes size): must be a number in [0, 2^31-1] and not
  // NaN, but — matching Node — a fractional value is truncated, not rejected.
  function validateByteCount(value, name) {
    if (typeof value !== 'number') throw invalidArgType(name, 'number', value);
    if (Number.isNaN(value) || value < 0 || value > 0x7fffffff)
      throw outOfRange(name, '>= 0 && <= ' + 0x7fffffff, value);
    return Math.trunc(value);
  }

  // toU8 accepts the byte sources Node accepts (string + Buffer/TypedArray/
  // DataView/ArrayBuffer) and throws ERR_INVALID_ARG_TYPE for anything else —
  // numbers used to be silently turned into a zero-filled buffer.
  function toU8(data, encoding, name) {
    if (typeof data === 'string') return new Uint8Array(Buffer.from(data, encoding || 'utf8'));
    if (ArrayBuffer.isView(data))
      return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
    if (typeof SharedArrayBuffer !== 'undefined' && data instanceof SharedArrayBuffer)
      return new Uint8Array(new Uint8Array(data));
    throw invalidArgType(name || 'data', ['string', 'Buffer', 'TypedArray', 'DataView'], data);
  }

  module.exports = {
    invalidArgType: invalidArgType,
    outOfRange: outOfRange,
    validateByteCount: validateByteCount,
    toU8: toU8,
  };
});
