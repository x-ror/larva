// Tests for the DOM oracle suite (scripts/lib/dom-oracle.mjs, scripts/run-dom-oracle.mjs):
// the views' format and the split of a recording into them, the Chrome-side walker
// and serializer over a stand-in DOM, the harness page, and the runner's verdicts end
// to end. A gate script: each rule here is one a broken runner would turn into a
// silent pass. The verdict rules themselves are web-oracle.mjs `judge`, tested in
// scripts/run-web-oracle.test.mjs; these pin what the DOM suite adds on top. Needs no
// bin/lava and no Chrome — the CLI tests hand the runner a stand-in binary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import {
  areaOf,
  domPage,
  dumpTree,
  fragmentContext,
  inputProblem,
  joinViews,
  lavaArgs,
  navCharset,
  navContentType,
  serializeDocument,
  splitViews,
} from './lib/dom-oracle.mjs';
import { ROOT, formatExpected, formatSnapshot, readSink } from './lib/web-oracle.mjs';

// --- the recording's views -----------------------------------------------------------

test('a recording splits back into the views it was joined from', () => {
  const views = { tree: '| <html>\n|   "#serialize"\n', serialize: '<html></html>\n' };
  assert.deepEqual(splitViews(joinViews(views)), views);
  // An opener inside a line is data, not a view boundary.
  assert.deepEqual(splitViews('#tree\n| "x #serialize\n"\n#serialize\ny'), {
    tree: '| "x #serialize\n"\n',
    serialize: 'y',
  });
});

test('a recording whose views cannot be told apart is refused, not guessed', () => {
  // A text node whose data holds "\n#serialize\n" puts the opener at a line start twice.
  assert.throws(() => splitViews('#tree\n| "a\n#serialize\n"\n#serialize\nb\n'), /2 lines/);
  assert.throws(() => splitViews('#tree\n| <html>\n'), /'#serialize' opens 0 lines/);
  assert.throws(() => splitViews('#serialize\nb\n#tree\n'), /starts with '#tree'|out of order/);
  assert.throws(() => splitViews('x\n#tree\n#serialize\n'), /starts with '#tree'/);
});

test('a fragment case names its context element; a document case has none', () => {
  assert.equal(fragmentContext('frag-cell.frag-tr'), 'tr');
  assert.equal(fragmentContext('void-elements'), null);
  assert.equal(fragmentContext('a.frag-'), null);
  // A foreign context comes back in html5lib's notation, a dash in its name kept.
  assert.equal(fragmentContext('m.frag-math-annotation-xml'), 'math annotation-xml');
  assert.equal(fragmentContext('s.frag-svg-foreignObject'), 'svg foreignObject');
  assert.equal(fragmentContext('h.frag-Div'), null);
  assert.equal(areaOf('frag-cell.frag-tr'), 'frag');
  assert.equal(areaOf('void-elements'), 'void');
  assert.deepEqual(lavaArgs('tree', null, 'f.html'), ['html', '--tree', 'f.html']);
  assert.deepEqual(lavaArgs('serialize', 'tr', 'f.html'), [
    'html',
    '--serialize',
    '--fragment',
    'tr',
    'f.html',
  ]);
});

test('a navigation case names its transport charset and runs lava with sniffing', () => {
  assert.equal(navCharset('charset-default.nav'), '');
  assert.equal(navCharset('charset-transport.nav-windows-1252'), 'windows-1252');
  assert.equal(navCharset('site-jp-portal.nav-shift_jis'), 'shift_jis');
  // Only as the name's last part: a DOMParser case keeps its UTF-8 input.
  assert.equal(navCharset('void-elements'), null);
  assert.equal(navCharset('a.nav.frag-div'), null);
  assert.equal(navContentType(''), 'text/html');
  assert.equal(navContentType('euc-kr'), 'text/html; charset=euc-kr');
  assert.deepEqual(lavaArgs('tree', null, 'f.html', ''), ['html', '--tree', '--sniff', 'f.html']);
  assert.deepEqual(lavaArgs('serialize', null, 'f.html', 'euc-kr'), [
    'html',
    '--serialize',
    '--charset',
    'euc-kr',
    'f.html',
  ]);
});

test('an input Chrome and lava would read differently is refused', () => {
  assert.equal(inputProblem(Buffer.from('<p>café</p>')), null);
  assert.match(inputProblem(Buffer.from([0xef, 0xbb, 0xbf, 0x3c])), /BOM/);
  assert.match(inputProblem(Buffer.from([0x3c, 0xff, 0x3e])), /not valid UTF-8/);
});

// --- the Chrome side, over a stand-in DOM ---------------------------------------------

