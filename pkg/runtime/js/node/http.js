/**
 * node:http — minimal HTTP/1.1 server (M2).
 *
 * Built on node:net with request heads parsed by the native picohttpparser bridge
 * (`native.parseRequest`). Supports keep-alive, chunked request/response bodies,
 * and slowloris/idle timeouts. No client API yet.
 *
 * @param {Function} require
 * @param {{ exports: object }} module
 * @param {object} exports
 * @param {{ parseRequest: Function, latin1WriteInto?: Function }} native
 */
(function (require, module, exports, native) {
  'use strict';

  /** Pristine intrinsics — response head must not use overridable Buffer methods. */
  // Also every module-eval constructor/static below: this module is LAZY, so a read of the
  // live global here runs after user code could have replaced it (#426).
  var primordials = require('internal/primordials');
  var ObjectCreate = primordials.ObjectCreate;
  var ObjectDefineProperty = primordials.ObjectDefineProperty;

  if (!native || typeof native.parseRequest !== 'function') {
    throw new primordials.Error('node:http is unavailable on this platform');
  }

  var EventEmitter = require('events');
  // Pristine, from the loader: this module is LAZY, so its own capture would run after
  // user code and be steerable (#333).
  var PristineBuffer = require.pristineBuffer;
  var BufferFrom = PristineBuffer.from;
  var BufferAlloc = PristineBuffer.alloc;
  var BufferConcat = PristineBuffer.concat;
  // The chunked decoder frames NETWORK-CONTROLLED bytes; every read below was live off
  // `Buffer.prototype`. Measured before this: replacing `toString` so a size line "5" reads
  // as "1" turned a valid chunked POST into 400 here, while node (llhttp, in C) delivered
  // the body unchanged.
  var BufferPrototypeToString = PristineBuffer.bufferToString;
  var BufferPrototypeIndexOf = PristineBuffer.bufferIndexOf;
  var BufferPrototypeSlice = PristineBuffer.bufferSlice;
  var net = require('net');
  // Every regex below decides FRAMING over attacker-controlled bytes, so none of
  // them may go through `re.test(...)`: `RegExp.prototype.exec` is a writable data
  // property, and the spec's RegExpExec re-reads it off the receiver, so a plain
  // assignment steers `test` too — including a captured one. Measured over a real
  // socket before this changed: `Content-Length: abc` answered 200 OK and
  // `Transfer-Encoding: gzip` was accepted as chunked. There is deliberately no
  // `RegExpPrototypeTest` in primordials; `RegExpMatches` is the only spelling, and
  // it lives there rather than here because this file, url.js and fetch.js each
  // grew a private copy during the migration and fetch.js's was inverted.
  // The character-class validators route through ONE shared predicate. They were
  // written privately into this file and url.js in the same commit that centralised
  // RegExpMatches to stop exactly that, and had already diverged when they landed.
  var reTest = primordials.RegExpMatches;
  var allChars = primordials.allChars;
  var isAsciiDigit = primordials.isAsciiDigit;
  var isAsciiHexDigit = primordials.isAsciiHexDigit;
  // The CAPTURED read. `String.prototype.charCodeAt` is a writable data property
  // like any other, so a hand-rolled charCode scan is only as sound as the
  // primitive it scans with — routing this file's validators off RegExp said
  // nothing about that. Measured: a gadget reporting 0x41 for CR and LF turned
  // `res.setHeader('Location', decodeURIComponent(req.url))` into a split response
  // driven by a REMOTE request line, while the exec and test poison phases passed
  // throughout because they never touch this carrier.
  var StringPrototypeCharCodeAt = primordials.StringPrototypeCharCodeAt;
  // Bootstrap-captured free globals from primordials — NOT `parseInt` at this
  // factory's own eval. This module is lazy; a free `var parseIntG = parseInt`
  // here binds whatever `globalThis.parseInt` is when the first `require('http')`
  // runs, which is after a dependency can already have replaced it. Hardening the
  // VALIDATOR and leaving the CONVERSION live closes nothing: with parseInt
  // replaced, the digit check still answers correctly and `contentLengthRemaining`
  // becomes whatever the gadget returns, so a crafted request's pipelined bytes are
  // framed as a second request. Measured as a desync against the real server.
  // Pinned by the parseint http-smoke phase and the parseIntG mutation entry.
  var parseIntG = primordials.parseInt;
  var NumberG = primordials.Number;
  var NumberIsInteger = primordials.NumberIsInteger;
  var NumberIsSafeInteger = primordials.NumberIsSafeInteger;

  // Hoisted so the literals are not re-created per request, and so every framing
  // pattern is visible in one place rather than inline at four call sites.
  var CHUNK_EXT_RE = /^;[^\s;]/;
  var TE_CHUNKED_RE = /^\s*chunked\s*$/i;
  var CONNECTION_CLOSE_RE = /\bclose\b/i;
  var CONNECTION_CLOSE_CS_RE = /\bclose\b/;
  var CONNECTION_KEEPALIVE_RE = /\bkeep-alive\b/;
  var TE_HAS_CHUNKED_RE = /\bchunked\b/i;
  var nativeLatin1WriteInto =
    typeof native.latin1WriteInto === 'function' ? native.latin1WriteInto : null;

  /** @const {number} Max request-head size before 431. */
  var MAX_HEAD_BYTES = 64 * 1024;

  var STATUS_CODES = {
    200: 'OK',
    201: 'Created',
    204: 'No Content',
    206: 'Partial Content',
    301: 'Moved Permanently',
    302: 'Found',
    304: 'Not Modified',
    307: 'Temporary Redirect',
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    405: 'Method Not Allowed',
    408: 'Request Timeout',
    411: 'Length Required',
    413: 'Payload Too Large',
    414: 'URI Too Long',
    431: 'Request Header Fields Too Large',
    500: 'Internal Server Error',
    501: 'Not Implemented',
    503: 'Service Unavailable',
  };

  /**
   * Fold `[name, value, ...]` pairs into a null-prototype headers object.
   * Names are lowercased; duplicates join with `', '` (Node for most headers).
   *
   * @param {Array} parseResult flat parseRequest array
   * @param {number} headerStart index of first name/value pair
   * @returns {Object<string, string>}
   */
  function buildHeaders(parseResult, headerStart) {
    var headers = Object.create(null);
    for (var i = headerStart; i + 1 < parseResult.length; i += 2) {
      var lowerName = parseResult[i].toLowerCase();
      var value = parseResult[i + 1];
      if (headers[lowerName] === undefined) headers[lowerName] = value;
      else headers[lowerName] += ', ' + value;
    }
    return headers;
  }

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

  /**
   * @param {*} name
   * @throws {TypeError} ERR_INVALID_HTTP_TOKEN
   */
  function assertHeaderName(name) {
    if (!isHttpToken(name)) {
      var err = new TypeError(
        'Header name must be a valid HTTP token [' + JSON.stringify(name) + ']',
      );
      err.code = 'ERR_INVALID_HTTP_TOKEN';
      throw err;
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
      var err = new TypeError('Invalid character in ' + what);
      err.code = 'ERR_INVALID_CHAR';
      throw err;
    }
  }

  /**
   * @param {*} statusCode may be string after `res.statusCode = '204'`
   * @returns {boolean}
   */
  function statusHasNoBody(statusCode) {
    var code = NumberG(statusCode);
    return code === 204 || code === 304 || (code >= 100 && code < 200);
  }

  /**
   * @param {*} statusCode
   * @returns {number}
   * @throws {RangeError} ERR_HTTP_INVALID_STATUS_CODE
   */
  function validateStatusCode(statusCode) {
    var code = NumberG(statusCode);
    if (!NumberIsInteger(code) || code < 100 || code > 999) {
      var err = new RangeError('Invalid status code: ' + JSON.stringify(statusCode));
      err.code = 'ERR_HTTP_INVALID_STATUS_CODE';
      throw err;
    }
    return code;
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

  /**
   * @param {net.Socket} socket
   * @param {Array} parseResult
   * @constructor
   */
  function IncomingMessage(socket, parseResult) {
    EventEmitter.call(this);
    this.socket = socket;
    this.method = parseResult[PARSE_METHOD];
    this.url = parseResult[PARSE_URL];
    this.httpVersionMajor = 1;
    this.httpVersionMinor = parseResult[PARSE_MINOR];
    this.httpVersion = '1.' + parseResult[PARSE_MINOR];
    // Eager headers (framing needs Connection/CL/TE). rawHeaders sliced on first access —
    // hello-world never reads it (saves a per-request array alloc).
    this._parseResult = parseResult;
    this.headers = buildHeaders(parseResult, PARSE_HEADERS);
    this.complete = false;
    this._ended = false;
  }
  IncomingMessage.prototype = ObjectCreate(EventEmitter.prototype);
  IncomingMessage.prototype.constructor = IncomingMessage;

  // Lazy rawHeaders: first get materializes an own data property (Node shape:
  // hasOwnProperty / Object.keys include rawHeaders after access).
  ObjectDefineProperty(IncomingMessage.prototype, 'rawHeaders', {
    configurable: true,
    enumerable: true,
    get: function () {
      var pairs = this._parseResult.slice(PARSE_HEADERS);
      Object.defineProperty(this, 'rawHeaders', {
        value: pairs,
        writable: true,
        enumerable: true,
        configurable: true,
      });
      return pairs;
    },
    set: function (value) {
      Object.defineProperty(this, 'rawHeaders', {
        value: value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    },
  });

  var STATUS_LINE_200 = 'HTTP/1.1 200 OK\r\n';
  var CONNECTION_KEEP_ALIVE = 'Connection: keep-alive\r\n';
  var CONNECTION_CLOSE = 'Connection: close\r\n';

  /**
   * @param {net.Socket} socket
   * @param {string} method
   * @param {number|undefined} httpMinor
   * @constructor
   */
  function ServerResponse(socket, method, httpMinor) {
    EventEmitter.call(this);
    this.socket = socket;
    this.statusCode = 200;
    this.statusMessage = undefined;
    this.headersSent = false;
    this._chunked = false;
    this.finished = false;
    /** @type {Object<string, string>} lowercased name → value */
    this._headerValues = Object.create(null);
    /** @type {Object<string, string>} lowercased name → wire-case name */
    this._headerNames = Object.create(null);
    this._isHead = method === 'HEAD';
    this._allowChunked = httpMinor === undefined || httpMinor >= 1;
    this._keepAlive = false;
    /** @type {((function(): void) | null)} connection hook after finish */
    this._onComplete = null;
    // Forward the socket's 'drain' to this response for the lifetime of the
    // response, so res.write() === false + res.once('drain', ...) is a real
    // backpressure contract (the native layer owes a 'drain' whenever a write
    // buffered past the HWM). Removed in end() — on a keep-alive connection the
    // next response gets its own forwarder on the same socket.
    var self = this;
    this._drainForwarder = null;
    if (socket && typeof socket.on === 'function') {
      this._drainForwarder = function () {
        self.emit('drain');
      };
      socket.on('drain', this._drainForwarder);
    }
  }
  ServerResponse.prototype = ObjectCreate(EventEmitter.prototype);
  ServerResponse.prototype.constructor = ServerResponse;

  /**
   * @param {string} name
   * @param {*} value
   * @returns {ServerResponse}
   */
  ServerResponse.prototype.setHeader = function (name, value) {
    assertHeaderName(name);
    var text = String(value);
    assertValidHeaderChar(text, 'header content [' + name + ']');
    var lowerName = name.toLowerCase();
    this._headerValues[lowerName] = text;
    this._headerNames[lowerName] = name;
    return this;
  };

  /**
   * @param {string} name
   * @returns {string|undefined}
   */
  ServerResponse.prototype.getHeader = function (name) {
    return this._headerValues[String(name).toLowerCase()];
  };

  /**
   * @param {string} name
   */
  ServerResponse.prototype.removeHeader = function (name) {
    var lowerName = String(name).toLowerCase();
    delete this._headerValues[lowerName];
    delete this._headerNames[lowerName];
  };

  /**
   * @param {string} name
   * @returns {boolean}
   */
  ServerResponse.prototype.hasHeader = function (name) {
    return this._headerValues[String(name).toLowerCase()] !== undefined;
  };

  /**
   * @param {number} statusCode
   * @param {string|object} [statusMessage]
   * @param {object} [headers]
   * @returns {ServerResponse}
   */
  ServerResponse.prototype.writeHead = function (statusCode, statusMessage, headers) {
    if (typeof statusMessage === 'object' && statusMessage !== null) {
      headers = statusMessage;
      statusMessage = undefined;
    }
    this.statusCode = validateStatusCode(statusCode);
    if (statusMessage) this.statusMessage = statusMessage;
    if (headers) {
      for (var name in headers) {
        if (Object.prototype.hasOwnProperty.call(headers, name)) {
          this.setHeader(name, headers[name]);
        }
      }
    }
    return this;
  };

  /**
   * Serialize status line + headers; finalizes `_keepAlive`. Does not write or set headersSent.
   *
   * @returns {string} latin1 head text
   */
  ServerResponse.prototype._buildHead = function () {
    var statusCode = validateStatusCode(this.statusCode);
    var reason = this.statusMessage || STATUS_CODES[statusCode] || '';
    assertValidHeaderChar(String(reason), 'statusMessage');
    var head =
      statusCode === 200 && !this.statusMessage
        ? STATUS_LINE_200
        : 'HTTP/1.1 ' + statusCode + ' ' + reason + '\r\n';

    var selfDelimited =
      this._chunked ||
      this.hasHeader('content-length') ||
      this._isHead ||
      statusHasNoBody(this.statusCode);
    if (!selfDelimited) this._keepAlive = false;

    if (this.hasHeader('connection')) {
      if (reTest(CONNECTION_CLOSE_RE, this.getHeader('connection'))) this._keepAlive = false;
    } else {
      head += this._keepAlive ? CONNECTION_KEEP_ALIVE : CONNECTION_CLOSE;
    }

    for (var lowerName in this._headerValues) {
      head += this._headerNames[lowerName] + ': ' + this._headerValues[lowerName] + '\r\n';
    }
    head += '\r\n';
    return head;
  };

  ServerResponse.prototype._flushHead = function () {
    if (this.headersSent) return;
    var headBytes = encodeHeadBytes(this._buildHead());
    this.headersSent = true;
    this.socket.write(headBytes);
  };

  /**
   * @param {string|Buffer|Uint8Array} [chunk]
   * @param {string|function} [encoding]
   * @param {function} [callback]
   * @returns {boolean}
   */
  ServerResponse.prototype.write = function (chunk, encoding, callback) {
    if (typeof encoding === 'function') {
      callback = encoding;
      encoding = undefined;
    }
    var omitBody = this._isHead || statusHasNoBody(this.statusCode);
    if (!this.headersSent) {
      if (
        !omitBody &&
        this._allowChunked &&
        !this.hasHeader('content-length') &&
        !this.hasHeader('transfer-encoding')
      ) {
        this._chunked = true;
        this.setHeader('Transfer-Encoding', 'chunked');
      } else if (this._allowChunked && this.hasHeader('transfer-encoding')) {
        this._chunked = reTest(TE_HAS_CHUNKED_RE, this.getHeader('transfer-encoding'));
      }
      this._flushHead();
    }
    var ok = true;
    if (!omitBody && chunk && chunk.length) {
      var bytes = typeof chunk === 'string' ? BufferFrom(chunk, encoding || 'utf8') : chunk;
      // The socket's return value IS the backpressure signal: false means the
      // native write buffer crossed its high-water mark and a 'drain' is owed
      // (forwarded to this response by _drainForwarder). Swallowing it here
      // would let a fast handler buffer without bound against a slow client.
      ok = this.socket.write(this._chunked ? frameChunkedBody(bytes) : bytes);
    }
    if (typeof callback === 'function') process.nextTick(callback);
    return ok;
  };

  /**
   * @param {string|Buffer|Uint8Array|function} [chunk]
   * @param {string|function} [encoding]
   * @param {function} [callback]
   * @returns {ServerResponse}
   */
  ServerResponse.prototype.end = function (chunk, encoding, callback) {
    if (typeof chunk === 'function') {
      callback = chunk;
      chunk = undefined;
    } else if (typeof encoding === 'function') {
      callback = encoding;
      encoding = undefined;
    }
    if (this.finished) return this;

    var body = null;
    if (chunk !== undefined && chunk !== null) {
      body = typeof chunk === 'string' ? BufferFrom(chunk, encoding || 'utf8') : chunk;
    }
    var omitBody = this._isHead || statusHasNoBody(this.statusCode);
    if (!this.headersSent) {
      if (!this.hasHeader('content-length') && !this.hasHeader('transfer-encoding') && !omitBody) {
        this.setHeader('Content-Length', String(body ? body.length : 0));
      }
      if (this._allowChunked && this.hasHeader('transfer-encoding')) {
        this._chunked = reTest(TE_HAS_CHUNKED_RE, this.getHeader('transfer-encoding'));
      }

      var headText = this._buildHead();
      var totalBytes = headText.length + (body ? body.length : 0);
      if (
        !omitBody &&
        body &&
        body.length &&
        body instanceof primordials.Uint8Array &&
        !this._chunked &&
        totalBytes <= HEAD_BODY_COALESCE_MAX
      ) {
        var combined = new primordials.Uint8Array(totalBytes);
        writeLatin1Into(combined, headText, 0);
        primordials.Uint8ArrayPrototypeSet(combined, body, headText.length);
        this.headersSent = true;
        this.socket.write(combined);
        body = null;
      } else {
        this.headersSent = true;
        this.socket.write(encodeHeadBytes(headText));
      }
    }
    if (!omitBody && body && body.length) {
      this.socket.write(this._chunked ? frameChunkedBody(body) : body);
    }
    if (this._chunked && !omitBody) this.socket.write(LAST_CHUNK);
    this.finished = true;
    if (this._drainForwarder && typeof this.socket.removeListener === 'function') {
      this.socket.removeListener('drain', this._drainForwarder);
      this._drainForwarder = null;
    }
    if (typeof callback === 'function') process.nextTick(callback);
    this.emit('finish');
    if (this._onComplete) this._onComplete();
    else this.socket.end();
    return this;
  };

  /**
   * @param {number} httpMinor
   * @param {string|undefined} connectionHeader
   * @returns {boolean}
   */
  function shouldKeepAlive(httpMinor, connectionHeader) {
    var connection = (connectionHeader || '').toLowerCase();
    if (httpMinor >= 1) return !reTest(CONNECTION_CLOSE_CS_RE, connection);
    return reTest(CONNECTION_KEEPALIVE_RE, connection);
  }

  var EMPTY_BUFFER = BufferAlloc(0);
  var DEADLINE_SWEEP_MS = 100;

  /**
   * @param {Server} server
   * @param {object} deadlines
   */
  function registerConnectionDeadlines(server, deadlines) {
    var sweep = server._connSweep || (server._connSweep = { connections: new Set(), timer: null });
    sweep.connections.add(deadlines);
    if (sweep.timer === null) {
      sweep.timer = setInterval(function () {
        tickConnectionDeadlines(sweep);
      }, DEADLINE_SWEEP_MS);
    }
  }

  /**
   * @param {Server} server
   * @param {object} deadlines
   */
  function unregisterConnectionDeadlines(server, deadlines) {
    var sweep = server._connSweep;
    if (!sweep) return;
    sweep.connections.delete(deadlines);
    if (sweep.connections.size === 0 && sweep.timer !== null) {
      clearInterval(sweep.timer);
      sweep.timer = null;
    }
  }

  /**
   * @param {{ connections: Set, timer: * }} sweep
   */
  function tickConnectionDeadlines(sweep) {
    var now = Date.now();
    sweep.connections.forEach(function (deadlines) {
      if (deadlines.idleUntil !== 0 && now >= deadlines.idleUntil) {
        deadlines.idleUntil = 0;
        deadlines.onIdleTimeout();
      } else if (deadlines.headersUntil !== 0 && now >= deadlines.headersUntil) {
        deadlines.headersUntil = 0;
        deadlines.onRequestTimeout();
      } else if (deadlines.requestUntil !== 0 && now >= deadlines.requestUntil) {
        deadlines.requestUntil = 0;
        deadlines.onRequestTimeout();
      }
    });
  }

  /**
   * Per-connection request/response loop.
   *
   * @param {Server} server
   * @param {net.Socket} socket
   */
  function onConnection(server, socket) {
    var pendingBytes = EMPTY_BUFFER;
    var partialHeadLength = 0;
    var parsingHead = true;
    var request = null;
    var response = null;
    var contentLengthRemaining = 0;
    var chunkedDecoder = null;
    var requestBodyComplete = false;
    var responseComplete = false;
    var peerHalfClosed = false;
    var connectionClosed = false;

    var keepAliveTimeoutMs = server.keepAliveTimeout || 0;
    var headersTimeoutMs = server.headersTimeout || 0;
    var requestTimeoutMs = server.requestTimeout || 0;
    var deadlines = {
      idleUntil: 0,
      headersUntil: 0,
      requestUntil: 0,
      onIdleTimeout: destroyConnection,
      onRequestTimeout: onReceiveTimeout,
    };
    var receivingRequest = false;
    registerConnectionDeadlines(server, deadlines);

    // Deferred body/'end' delivery: one reused nextTick callback + parallel arrays
    // (no per-request closure). Pipelined sync processRequestHead can enqueue more
    // while flush runs; deferScheduled stays true until the queue is empty.
    var deferRequests = [];
    var deferBodies = [];
    var deferKinds = []; // 0 = emit end, 1 = Content-Length feed, 2 = chunked feed
    var deferDecoders = [];
    var deferScheduled = false;
    var deferFlushError = undefined;
    var DEFER_END = 0;
    var DEFER_CONTENT_LENGTH = 1;
    var DEFER_CHUNKED = 2;

    function scheduleAfterRequest(targetRequest, bodyFromHead, kind, decoder) {
      deferRequests.push(targetRequest);
      deferBodies.push(bodyFromHead);
      deferKinds.push(kind);
      deferDecoders.push(decoder);
      if (!deferScheduled) {
        deferScheduled = true;
        process.nextTick(flushAfterRequest);
      }
    }

    function flushAfterRequest() {
      // try/finally: a throw from a user 'end'/'data' listener must not latch
      // deferScheduled=true forever (which would skip later nextTick arms).
      deferFlushError = undefined;
      try {
        var index = 0;
        while (index < deferRequests.length) {
          var targetRequest = deferRequests[index];
          var bodyFromHead = deferBodies[index];
          var kind = deferKinds[index];
          var decoder = deferDecoders[index];
          index++;
          if (connectionClosed) continue;
          try {
            if (kind === DEFER_END) {
              emitRequestEnd(targetRequest);
              maybeAdvance();
            } else if (kind === DEFER_CHUNKED) {
              decoder(bodyFromHead);
            } else {
              feedContentLengthBody(bodyFromHead);
            }
          } catch (err) {
            // Drain siblings first; rethrow the first error after cleanup.
            if (deferFlushError === undefined) deferFlushError = err;
          }
        }
      } finally {
        deferRequests.length = 0;
        deferBodies.length = 0;
        deferKinds.length = 0;
        deferDecoders.length = 0;
        deferScheduled = false;
        var pendingError = deferFlushError;
        deferFlushError = undefined;
        if (pendingError !== undefined) throw pendingError;
      }
    }

    function clearReceiveDeadlines() {
      deadlines.headersUntil = 0;
      deadlines.requestUntil = 0;
    }

    function clearAllDeadlines() {
      deadlines.idleUntil = 0;
      clearReceiveDeadlines();
      unregisterConnectionDeadlines(server, deadlines);
    }

    function destroyConnection() {
      if (connectionClosed) return;
      connectionClosed = true;
      clearAllDeadlines();
      socket.destroy();
    }

    function armIdleDeadline() {
      if (keepAliveTimeoutMs > 0) deadlines.idleUntil = Date.now() + keepAliveTimeoutMs;
    }

    function beginReceiveDeadlines() {
      receivingRequest = true;
      if (headersTimeoutMs > 0 || requestTimeoutMs > 0) {
        var now = Date.now();
        if (headersTimeoutMs > 0) deadlines.headersUntil = now + headersTimeoutMs;
        if (requestTimeoutMs > 0) deadlines.requestUntil = now + requestTimeoutMs;
      }
    }

    function onReceiveTimeout() {
      if (connectionClosed) return;
      if (response && response.headersSent) destroyConnection();
      else sendErrorAndClose(408);
    }

    /**
     * @param {number} statusCode
     */
    function sendErrorAndClose(statusCode) {
      if (connectionClosed) return;
      connectionClosed = true;
      clearAllDeadlines();
      var reason = STATUS_CODES[statusCode] || 'Error';
      socket.write(
        BufferFrom(
          'HTTP/1.1 ' +
            statusCode +
            ' ' +
            reason +
            '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
          'latin1',
        ),
      );
      socket.end();
    }

    function resetForNextRequest() {
      parsingHead = true;
      partialHeadLength = 0;
      request = null;
      response = null;
      contentLengthRemaining = 0;
      chunkedDecoder = null;
      requestBodyComplete = false;
      responseComplete = false;
      receivingRequest = false;
    }

    /**
     * Advance when both request body and response are done (keep-alive or close).
     */
    function maybeAdvance() {
      if (connectionClosed || !requestBodyComplete || !responseComplete) return;
      if (!response._keepAlive) {
        connectionClosed = true;
        clearAllDeadlines();
        socket.end();
        return;
      }
      resetForNextRequest();
      if (pendingBytes.length > 0) {
        beginReceiveDeadlines();
        processRequestHead();
      } else if (peerHalfClosed) {
        destroyConnection();
      } else {
        armIdleDeadline();
      }
    }

    function onResponseComplete() {
      responseComplete = true;
      maybeAdvance();
    }

    /**
     * Mark the request fully received (timers off, pipelined leftover stashed).
     * Does not emit `'end'`.
     *
     * @param {Buffer|Uint8Array|undefined} leftover
     */
    function markRequestReceived(leftover) {
      pendingBytes = leftover && leftover.length ? leftover : EMPTY_BUFFER;
      clearReceiveDeadlines();
      requestBodyComplete = true;
    }

    /**
     * Emit request `'end'` once. Accepts a captured request when outer `request`
     * was cleared by a synchronous keep-alive advance.
     *
     * @param {IncomingMessage|null} [targetRequest]
     */
    function emitRequestEnd(targetRequest) {
      var message = targetRequest || request;
      if (message && !message._ended) {
        message._ended = true;
        message.complete = true;
        message.emit('end');
      }
    }

    /**
     * Full body completion: mark received (if needed), emit end, try advance.
     *
     * @param {Buffer|Uint8Array|undefined} leftover
     */
    function onRequestBodyComplete(leftover) {
      if (!requestBodyComplete) markRequestReceived(leftover);
      emitRequestEnd(request);
      maybeAdvance();
    }

    /**
     * @param {Buffer|Uint8Array|undefined} chunk
     */
    function feedContentLengthBody(chunk) {
      if (!request || request._ended) return;
      if (contentLengthRemaining > 0 && chunk && chunk.length) {
        var take = chunk.length < contentLengthRemaining ? chunk.length : contentLengthRemaining;
        request.emit('data', chunk.slice(0, take));
        contentLengthRemaining -= take;
        chunk = chunk.slice(take);
      }
      if (contentLengthRemaining <= 0) onRequestBodyComplete(chunk);
    }

    function processRequestHead() {
      var parseResult = native.parseRequest(pendingBytes, partialHeadLength);
      var state = parseResult[PARSE_STATE];
      if (state === PARSE_NEED_MORE) {
        if (pendingBytes.length > MAX_HEAD_BYTES) sendErrorAndClose(431);
        else partialHeadLength = pendingBytes.length;
        return;
      }
      if (state !== PARSE_OK) return sendErrorAndClose(400);

      var consumed = parseResult[PARSE_CONSUMED];
      if (consumed > MAX_HEAD_BYTES) return sendErrorAndClose(431);

      parsingHead = false;
      partialHeadLength = 0;
      deadlines.headersUntil = 0;

      request = new IncomingMessage(socket, parseResult);
      response = new ServerResponse(socket, request.method, request.httpVersionMinor);
      response._keepAlive = shouldKeepAlive(
        request.httpVersionMinor,
        request.headers['connection'],
      );
      response._onComplete = onResponseComplete;

      var bodyFromHead =
        consumed < pendingBytes.length ? pendingBytes.slice(consumed) : EMPTY_BUFFER;
      pendingBytes = EMPTY_BUFFER;

      var transferEncoding = request.headers['transfer-encoding'];
      var contentLengthHeader = request.headers['content-length'];
      if (transferEncoding !== undefined) {
        if (contentLengthHeader !== undefined) return sendErrorAndClose(400);
        if (!reTest(TE_CHUNKED_RE, transferEncoding)) return sendErrorAndClose(501);
        chunkedDecoder = createChunkedDecoder(
          request,
          function () {
            if (response.headersSent) destroyConnection();
            else sendErrorAndClose(400);
          },
          onRequestBodyComplete,
        );
      } else if (contentLengthHeader !== undefined) {
        if (!allChars(contentLengthHeader, isAsciiDigit)) return sendErrorAndClose(400);
        contentLengthRemaining = parseIntG(contentLengthHeader, 10);
      }

      var hasEntityBody = chunkedDecoder !== null || contentLengthRemaining > 0;
      // Capture before emit: sync res.end() may reset outer `request` via maybeAdvance.
      var capturedRequest = request;
      var capturedBody = bodyFromHead;
      var capturedDecoder = chunkedDecoder;
      var deferKind = !hasEntityBody
        ? DEFER_END
        : chunkedDecoder
          ? DEFER_CHUNKED
          : DEFER_CONTENT_LENGTH;

      // Bodyless: mark receive-complete before 'request' so sync res.end() can reuse
      // the connection same turn. requestTimeout is receive-only (Node parity).
      if (!hasEntityBody) {
        markRequestReceived(bodyFromHead.length ? bodyFromHead : EMPTY_BUFFER);
      }

      server.emit('request', request, response);
      // After emit so a throwing handler does not leave a stray deferred delivery.
      // 'end' / entity bytes still on nextTick for listeners attached in the handler.
      scheduleAfterRequest(capturedRequest, capturedBody, deferKind, capturedDecoder);
    }

    socket.on('data', function (chunk) {
      if (connectionClosed) return;
      deadlines.idleUntil = 0;
      if (!receivingRequest) beginReceiveDeadlines();
      if (parsingHead) {
        pendingBytes = pendingBytes.length ? BufferConcat([pendingBytes, chunk]) : chunk;
        processRequestHead();
      } else if (requestBodyComplete) {
        pendingBytes = pendingBytes.length ? BufferConcat([pendingBytes, chunk]) : chunk;
      } else if (chunkedDecoder) {
        chunkedDecoder(chunk);
      } else {
        feedContentLengthBody(chunk);
      }
    });

    socket.on('end', function () {
      peerHalfClosed = true;
      process.nextTick(function () {
        if (connectionClosed) return;
        if (parsingHead) {
          if (pendingBytes.length > 0) sendErrorAndClose(400);
          else destroyConnection();
        } else if (request && !request._ended) {
          if (response && response.headersSent) destroyConnection();
          else sendErrorAndClose(400);
        }
      });
    });

    socket.on('error', function () {
      connectionClosed = true;
      clearAllDeadlines();
    });

    armIdleDeadline();
  }

  /**
   * @param {object|function} [options]
   * @param {function} [requestListener]
   * @constructor
   */
  function Server(options, requestListener) {
    if (typeof options === 'function') {
      requestListener = options;
      options = {};
    }
    EventEmitter.call(this);
    var self = this;
    this.keepAliveTimeout = 5000;
    this.headersTimeout = 60000;
    this.requestTimeout = 300000;
    var tlsContext;
    if (options && typeof options === 'object') {
      if (typeof options.keepAliveTimeout === 'number') {
        this.keepAliveTimeout = options.keepAliveTimeout;
      }
      if (typeof options.headersTimeout === 'number') {
        this.headersTimeout = options.headersTimeout;
      }
      if (typeof options.requestTimeout === 'number') {
        this.requestTimeout = options.requestTimeout;
      }
      tlsContext = options.tls;
    }
    this._net = net.createServer({ tls: tlsContext }, function (socket) {
      onConnection(self, socket);
    });
    this._net.on('listening', function () {
      self.emit('listening');
    });
    this._net.on('close', function () {
      self.emit('close');
    });
    this._net.on('error', function (err) {
      self.emit('error', err);
    });
    if (typeof requestListener === 'function') this.on('request', requestListener);
  }
  Server.prototype = ObjectCreate(EventEmitter.prototype);
  Server.prototype.constructor = Server;

  Server.prototype.listen = function () {
    this._net.listen.apply(this._net, arguments);
    return this;
  };
  Server.prototype.close = function (callback) {
    this._net.close(callback);
    return this;
  };
  Server.prototype.address = function () {
    return this._net.address();
  };

  /**
   * @param {object|function} [options]
   * @param {function} [requestListener]
   * @returns {Server}
   */
  function createServer(options, requestListener) {
    return new Server(options, requestListener);
  }

  module.exports = {
    createServer: createServer,
    Server: Server,
    IncomingMessage: IncomingMessage,
    ServerResponse: ServerResponse,
    STATUS_CODES: STATUS_CODES,
  };
});
