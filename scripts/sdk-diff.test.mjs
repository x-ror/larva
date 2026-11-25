import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchesPin, parseOdinVersion, parsePin, sameCommit } from './lib/odin-pin.mjs';
import { buildIndex, diffIndex, packageOf, scanFile } from './lib/odin-sdk-index.mjs';
import { foreignHits, osCompatible, osOf, watchHits } from './sdk-diff.mjs';

const names = (src) => scanFile(src).decls.map((d) => d.name);
const decl = (src, name) => scanFile(src).decls.find((d) => d.name === name);

test('packageOf keeps public packages and drops private, test and example trees', () => {
  assert.equal(packageOf('core/crypto/sha2/sha2.odin'), 'core:crypto/sha2');
  assert.equal(packageOf('vendor/zlib/zlib.odin'), 'vendor:zlib');
  assert.equal(packageOf('core/crypto/_aes/ct64/api.odin'), null);
  assert.equal(packageOf('core/net/tests/x.odin'), null);
  assert.equal(packageOf('core/net/net_test.odin'), null);
  assert.equal(packageOf('core/net/README.md'), null);
  assert.equal(packageOf('examples/demo/demo.odin'), null);
});

test('a #+private file exports nothing', () => {
  assert.deepEqual(names('#+private\npackage p\nfoo :: proc() {}\n'), []);
  assert.deepEqual(names('#+private file\npackage p\nfoo :: proc() {}\n'), []);
});

test('@(private) hides the next declaration, on its own line or inline, and nothing after it', () => {
  const src = [
    'package p',
    '@(private)',
    'a :: proc() {}',
    '@(private="file") b :: 1',
    '@(link_prefix="x", private)',
    'c :: proc() {}',
    '@(require_results)',
    'd :: proc() -> int { return 1 }',
    'e :: 2',
  ].join('\n');
  assert.deepEqual(names(src), ['d', 'e']);
});

test('@(private) on a foreign block hides every binding in it', () => {
  const src = [
    'package p',
    '@(private)',
    'foreign lib {',
    '\tgetifaddrs :: proc(ifap: ^^ifaddrs) -> i32 ---',
    '}',
    '@(default_calling_convention="c")',
    'foreign lib {',
    '\tdeflate :: proc(s: ^Stream, flush: i32) -> i32 ---',
    '}',
  ].join('\n');
  assert.deepEqual(names(src), ['deflate']);
  assert.equal(decl(src, 'deflate').foreign, true);
});

test('declarations inside a top-level when block count; locals inside a proc body do not', () => {
  const src = [
    'package p',
    'when ODIN_OS == .Linux {',
    '\tonly_linux :: proc() {}',
    '}',
    'outer :: proc() {',
    '\tinner :: proc() {}',
    '\tLOCAL :: 3',
    '}',
  ].join('\n');
  assert.deepEqual(names(src), ['only_linux', 'outer']);
  assert.equal(decl(src, 'only_linux').foreign, false);
});

test('braces and parens inside string literals and comments do not move the scanner', () => {
  const src = [
    'package p',
    'a :: proc() { s := "}}}((" }',
    '/* { unclosed in a block',
    '   comment } { */',
    'b :: proc() {} // {',
    "c :: '{'",
    'd :: 1',
  ].join('\n');
  assert.deepEqual(names(src), ['a', 'b', 'c', 'd']);
});

test('a proc signature spans lines, keeps its calling convention, and drops inlining hints', () => {
  const src = [
    'package p',
    'f :: #force_inline proc "c" (',
    '\ta: int,',
    '\tb: string,',
    ') -> (ok: bool) {',
    '}',
  ].join('\n');
  assert.equal(decl(src, 'f').sig, 'proc "c" ( a: int, b: string, ) -> (ok: bool)');
  assert.equal(decl('package p\ng :: proc(x: int) -> int ---\n', 'g').sig, 'proc(x: int) -> int');
});

test('kinds: proc, group, type, const; _-prefixed names are not public', () => {
  const src = [
    'package p',
    'f :: proc() {}',
    'g :: proc{f, h}',
    'T :: struct { x: int }',
    'E :: enum u8 { A }',
    'D :: distinct int',
    'K :: 4',
    '_hidden :: proc() {}',
  ].join('\n');
  const kinds = Object.fromEntries(scanFile(src).decls.map((d) => [d.name, d.kind]));
  assert.deepEqual(kinds, { f: 'proc', g: 'group', T: 'type', E: 'type', D: 'type', K: 'const' });
});

