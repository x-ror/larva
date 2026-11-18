// 64-bit integer handling for node:sqlite (#131). SQLite INTEGER is i64; JS
// numbers are exact only to 2^53-1. Match Node: read out-of-range columns throw
// ERR_OUT_OF_RANGE by default, setReadBigInts(true) returns BigInt, and run()'s
// changes/lastInsertRowid are lossy numbers by default / BigInt when opted in.
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE t (x INTEGER)');

// In-range integer is a plain number.
db.exec('INSERT INTO t VALUES (42)');
let s = db.prepare('SELECT x FROM t');
assert.equal(s.get().x, 42);
assert.equal(typeof s.get().x, 'number');

// Out-of-range integer (i64 max) throws ERR_OUT_OF_RANGE by default.
db.exec('DELETE FROM t; INSERT INTO t VALUES (9223372036854775807)');
s = db.prepare('SELECT x FROM t');
let err;
try {
  s.get();
} catch (e) {
  err = e;
}
assert.ok(err, 'expected out-of-range read to throw');
assert.equal(err.code, 'ERR_OUT_OF_RANGE');

// setReadBigInts(true) returns the value as BigInt (in range or out).
assert.equal(s.setReadBigInts(true), undefined);
assert.equal(s.get().x, 9223372036854775807n);
const s2 = db.prepare('SELECT x FROM t');
s2.setReadBigInts(true);
db.exec('DELETE FROM t; INSERT INTO t VALUES (5)');
assert.equal(s2.get().x, 5n);

// The 2^53-1 boundary: exactly safe is a number; one beyond throws.
function readOne(val) {
  db.exec('DELETE FROM t; INSERT INTO t VALUES (' + val + ')');
  return db.prepare('SELECT x FROM t').get().x;
}
assert.equal(readOne('9007199254740991'), 9007199254740991);
let boundary;
try {
  readOne('9007199254740992');
} catch (e) {
  boundary = e;
}
assert.equal(boundary && boundary.code, 'ERR_OUT_OF_RANGE');

// run(): changes/lastInsertRowid are numbers by default, BigInt under
// setReadBigInts(true). From node 26 an unsafe rowid throws like a column read does
// (node 24 returned a lossy number) — AFTER the row is written, so the insert stands.
db.exec('CREATE TABLE u (id INTEGER PRIMARY KEY)');
const small = db.prepare('INSERT INTO u (id) VALUES (5)').run();
assert.equal(small.lastInsertRowid, 5);
assert.equal(small.changes, 1);
const ins = db.prepare('INSERT INTO u (id) VALUES (9007199254740995)');
let unsafe;
try {
  ins.run();
} catch (e) {
  unsafe = e;
}
assert.ok(unsafe instanceof RangeError, 'unsafe rowid: RangeError');
assert.equal(unsafe.code, 'ERR_OUT_OF_RANGE');
assert.equal(
  unsafe.message,
  'Value is too large to be represented as a JavaScript number: 9007199254740995',
);
assert.equal(db.prepare('SELECT count(*) AS c FROM u WHERE id = 9007199254740995').get().c, 1);

const insBig = db.prepare('INSERT INTO u (id) VALUES (9007199254740999)');
insBig.setReadBigInts(true);
const r2 = insBig.run();
assert.equal(r2.lastInsertRowid, 9007199254740999n);
assert.equal(r2.changes, 1n);

console.log('ok');
