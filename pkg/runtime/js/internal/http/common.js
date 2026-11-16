// HTTP/1.1 framing helpers shared by the request and response sides — the token table,
// the request-head parse layout, and the chunked request-body decoder. Where node keeps
// its parser glue and _checkIsHttpToken: lib/_http_common.js. Lava's equivalent lives
// under internal/ (not a public `_http_common`) because node's module of that name
// exports a parser surface Lava does not have.
(function (require, module) {
  'use strict';

  // This module is LAZY (first loaded by node:http on the user's first require), so every
  // module-eval capture below comes from the loader, never a live global (#426, #333).
  var primordials = require('internal/primordials');
  var PristineBuffer = require.pristineBuffer;
  var BufferAlloc = PristineBuffer.alloc;
  var BufferConcat = PristineBuffer.concat;
  // The chunked decoder frames NETWORK-CONTROLLED bytes; every read below was live off
  // `Buffer.prototype`. Measured before this: replacing `toString` so a size line "5" reads
  // as "1" turned a valid chunked POST into 400 here, while node (llhttp, in C) delivered
  // the body unchanged.
  var BufferPrototypeToString = PristineBuffer.bufferToString;
  var BufferPrototypeIndexOf = PristineBuffer.bufferIndexOf;
  var BufferPrototypeSlice = PristineBuffer.bufferSlice;
  // Every regex below decides FRAMING over attacker-controlled bytes, so none of
  // them may go through `re.test(...)`: `RegExp.prototype.exec` is a writable data
  // property, and the spec's RegExpExec re-reads it off the receiver, so a plain
  // assignment steers `test` too — including a captured one. Measured over a real
  // socket before this changed: `Content-Length: abc` answered 200 OK and
  // `Transfer-Encoding: gzip` was accepted as chunked. There is deliberately no
  // `RegExpPrototypeTest` in primordials; `RegExpMatches` is the only spelling, and
  // it lives there rather than here because http.js, url.js and fetch.js each
  // grew a private copy during the migration and fetch.js's was inverted.
  // The character-class validators route through ONE shared predicate. They were
  // written privately into http.js and url.js in the same commit that centralised
  // RegExpMatches to stop exactly that, and had already diverged when they landed.
  var reTest = primordials.RegExpMatches;
  var allChars = primordials.allChars;
  var isAsciiHexDigit = primordials.isAsciiHexDigit;
  // The CAPTURED read. `String.prototype.charCodeAt` is a writable data property
  // like any other, so a hand-rolled charCode scan is only as sound as the
  // primitive it scans with — routing http's validators off RegExp said
  // nothing about that. Measured: a gadget reporting 0x41 for CR and LF turned
  // `res.setHeader('Location', decodeURIComponent(req.url))` into a split response
  // driven by a REMOTE request line, while the exec and test poison phases passed
  // throughout because they never touch this carrier.
  var StringPrototypeCharCodeAt = primordials.StringPrototypeCharCodeAt;
  // Bootstrap-captured free globals from primordials — NOT `parseInt` at this
  // factory's own eval (server.js takes its Content-Length parseIntG the same way). This module is lazy; a free `var parseIntG = parseInt`
  // here binds whatever `globalThis.parseInt` is when the first `require('http')`
  // runs, which is after a dependency can already have replaced it. Hardening the
  // VALIDATOR and leaving the CONVERSION live closes nothing: with parseInt
  // replaced, the digit check still answers correctly and `contentLengthRemaining`
  // becomes whatever the gadget returns, so a crafted request's pipelined bytes are
  // framed as a second request. Measured as a desync against the real server.
  // Pinned by the parseint http-smoke phase and the parseIntG mutation entry.
  var parseIntG = primordials.parseInt;
  var NumberIsSafeInteger = primordials.NumberIsSafeInteger;

  // Hoisted so the literals are not re-created per request, and so every framing
  // pattern is visible in one place rather than inline at four call sites.
  var CHUNK_EXT_RE = /^;[^\s;]/;
  var TE_CHUNKED_RE = /^\s*chunked\s*$/i;
  var CONNECTION_CLOSE_RE = /\bclose\b/i;
  var CONNECTION_CLOSE_CS_RE = /\bclose\b/;
  var CONNECTION_KEEPALIVE_RE = /\bkeep-alive\b/;
  var TE_HAS_CHUNKED_RE = /\bchunked\b/i;

  /**
   * RFC 7230 tchar bitmap for field-names (setHeader + chunked trailers).
   * @type {Uint8Array}
   */
  var HTTP_TCHAR = new primordials.Uint8Array(128);
  (function initHttpTchar() {
    var chars = "!#$%&'*+-.0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ^_`abcdefghijklmnopqrstuvwxyz|~";
    for (var i = 0; i < chars.length; i++) HTTP_TCHAR[StringPrototypeCharCodeAt(chars, i)] = 1;
  })();

  /**
   * @param {string} value
   * @returns {boolean}
   */
  function isHttpToken(value) {
    if (typeof value !== 'string' || value.length === 0) return false;
    for (var i = 0; i < value.length; i++) {
      var code = StringPrototypeCharCodeAt(value, i);
      if (code >= 128 || !HTTP_TCHAR[code]) return false;
    }
    return true;
  }

  /** @const {number} Max chunk-size / trailer line length. */
  var MAX_CHUNK_LINE_BYTES = 64 * 1024;

  /**
   * Incremental Transfer-Encoding: chunked request-body decoder.
   *
   * @param {IncomingMessage} request
   * @param {function(): void} onError
   * @param {function(Buffer): void} onComplete leftover bytes after the body
   * @returns {function(Buffer|undefined): void} feed
   */
  function createChunkedDecoder(request, onError, onComplete) {
    var buffer = BufferAlloc(0);
    var state = 'size';
    var bytesRemaining = 0;
    var finished = false;

    function fail() {
      finished = true;
      onError();
    }

    return function feed(incoming) {
      if (finished) return;
      if (incoming && incoming.length) {
        buffer = buffer.length ? BufferConcat([buffer, incoming]) : incoming;
      }
      for (;;) {
        if (state === 'size') {
          var lineEnd = BufferPrototypeIndexOf(buffer, '\r\n');
          if (lineEnd < 0) {
            if (buffer.length > MAX_CHUNK_LINE_BYTES) fail();
            return;
          }
          if (lineEnd > MAX_CHUNK_LINE_BYTES) return fail();
          var sizeLine = BufferPrototypeToString(buffer, 'latin1', 0, lineEnd);
          var extensionSep = sizeLine.indexOf(';');
          var sizeToken = extensionSep >= 0 ? sizeLine.slice(0, extensionSep) : sizeLine;
          if (!allChars(sizeToken, isAsciiHexDigit)) return fail();
          if (extensionSep >= 0 && !reTest(CHUNK_EXT_RE, sizeLine.slice(extensionSep)))
            return fail();
          var chunkSize = parseIntG(sizeToken, 16);
          if (!NumberIsSafeInteger(chunkSize) || chunkSize < 0) return fail();
          buffer = BufferPrototypeSlice(buffer, lineEnd + 2);
          if (chunkSize === 0) state = 'trailer';
          else {
            bytesRemaining = chunkSize;
            state = 'data';
          }
        } else if (state === 'data') {
          if (buffer.length === 0) return;
          var take = buffer.length < bytesRemaining ? buffer.length : bytesRemaining;
          request.emit('data', BufferPrototypeSlice(buffer, 0, take));
          buffer = BufferPrototypeSlice(buffer, take);
          bytesRemaining -= take;
          if (bytesRemaining === 0) state = 'dataCRLF';
        } else if (state === 'dataCRLF') {
          if (buffer.length < 2) return;
          if (buffer[0] !== 13 || buffer[1] !== 10) return fail();
          buffer = BufferPrototypeSlice(buffer, 2);
          state = 'size';
        } else {
          if (buffer.length < 2) return;
          if (buffer[0] === 13 && buffer[1] === 10) {
            buffer = BufferPrototypeSlice(buffer, 2);
            finished = true;
            return onComplete(buffer);
          }
          var trailerEnd = BufferPrototypeIndexOf(buffer, '\r\n');
          if (trailerEnd < 0) {
            if (buffer.length > MAX_CHUNK_LINE_BYTES) fail();
            return;
          }
          if (trailerEnd > MAX_CHUNK_LINE_BYTES) return fail();
          var trailerLine = BufferPrototypeToString(buffer, 'latin1', 0, trailerEnd);
          var colon = trailerLine.indexOf(':');
          if (colon <= 0 || !isHttpToken(trailerLine.slice(0, colon))) return fail();
          buffer = BufferPrototypeSlice(buffer, trailerEnd + 2);
        }
      }
    };
  }

  // Flat parseRequest layout (mirrors http.odin PARSE_* / vals[]):
  // [state, consumed, method, url, minor, name, value, ...]
  var PARSE_STATE = 0;
  var PARSE_CONSUMED = 1;
  var PARSE_METHOD = 2;
  var PARSE_URL = 3;
  var PARSE_MINOR = 4;
  var PARSE_HEADERS = 5;
  var PARSE_OK = 0;
  var PARSE_NEED_MORE = 1;

  module.exports = {
    TE_CHUNKED_RE: TE_CHUNKED_RE,
    CONNECTION_CLOSE_RE: CONNECTION_CLOSE_RE,
    CONNECTION_CLOSE_CS_RE: CONNECTION_CLOSE_CS_RE,
    CONNECTION_KEEPALIVE_RE: CONNECTION_KEEPALIVE_RE,
    TE_HAS_CHUNKED_RE: TE_HAS_CHUNKED_RE,
    isHttpToken: isHttpToken,
    createChunkedDecoder: createChunkedDecoder,
    PARSE_STATE: PARSE_STATE,
    PARSE_CONSUMED: PARSE_CONSUMED,
    PARSE_METHOD: PARSE_METHOD,
    PARSE_URL: PARSE_URL,
    PARSE_MINOR: PARSE_MINOR,
    PARSE_HEADERS: PARSE_HEADERS,
    PARSE_OK: PARSE_OK,
    PARSE_NEED_MORE: PARSE_NEED_MORE,
  };
});
