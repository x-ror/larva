// A synchronous XMLHttpRequest (open's third argument false): Chrome blocks the page
// until the response is in and fires the events from inside send(). Larva does not
// implement it — a known gap (tests/web/known-gaps.txt) pinning what send() throws.
const xhr = new XMLHttpRequest();
const log = [];
for (const t of ['readystatechange', 'loadstart', 'progress', 'load', 'loadend', 'error']) {
  xhr.addEventListener(t, (e) => log.push(e.type + '@' + xhr.readyState));
}
xhr.open('GET', ORIGIN + '/fx/text', false);
try {
  xhr.send();
  print('sync ' + xhr.status + ' ' + JSON.stringify(xhr.responseText));
} catch (e) {
  print('sync send threw ' + e.constructor.name + ' ' + e.name);
}
print('sync events ' + log.join(' '));
