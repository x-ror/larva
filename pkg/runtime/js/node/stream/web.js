// node:stream/web — the public entry for the WHATWG Streams classes. The export
// object, the classes and the globals all come from internal/webstreams/index.js,
// which the loader instantiates before user code on both surfaces; this file hands
// that SAME object out, so `require('stream/web').ReadableStream === ReadableStream`
// holds as it did when the assembly lived here.
(function (require, module, _exports) {
  'use strict';

  module.exports = require('internal/webstreams/index');
});
