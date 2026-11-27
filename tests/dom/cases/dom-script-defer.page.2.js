// dom-script-defer.page's second deferred script, after the first in document order.
order.push('defer 2 current=' + name(document.currentScript) + ' ' + document.readyState);
Promise.resolve().then(function () {
  order.push('microtask after defer 2');
});
