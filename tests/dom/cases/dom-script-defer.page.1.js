// dom-script-defer.page's first deferred script: it runs once the whole tree is parsed.
order.push(
  'defer 1 current=' +
    name(document.currentScript) +
    ' ' +
    document.readyState +
    ' tail=' +
    (document.getElementById('tail') !== null),
);
