// fetch's value types, without the network: Headers and Request construction are
// paid on every fetch() before a byte moves, and Headers#get is how every response
// is read. Header-name validation and lower-casing live here, which is where a
// hardening change (captured primordials, code-unit loops) would show as a cost.

const init = {
  'Content-Type': 'application/json',
  Accept: 'text/html,application/xhtml+xml',
  'X-Request-Id': 'abc-123',
  'Cache-Control': 'no-cache',
};
const prebuilt = new Headers(init);
const target = 'https://example.com/api/items?page=2';

bench('headers-new', () => new Headers(init), { iterations: 25000 });
bench('headers-get', () => prebuilt.get('x-request-id'), { iterations: 200000 });
bench('request-new', () => new Request(target, { method: 'POST', headers: init }).url, {
  iterations: 7000,
});
bench('response-new', () => new Response('ok', { status: 201, headers: init }).status, {
  iterations: 15000,
});
