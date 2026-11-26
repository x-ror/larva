// A space in a special URL's host. Chrome's parser percent-encodes it and accepts the
// URL; the WHATWG parser Lava follows rejects it as a forbidden host code point. Kept
// apart from url-errors.js because it is parser behavior, not error text.
for (const input of ['http://exa mple.com/', 'http://a%20b.com/', 'foo://exa mple/']) {
  try {
    print(JSON.stringify(input) + ' => ' + new URL(input).href);
  } catch (e) {
    print(JSON.stringify(input) + ' => throws ' + e.constructor.name);
  }
}
