// IncomingMessage — the request side of node:http, built from one native parseRequest
// result. Where node keeps it: lib/_http_incoming.js (under internal/ here; see common.js
// for why there is no public `_http_incoming`).
(function (require, module) {
  'use strict';

  // LAZY module: constructors/statics come from primordials, not live globals (#426).
  var primordials = require('internal/primordials');
  var ObjectCreate = primordials.ObjectCreate;
  var ObjectDefineProperty = primordials.ObjectDefineProperty;
  var EventEmitter = require('events');
  var common = require('internal/http/common');
  var PARSE_METHOD = common.PARSE_METHOD;
  var PARSE_URL = common.PARSE_URL;
  var PARSE_MINOR = common.PARSE_MINOR;
  var PARSE_HEADERS = common.PARSE_HEADERS;

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

  module.exports = {
    IncomingMessage: IncomingMessage,
  };
});