const HTML = 'http://www.w3.org/1999/xhtml';
const SVG = 'http://www.w3.org/2000/svg';
const XLINK = 'http://www.w3.org/1999/xlink';

const text = (data) => ({ nodeType: 3, data });
const comment = (data) => ({ nodeType: 8, data });
const pi = (target, data) => ({ nodeType: 7, target, data });
const doctype = (name, publicId = '', systemId = '') => ({
  nodeType: 10,
  name,
  publicId,
  systemId,
});
function el(localName, attrs = [], children = [], ns = HTML) {
  return {
    nodeType: 1,
    namespaceURI: ns,
    localName,
    attributes: attrs.map(([name, value, ans = null]) => ({
      localName: name,
      value,
      namespaceURI: ans,
    })),
    childNodes: children,
    outerHTML: `<${localName}>`,
  };
}

test('dumpTree prints the html5lib format, attributes in element order', () => {
  const tree = [
    doctype('html'),
    comment(' c '),
    el(
      'html',
      [],
      [
        el(
          'body',
          [
            ['z', '1'],
            ['a', '"2"'],
          ],
          [
            text('t'),
            el(
              'svg',
              [
                ['href', '#a', XLINK],
                ['viewBox', '0'],
              ],
              [el('foreignObject', [], [], SVG)],
              SVG,
            ),
          ],
        ),
      ],
    ),
  ];
  assert.equal(
    dumpTree(tree),
    [
      '| <!DOCTYPE html>',
      '| <!--  c  -->',
      '| <html>',
      '|   <body>',
      '|     z="1"',
      '|     a=""2""',
      '|     "t"',
      '|     <svg svg>',
      '|       xlink href="#a"',
      '|       viewBox="0"',
      '|       <svg foreignObject>',
      '',
    ].join('\n'),
  );
});

test("dumpTree prints a template's content under it and a doctype's ids when it has any", () => {
  const tpl = el('template', [], []);
  tpl.content = { childNodes: [el('p', [], [text('in')])] };
  assert.equal(
    dumpTree([doctype('html', 'pub', ''), tpl]),
    '| <!DOCTYPE html "pub" "">\n| <template>\n|   content\n|     <p>\n|       "in"\n',
  );
});

test('dumpTree refuses what an HTML parser does not produce', () => {
  assert.throws(() => dumpTree([el('x', [], [], 'urn:other')]), /namespace urn:other/);
  assert.throws(() => dumpTree([{ nodeType: 4, data: 'x' }]), /node type 4/);
});

// Chrome 158 parses `<?php echo 1 ?>` in a body as a processing instruction (target
// `php`, data `echo 1 `), where older parsers made a bogus comment of it.
test("dumpTree prints a processing instruction in html5lib's form", () => {
  assert.equal(dumpTree([pi('php', 'echo 1 '), pi('x', '')]), '| <?php echo 1 >\n| <?x >\n');
});

test('serializeDocument is the doctype, the comments and the elements, then a newline', () => {
  const doc = {
    childNodes: [doctype('html', 'pub', 'sys'), comment('x'), el('html'), pi('y', 'z')],
  };
  assert.equal(serializeDocument(doc), '<!DOCTYPE html><!--x--><html><?y z?>\n');
});

// The harness page, run for real: its inline script executes in a vm against a
// stand-in DOMParser, then #out is read back through readSink the way the recorder
// reads --dump-dom. Pins that the page decodes the input as UTF-8, uses the fragment
// path for a fragment case, and joins the views in the form splitViews reads.
function runPage(input, context) {
  const html = domPage('x', Buffer.from(input), context);
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  const sinks = { out: '', err: '' };
  const seen = {};
  class DOMParser {
    parseFromString(s) {
      seen.parsed = s;
      return {
        childNodes: [doctype('html'), el('html', [], [text(s)])],
        createElementNS(ns, name) {
          seen.contextNS = [ns, name];
          return this.createElement(name, true);
        },
        createElement(name, foreign = false) {
          if (!foreign) seen.context = name;
          const node = el(name);
          Object.defineProperty(node, 'innerHTML', {
            set(v) {
              seen.inner = v;
              node.childNodes = [text(v)];
            },
            get: () => `[${seen.inner}]`,
          });
          return node;
        },
      };
    }
  }
  const ctx = {
    DOMParser,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    atob,
    btoa,
    String,
    document: {
      getElementById: (id) => ({
        set textContent(v) {
          sinks[id] = v;
        },
      }),
    },
  };
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  const dom = `<pre id="out">${sinks.out}</pre><pre id="err">${sinks.err}</pre>`;
  return { out: readSink(dom, 'out'), err: readSink(dom, 'err'), seen };
}

