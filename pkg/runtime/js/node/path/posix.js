// node:path/posix — the POSIX path variant. path.js already exposes both variants on
// its export (path.posix / path.win32); this module surfaces the POSIX one under its
// own specifier (Node: require('node:path/posix')).
(function (require, module) {
  'use strict';
  module.exports = require('path').posix;
});
