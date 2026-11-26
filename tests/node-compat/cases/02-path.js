const assert = require('node:assert/strict');
const path = require('node:path');

// node:fs went with the Node profile; this case keeps the node:path half of the old
// 02-fs-path.js.
const fixturePath = path.join(__dirname, '..', 'fixtures', 'hello.txt');

assert.equal(path.extname(fixturePath), '.txt');
assert.equal(path.isAbsolute(fixturePath), true);

// --- expanded node:path surface ---
// The default path module delegates to the platform flavor: POSIX on
// Linux/macOS and win32 on Windows (whose behavior is covered by the
// path.win32.* assertions below). Assert the platform separators here; the
// concrete POSIX path vectors run on POSIX.
const isWin = process.platform === 'win32';
if (isWin) {
  assert.equal(path.sep, '\\');
  assert.equal(path.delimiter, ';');
} else {
  assert.equal(path.sep, '/');
  assert.equal(path.delimiter, ':');

  // dirname / basename / extname
  assert.equal(path.dirname('/a/b/c.js'), '/a/b');
  assert.equal(path.dirname('/a/b/'), '/a');
  assert.equal(path.dirname('foo'), '.');
  assert.equal(path.dirname('/'), '/');
  assert.equal(path.basename('/a/b/c.js'), 'c.js');
  assert.equal(path.basename('/a/b/c.js', '.js'), 'c');
  assert.equal(path.basename('/a/b/'), 'b');
  assert.equal(path.extname('index.html'), '.html');
  assert.equal(path.extname('a.b.c'), '.c');
  assert.equal(path.extname('.gitignore'), '');
  assert.equal(path.extname('noext'), '');

  // normalize
  assert.equal(path.normalize('/foo/bar//baz/asdf/quux/..'), '/foo/bar/baz/asdf');
  assert.equal(path.normalize('a/b/../c'), 'a/c');
  assert.equal(path.normalize('a/../../b'), '../b');
  assert.equal(path.normalize('foo/bar/'), 'foo/bar/');
  assert.equal(path.normalize(''), '.');

  // join
  assert.equal(path.join('a', 'b', 'c'), 'a/b/c');
  assert.equal(path.join('/a', 'b', '..', 'c'), '/a/c');
  assert.equal(path.join('a', '', 'b'), 'a/b');
  assert.equal(path.join(), '.');

  // resolve (anchored to an absolute first arg so it is cwd-independent)
  assert.equal(path.resolve('/foo/bar', './baz'), '/foo/bar/baz');
  assert.equal(path.resolve('/foo/bar', '../baz'), '/foo/baz');
  assert.equal(path.resolve('/a', '/b', 'c'), '/b/c');
  // a relative resolve is rooted at cwd; assert its shape, not the absolute prefix
  const rel = path.resolve('x', 'y');
  assert.equal(path.isAbsolute(rel), true);
  assert.equal(rel.endsWith('/x/y'), true);

  // relative
  assert.equal(path.relative('/a/b/c', '/a/b/d'), '../d');
  assert.equal(path.relative('/a/b', '/a/b/c/d'), 'c/d');
  assert.equal(path.relative('/a/b/c/d', '/a/b'), '../..');
  assert.equal(path.relative('/a/b', '/a/b'), '');

  // parse / format round-trip
  const parsed = path.parse('/home/user/file.txt');
  assert.deepEqual(parsed, {
    root: '/',
    dir: '/home/user',
    base: 'file.txt',
    ext: '.txt',
    name: 'file',
  });
  assert.equal(path.format(parsed), '/home/user/file.txt');
  assert.equal(path.format({ dir: '/a', base: 'b.js' }), '/a/b.js');
}

// posix and win32 are always reachable as sub-namespaces
assert.equal(path.posix.join('a', 'b'), 'a/b');
assert.equal(path.posix.sep, '/');
assert.equal(path.win32.join('C:\\', 'a', 'b'), 'C:\\a\\b');
assert.equal(path.win32.normalize('C:\\a\\..\\b'), 'C:\\b');
assert.equal(path.win32.dirname('C:\\a\\b.txt'), 'C:\\a');
assert.equal(path.win32.basename('C:\\a\\b.txt'), 'b.txt');
assert.equal(path.win32.isAbsolute('C:\\a'), true);
assert.equal(path.win32.relative('C:\\a\\b', 'C:\\a\\c'), '..\\c');
assert.equal(path.win32.relative('C:\\', 'C:\\foo'), 'foo');
assert.equal(path.win32.relative('C:\\foo', 'C:\\'), '..');
assert.equal(path.win32.relative('\\\\srv\\s1\\a', '\\\\srv\\s2\\b'), '..\\..\\s2\\b');
assert.equal(path.win32.relative('\\\\server\\share\\', '\\\\server\\share\\foo'), 'foo');
assert.equal(path.win32.relative('\\\\server\\share\\foo', '\\\\server\\share\\'), '..');
assert.equal(path.win32.basename('C:.js', 'C:.js'), '');
assert.throws(
  () => path.win32.relative('C:\\', 1),
  (e) => e.code === 'ERR_INVALID_ARG_TYPE',
);
assert.throws(
  () => path.win32.basename('x', 1),
  (e) => e.code === 'ERR_INVALID_ARG_TYPE',
);
assert.equal(path.win32.sep, '\\');
assert.equal(path.posix.win32, path.win32);
assert.equal(path.win32.posix, path.posix);
