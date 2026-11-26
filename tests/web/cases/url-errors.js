// What URL and URLSearchParams throw, as a page sees it: the error's class, message
// and `code` (a page's errors have none). Split from url-parse.js, which prints only
// the class.
function show(label, f) {
  try {
    const v = f();
    print(label + ': no throw ' + JSON.stringify(String(v)));
  } catch (e) {
    print(label + ': ' + e.constructor.name + ': ' + e.message + ' code=' + e.code);
  }
}
show('new URL()', () => new URL());
show('relative without base', () => new URL('/x'));
show('bad host', () => new URL('http://exa mple.com/'));
show('empty host', () => new URL('http://'));
show('bad base', () => new URL('x', 'not a base'));
show('bad port', () => new URL('http://a.com:99999/'));
show('bad IPv6', () => new URL('http://[::1/'));
show('URL.parse bad', () => URL.parse('nope'));
show('URL.canParse bad', () => URL.canParse('nope'));
show('URLSearchParams bad pair', () => new URLSearchParams([['a']]));
show('URLSearchParams bad entry', () => new URLSearchParams([1]));
show('href setter', () => {
  const u = new URL('http://a/');
  u.href = 'nope';
  return u;
});
show('createObjectURL string', () => URL.createObjectURL('x'));
