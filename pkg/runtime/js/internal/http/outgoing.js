// Response-side header validation and wire encoding for node:http — the header-name /
// header-char checks and the latin1 head and chunked-body framing. Where node keeps
// validateHeaderName/Value and the outgoing framing: lib/_http_outgoing.js (under
// internal/ here; see common.js for why there is no public `_http_outgoing`).
//
// @param {{ latin1WriteInto?: Function }} native node:http's bindings (the loader hands
//   this file the same object as node/http.js).
(function (require, module, exports, native) {
  'use strict';

  /** Pristine intrinsics — response head must not use overridable Buffer methods. */
  // LAZY module: every module-eval capture comes from the loader (#426, #333).
  var primordials = require('internal/primordials');
  var nodeError = require('internal/errors').nodeError;
  var PristineBuffer = require.pristineBuffer;
  var BufferFrom = PristineBuffer.from;
  var BufferConcat = PristineBuffer.concat;
  // The CAPTURED read — see common.js: a live `value.charCodeAt` lets a CR/LF-lying
  // gadget split the response.
  var StringPrototypeCharCodeAt = primordials.StringPrototypeCharCodeAt;
  var isHttpToken = require('internal/http/common').isHttpToken;
  var nativeLatin1WriteInto =
    typeof native.latin1WriteInto === 'function' ? native.latin1WriteInto : null;

  /**
   * @param {*} name
   * @throws {TypeError} ERR_INVALID_HTTP_TOKEN
   */
  function assertHeaderName(name) {
    if (!isHttpToken(name)) {
      throw nodeError(
        primordials.TypeError,
        'ERR_INVALID_HTTP_TOKEN',
        'Header name must be a valid HTTP token [' + JSON.stringify(name) + ']',
      );
    }
  }

  /**
   * Reject CTL (except HT) and code points above 0xFF (latin1 serialization would mask).
   *
   * @param {string} value
   * @param {string} what label for the error message
   * @throws {TypeError} ERR_INVALID_CHAR
   */
  function assertValidHeaderChar(value, what) {
    for (var i = 0; i < value.length; i++) {
      var code = StringPrototypeCharCodeAt(value, i);
      if (code === 9 || (code >= 0x20 && code <= 0x7e) || (code >= 0x80 && code <= 0xff)) {
        continue;
      }
      throw nodeError(primordials.TypeError, 'ERR_INVALID_CHAR', 'Invalid character in ' + what);
    }
  }

  var CRLF = BufferFrom('\r\n', 'latin1');
  var LAST_CHUNK = BufferFrom('0\r\n\r\n', 'latin1');
  /** Max combined head+body size for single-write coalesce. */
  var HEAD_BODY_COALESCE_MAX = 64 * 1024;

  /**
   * Write `text` as latin1 into `destination` at `offset`.
   *
   * @param {Uint8Array} destination
   * @param {string} text
   * @param {number} offset
   */
  function writeLatin1Into(destination, text, offset) {
    if (nativeLatin1WriteInto !== null) {
      nativeLatin1WriteInto(destination, text, offset, text.length);
      return;
    }
    for (var i = 0; i < text.length; i++) {
      destination[offset + i] = primordials.StringPrototypeCharCodeAt(text, i) & 0xff;
    }
  }

  /**
   * @param {string} headText latin1 head string
   * @returns {Uint8Array}
   */
  function encodeHeadBytes(headText) {
    var bytes = new primordials.Uint8Array(headText.length);
    writeLatin1Into(bytes, headText, 0);
    return bytes;
  }

  /**
   * @param {Buffer|Uint8Array} bodyChunk
   * @returns {Buffer}
   */
  function frameChunkedBody(bodyChunk) {
    return BufferConcat([
      BufferFrom(bodyChunk.length.toString(16) + '\r\n', 'latin1'),
      bodyChunk,
      CRLF,
    ]);
  }

  module.exports = {
    assertHeaderName: assertHeaderName,
    assertValidHeaderChar: assertValidHeaderChar,
    LAST_CHUNK: LAST_CHUNK,
    HEAD_BODY_COALESCE_MAX: HEAD_BODY_COALESCE_MAX,
    writeLatin1Into: writeLatin1Into,
    encodeHeadBytes: encodeHeadBytes,
    frameChunkedBody: frameChunkedBody,
  };
});
