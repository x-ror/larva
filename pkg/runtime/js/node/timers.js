// node:timers — the callback timer API. The functions themselves are globals in this
// runtime (the event loop backs setTimeout/setInterval/setImmediate); this module just
// exposes them under the module specifier, plus the `.promises` namespace Node attaches
// (which is the same surface as require('node:timers/promises')).
(function (require, module, exports) {
  'use strict';

  module.exports = {
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: setInterval,
    clearInterval: clearInterval,
    setImmediate: setImmediate,
    clearImmediate: clearImmediate,
    get promises() {
      return require('timers/promises');
    },
  };
});
