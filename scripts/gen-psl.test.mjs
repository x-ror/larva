// Tests for the Public Suffix List compiler (scripts/gen-psl.mjs): how rules are
// normalised, the table layout pkg/http/cookie/psl.odin reads, and the drift check that
// keeps the committed psl.table the build of the committed .dat. A gate script: without
// the drift check a list update nobody regenerated ships the old list under the new
// list's name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  BIN,
  DAT,
  EXACT,
  EXCEPTION,
  WILDCARD,
  build,
  driftProblems,
  hash,
  parseRules,
} from './gen-psl.mjs';

test('rules: wildcard and exception flags, IDN to A-labels, sections merged', () => {
  const rules = parseRules(
    [
      '// ===BEGIN ICANN DOMAINS===',
      'com',
      '*.ck',
      '!www.ck',
      '公司.cn',
      'CO.UK   trailing comment',
      '// ===END ICANN DOMAINS===',
      '// ===BEGIN PRIVATE DOMAINS===',
      'github.io',
      'ck',
      '',
    ].join('\n'),
  );
  assert.deepEqual(
    [...rules].sort(),
    [
      ['ck', WILDCARD | EXACT],
      ['co.uk', EXACT],
      ['com', EXACT],
      ['github.io', EXACT],
      ['www.ck', EXCEPTION],
      ['xn--55qx5d.cn', EXACT],
    ].sort(),
  );
});

test('rules: what the lookup cannot express is refused, not guessed', () => {
  assert.throws(() => parseRules('a.*.b\n'), /wildcard placement/);
  assert.throws(() => parseRules('!foo\n'), /exception rule without a dot/);
});

test('table: header, slots that find every key, offsets that bracket each entry', () => {
  const dat = Buffer.from('zz\n*.ck\n!www.ck\nco.uk\n');
  const bin = build(dat);
  assert.equal(bin.toString('latin1', 0, 4), 'LPSL');
  assert.equal(bin.readUInt32LE(4), 2);
  const n = bin.readUInt32LE(8);
  assert.equal(n, 4);
  assert.equal(bin.readUInt32LE(12), 2);
  const slots = bin.readUInt32LE(16);
  assert.equal(slots, 8);
  assert.deepEqual(bin.subarray(24, 56), createHash('sha256').update(dat).digest());
  const offsets = 56 + 2 * slots;
  const entries = offsets + 4 * (n + 1);
  const entry = (i) => {
    const at = bin.readUInt32LE(offsets + 4 * i);
    const end = bin.readUInt32LE(offsets + 4 * (i + 1));
    return [bin.toString('latin1', entries + at + 1, entries + end), bin[entries + at]];
  };
  assert.deepEqual([0, 1, 2, 3].map(entry), [
    ['ck', WILDCARD],
    ['co.uk', EXACT],
    ['www.ck', EXCEPTION],
    ['zz', EXACT],
  ]);
  assert.equal(entries + bin.readUInt32LE(offsets + 4 * n), bin.length);
  // The probe psl.odin runs: from the hash's slot to the key, through no empty slot.
  for (const [key] of [0, 1, 2, 3].map(entry)) {
    let slot = hash(key) & (slots - 1);
    for (;;) {
      const v = bin.readUInt16LE(56 + 2 * slot);
      assert.notEqual(v, 0, `${key}: an empty slot before the key`);
      if (entry(v - 1)[0] === key) break;
      slot = (slot + 1) & (slots - 1);
    }
  }
});

test('hash: FNV-1a 32 (psl.odin computes the same)', () => {
  assert.equal(hash(''), 0x811c9dc5);
  assert.equal(hash('a'), 0xe40c292c);
  assert.equal(hash('foobar'), 0xbf9cf968);
});

test('drift: the committed psl.table is the build of the committed .dat', () => {
  assert.deepEqual(driftProblems(), []);
  const bin = Buffer.from(readFileSync(BIN));
  bin[bin.length - 1] ^= 1;
  assert.equal(driftProblems(readFileSync(DAT), bin).length, 1);
});
