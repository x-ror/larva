// node:util is assembled from internal modules laid out like node's lib/internal/util:
// js/internal/util/{inspect,comparisons,debuglog}.js and js/internal/util.js hold the
// implementation and node/util stays the public entry. A throw from inside inspect or
// isDeepStrictEqual used to carry only `node:util` frames, because everything was
// defined in util.js; now it names its file, exactly as node's does.
//
// Each frame line prints `ok` when the stack carries `node:<file>:` and names the first
// `node:` frame it got otherwise. Only the source name is compared, never the message,
// line or column. callbackify, inherits, styleText and toUSVString stay in node/util on
// both runtimes (lib/util.js on node), so their lines check `node:util:` instead.
// deprecate is not probed: a throw through its wrapper carries no `node:` frame on
// Lava. Every site throws synchronously on both runtimes (probed on node 26.13.0).
//
// The new ids must stay internal: neither the bare nor the `node:` spelling may resolve
// from user code. Only the error CODE of the bare spelling is printed (the messages
// diverge, #415).
//
// The export lines check identities that cross the new file seams (util.debug is
// util.debuglog; styleText reads the very table util.inspect.colors exposes; util.types
// is node:util/types). Export ORDER is not oracle-able — node's key list is a different
// set in a different order — so the split was checked against the previous binary
// instead (the PR records the diff). `aborted` is an accessor on node and a data
// property on Lava, a pre-existing gap the split does not touch, so only its type is
// printed.
'use strict';

const util = require('util');

for (const id of [
  'internal/util',
  'internal/util/inspect',
  'internal/util/comparisons',
  'internal/util/debuglog',
  'util/inspect',
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
  const where = stack.includes('node:' + file + ':')
    ? 'ok'
    : 'got ' + (stack.match(/node:[\w/]+/) || ['no node: frame'])[0];
  console.log(label + ': ' + file + ' ' + where);
}

const throwingHook = {
  [util.inspect.custom]() {
    throw new Error('hook');
  },
};
const throwingGetter = {};
Object.defineProperty(throwingGetter, 'a', {
  enumerable: true,
  get() {
    throw new Error('getter');
  },
});
frame('inspect hook', 'internal/util/inspect', () => util.inspect(throwingHook));
frame('format %o hook', 'internal/util/inspect', () => util.format('%o', throwingHook));
frame('stripVTControlCharacters str', 'internal/util/inspect', () =>
  util.stripVTControlCharacters(5),
);
frame('isDeepStrictEqual getter', 'internal/util/comparisons', () =>
  util.isDeepStrictEqual(throwingGetter, { a: 1 }),
);
frame(
  'debuglog section',
  'internal/util/debuglog',
  () =>
    util.debuglog({
      toString() {
        throw new Error('section');
      },
    }).enabled,
);
frame('promisify original', 'internal/util', () => util.promisify(5));
frame('callbackify original', 'util', () => util.callbackify(5));
frame('inherits ctor', 'util', () => util.inherits(5, 6));
frame('styleText format', 'util', () => util.styleText('bogus', 'x'));
frame('toUSVString symbol', 'util', () => util.toUSVString(Symbol('s')));

// --- the assembled exports: shapes and identities ----------------------------------
console.log('same module', require('node:util') === util);
const SHARED = [
  'inspect',
  'format',
  'formatWithOptions',
  'promisify',
  'callbackify',
  'inherits',
  'deprecate',
  'isDeepStrictEqual',
  'debuglog',
  'debug',
  'parseArgs',
  'parseEnv',
  'MIMEType',
  'MIMEParams',
  'styleText',
  'stripVTControlCharacters',
  'toUSVString',
  'types',
];
for (const k of SHARED) {
  const d = Object.getOwnPropertyDescriptor(util, k);
  console.log('export', k, typeof util[k], 'value' in d ? 'data' : 'accessor', d.enumerable);
}
console.log('export aborted', typeof util.aborted);
util.inspect.colors.lavaSplitStyle = [1, 22];
console.log(
  'identities',
  util.debug === util.debuglog,
  util.types === require('util/types'),
  util.inspect.custom === Symbol.for('nodejs.util.inspect.custom'),
  util.promisify.custom === Symbol.for('nodejs.util.promisify.custom'),
  JSON.stringify(util.styleText('lavaSplitStyle', 'x', { validateStream: false })),
);

// --- behavior across the file seams -------------------------------------------------
console.log(util.format('%s:%d:%j %O', 'a', 42, { b: 1 }, [1]), util.inspect("it's"));
console.log(
  util.formatWithOptions({}, '%s', 'w'),
  util.stripVTControlCharacters('\x1b[1mx\x1b[22m'),
);
console.log(
  'deep',
  util.isDeepStrictEqual({ a: [1, new Map([[1, 2]])] }, { a: [1, new Map([[1, 2]])] }),
  util.isDeepStrictEqual(0, -0),
);
console.log('debuglog', util.debuglog('lava_split_unset').enabled);

const EventEmitter = require('events');
function Legacy() {
  EventEmitter.call(this);
}
util.inherits(Legacy, EventEmitter);
const legacy = new Legacy();
legacy.on('ping', (v) => console.log('inherits', v, Legacy.super_ === EventEmitter));
legacy.emit('ping', legacy instanceof EventEmitter);

const promised = util.promisify((v, cb) => cb(null, v + 1));
const callbacked = util.callbackify(async (v) => v * 2);
promised(1).then((v) => {
  console.log('promisify', v);
  callbacked(4, (err, r) => console.log('callbackify', err, r));
});
