// Coded errors built by the builtins: class, `code`, message and String(e), through each
// consumer's PUBLIC API, byte-identical with node 26.13.0.
//
// Every builtin used to carry its own copy of node's ERR_* constructors (describeType,
// invalidArgType, outOfRange, …), and the copies disagreed with node and with each other:
// `path.join(1)` said "Received type number" with no value, crypto rendered a string as
// "type string" with no value and dropped node's `_` grouping on large integers, url
// printed an object as "type object ()". They now all build through internal/errors, which this case pins.
//
// Two error SHAPES exist in node and both are observable through String(e):
//   - errors thrown by node's JS layer (`new ERR_X(...)`) stringify as
//     `TypeError [ERR_X]: msg` — the code is spliced in by an inherited toString;
//   - errors thrown by node's C++ layer (THROW_ERR_X: URL parsing, the encoding binding,
//     timingSafeEqual) are a bare `TypeError` with a `code` own property and
//     stringify as `TypeError: msg`.
// Lava used to produce the second shape everywhere.
//
// Not covered, because the remaining difference is not error construction:
//   - a null-prototype object as the received value — node prints
//     `[Object: null prototype] {}`, Lava's util.inspect gives `{}` (#331);
//   - util.styleText's invalid-format list — it is built from inspect.colors, whose key
//     set differs between the runtimes;
// os, fs, sqlite, dns and crypto's hash/KDF sites went with those modules (the Node-profile
// removal, docs/LARVA.md decision 1).
'use strict';

// One error prints as up to three SHORT lines — the shape (everything String(e) adds
// around the message), the message up to its "Received" clause, and that clause alone —
// so a difference in any one part stays inside the 140 characters the mutation runner
// shows per differing line, instead of being cut off the end of one long line.
function show(label, e) {
  const own = Object.getOwnPropertyNames(e).filter(
    (k) => !['stack', 'message', 'code', 'line', 'column', 'sourceURL'].includes(k),
  );
  const str = String(e);
  const msg = e.message;
  const shape = str.endsWith(msg) ? str.slice(0, str.length - msg.length) : str;
  console.log(
    label +
      ' | ' +
      e.constructor.name +
      ' | ' +
      e.code +
      ' | ' +
      shape +
      (own.length ? ' | ' + own.map((k) => k + '=' + String(e[k])).join(',') : ''),
  );
  const at = msg.lastIndexOf(' Received ');
  console.log('  message: ' + (at === -1 ? msg : msg.slice(0, at)));
  if (at !== -1) console.log('  received: ' + msg.slice(at + ' Received '.length));
}
function t(label, f) {
  try {
    f();
    console.log(label + ' | NO THROW');
  } catch (e) {
    show(label, e);
  }
}
const pending = [];
function a(label, f) {
  pending.push([label, f]);
}

class Foo {}
function named() {}
const long = 'abcdefghijklmnopqrstuvwxyz0123456789';

// --- determineSpecificType, every branch, through Buffer.alloc's "size" ---
t('received string', () => Buffer.alloc('5'));
t('received string quote', () => Buffer.alloc("it's"));
t('received string 28', () => Buffer.alloc('a'.repeat(28)));
t('received string 29', () => Buffer.alloc('a'.repeat(29)));
t('received string long', () => Buffer.alloc(long));
t('received boolean', () => Buffer.alloc(true));
t('received bigint', () => Buffer.alloc(5n));
t('received symbol', () => Buffer.alloc(Symbol('s')));
t('received function', () => Buffer.alloc(named));
t('received anonymous fn', () => Buffer.alloc(() => {}));
t('received class', () => Buffer.alloc(Foo));
t('received instance', () => Buffer.alloc(new Foo()));
t('received array', () => Buffer.alloc([]));
t('received null', () => Buffer.alloc(null));
t('received undefined', () => Buffer.alloc(undefined));
t('received ctor-less', () => Buffer.alloc({ constructor: undefined }));
t('received -0', () => Buffer.from(-0));
t('received NaN', () => Buffer.from(NaN));

