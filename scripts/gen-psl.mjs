#!/usr/bin/env node
// Compiles the vendored Public Suffix List (pkg/http/cookie/psl/public_suffix_list.dat)
// into the sorted rule table the cookie jar `#load`s (pkg/http/cookie/psl/psl.table).
//
//   node scripts/gen-psl.mjs            # (re)write psl.table from the .dat
//   node scripts/gen-psl.mjs --check    # fail when the committed psl.table drifts
//
// Rules are normalised as Chrome's net/tools/tld_cleanup does before it builds its
// DAFSA: each rule is canonicalised as a host (a U-label becomes its punycode A-label,
// through node's UTS-46 domainToASCII), `*.x` is stored under `x` with the wildcard
// flag, `!x` under `x` with the exception flag, and the ICANN and PRIVATE sections are
// merged: Chrome's cookie and site code asks with INCLUDE_PRIVATE_REGISTRIES, so the
// jar never needs to tell them apart.
//
// Layout, little-endian (read by pkg/http/cookie/psl.odin):
//   0   "LPSL"
//   4   u32 format version (2)
//   8   u32 rule count N (< 65535: slots hold index + 1 in a u16)
//   12  u32 the most labels any key has
//   16  u32 hash slot count S, a power of two at least 1.5 N
//   20  u32 0
//   24  32 bytes: SHA-256 of the .dat the table was built from
//   56  u16 slots[S]: 0 empty, else 1 + the index of a key whose FNV-1a 32 hash, masked
//       by S - 1, lands there or in an occupied run just before it (linear probing)
//   ..  u32 offsets[N + 1], into the entry area that follows them
//   ..  entries: one flags byte (1 exact, 2 wildcard, 4 exception), then the key's
//       lowercase ASCII bytes; sorted by key, bytewise, so the output is deterministic.
//
// A hash and not a binary search because a lookup probes every suffix of the host, and
// a binary search over 10507 keys takes ~14 steps per suffix: site_key measured ~245 ns
// that way against ~77 ns with the slots, which add 32 KiB (method in psl.odin).
//
// Both the .dat and psl.table are committed: the build needs no node, and
// scripts/gen-psl.test.mjs runs --check's comparison, so a .dat update nobody
// regenerated, or a hand-edited table, fails `make check-js`.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { domainToASCII } from 'node:url';
import { fileURLToPath } from 'node:url';
import { ROOT } from './lib/web-oracle.mjs';

export const DAT = join(ROOT, 'pkg/http/cookie/psl/public_suffix_list.dat');
export const BIN = join(ROOT, 'pkg/http/cookie/psl/psl.table');

export const EXACT = 1;
export const WILDCARD = 2;
export const EXCEPTION = 4;
const FORMAT_VERSION = 2;
const HEADER_BYTES = 56;

/**
 * FNV-1a, 32-bit, over a key's bytes; psl.odin's psl_hash must agree.
 * @param {string} key lowercase ASCII
 */
export function hash(key) {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

/**
 * Parses the list's text into a Map of normalised key -> flags.
 * @param {string} text
 * @returns {Map<string, number>}
 */
export function parseRules(text) {
  const rules = new Map();
  for (const raw of text.split('\n')) {
    // A rule is the line up to its first whitespace (publicsuffix.org/list format).
    const line = raw.trim().split(/\s/)[0];
    if (line === '' || line.startsWith('//')) continue;
    let flag = EXACT;
    let body = line;
    if (body.startsWith('!')) {
      flag = EXCEPTION;
      body = body.slice(1);
    } else if (body.startsWith('*.')) {
      flag = WILDCARD;
      body = body.slice(2);
    }
    if (body.includes('*')) throw new Error(`gen-psl: unsupported wildcard placement: ${line}`);
    const key = domainToASCII(body);
    if (key === '' || key !== key.toLowerCase() || /[^a-z0-9.-]/.test(key)) {
      throw new Error(`gen-psl: rule does not canonicalise to an ASCII host: ${line}`);
    }
    if (flag === EXCEPTION && !key.includes('.')) {
      // Chrome treats a dotless exception as unreachable (registry_controlled_domain.cc).
      throw new Error(`gen-psl: exception rule without a dot: ${line}`);
    }
    rules.set(key, (rules.get(key) ?? 0) | flag);
  }
  return rules;
}

/**
 * Builds psl.table's bytes from the .dat's bytes.
 * @param {Buffer} dat
 * @returns {Buffer}
 */
export function build(dat) {
  const rules = parseRules(dat.toString('utf8'));
  // Keys are ASCII, so UTF-16 order is byte order.
  const keys = [...rules.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (keys.length >= 0xffff) throw new Error('gen-psl: too many rules for u16 slots');
  let slots = 1;
  while (slots < keys.length * 1.5) slots *= 2;
  let maxLabels = 0;
  let entryBytes = 0;
  for (const k of keys) {
    maxLabels = Math.max(maxLabels, k.split('.').length);
    entryBytes += 1 + k.length;
  }
  const slotsAt = HEADER_BYTES;
  const offsetsAt = slotsAt + 2 * slots;
  const entriesAt = offsetsAt + 4 * (keys.length + 1);
  const out = Buffer.alloc(entriesAt + entryBytes);
  out.write('LPSL', 0, 'latin1');
  out.writeUInt32LE(FORMAT_VERSION, 4);
  out.writeUInt32LE(keys.length, 8);
  out.writeUInt32LE(maxLabels, 12);
  out.writeUInt32LE(slots, 16);
  createHash('sha256').update(dat).digest().copy(out, 24);
  let at = 0;
  keys.forEach((k, i) => {
    out.writeUInt32LE(at, offsetsAt + 4 * i);
    out[entriesAt + at] = rules.get(k);
    out.write(k, entriesAt + at + 1, 'latin1');
    at += 1 + k.length;
    let slot = hash(k) & (slots - 1);
    while (out.readUInt16LE(slotsAt + 2 * slot) !== 0) slot = (slot + 1) & (slots - 1);
    out.writeUInt16LE(i + 1, slotsAt + 2 * slot);
  });
  out.writeUInt32LE(at, offsetsAt + 4 * keys.length);
  return out;
}

/** @returns {string[]} what is wrong with the committed psl.table; [] when it is current */
export function driftProblems(dat = readFileSync(DAT), bin = readFileSync(BIN)) {
  return build(dat).equals(bin)
    ? []
    : [`${BIN} is not what scripts/gen-psl.mjs builds from ${DAT}; run node scripts/gen-psl.mjs`];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) {
    const problems = driftProblems();
    for (const p of problems) console.error(p);
    process.exit(problems.length ? 1 : 0);
  }
  const bin = build(readFileSync(DAT));
  writeFileSync(BIN, bin);
  console.log(`gen-psl: ${bin.readUInt32LE(8)} rules, ${bin.length} bytes -> ${BIN}`);
}
