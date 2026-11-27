#!/usr/bin/env node
// Writes the tests/web "shape" cases (#114): one case per Web API family Larva
// implements, each printing what a page can read off the family's globals WITHOUT
// calling into them — the global's property descriptor, every function's name,
// length, own keys, `prototype`, constructibility and Function.prototype.toString
// text, and the same for every static and every prototype member, in own-key order.
// Chrome's recording is the expectation, so a member Chrome has and Larva lacks (or
// the reverse), a wrong order, a wrong enumerability or a source text where Chrome
// prints `[native code]` fails the case. The members are ENUMERATED at run time
// (Reflect.ownKeys), never listed here, so a member added to either side is caught.
//
//   node scripts/gen-web-shape.mjs          # rewrite the cases
//   node scripts/gen-web-shape.mjs --check  # exit 1 when a case is out of date
//
// FAMILIES lists the globals each case covers: every Window global Larva installs,
// grouped by the module that installs it. MISSING lists the Chrome globals of the
// same families Larva does not implement; the shape-missing case prints them, and it
// stays a known gap (tests/web/known-gaps.txt) until they exist. Re-record a changed
// case with `make record-web CASES=shape-<family>`.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CASES_DIR = join(ROOT, 'tests/web/cases');

export const FAMILIES = {
  url: ['URL', 'URLSearchParams'],
  encoding: ['TextEncoder', 'TextDecoder'],
  fetch: ['fetch', 'Headers', 'Request', 'Response'],
  blob: ['Blob', 'File'],
  streams: [
    'ReadableStream',
    'ReadableStreamDefaultReader',
    'ReadableStreamBYOBReader',
    'ReadableStreamDefaultController',
    'WritableStream',
    'WritableStreamDefaultWriter',
    'WritableStreamDefaultController',
    'TransformStream',
    'TransformStreamDefaultController',
    'ByteLengthQueuingStrategy',
    'CountQueuingStrategy',
  ],
  events: ['EventTarget', 'Event', 'CustomEvent'],
  abort: ['AbortController', 'AbortSignal'],
  domexception: ['DOMException', 'QuotaExceededError'],
  operations: [
    'atob',
    'btoa',
    'structuredClone',
    'queueMicrotask',
    'setTimeout',
    'setInterval',
    'clearTimeout',
    'clearInterval',
  ],
  crypto: ['crypto', 'Crypto'],
  performance: ['performance'],
  console: ['console'],
};

// Chrome globals of the families above that Larva does not install (Chrome 158).
export const MISSING = [
  'TextEncoderStream',
  'TextDecoderStream',
  'FormData',
  'FileReader',
  'ReadableByteStreamController',
  'ReadableStreamBYOBRequest',
  'CompressionStream',
  'DecompressionStream',
  'SubtleCrypto',
  'CryptoKey',
  'Performance',
  'reportError',
];