// --- the shape itself ---
try {
  Buffer.alloc('x');
} catch (e) {
  console.log(
    'shape node-error',
    e.name,
    e instanceof TypeError,
    e.constructor === TypeError,
    Object.keys(e).join(','),
    Object.prototype.hasOwnProperty.call(e, 'toString'),
    Object.getOwnPropertyDescriptor(e, 'message').enumerable,
  );
}
try {
  new URL('nope');
} catch (e) {
  console.log(
    'shape native-error',
    e.name,
    e instanceof TypeError,
    e.constructor === TypeError,
    Object.keys(e).join(','),
  );
}

// --- buffer ---
t('buf from num', () => Buffer.from(5));
t('buf readUInt8 str', () => Buffer.alloc(4).readUInt8('1'));
t('buf readUInt8 frac', () => Buffer.alloc(4).readUInt8(1.5));
t('buf readUInt8 oob', () => Buffer.alloc(4).readUInt8(9));
t('buf readUInt32 oob', () => Buffer.alloc(2).readUInt32LE(0));
t('buf writeUInt8 300', () => Buffer.alloc(4).writeUInt8(300));
t('buf writeUInt32 2^40', () => Buffer.alloc(4).writeUInt32LE(2 ** 40));
t('buf writeInt32 -2^40', () => Buffer.alloc(4).writeInt32LE(-(2 ** 40)));
t('buf writeIntLE 6', () => Buffer.alloc(8).writeIntLE(2 ** 50, 0, 6));
t('buf writeBigInt64', () => Buffer.alloc(8).writeBigInt64LE(2n ** 70n));
t('buf writeBigUInt64 -1n', () => Buffer.alloc(8).writeBigUInt64LE(-1n));
t('buf readIntLE bl', () => Buffer.alloc(8).readIntLE(0, 7));
t('buf toString enc', () => Buffer.from('a').toString('bogus'));
t('buf swap16', () => Buffer.alloc(3).swap16());
t('buf fill bad hex', () => Buffer.alloc(2).fill('zz', 'hex'));
t('buf concat', () => Buffer.concat(5));
t('buf concat el', () => Buffer.concat([5]));
t('buf byteLength', () => Buffer.byteLength(5));
t('buf compare', () => Buffer.compare(1, 2));
t('buf write num', () => Buffer.alloc(1).write(5));
t('buf atob', () => atob());
t('buf fill empty', () => Buffer.alloc(2).fill(Buffer.alloc(0)));
t('buf indexOf obj', () => Buffer.alloc(2).indexOf({}));
t('buf createObjectURL', () => URL.createObjectURL(5));
t('buf revokeObjectURL', () => URL.revokeObjectURL());

// --- encoding ---
t('td label', () => new TextDecoder('bogus'));
t('td opts', () => new TextDecoder('utf8', 5));
t('td decode', () => new TextDecoder().decode(5));
t('td fatal', () => new TextDecoder('utf8', { fatal: true }).decode(new Uint8Array([0xff])));
t('te encodeInto', () => new TextEncoder().encodeInto('a', 5));

// --- path ---
const path = require('path');
t('path join', () => path.join(1));
t('path basename', () => path.basename('a', 5));
t('path resolve obj', () => path.resolve({}));
t('path matchesGlob', () => path.matchesGlob(1, '*'));
t('path win32 join', () => path.win32.join(null));

// --- url ---
const url = require('url');
t('url invalid', () => new URL('nope'));
t('url invalid base', () => new URL('x', 'nope'));
t('url fileURLToPath num', () => url.fileURLToPath(5));
t('url fileURLToPath obj', () => url.fileURLToPath({}));
t('url fileURLToPath null', () => url.fileURLToPath(null));
t('url fileURLToPath scheme', () => url.fileURLToPath('http://x/'));
t('url fileURLToPath host', () => url.fileURLToPath('file://host/x'));
t('url href setter', () => {
  new URL('http://a/').href = 'nope';
});
t('url fileURLToPath %2F', () => url.fileURLToPath('file:///a%2Fb'));
t('url pathToFileURL', () => url.pathToFileURL(5));

