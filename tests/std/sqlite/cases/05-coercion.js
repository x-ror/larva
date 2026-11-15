// Value coercion / validation parity with node:sqlite (#91). Covers the bind and
// read edges where Lava previously diverged: BigInt binding, rejecting unbindable
// types (undefined/boolean) instead of silently coercing, surfacing failed binds,
// NUL-containing TEXT, empty exec, the required constructor path, and parameter
// count mismatches. Run under Node as the oracle and compared against Lava.
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

// The message is part of the conformance surface (CLAUDE.md §1), so it is asserted
// alongside the code: with only `err.code` checked, any message drift on these
// paths stayed invisible because nothing derived from the message was printed.
function throwsWithCode(fn, code, message, label) {
  let err;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  assert.ok(err, label + ': expected a throw');
  assert.equal(err.code, code, label + ': code');
  assert.equal(err.message, message, label + ': message');
}

const PATH_TYPE_MSG =
  'The "path" argument must be a string, Uint8Array, or URL without null bytes.';
const UNBINDABLE_MSG = 'Provided value cannot be bound to SQLite parameter 1.';

// --- constructor requires a real path (no silent "undefined" file) ---
throwsWithCode(() => new DatabaseSync(), 'ERR_INVALID_ARG_TYPE', PATH_TYPE_MSG, 'no-arg ctor');
throwsWithCode(
  () => new DatabaseSync(undefined),
  'ERR_INVALID_ARG_TYPE',
  PATH_TYPE_MSG,
  'undefined ctor',
);

const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE t (x)');

// --- empty exec is a no-op (not an error) ---
assert.equal(db.exec(''), undefined);
assert.equal(db.exec('   '), undefined);

function insertOne(value) {
  db.exec('DELETE FROM t');
  db.prepare('INSERT INTO t VALUES (?)').run(value);
}

// --- BigInt binds as INTEGER when it fits in i64 ---
insertOne(42n);
const r42 = db.prepare('SELECT x, typeof(x) AS ty FROM t').get();
assert.equal(r42.x, 42);
assert.equal(r42.ty, 'integer');

// A full-width i64 round-trips exactly when read back as BigInt.
insertOne(9223372036854775807n);
const big = db.prepare('SELECT x FROM t');
big.setReadBigInts(true);
assert.equal(big.get().x, 9223372036854775807n);

// A BigInt outside i64 range cannot be bound — Node throws, no lossy/wrapped write.
throwsWithCode(
  () => insertOne(2n ** 64n),
  'ERR_INVALID_ARG_VALUE',
  'BigInt value is too large to bind.',
  'bigint overflow',
);

// --- unbindable types throw instead of coercing ---
// `undefined` is NOT one of them from node 26: it binds as SQL NULL, positional and
// named alike (node 24 threw ERR_INVALID_ARG_TYPE here).
insertOne(undefined);
const undefRow = db.prepare('SELECT x, typeof(x) AS ty FROM t').get();
assert.equal(undefRow.x, null);
assert.equal(undefRow.ty, 'null');
assert.equal(db.prepare('SELECT typeof(:v) AS ty').get({ v: undefined }).ty, 'null');
throwsWithCode(() => insertOne(Symbol('s')), 'ERR_INVALID_ARG_TYPE', UNBINDABLE_MSG, 'bind symbol');
// (A boolean is bindable since node 24.x — INTEGER 1/0, pinned in 08-coercion-parity.js.)

// --- null is a valid bind (-> SQL NULL) ---
insertOne(null);
assert.equal(db.prepare('SELECT x FROM t').get().x, null);

// --- TEXT with an embedded NUL round-trips intact (no truncation) ---
// SQLite TEXT may legally contain NULs; the Node 24 CI baseline and Lava preserve
// them (the #91 fix). (Node 22 truncated at the first NUL, but it is no longer the
// oracle — see #167.)
insertOne('a\0b');
const text = db.prepare('SELECT x FROM t').get().x;
assert.equal(text.length, 3);
assert.equal(text.charCodeAt(0), 97);
assert.equal(text.charCodeAt(1), 0);
assert.equal(text.charCodeAt(2), 98);

// --- too few positional params bind NULL; too many surface a SQLite error ---
db.exec('CREATE TABLE pair (a, b)');
db.prepare('INSERT INTO pair VALUES (?, ?)').run(); // 0 args, 2 placeholders
const pair = db.prepare('SELECT a, b FROM pair').get();
assert.equal(pair.a, null);
assert.equal(pair.b, null);

throwsWithCode(
  () => db.prepare('INSERT INTO t VALUES (?)').run(1, 2),
  'ERR_SQLITE_ERROR',
  'column index out of range',
  'extra positional param',
);

db.close();
console.log('ok');
