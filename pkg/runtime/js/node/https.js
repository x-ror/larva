// node:https — HTTPS server (M1), the TLS counterpart of node:http. https.createServer wraps an
// http.Server whose connections are TLS-terminated natively (pkg/runtime/tls_server.odin): the
// SAME request/response machinery (node:http over node:net) runs over the decrypted socket, so
// keep-alive, chunked, and the timeouts all work unchanged.
//
// M1 surface: { key, cert } (PEM strings or Buffers, including a leaf+chain PEM). Deferred (and
// REJECTED rather than silently ignored, so a caller never gets weaker security than asked):
// client-cert auth (requestCert/ca/rejectUnauthorized), SNI (SNICallback), ALPN, ciphers,
// min/maxVersion, passphrase. The HTTPS client (https.request/get/Agent) is provided by fetch and
// is out of scope here.
(function (require, module, exports, native) {
  'use strict';

  if (!native || typeof native.createSecureContext !== 'function') {
    throw new Error('node:https is unavailable on this platform');
  }

  var http = require('http');
  // Pristine, from the loader — see #333; a capture here runs after user code.
  var PristineBuffer = require.pristineBuffer;
  var Buffer = PristineBuffer.Buffer;
  var BufferFrom = PristineBuffer.from;
  var BufferPrototypeToString = PristineBuffer.bufferToString;
  var BufferIsBuffer = PristineBuffer.isBuffer;

  function unsupported(name) {
    var e = new Error(
      "node:https (M1) does not support the '" +
        name +
        "' option; it is rejected rather than ignored so the connection is never weaker than requested",
    );
    e.code = 'ERR_TLS_UNSUPPORTED_OPTION';
    throw e;
  }

  // Reject the deferred, security-sensitive options — but only when set to a behavior-changing value
  // (`!= null` skips both undefined AND null, so an ordinary options bag carrying defaults still
  // works). Includes the legacy protocol/cipher knobs (secureProtocol/secureOptions/honorCipherOrder/
  // ecdhCurve/dhparam/sigalgs) and pfx so a pin via any API is rejected the same as the modern
  // minVersion/ciphers — never silently weaker than requested. rejectUnauthorized is intentionally
  // NOT listed: on a server it is a no-op unless requestCert (rejected above), so a shared
  // client/server config carrying `rejectUnauthorized: true` must not spuriously throw.
  function rejectDeferred(options) {
    if (options.requestCert) unsupported('requestCert');
    if (options.ca != null) unsupported('ca');
    if (options.minVersion != null) unsupported('minVersion');
    if (options.maxVersion != null) unsupported('maxVersion');
    if (options.secureProtocol != null) unsupported('secureProtocol');
    if (options.secureOptions != null) unsupported('secureOptions');
    if (options.ciphers != null) unsupported('ciphers');
    if (options.honorCipherOrder != null) unsupported('honorCipherOrder');
    if (options.ecdhCurve != null) unsupported('ecdhCurve');
    if (options.sigalgs != null) unsupported('sigalgs');
    if (options.dhparam != null) unsupported('dhparam');
    if (options.privateKeyEngine != null) unsupported('privateKeyEngine');
    if (options.pfx != null) unsupported('pfx');
    if (options.passphrase != null) unsupported('passphrase');
    if (typeof options.SNICallback === 'function') unsupported('SNICallback');
    if (options.ALPNProtocols != null) unsupported('ALPNProtocols');
  }

  // Node accepts key/cert as a string, a Buffer, or (for multiple contexts) an array. M1 is one
  // key + one cert (the cert PEM may itself hold leaf+intermediates), so arrays are rejected.
  function toPem(value, field) {
    if (value == null || value === '') {
      var e = new Error("node:https requires the '" + field + "' option");
      e.code = 'ERR_TLS_CERT';
      throw e;
    }
    if (typeof value === 'string') return value;
    // `value.toString('utf8')` would read the method off the INSTANCE, i.e. through the
    // mutable `Buffer.prototype`. This is the TLS key/cert ingestion path: a replacement
    // returning a valid PEM makes the server present a certificate of the attacker's
    // choosing. Node is not steerable here (measured: `outcome=created steeredPEMReads=0`
    // with `Buffer.prototype.toString` replaced; Lava read it twice and threw).
    if (BufferIsBuffer(value)) return BufferPrototypeToString(value, 'utf8');
    if (value instanceof Uint8Array) return BufferPrototypeToString(BufferFrom(value), 'utf8');
    if (Array.isArray(value)) {
      var ae = new Error(
        "node:https (M1) supports a single '" +
          field +
          "'; arrays (multiple contexts) are deferred",
      );
      ae.code = 'ERR_TLS_UNSUPPORTED_OPTION';
      throw ae;
    }
    // Anything else (a stray object/number) — throw a clear type error rather than feeding
    // String(value) (e.g. '[object Object]') to OpenSSL and surfacing a confusing ERR_TLS_CERT.
    var te = new TypeError(
      "node:https option '" + field + "' must be a string, Buffer, or Uint8Array (PEM)",
    );
    te.code = 'ERR_INVALID_ARG_TYPE';
    throw te;
  }

  function createServer(options, requestListener) {
    // Unlike http, https has no (requestListener)-only form: key+cert are mandatory.
    if (typeof options === 'function') {
      var e = new Error('node:https requires an options object with `key` and `cert`');
      e.code = 'ERR_TLS_CERT';
      throw e;
    }
    if (!options || typeof options !== 'object') options = {};

    rejectDeferred(options);
    var keyPem = toPem(options.key, 'key');
    var certPem = toPem(options.cert, 'cert');

    // Build + validate the context synchronously: a bad PEM / key-cert mismatch / encrypted key
    // THROWS here, which is exactly where a Node caller's try/catch around createServer expects it.
    var ctxId;
    try {
      ctxId = native.createSecureContext(keyPem, certPem);
    } catch (e) {
      if (e && !e.code) e.code = 'ERR_TLS_CERT';
      throw e;
    }

    // Reuse all of node:http, attaching the TLS context (threaded http.Server → net → native.listen).
    // Pass through the http timeout options too.
    var server = http.createServer(
      {
        tls: ctxId,
        keepAliveTimeout: options.keepAliveTimeout,
        headersTimeout: options.headersTimeout,
        requestTimeout: options.requestTimeout,
      },
      requestListener,
    );

    // Free the context once the server is done with it, on 'close'. We do NOT free on 'error': that
    // would add an 'error' listener and silently swallow a real bind failure (EADDRINUSE/EACCES),
    // whereas Node lets it throw "Unhandled error" — the native listen path frees the context itself
    // on a failed bind/listen (net_listen_cb's deferred free), so there is nothing to clean up here.
    // A context built but never listened on (createServer without listen) is freed at process
    // teardown (net_destroy_state); acceptable for M1.
    var freed = false;
    function freeCtx() {
      if (freed) return;
      freed = true;
      if (typeof native.freeSecureContext === 'function') native.freeSecureContext(ctxId);
    }
    server.once('close', freeCtx);

    return server;
  }

  // https.Server: M1 returns an http.Server with TLS transport (not a distinct tls.Server subclass),
  // so `new https.Server(opts, fn)` works but `instanceof https.Server` is not meaningful yet.
  function Server(options, requestListener) {
    return createServer(options, requestListener);
  }

  // Client surface (https.request/get/Agent/globalAgent) is deferred — the HTTPS *client* is `fetch`.
  // Provide throwing stubs rather than leaving them undefined so a dependency that calls
  // https.request(...) gets an actionable message (use fetch) instead of an opaque
  // "https.request is not a function" TypeError.
  function clientUnsupported(name) {
    var e = new Error(
      'node:https client API `' +
        name +
        '` is not implemented; use the global `fetch()` for HTTPS requests',
    );
    e.code = 'ERR_TLS_UNSUPPORTED_OPTION';
    throw e;
  }
  function request() {
    clientUnsupported('https.request');
  }
  function get() {
    clientUnsupported('https.get');
  }
  function Agent() {
    clientUnsupported('https.Agent');
  }

  // globalAgent is a plain object in Node, and is commonly READ at config time
  // (https.globalAgent.maxSockets = N, typeof, destructuring). A throwing getter would crash on
  // mere access — worse than undefined — so expose an inert object. The HTTPS client is fetch;
  // this agent is never actually used to drive a request.
  module.exports = {
    createServer: createServer,
    Server: Server,
    request: request,
    get: get,
    Agent: Agent,
    globalAgent: { maxSockets: Infinity, maxFreeSockets: 256, sockets: {}, requests: {} },
  };
});