// --- crypto ---
const crypto = require('crypto');
t('crypto randomBytes str', () => crypto.randomBytes('x'));
t('crypto randomBytes neg', () => crypto.randomBytes(-1));
t('crypto randomBytes 2^40', () => crypto.randomBytes(2 ** 40));
t('crypto randomFillSync off', () => crypto.randomFillSync(Buffer.alloc(4), 'x'));
t('crypto randomFillSync off oob', () => crypto.randomFillSync(Buffer.alloc(4), 9));
t('crypto randomFillSync size', () => crypto.randomFillSync(Buffer.alloc(4), 0, 9));
t('crypto randomFillSync buf', () => crypto.randomFillSync(5));
t('crypto timingSafeEqual len', () => crypto.timingSafeEqual(Buffer.alloc(1), Buffer.alloc(2)));
t('crypto timingSafeEqual type', () => crypto.timingSafeEqual(1, Buffer.alloc(2)));
t('crypto timingSafeEqual type b', () => crypto.timingSafeEqual(Buffer.alloc(1), 'x'));

// --- util (+ parse_env, parse_args, mime) ---
const util = require('util');
t('util styleText text', () => util.styleText('red', 1));
t('util styleText vs', () => util.styleText('red', 'x', { validateStream: 1 }));
t('util stripVT', () => util.stripVTControlCharacters(1));
a('util aborted signal', () => util.aborted(5, {}));
a('util aborted resource', () => util.aborted(new AbortController().signal, 5));
t('util parseEnv', () => util.parseEnv(5));
t('util parseEnv buf', () => util.parseEnv(Buffer.from('a')));
t('util parseArgs unknown', () => util.parseArgs({ args: ['--x'], options: {} }));
t('util parseArgs value', () =>
  util.parseArgs({ args: ['--x'], options: { x: { type: 'string' } } }),
);
t('util parseArgs positional', () => util.parseArgs({ args: ['p'], options: {} }));
t('util parseArgs options', () => util.parseArgs({ args: [], options: 5 }));
t('util MIMEType', () => new util.MIMEType('bad'));

// --- events ---
const events = require('events');
const { EventEmitter, once } = events;
t('events on emitter', () => events.on(5, 'x'));
t('events on signal', () => events.on(new EventEmitter(), 'x', { signal: 5 }));
t('events addAbortListener', () => events.addAbortListener(5, () => {}));
t('events addAbortListener fn', () => events.addAbortListener(new AbortController().signal, 5));
t('events setMaxListeners str', () => new EventEmitter().setMaxListeners('x'));
t('events setMaxListeners neg', () => new EventEmitter().setMaxListeners(-1));
t('events setMaxListeners obj', () => new EventEmitter().setMaxListeners({}));
a('events once emitter', () => once(5, 'x'));
a('events once options', () => once(new EventEmitter(), 'x', 5));
a('events once signal', () => once(new EventEmitter(), 'x', { signal: 5 }));
a('events once options long', () => once(new EventEmitter(), 'x', long));

// --- stream / string_decoder ---
const { Writable, pipeline, finished } = require('stream');
const sink = () => new Writable({ write: (c, e, cb) => cb() });
t('stream write null', () => sink().write(null));
t('stream write num', () => sink().write(5));
t('stream write enc', () => sink().write('a', 'bogus'));
t('stream pipeline cb', () => pipeline(5));
t('stream finished', () => finished(5, () => {}));
t('stream pipeline missing', () => pipeline(() => {}));
a(
  'stream write after end',
  () =>
    new Promise((resolve, reject) => {
      const w = sink();
      w.on('error', reject);
      w.end();
      w.write('x');
    }),
);
a(
  'stream already finished',
  () =>
    new Promise((resolve, reject) => {
      const w = sink();
      w.end(() => w.end((e) => (e ? reject(e) : resolve())));
    }),
);
t('string_decoder enc', () => new (require('string_decoder').StringDecoder)('bogus'));

(async () => {
  for (const [label, f] of pending) {
    try {
      await f();
      console.log(label + ' | NO THROW');
    } catch (e) {
      show(label, e);
    }
  }
})();
