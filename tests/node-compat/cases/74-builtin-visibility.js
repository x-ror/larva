// Builtin visibility: the embedded JS tree decides what the public resolver answers.
// Modules under pkg/runtime/js/node are requireable; pkg/runtime/js/internal is not, and
// neither is a module's internal id spelled directly (`node/buffer`, `internal/fetch`).
//
// Only the error CODE is printed for the bare spellings and only "threw" for `node:`
// ones: the messages diverge from node (#415 — lava has no "Require stack", and answers
// MODULE_NOT_FOUND where node answers ERR_UNKNOWN_BUILTIN_MODULE for `node:` names).
// Bare `sqlite` is left out on purpose: lava resolves it and node does not (#416).

const hidden = [
  'primordials',
  'fetch',
  'abort',
  'encoding',
  'structured_clone',
  'stdio',
  'mime',
  'parse_args',
  'parse_env',
  'internal/primordials',
  'internal/fetch',
  'internal/abort',
  'internal/encoding',
  'internal/structured_clone',
  'internal/stdio',
  'internal/mime',
  'internal/parse_args',
  'internal/parse_env',
  'node/buffer',
  'node/stream/web',
  'constructor',
  '__proto__',
];

for (const name of hidden) {
  try {
    require(name);
    console.log('bare', name, 'RESOLVED');
  } catch (e) {
    console.log('bare', name, e.code);
  }
  let threw = false;
  try {
    require('node:' + name);
  } catch {
    threw = true;
  }
  console.log('node:' + name, threw ? 'threw' : 'RESOLVED');
}

const visible = [
  'assert',
  'assert/strict',
  'node:assert/strict',
  'buffer',
  'node:buffer',
  'console',
  'node:console',
  'crypto',
  'diagnostics_channel',
  'events',
  'path',
  'path/posix',
  'node:path/win32',
  'process',
  'node:process',
  'querystring',
  'stream',
  'stream/promises',
  'stream/web',
  'node:stream/web',
  'string_decoder',
  'timers',
  'timers/promises',
  'url',
  'util',
  'util/types',
];
for (const name of visible) console.log(name, typeof require(name));

// Frames inside builtin code carry a `node:` source name on both runtimes (node:
// `node:internal/url`, lava: `node:url`); only the presence is compared, the frame
// syntax differs (`at fn (file:N:N)` vs `fn@file:N:N`).
const throwers = [
  ['new URL', () => new URL('x')],
  ['Buffer.alloc', () => Buffer.alloc(-1)],
  ['path.join', () => require('path').join(1)],
  ['new TextDecoder', () => new TextDecoder('nope')],
];
for (const [label, fn] of throwers) {
  try {
    fn();
    console.log(label, 'NO THROW');
  } catch (e) {
    console.log(label, 'stack has node:', String(e.stack).includes('node:'));
  }
}
