// require() resolution fidelity (issue #93): bare builtins, directory vs sibling
// shadowing, MODULE_NOT_FOUND on unresolved paths, prototype-key specifiers,
// absolute cache-key normalization, and .json parsed as JSON (not evaluated).
const assert = require('node:assert/strict');
const path = require('node:path');

// Bare builtin specifier resolves the same as the node: form.
const util = require('util');
assert.equal(typeof util.format, 'function');
assert.equal(require('util'), require('node:util'));

// A directory must not shadow a sibling <name>.js during resolution.
assert.equal(require('../fixtures/resolve/pkgdir'), 'SIBLING_WINS');

// Unresolved specifiers throw MODULE_NOT_FOUND, never return undefined.
assert.throws(() => require('../fixtures/resolve/does-not-exist'), /Cannot find module/);

// Object.prototype keys are not builtins.
assert.throws(() => require('constructor'), /Cannot find module/);
assert.throws(() => require('toString'), /Cannot find module/);

// .json is parsed as JSON, returning data — not evaluated as code.
const data = require('../fixtures/resolve/valid.json');
assert.deepEqual(data, { name: 'valid', nums: [1, 2, 3] });

// A .json file that is not valid JSON (here, JS source) throws a SyntaxError
// instead of executing.
let jsonErr;
try {
  require('../fixtures/resolve/code.json');
} catch (e) {
  jsonErr = e;
}
assert.ok(jsonErr, 'expected invalid .json to throw');
assert.equal(jsonErr.name, 'SyntaxError');

// Absolute specifiers with redundant separators collapse to one cache entry, so
// the module's exports are identical (loaded once).
const abs = path.join(__dirname, '..', 'fixtures', 'resolve', 'valid.json');
const messy = abs.replace(
  path.sep + 'fixtures' + path.sep,
  path.sep + 'fixtures' + path.sep + '.' + path.sep,
);
assert.equal(require(abs), require(messy));

console.log('ok');
