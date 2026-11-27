// The second: it sees the tree up to its own element and nothing after it.
window.fromB = true;
order.push(
  'b run current=' +
    name(document.currentScript) +
    ' before=' +
    (document.getElementById('before') !== null) +
    ' after=' +
    (document.getElementById('after') !== null) +
    ' last=' +
    name(document.body.lastChild.previousSibling),
);
document.getElementById('before').textContent = 'changed by b';
