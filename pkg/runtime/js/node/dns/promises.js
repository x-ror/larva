// node:dns/promises — re-exports the `promises` surface of node:dns so
// `require('node:dns/promises')` and `import ... from 'node:dns/promises'` work.
(function (require, module, _exports) {
  'use strict';
  module.exports = require('node:dns').promises;
});
