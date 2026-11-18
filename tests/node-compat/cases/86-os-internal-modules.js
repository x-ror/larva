// node:os is assembled from two files: js/internal/os/constants.js holds the signal,
// errno, priority and dlopen tables (node reads them from its C++ constants binding,
// internalBinding('constants').os, not from lib/os.js), and node/os keeps every
// function. The tables are pure data — nothing in them throws — so no stack frame moves
// and this case has no frame lines.
//
// The new id must stay internal: neither the bare nor the `node:` spelling may resolve
// from user code. Only the error CODE of the bare spelling is printed (the messages
// diverge, #415).
//
// The export lines check what crosses the new seam: os's key SET (sorted — the two
// runtimes list them in a different order, a pre-existing gap), os.constants' top-level
// tables and their types, that it is one object across requires, and values that agree
// on every platform. Full table listings are left out: signals carries an extra SIGEMT
// on darwin here, and node's src/node_constants.cc adds RTLD_DEEPBIND to dlopen where
// glibc defines it, which this table does not — both pre-existing, outside the split.
//
// There is no line that is red against the pre-split binary: the split is meant to be
// invisible, and the id was unresolvable before it as well. What this case pins is that
// the assembled module still answers the same — tests/mutation-manifest.json kills it by
// dropping a table from the moved file.
'use strict';

const os = require('os');

for (const id of ['internal/os/constants', 'internal/os', 'os/constants']) {
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

console.log('same module', require('node:os') === os);
console.log('keys', Object.keys(os).sort().join(','));

const c = os.constants;
console.log('constants identity', c === require('node:os').constants, c === os.constants);
for (const k of Object.keys(c).sort()) {
  console.log('constants', k, typeof c[k]);
}
console.log(
  'values',
  c.UV_UDP_REUSEADDR,
  c.signals.SIGINT,
  c.signals.SIGKILL,
  c.signals.SIGTERM,
  c.errno.EPERM,
  c.errno.ENOENT,
  c.errno.EACCES,
  c.dlopen.RTLD_LAZY,
  c.dlopen.RTLD_NOW,
);
console.log(
  'priority',
  Object.keys(c.priority)
    .sort()
    .map((k) => k + '=' + c.priority[k])
    .join(','),
);