test('the harness page parses the input as a document and joins the views', () => {
  const r = runPage('café', null);
  assert.equal(r.err, '');
  assert.equal(r.seen.parsed, 'café');
  assert.deepEqual(splitViews(r.out), {
    tree: '| <!DOCTYPE html>\n| <html>\n|   "café"\n',
    serialize: '<!DOCTYPE html><html>\n',
  });
});

test('the harness page parses a fragment case as its context element innerHTML', () => {
  const r = runPage('<td>a', 'tr');
  assert.equal(r.err, '');
  assert.equal(r.seen.context, 'tr');
  // The context element lives in a no-quirks document.
  assert.equal(r.seen.parsed, '<!DOCTYPE html>');
  assert.deepEqual(splitViews(r.out), { tree: '| "<td>a"\n', serialize: '[<td>a]\n' });
});

test('the harness page makes a foreign context element in its namespace', () => {
  const r = runPage('<p>', 'svg foreignObject');
  assert.equal(r.err, '');
  assert.deepEqual(r.seen.contextNS, ['http://www.w3.org/2000/svg', 'foreignObject']);
  assert.equal(r.seen.context, undefined);
});

// --- the runner, through the CLI ------------------------------------------------------

const FLOOR = JSON.parse(readFileSync(join(ROOT, 'runtime/gates/case-counts.json'), 'utf8')).suites[
  'tests/dom/cases'
].min;
const META = { chrome: 'Google Chrome 0', date: 'd', runs: 3, command: 'c' };

// A stand-in lava: prints the view's flag, and the context after it for a fragment,
// so a recording of `--tree\n` / `--serialize\n` is what a correct run produces.
const FAKE_LAVA =
  '#!/bin/sh\nif [ "$3" = "--fragment" ]; then printf \'%s %s\\n\' "$2" "$4"; else printf \'%s\\n\' "$2"; fi\n';

const RIGHT = joinViews({ tree: '--tree\n', serialize: '--serialize\n' });

// A throwaway suite of `count` document cases recorded as RIGHT; `extra(dir)` edits it.
function runSuite(count, extra, argv = []) {
  const dir = mkdtempSync(join(tmpdir(), 'dom-oracle-suite-'));
  try {
    const cases = join(dir, 'cases');
    mkdirSync(cases);
    mkdirSync(join(dir, 'known'));
    writeFileSync(join(dir, 'known-gaps.txt'), '# none\n');
    for (let i = 0; i < count; i++) {
      writeFileSync(join(cases, `t-${i}.html`), '<p>x');
      writeFileSync(join(cases, `t-${i}.expected`), formatExpected(META, RIGHT));
    }
    if (extra) extra(dir);
    const fake = join(dir, 'lava');
    writeFileSync(fake, FAKE_LAVA);
    chmodSync(fake, 0o755);
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts/run-dom-oracle.mjs'), ...argv], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, LAVA_BIN: fake, DOM_ORACLE_SUITE: dir },
      timeout: 60_000,
    });
    r.dir = dir;
    r.pins = (name) => readFileSync(join(dir, 'known', name), 'utf8');
    return r;
  } finally {
    if (!argv.includes('--update-known')) rmSync(dir, { recursive: true, force: true });
  }
}

const recordAs = (dir, name, views) =>
  writeFileSync(join(dir, 'cases', `${name}.expected`), formatExpected(META, joinViews(views)));

test('a clean throwaway suite at the floor passes, two views per case', () => {
  const r = runSuite(FLOOR);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`${FLOOR * 2} pass, 0 known, 0 fail`));
});

test('a view that differs from its recording fails alone, naming the view', () => {
  const r = runSuite(FLOOR, (dir) =>
    recordAs(dir, 't-0', { tree: '--tree\n', serialize: 'chrome\n' }),
  );
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /FAIL t-0\.serialize\n/);
  assert.doesNotMatch(r.stdout, /t-0\.tree/);
  assert.match(r.stdout, new RegExp(`${FLOOR * 2 - 1} pass, 0 known, 1 fail`));
});

test('a fragment case runs lava with --fragment and its context', () => {
  const r = runSuite(FLOOR, (dir) => {
    writeFileSync(join(dir, 'cases', 'f.frag-tr.html'), '<td>');
    recordAs(dir, 'f.frag-tr', { tree: '--tree tr\n', serialize: '--serialize tr\n' });
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`${FLOOR * 2 + 2} pass`));
});

