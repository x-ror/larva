// The first external script of dom-script-external.page: the parser waits for it.
window.fromA = (window.fromA || 0) + 1;
order.push(
  'a run ' +
    window.fromA +
    ' current=' +
    name(document.currentScript) +
    ' src=' +
    document.currentScript.getAttribute('src') +
    ' body=' +
    name(document.body) +
    ' ' +
    document.readyState,
);
