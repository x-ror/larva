// node:crypto is assembled from internal modules laid out like node's
// lib/internal/crypto: js/internal/crypto/{util,hash,random,pbkdf2,hkdf,scrypt}.js hold
// the implementation and node/crypto stays the public entry. A throw from pbkdf2Sync
// used to carry only `node:crypto` frames, because everything was defined in crypto.js;
// now it names its file, exactly as node's does.
//
// Each frame line prints `ok` when the stack carries `node:internal/crypto/<file>:`
// and names the first `node:` frame it got otherwise. Only the source name is compared,
// never the message, line or column, and never the error class where Lava's is a known
// gap (randomInt's RangeError has no code, getRandomValues throws a RangeError where node
// throws a QuotaExceededError DOMException). timingSafeEqual is node's C++ binding with
// no JS frame at all, and stays in node/crypto on Lava, so it prints `false` on both.
// Every site throws synchronously on both runtimes (probed on node 26.13.0).
//
// The new ids must stay internal: neither the bare nor the `node:` spelling may resolve
// from user code. Only the error CODE of the bare spelling is printed (the messages
// diverge, #415).
//
// The export lines check identities that cross the new file seams (createHash in the
// entry, Hash in internal/crypto/hash; the deprecated randomBytes aliases; the WHATWG
// global). Export ORDER is not oracle-able — node's key list is a different set in a
// different order — so the split was checked against the previous binary instead (the
// PR records the diff). `new crypto.Hash` is never called: node prints DEP0179 for it.
'use strict';

const crypto = require('crypto');

for (const id of [
  'internal/crypto/util',
  'internal/crypto/hash',
  'internal/crypto/random',
  'internal/crypto/pbkdf2',
  'internal/crypto/hkdf',
  'internal/crypto/scrypt',
  'crypto/random',
]) {
  let code = 'RESOLVED';
  try {
    require(id);
  } catch (e) {
    code = e.code;
  }
  let threw = false;
  try {
    require('node:' + id);
  } catch {
    threw = true;
  }
  console.log('hidden', id, code, 'node:' + (threw ? 'threw' : 'RESOLVED'));
}

function frame(label, file, f) {
  let stack = null;
  try {
    f();
  } catch (e) {
    stack = String(e && e.stack);
  }
  if (stack === null) return console.log(label + ': NO THROW');
  if (file === null) {
    return console.log(
      label + ': internal/crypto frame=' + stack.includes('node:internal/crypto/'),
    );
  }
  const where = stack.includes('node:internal/crypto/' + file + ':')
    ? 'ok'
    : 'got ' + (stack.match(/node:[\w/]+/) || ['no node: frame'])[0];
  console.log(label + ': ' + file + ' ' + where);
}

frame('createHash digest', 'hash', () => crypto.createHash('bogus'));
frame('createHmac digest', 'hash', () => crypto.createHmac('bogus', 'k'));
frame('hash digest', 'hash', () => crypto.hash('bogus', 'x'));
frame('digest twice', 'hash', () => {
  const h = crypto.createHash('sha1');
  h.digest();
  h.digest();
});
frame('randomBytes size', 'random', () => crypto.randomBytes(-1));
frame('randomFillSync buf', 'random', () => crypto.randomFillSync(5));
frame('randomFill offset', 'random', () => crypto.randomFill(new Uint8Array(1), -1, () => {}));
frame('randomInt range', 'random', () => crypto.randomInt(5, 1));
frame('getRandomValues quota', 'random', () => crypto.getRandomValues(new Uint8Array(70000)));
frame('pbkdf2Sync digest', 'pbkdf2', () => crypto.pbkdf2Sync('a', 'b', 1, 1, 'bogus'));
frame('pbkdf2Sync iterations', 'pbkdf2', () => crypto.pbkdf2Sync('a', 'b', -1, 1, 'sha1'));
frame('hkdfSync digest', 'hkdf', () => crypto.hkdfSync('bogus', 'a', 'b', 'c', 1));
frame('scryptSync keylen', 'scrypt', () => crypto.scryptSync('a', 'b', -1));
frame('scryptSync N', 'scrypt', () => crypto.scryptSync('a', 'b', 1, { N: 3 }));
frame('scryptSync option pair', 'scrypt', () => crypto.scryptSync('a', 'b', 1, { N: 2, cost: 2 }));
frame('timingSafeEqual length', null, () =>
  crypto.timingSafeEqual(new Uint8Array(1), new Uint8Array(2)),
);