test('a case with no recording fails both views and names the recorder', () => {
  const r = runSuite(FLOOR, (dir) => writeFileSync(join(dir, 'cases', 'new.html'), '<p>'));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(
    r.stdout,
    /FAIL new\.tree\n {4}no Chrome recording; run: node scripts\/record-dom\.mjs new\n/,
  );
  assert.match(r.stdout, /FAIL new\.serialize/);
});

test('a recording that does not split into its views fails both views', () => {
  const r = runSuite(FLOOR, (dir) =>
    writeFileSync(join(dir, 'cases', 't-0.expected'), formatExpected(META, '#tree\n--tree\n')),
  );
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /FAIL t-0\.tree\n {4}t-0\.expected: '#serialize' opens 0 lines/);
  assert.match(r.stdout, /FAIL t-0\.serialize/);
});

// One view listed and pinned: it holds as known while the case's other view is still
// held to Chrome.
function knownTreeGap(dir, pinned = '--tree\n') {
  recordAs(dir, 't-0', { tree: 'chrome\n', serialize: '--serialize\n' });
  writeFileSync(join(dir, 'known-gaps.txt'), 't-0.tree 3b: the dump differs\n');
  writeFileSync(join(dir, 'known', 't-0.tree.lava'), formatSnapshot({ code: 0, stdout: pinned }));
}

test('a known gap names one view and holds while that view prints its pin', () => {
  const r = runSuite(FLOOR, (dir) => knownTreeGap(dir));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /KNOWN t-0\.tree/);
  assert.match(r.stdout, new RegExp(`${FLOOR * 2 - 1} pass, 1 known, 0 fail`));
});

test('a known gap whose view drifts from its pin fails', () => {
  const r = runSuite(FLOOR, (dir) => knownTreeGap(dir, 'older lava\n'));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /FAIL t-0\.tree\n {4}known gap \(3b\) drifted/);
});

test('a known gap that matches Chrome fails until its entry is removed', () => {
  const r = runSuite(FLOOR, (dir) => {
    knownTreeGap(dir);
    recordAs(dir, 't-0', { tree: '--tree\n', serialize: '--serialize\n' });
  });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /remove the entry and tests\/dom\/known\/t-0\.tree\.lava/);
});

test('a known gap with a stage outside the DOM plan is refused', () => {
  const r = runSuite(FLOOR, (dir) =>
    writeFileSync(join(dir, 'known-gaps.txt'), 't-0.tree S4a: a Window-suite stage\n'),
  );
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /stage 'S4a' is not one of 3b/);
});

test('orphans fail: a gap for a view that does not exist, a recording or pin with no case', () => {
  const r = runSuite(FLOOR, (dir) => {
    writeFileSync(join(dir, 'known-gaps.txt'), 't-0.layout 3b: no such view\n');
    writeFileSync(join(dir, 'cases', 'gone.expected'), '');
    writeFileSync(join(dir, 'known', 'zzz.tree.lava'), '# exit 0\n');
  });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /FAIL known-gaps\.txt lists t-0\.layout, which has no case/);
  assert.match(r.stdout, /FAIL tests\/dom\/cases\/gone\.expected has no case/);
  assert.match(r.stdout, /FAIL tests\/dom\/known\/zzz\.tree\.lava has no known-gaps\.txt entry/);
});

test('a suite below the case-count floor fails before running anything', () => {
  const r = runSuite(FLOOR - 1);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /case-count/);
  assert.doesNotMatch(r.stdout, /pass, 0 known/);
});

// Generated cases do not make up for deleted hand-written ones: they are held to their
// .dat inputs by the generator's own test, not by this floor.
test('generated cases do not count toward the floor', () => {
  const r = runSuite(FLOOR - 1, (dir) => {
    for (const n of ['html5lib-x-001', 'html5lib-x-002']) {
      writeFileSync(join(dir, 'cases', `${n}.html`), '<p>x');
      writeFileSync(join(dir, 'cases', `${n}.expected`), formatExpected(META, RIGHT));
    }
  });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /case-count: .* has \d+ hand-written cases/);
});

test('--update-known pins only the listed view of a case', () => {
  const r = runSuite(FLOOR, (dir) => knownTreeGap(dir, 'stale\n'), ['--update-known', 't-0']);
  try {
    assert.match(r.stdout, /pinned t-0\.tree \(exit 0\)/);
    assert.doesNotMatch(r.stdout, /pinned t-0\.serialize/);
    assert.equal(r.pins('t-0.tree.lava'), '# exit 0\n--tree\n');
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test('--update-known refuses a case with no listed view', () => {
  const r = runSuite(FLOOR, undefined, ['--update-known', 't-0']);
  try {
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /t-0 has no view in known-gaps\.txt/);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});