test('buildIndex records OS targets from file names and #+build, empty when declared everywhere', () => {
  const idx = buildIndex([
    {
      path: 'core/x/a_linux.odin',
      text: 'package x\nonly_linux :: proc() {}\nboth :: proc() {}\n',
    },
    { path: 'core/x/a_windows.odin', text: 'package x\nboth :: proc() {}\n' },
    {
      path: 'core/x/tagged.odin',
      text: '#+build darwin, freebsd\npackage x\ntagged :: proc() {}\n',
    },
    {
      path: 'core/x/common.odin',
      text: 'package x\nanywhere :: proc() {}\nlinux_and_common :: proc() {}\n',
    },
    { path: 'core/x/b_linux.odin', text: 'package x\nlinux_and_common :: proc() {}\n' },
    { path: 'core/y/all_private.odin', text: '#+private\npackage y\nz :: 1\n' },
  ]);
  const x = idx.get('core:x');
  assert.deepEqual([...x.get('only_linux').targets], ['linux']);
  assert.deepEqual([...x.get('both').targets].sort(), ['linux', 'windows']);
  assert.deepEqual([...x.get('tagged').targets], ['darwin, freebsd']);
  assert.deepEqual([...x.get('anywhere').targets], []);
  assert.deepEqual(
    [...x.get('linux_and_common').targets],
    [],
    'one unconstrained file makes it available everywhere',
  );
  assert.equal(idx.has('core:y'), false, 'a package with no public symbol is not listed');
});

test('diffIndex reports added/removed packages and symbols and changed proc signatures', () => {
  const from = buildIndex([
    {
      path: 'core/a/a.odin',
      text: 'package a\nkeep :: proc(x: int) {}\ngone :: proc() {}\nsame :: proc() {}\n',
    },
    { path: 'core/old/o.odin', text: 'package old\no :: proc() {}\n' },
  ]);
  const to = buildIndex([
    {
      path: 'core/a/a.odin',
      text: 'package a\nkeep :: proc(x: int) -> bool {}\nfresh :: proc() {}\nsame :: #force_no_inline proc() {}\n',
    },
    { path: 'core/new/n.odin', text: 'package new\nn :: proc() {}\n' },
  ]);
  const d = diffIndex(from, to);
  assert.deepEqual(d.addedPackages, ['core:new']);
  assert.deepEqual(d.removedPackages, ['core:old']);
  assert.deepEqual(d.added.get('core:a'), ['fresh']);
  assert.deepEqual(d.removed.get('core:a'), ['gone']);
  assert.deepEqual(d.removed.get('core:old'), ['o']);
  assert.deepEqual(d.changed.get('core:a'), [
    { name: 'keep', from: 'proc(x: int)', to: 'proc(x: int) -> bool' },
  ]);
});

test('osCompatible keeps a lead unless the SDK symbol provably excludes the file OS', () => {
  assert.equal(osOf('pkg/runtime/os_windows.odin'), 'windows');
  assert.equal(osOf('pkg/runtime/net.odin'), null);
  assert.equal(osCompatible('windows', new Set(['linux, darwin, netbsd'])), false);
  assert.equal(osCompatible('windows', new Set(['posix'])), false);
  assert.equal(osCompatible('linux', new Set(['posix'])), true);
  assert.equal(osCompatible('linux', new Set(['!windows'])), true);
  assert.equal(osCompatible('windows', new Set(['!windows'])), false);
  assert.equal(osCompatible('windows', new Set(['windows amd64'])), true);
  assert.equal(osCompatible('posix', new Set(['darwin'])), true);
  assert.equal(osCompatible('windows', new Set()), true);
  assert.equal(osCompatible(null, new Set(['linux'])), true);
});