// --- the assembled exports: shapes and identities ----------------------------------
console.log('same module', require('node:crypto') === crypto);
const SHARED = [
  'Hash',
  'Hmac',
  'createHash',
  'createHmac',
  'hash',
  'getHashes',
  'timingSafeEqual',
  'randomBytes',
  'randomFillSync',
  'randomFill',
  'randomInt',
  'randomUUID',
  'pbkdf2',
  'pbkdf2Sync',
  'hkdf',
  'hkdfSync',
  'scrypt',
  'scryptSync',
  'getFips',
  'constants',
  'getRandomValues',
];
for (const k of SHARED) {
  const d = Object.getOwnPropertyDescriptor(crypto, k);
  // Enumerability is not printed: getRandomValues is enumerable on node and not on Lava,
  // a pre-existing gap the split does not touch.
  console.log('export', k, typeof crypto[k], 'value' in d ? 'data' : 'accessor');
}
console.log(
  'identities',
  crypto.createHash('sha256') instanceof crypto.Hash,
  crypto.createHmac('sha256', 'k') instanceof crypto.Hmac,
  crypto.createHash('sha256').copy() instanceof crypto.Hash,
  crypto.prng === crypto.randomBytes,
  crypto.rng === crypto.randomBytes,
  crypto.pseudoRandomBytes === crypto.randomBytes,
  crypto.getRandomValues === crypto.getRandomValues,
);

// --- the WHATWG global --------------------------------------------------------------
const g = globalThis.crypto;
const u8 = new Uint8Array(8);
console.log(
  'globalThis.crypto',
  typeof g,
  g === globalThis.crypto,
  typeof g.randomUUID,
  typeof g.getRandomValues,
  g.getRandomValues(u8) === u8,
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(g.randomUUID()),
);

// --- behavior across the file seams -------------------------------------------------
console.log('sha256', crypto.createHash('sha256').update('la').update('va').digest('hex'));
console.log('alias', crypto.createHash('RSA-SHA256').update('lava').digest('base64'));
console.log('one-shot', crypto.hash('sha1', 'lava'), crypto.hash('md5', 'lava', 'base64'));
console.log('hmac', crypto.createHmac('sha256', 'key').update('lava').digest('hex'));
const partial = crypto.createHash('sha512').update('la');
const forked = partial.copy();
console.log(
  'copy',
  partial.update('va').digest('hex') === forked.update('va').digest('hex'),
  forked.digest === crypto.Hash.prototype.digest,
);
const hashes = crypto.getHashes();
console.log('getHashes', hashes.includes('sha256'), hashes.includes('RSA-SHA256'));
console.log('pbkdf2Sync', crypto.pbkdf2Sync('password', 'salt', 2, 16, 'sha256').toString('hex'));
console.log(
  'hkdfSync',
  Buffer.from(crypto.hkdfSync('sha256', 'ikm', 'salt', 'info', 16)).toString('hex'),
);
console.log(
  'scryptSync',
  crypto.scryptSync('pw', 'salt', 16, { N: 16, r: 1, p: 1 }).toString('hex'),
);
console.log(
  'timingSafeEqual',
  crypto.timingSafeEqual(Buffer.from('ab'), Buffer.from('ab')),
  crypto.timingSafeEqual(Buffer.from('ab'), Buffer.from('ac')),
);
const filled = new Uint16Array(4);
console.log(
  'random',
  crypto.randomBytes(7).length,
  crypto.randomFillSync(filled) === filled,
  (() => {
    const n = crypto.randomInt(3, 9);
    return n >= 3 && n < 9;
  })(),
);
console.log('constants', crypto.constants.RSA_PKCS1_PADDING, crypto.getFips());

const cb = (f) => new Promise((resolve, reject) => f((err, v) => (err ? reject(err) : resolve(v))));
Promise.all([
  cb((done) => crypto.randomBytes(5, done)),
  cb((done) => crypto.randomFill(new Uint8Array(3), done)),
  cb((done) => crypto.randomInt(10, done)),
  cb((done) => crypto.pbkdf2('password', 'salt', 2, 16, 'sha256', done)),
  cb((done) => crypto.hkdf('sha256', 'ikm', 'salt', 'info', 16, done)),
  cb((done) => crypto.scrypt('pw', 'salt', 16, { N: 16, r: 1, p: 1 }, done)),
]).then(([rb, rf, ri, pb, hk, sc]) => {
  console.log('async random', rb.length, rf.length, ri >= 0 && ri < 10);
  console.log('async pbkdf2', pb.toString('hex'));
  console.log('async hkdf', Buffer.from(hk).toString('hex'));
  console.log('async scrypt', sc.toString('hex'));
});