// The printer every case shares. Page code, so plain JS; it reads through captured
// intrinsics only to stay correct if a case ever poisons one.
const PRINTER = String.raw`const ownKeys = Reflect.ownKeys;
const getDesc = Object.getOwnPropertyDescriptor;
const getProto = Object.getPrototypeOf;
const hasOwn = Object.hasOwn;
const fnToString = Function.prototype.toString;
const construct = Reflect.construct;
const objToString = Object.prototype.toString;
const apply = Reflect.apply;

function isConstructor(f) {
  try {
    construct(String, [], f);
    return true;
  } catch {
    return false;
  }
}
function keyName(k) {
  return typeof k === 'symbol' ? '[' + String(k) + ']' : k;
}
function source(f) {
  try {
    return JSON.stringify(apply(fnToString, f, []));
  } catch (e) {
    return 'throws ' + e.constructor.name;
  }
}
function fn(f) {
  return (
    'name=' +
    JSON.stringify(f.name) +
    ' length=' +
    f.length +
    ' own=[' +
    ownKeys(f).map(keyName).join(',') +
    ']' +
    ' prototype=' +
    hasOwn(f, 'prototype') +
    ' ctor=' +
    isConstructor(f) +
    ' src=' +
    source(f)
  );
}
// A writable primitive is state (a clock reading), not shape: only its type is printed.
// Read-only ones (DOMException's constants, @@toStringTag) are printed whole.
function value(v, writable) {
  if (typeof v === 'function') return 'fn ' + fn(v);
  if (typeof v === 'object' && v !== null) return 'object ' + apply(objToString, v, []);
  if (writable) return typeof v;
  if (typeof v === 'string') return 'string ' + JSON.stringify(v);
  return typeof v + ' ' + String(v);
}
function flags(d) {
  return (
    (d.enumerable ? 'e' : '-') +
    (d.configurable ? 'c' : '-') +
    ('value' in d ? (d.writable ? 'w' : '-') : '')
  );
}
function member(where, o, k) {
  const d = getDesc(o, k);
  if ('value' in d) {
    print(where + ' ' + keyName(k) + ' data ' + flags(d) + ' ' + value(d.value, d.writable));
    return;
  }
  print(where + ' ' + keyName(k) + ' accessor ' + flags(d));
  print('  get ' + (d.get ? fn(d.get) : 'undefined'));
  print('  set ' + (d.set ? fn(d.set) : 'undefined'));
}
function protoName(p) {
  if (p === null) return 'null';
  if (p === Function.prototype) return 'Function.prototype';
  if (p === Object.prototype) return 'Object.prototype';
  if (typeof p === 'function') return 'function ' + p.name;
  const c = getDesc(p, 'constructor');
  return c && typeof c.value === 'function'
    ? c.value.name + '.prototype'
    : apply(objToString, p, []);
}
function members(where, o, skip) {
  for (const k of ownKeys(o)) if (!skip.includes(k)) member(where, o, k);
}
function shape(name) {
  print('== ' + name);
  const d = getDesc(globalThis, name);
  if (!d) {
    print('missing');
    return;
  }
  member('global', globalThis, name);
  const v = 'value' in d ? d.value : apply(d.get, globalThis, []);
  if (typeof v === 'function') {
    print('[[Prototype]] ' + protoName(getProto(v)));
    if (!hasOwn(v, 'prototype')) return;
    try {
      v();
      print('call: no throw');
    } catch (e) {
      print('call: ' + e.constructor.name + ': ' + e.message);
    }
    members('static', v, ['length', 'name', 'prototype']);
    member('static', v, 'prototype');
    const p = v.prototype;
    print('prototype [[Prototype]] ' + protoName(getProto(p)));
    members('proto', p, []);
    return;
  }
  if (typeof v === 'object' && v !== null) {
    print('object ' + apply(objToString, v, []) + ' [[Prototype]] ' + protoName(getProto(v)));
    members('own', v, []);
    const p = getProto(v);
    if (p !== Object.prototype && p !== null) members('proto', p, []);
  }
}
`;

function header(lines) {
  return lines.map((l) => '// ' + l).join('\n') + '\n';
}

export function familyCase(family, names) {
  return (
    header([
      `GENERATED by scripts/gen-web-shape.mjs — edit the generator, not this file.`,
      `What a page reads off the ${family} globals without calling them (#114): the`,
      `descriptors, names, lengths, own keys, constructibility and toString text of the`,
      `globals, their statics and every prototype member, in own-key order.`,
    ]) +
    PRINTER +
    names.map((n) => `shape('${n}');\n`).join('')
  );
}

export function missingCase() {
  return (
    header([
      `GENERATED by scripts/gen-web-shape.mjs — edit the generator, not this file.`,
      `The Chrome globals of the shape-* families that Larva does not install (#114).`,
    ]) +
    `for (const name of [\n${MISSING.map((n) => `  '${n}',\n`).join('')}])\n  print(name + ' ' + typeof globalThis[name]);\n`
  );
}

export function cases() {
  const out = new Map();
  for (const [family, names] of Object.entries(FAMILIES)) {
    out.set(`shape-${family}`, familyCase(family, names));
  }
  out.set('shape-missing', missingCase());
  return out;
}

function main() {
  const check = process.argv.includes('--check');
  let stale = 0;
  for (const [name, text] of cases()) {
    const file = join(CASES_DIR, name + '.js');
    let have = null;
    try {
      have = readFileSync(file, 'utf8');
    } catch {}
    if (have === text) continue;
    if (check) {
      console.error(`${file} is out of date: run node scripts/gen-web-shape.mjs`);
      stale++;
    } else {
      writeFileSync(file, text);
      console.log(`wrote ${file}`);
    }
  }
  if (stale) process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