test('foreignHits finds hand-declared bindings the SDK exports for that OS, new ones first', () => {
  const from = buildIndex([
    { path: 'core/sys/windows/k.odin', text: 'package windows\nOld :: proc() ---\n' },
  ]);
  const to = buildIndex([
    {
      path: 'core/sys/windows/k.odin',
      text: 'package windows\nOld :: proc() ---\nNew :: proc() ---\n',
    },
    {
      path: 'core/sys/posix/p.odin',
      text: '#+build linux, darwin\npackage posix\ninet_ntop :: proc() ---\n',
    },
  ]);
  const foreign = new Map([
    ['Old', ['pkg/runtime/os_windows.odin']],
    ['New', ['pkg/runtime/os_windows.odin']],
    ['inet_ntop', ['pkg/runtime/os_windows.odin']],
    ['Absent', ['pkg/x.odin']],
  ]);
  const hits = foreignHits(foreign, to, diffIndex(from, to));
  assert.deepEqual(
    hits.map((h) => [h.name, h.isNew]),
    [
      ['New', true],
      ['Old', false],
    ],
  );
});

test('watchHits matches new packages and new non-constant symbols only', () => {
  const from = buildIndex([
    { path: 'core/compress/deflate/d.odin', text: 'package deflate\nx :: proc() {}\n' },
  ]);
  const to = buildIndex([
    {
      path: 'core/compress/deflate/d.odin',
      text: 'package deflate\nx :: proc() {}\ninflate_stream :: proc() {}\nINFLATE_CHUNK :: 4\n',
    },
    { path: 'core/crypto/tls/t.odin', text: 'package tls\nclient_handshake :: proc() {}\n' },
  ]);
  const watch = {
    entries: [
      { ours: 'tls', match: ['^core:crypto/tls'], why: '' },
      { ours: 'zlib', match: ['^core:compress/deflate\\..*inflate'], why: '' },
      { ours: 'none', match: ['^core:nothing'], why: '' },
    ],
  };
  const hits = watchHits(watch, diffIndex(from, to), to);
  assert.deepEqual(
    hits.map((h) => [h.entry.ours, h.hits]),
    [
      ['tls', ['core:crypto/tls']],
      ['zlib', ['core:compress/deflate.inflate_stream']],
    ],
  );
});

test('parsePin requires a full SHA and a numeric llvm; parseOdinVersion reads the hash', () => {
  const sha = 'a'.repeat(40);
  assert.deepEqual(parsePin(`# c\ncommit=${sha}\nrelease=\nllvm=18 # x\n`), {
    commit: sha,
    release: '',
    llvm: '18',
  });
  assert.throws(() => parsePin('commit=abc1234\nllvm=18\n'), /40-hex/);
  assert.throws(() => parsePin(`commit=${sha}\nllvm=x\n`), /llvm/);
  assert.throws(() => parsePin(`commit=${sha}\nllvm=18\nbranch=master\n`), /unknown key/);
  assert.deepEqual(parseOdinVersion('odin version dev-2026-11:6a275d863\n'), {
    tag: 'dev-2026-11',
    commit: '6a275d863',
  });
  assert.deepEqual(parseOdinVersion('odin version dev-2026-11a\n'), {
    tag: 'dev-2026-11a',
    commit: null,
  });
  assert.equal(sameCommit('6a275d863', '6a275d863' + '0'.repeat(31)), true);
  assert.equal(
    sameCommit('6a27', '6a27' + '0'.repeat(36)),
    false,
    'a 4-char prefix is too short to trust',
  );
  assert.equal(sameCommit(null, sha), false);
});

test('matchesPin: a git build by commit, a hashless release only by the pinned release tag', () => {
  const pin = { commit: '9a6991685' + '0'.repeat(31), release: 'dev-2026-11a', llvm: '18' };
  assert.equal(matchesPin({ tag: 'dev-2026-11', commit: '9a6991685' }, pin), true);
  assert.equal(
    matchesPin({ tag: 'dev-2026-11a', commit: '6a275d863' }, pin),
    false,
    'the commit wins over the tag',
  );
  assert.equal(matchesPin({ tag: 'dev-2026-11a', commit: null }, pin), true);
  assert.equal(matchesPin({ tag: 'dev-2026-10', commit: null }, pin), false);
  assert.equal(matchesPin({ tag: 'dev-2026-11a', commit: null }, { ...pin, release: '' }), false);
});
