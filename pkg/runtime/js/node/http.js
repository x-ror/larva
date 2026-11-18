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

  // The implementation lives in js/internal/http/{common,incoming,outgoing,server}.js,
  // laid out like node's _http_common/_http_incoming/_http_outgoing/_http_server; this
  // file stays the public entry and keeps node's createServer here. The loader hands
  // outgoing.js and server.js these same bindings, so the platform check below guards
  // them too: it runs before either is required.
  var primordials = require('internal/primordials');

  if (!native || typeof native.parseRequest !== 'function') {
    throw new primordials.Error('node:http is unavailable on this platform');
  }

  var server = require('internal/http/server');
  var Server = server.Server;

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
    IncomingMessage: require('internal/http/incoming').IncomingMessage,
    ServerResponse: server.ServerResponse,
    STATUS_CODES: server.STATUS_CODES,
  };
});
