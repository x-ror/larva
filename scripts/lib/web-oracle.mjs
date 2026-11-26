// The Window-profile oracle suite (tests/web), shared by its recorder
// (scripts/record-chrome.mjs) and its runner (scripts/run-web-oracle.mjs).
//
// A case is a classic script that reports through ONE global, `print(value)`, which
// writes `String(value)` and a newline. Chrome is the oracle (CLAUDE.md §1, §6): the
// recorder runs the case in headless Chrome and keeps what `print` wrote, with the
// Chrome version and the command beside it; the runner runs the same bytes under
// `lava run --surface=web` and compares stdout byte for byte. Node never produces an
// expectation here.
//
// Everything a recording and a run must agree on lives in this file, so the two
// sides cannot drift: the print shim's semantics, the fixture server both point the
// case at, the `.expected` header, and the verdict rules (`judge`).

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// WEB_ORACLE_SUITE points the recorder and runner at another suite directory with the
// same layout; scripts/run-web-oracle.test.mjs uses it to drive the runner's
// whole-suite rules over a throwaway suite. Nothing else sets it.
export const SUITE_DIR = process.env.WEB_ORACLE_SUITE
  ? resolve(process.env.WEB_ORACLE_SUITE)
  : join(ROOT, 'tests/web');
export const CASES_DIR = join(SUITE_DIR, 'cases');
export const KNOWN_FILE = join(SUITE_DIR, 'known-gaps.txt');
export const KNOWN_DIR = join(SUITE_DIR, 'known');

// The line that ends a recording's header. Everything after it is Chrome's output,
// byte for byte, including a missing final newline.
export const HEADER_END = '# ---\n';

// The stages of the Node-profile removal a known gap may wait on (tests/web/README.md
// says what each one changes). An entry naming anything else is malformed: "fixed
// later" without a stage is how a gap list turns into a skip list.
export const STAGES = ['S2', 'S4a', 'S4b', 'S4c', 'S4d', 'S4e', 'S5b', 'unplanned'];

/**
 * The case-count floor for the suite (runtime/gates/case-counts.json): a deleted
 * case must not turn the suite green by vanishing. Applied to whichever suite the
 * runner was pointed at, so the floor itself is testable. `key` names another
 * suite's entry (scripts/lib/dom-oracle.mjs passes 'tests/dom/cases').
 */
export function caseFloor(key = 'tests/web/cases') {
  const counts = JSON.parse(readFileSync(join(ROOT, 'runtime/gates/case-counts.json'), 'utf8'));
  return counts.suites[key].min;
}

/** Case names (file name without `.js`), sorted, so runs and reports are stable. */
export function listCases(dir = CASES_DIR) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => f.slice(0, -3))
    .sort();
}

/** The area a case reports under: its name up to the first '-'. */
export function areaOf(name) {
  const i = name.indexOf('-');
  return i < 0 ? name : name.slice(0, i);
}

/**
 * Serializes a recording. `meta` carries what makes it re-checkable: the Chrome
 * version, the date, the command that re-records it, and how many runs agreed.
 */
export function formatExpected(meta, output) {
  return (
    '# Recorded from Chrome; Node is never the expectation here (CLAUDE.md §6).\n' +
    `# chrome: ${meta.chrome}\n` +
    `# date: ${meta.date}\n` +
    `# runs: ${meta.runs} identical\n` +
    `# command: ${meta.command}\n` +
    HEADER_END +
    output
  );
}

/**
 * Splits a recording into its header fields and Chrome's output. Throws on a file
 * with no header end or no `chrome:` line: a hand-written expectation must not
 * pass for a recording.
 */
export function parseExpected(text) {
  const end = text.indexOf(HEADER_END);
  if (end < 0) throw new Error(`no '${HEADER_END.trim()}' header end`);
  const header = {};
  for (const line of text.slice(0, end).split('\n')) {
    const m = /^# (\w+): (.*)$/.exec(line);
    if (m) header[m[1]] = m[2];
  }
  if (!header.chrome) throw new Error('header names no chrome version');
  return { header, output: text.slice(end + HEADER_END.length) };
}

/**
 * Parses known-gaps.txt: `<case> <stage>: <reason>` per line, `#` comments. Every
 * entry needs a stage from `stages` (STAGES unless another suite passes its own) and
 * a reason; a malformed or duplicate line throws, so a gap cannot be listed without
 * saying why and when it closes.
 */
export function parseKnown(text, stages = STAGES) {
  const known = new Map();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = /^(\S+)\s+(\S+):\s*(.*)$/.exec(line);
    if (!m) throw new Error(`known-gaps.txt:${i + 1}: want '<case> <stage>: <reason>'`);
    const [, name, stage, reason] = m;
    if (!stages.includes(stage)) {
      throw new Error(`known-gaps.txt:${i + 1}: stage '${stage}' is not one of ${stages}`);
    }
    if (reason.trim() === '') throw new Error(`known-gaps.txt:${i + 1}: ${name} has no reason`);
    if (known.has(name)) throw new Error(`known-gaps.txt:${i + 1}: ${name} listed twice`);
    known.set(name, { stage, reason });
  }
  return known;
}

/**
 * What is wrong with the suite as a whole rather than with one run: a gap entry for
 * a case that does not exist, a recording or a pinned gap with no case or no entry.
 * Each is a failure — an orphan is a case somebody deleted while its expectation
 * stayed behind, or a gap whose entry was dropped while its pin still excuses it.
 *
 * `units` are what a gap entry may name: the cases themselves here, `<case>.<view>`
 * in the DOM suite, which judges each case's views apart. `label` is the suite's
 * path in the messages.
 */
export function suiteProblems(
  cases,
  known,
  casesDir = CASES_DIR,
  knownDir = KNOWN_DIR,
  { units = cases, label = 'tests/web' } = {},
) {
  const out = [];
  const have = new Set(cases);
  const listable = new Set(units);
  for (const name of known.keys()) {
    if (!listable.has(name)) out.push(`known-gaps.txt lists ${name}, which has no case`);
  }
  for (const f of filesWith(casesDir, '.expected')) {
    if (!have.has(f)) out.push(`${label}/cases/${f}.expected has no case`);
  }
  for (const f of filesWith(knownDir, '.lava')) {
    if (!known.has(f)) out.push(`${label}/known/${f}.lava has no known-gaps.txt entry`);
  }
  return out;
}

function filesWith(dir, ext) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(ext))
    .map((f) => f.slice(0, -ext.length));
}

/**
 * A known gap's pinned Lava output: `# exit <code>` then stdout. The runner holds a
 * gap to this, so a known case that changes its output — for better or worse — is
 * a failure to look at, not a silent "still known".
 */
export function formatSnapshot(result) {
  return `# exit ${result.code}\n${result.stdout}`;
}

export function parseSnapshot(text) {
  const m = /^# exit (-?\d+|null)\n/.exec(text);
  if (!m) throw new Error("no '# exit <code>' line");
  return { code: m[1] === 'null' ? null : Number(m[1]), stdout: text.slice(m[0].length) };
}

// Where judge's details send the reader: the recorder, the pins, the re-pin command.
// The DOM suite passes its own (scripts/lib/dom-oracle.mjs).
export const WEB_SUITE = {
  record: 'node scripts/record-chrome.mjs',
  known: 'tests/web/known',
  update: 'node scripts/run-web-oracle.mjs --update-known',
};

/**
 * The verdict for one case.
 *
 * @param {object} c
 * @param {string} c.name
 * @param {string|null} c.expected  Chrome's output, or null when there is no recording.
 * @param {{stdout: string, stderr: string, code: number|null}} c.actual  Lava's run.
 * @param {{stage: string, reason: string}|undefined} c.known  Its known-gaps entry.
 * @param {string|null} c.snapshot  The known gap's pinned Lava output file, or null.
 * @param {typeof WEB_SUITE} [c.suite]  Paths and commands named in the details.
 * @returns {{verdict: 'pass'|'known'|'fail', detail: string}}
 *
 * A pass needs Chrome's bytes AND exit 0: a case that printed everything and then
 * threw has not matched a browser, where the throw would be a page error. A missing
 * recording fails rather than skips. A known gap that now matches Chrome fails too,
 * so its entry is removed in the change that closes it.
 */
export function judge({ name, expected, actual, known, snapshot, suite = WEB_SUITE }) {
  if (expected === null) {
    return {
      verdict: 'fail',
      detail: `no Chrome recording; run: ${suite.record} ${name}`,
    };
  }
  const matches = actual.stdout === expected && actual.code === 0;
  if (matches) {
    if (known) {
      return {
        verdict: 'fail',
        detail: `matches Chrome but is listed in known-gaps.txt (${known.stage}); remove the entry and ${suite.known}/${name}.lava`,
      };
    }
    return { verdict: 'pass', detail: '' };
  }
  if (!known) return { verdict: 'fail', detail: describeMismatch(expected, actual) };
  if (snapshot === null) {
    return {
      verdict: 'fail',
      detail: `known gap has no ${suite.known}/${name}.lava; run: ${suite.update} ${name}`,
    };
  }
  let pinned;
  try {
    pinned = parseSnapshot(snapshot);
  } catch (e) {
    return { verdict: 'fail', detail: `${suite.known}/${name}.lava: ${e.message}` };
  }
  if (actual.stdout === pinned.stdout && actual.code === pinned.code) {
    return { verdict: 'known', detail: `${known.stage}: ${known.reason}` };
  }
  return {
    verdict: 'fail',
    detail:
      `known gap (${known.stage}) drifted from its pinned Lava output; if intended, ` +
      `run --update-known ${name}\n` +
      describeMismatch(pinned.stdout, actual, pinned.code),
  };
}

// The first differing line with a little context, plus the exit code and stderr: a
// whole-output dump buries the one line that matters.
function describeMismatch(want, actual, wantCode = 0) {
  const a = want.split('\n');
  const b = actual.stdout.split('\n');
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const out = [];
  if (actual.code !== wantCode) out.push(`exit code ${actual.code} (want ${wantCode})`);
  if (i < a.length || i < b.length) {
    out.push(`first difference at line ${i + 1}:`);
    out.push(`  want: ${i < a.length ? JSON.stringify(a[i]) : '<end of output>'}`);
    out.push(`  got:  ${i < b.length ? JSON.stringify(b[i]) : '<end of output>'}`);
  }
  if (actual.stderr) out.push('stderr:\n' + actual.stderr.trimEnd().replace(/^/gm, '  '));
  return out.join('\n');
}

// --- the print shim, one per host --------------------------------------------------
//
// Both shims capture what they call BEFORE the case runs, because several cases
// replace globals and prototype methods on purpose; a shim reading `String` or
// `console.log` live would report the case's poison, not its result.

/**
 * Lava's prelude: one line with no trailing newline, prepended to the case's first
 * line so line numbers in a stack match Chrome's. The console's own writer prints a
 * single string argument verbatim (no format directives), which
 * tests/web/cases/harness-print.js pins against Chrome.
 */
export function lavaPrelude(origin) {
  return (
    'var print = ((log, S) => function print(v) { log(S(v)); })(console.log, String); ' +
    `var ORIGIN = ${JSON.stringify(origin)}; `
  );
}

/**
 * A case's recording options, from a `// web-oracle: real-time <ms>` line among its
 * leading comments. Chrome's virtual time freezes the clock while a task runs —
 * measured: a `while (performance.now() < end)` spin inside a timer callback never
 * ends under --virtual-time-budget, and the same spin in the top-level script does —
 * so a case that spins on the clock runs in real time instead, for `<ms>` of wall
 * clock (see chromePage). Lava runs every case the same way; this only changes how
 * Chrome is driven.
 */
export function caseOptions(source) {
  const m = /^\/\/ web-oracle: real-time (\d+)$/m.exec(source);
  return { realTimeMs: m ? Number(m[1]) : 0 };
}

/**
 * The page Chrome loads for a case: the shim, then the case as its own classic
 * script, served unmodified so its line numbers are its own. Output goes into
 * #out as one base64 line per print (UTF-8), so the DOM serializer has nothing to
 * escape and the recorder decodes it exactly; page errors and unhandled rejections
 * go to #err the same way, and the recorder refuses to record a case that has any.
 */
export function chromePage(name, { realTimeMs = 0 } = {}) {
  return `<!doctype html><meta charset="utf-8"><title>${name}</title>
<pre id="out"></pre><pre id="err"></pre>
<script>
(() => {
  const RA = Reflect.apply, S = String, fcc = String.fromCharCode, b64 = btoa;
  const encode = TextEncoder.prototype.encode, enc = new TextEncoder();
  const lenOf = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'length').get;
  const appendData = CharacterData.prototype.appendData;
  const sink = (id) => document.getElementById(id).appendChild(document.createTextNode(''));
  const out = sink('out'), err = sink('err');
  const emit = (node, s) => {
    const bytes = RA(encode, enc, [s]);
    const n = RA(lenOf, bytes, []);
    let bin = '';
    for (let i = 0; i < n; i++) bin += fcc(bytes[i]);
    RA(appendData, node, [b64(bin) + '\\n']);
  };
  window.print = function print(v) { emit(out, S(v) + '\\n'); };
  window.ORIGIN = location.origin;
  addEventListener('error', (e) => emit(err, 'error: ' + S(e.message) + '\\n'));
  addEventListener('unhandledrejection', (e) => emit(err, 'unhandled rejection: ' + S(e.reason) + '\\n'));
})();
</script>
<script src="/case/${name}.js"></script>
${
  // A real-time case keeps the load event, which is when --dump-dom reads the DOM
  // without virtual time, waiting on an image the server holds for realTimeMs.
  realTimeMs ? `<img src="/hold/${realTimeMs}" alt="">` : ''
}
`;
}

/**
 * What the recorder may write for a case, from its Chrome runs (`{out, err}` each,
 * the decoded #out and #err sinks). An output is kept only if every run printed it
 * and no run raised a page error or an unhandled rejection: a page that throws after
 * its last print is not a clean oracle, and a case that prints differently run to
 * run is flaky, not recorded.
 * @returns {{output: string} | {error: string}}
 */
export function recordVerdict(runs) {
  if (runs.length === 0) return { error: 'no run to record' };
  for (let r = 0; r < runs.length; r++) {
    if (runs[r].out === null) return { error: 'no #out in the dumped DOM (did the page load?)' };
    if (runs[r].err) return { error: `page error in run ${r + 1}:\n${runs[r].err}` };
  }
  for (let r = 1; r < runs.length; r++) {
    if (runs[r].out !== runs[0].out) return { error: `run ${r + 1} differs from run 1 (flaky)` };
  }
  return { output: runs[0].out };
}

/** Decodes one of chromePage's base64 sinks out of a --dump-dom serialization. */
export function readSink(dom, id) {
  const open = `<pre id="${id}">`;
  const start = dom.indexOf(open);
  if (start < 0) return null;
  const end = dom.indexOf('</pre>', start);
  return Buffer.concat(
    dom
      .slice(start + open.length, end)
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => Buffer.from(l, 'base64')),
  ).toString('utf8');
}

// --- driving Chrome -----------------------------------------------------------------
//
// Shared by both recorders (scripts/record-chrome.mjs, scripts/record-dom.mjs): one
// headless Chrome per run, each in a fresh profile, the page's DOM read back through
// --dump-dom once it has loaded.

/** `chrome --version`'s line, the header's `chrome:` field; throws when it cannot run. */
export function chromeVersion(chrome) {
  const version = spawnSync(chrome, ['--version'], { encoding: 'utf8' });
  if (version.status !== 0)
    throw new Error(`cannot run ${chrome} --version (set CHROME_BIN or --chrome)`);
  return version.stdout.trim();
}

// The wall-clock guard is for a Chrome that hangs; a page's own timing is bounded by
// the virtual-time budget the caller passes, if any.
const WALL_TIMEOUT_MS = 120_000;

/**
 * Loads `url` in a headless Chrome with a fresh profile and resolves with the DOM it
 * dumps. `args` go before --dump-dom (record-chrome.mjs passes its virtual-time
 * budget there).
 */
export async function dumpDom(chrome, url, args = []) {
  const profile = mkdtempSync(join(tmpdir(), 'larva-web-oracle-'));
  try {
    return await new Promise((resolveRun, rejectRun) => {
      const child = spawn(
        chrome,
        [
          '--headless=new',
          '--no-sandbox',
          '--disable-gpu',
          '--no-first-run',
          '--disable-extensions',
          `--user-data-dir=${profile}`,
          ...args,
          '--dump-dom',
          url,
        ],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      );
      let dom = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d) => (dom += d));
      const timer = setTimeout(() => child.kill('SIGKILL'), WALL_TIMEOUT_MS);
      child.on('error', rejectRun);
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) return rejectRun(new Error(`chrome exited ${code ?? 'on a signal'}`));
        resolveRun(dom);
      });
    });
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}

/**
 * Runs `url` `runs` times and judges the runs with recordVerdict: each run's #out and
 * #err sinks, decoded by readSink.
 * @returns {Promise<{output: string} | {error: string}>}
 */
export async function recordRuns(chrome, url, runs, args = []) {
  const results = [];
  for (let r = 0; r < runs; r++) {
    let dom;
    try {
      dom = await dumpDom(chrome, url, args);
    } catch (e) {
      return { error: `run ${r + 1}: ${e.message}` };
    }
    results.push({ out: readSink(dom, 'out'), err: readSink(dom, 'err') });
  }
  return recordVerdict(results);
}

// --- the fixture server -------------------------------------------------------------
//
// One server for both sides. Chrome loads the page and the case from it, so every
// fixture is same-origin there; Lava gets its address as ORIGIN. Cases print paths
// relative to ORIGIN, never the port.

const FIXTURES = {
  '/fx/text': (req, res) => send(res, 200, 'text/plain; charset=utf-8', 'hello from the fixture'),
  '/fx/utf8': (req, res) => send(res, 200, 'text/plain; charset=utf-8', 'héllo café ☕ 日本語'),
  '/fx/json': (req, res) =>
    send(res, 200, 'application/json', JSON.stringify({ ok: true, list: [1, 2, 3] })),
  '/fx/bytes': (req, res) =>
    send(res, 200, 'application/octet-stream', Buffer.from([0, 1, 2, 0xfe, 0xff])),
  '/fx/missing': (req, res) => send(res, 404, 'text/plain', 'not here'),
  '/fx/redirect': (req, res) => {
    res.writeHead(302, { Location: '/fx/text', 'Content-Length': '0' });
    res.end();
  },
  '/fx/headers': (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/plain',
      'X-Fixture': 'one',
      'Content-Length': '2',
    });
    res.end('ok');
  },
  '/fx/echo': (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const seen = {
        method: req.method,
        contentType: req.headers['content-type'] || null,
        xTest: req.headers['x-test'] || null,
        body,
      };
      send(res, 200, 'application/json', JSON.stringify(seen));
    });
  },
};

function send(res, status, type, body) {
  const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': String(bytes.length) });
  res.end(bytes);
}

/**
 * Starts the fixture server on an ephemeral 127.0.0.1 port (a secure context to
 * Chrome, which crypto.subtle and randomUUID need). Serves `/page/<case>` and
 * `/case/<case>.js` for the recorder and `/fx/*` for both.
 *
 * `pageFor(name)`, when given, answers `/page/<name>` instead (null for no such
 * case): the DOM suite's harness page (scripts/lib/dom-oracle.mjs) is built from an
 * HTML case, not a script.
 */
export function startServer(casesDir = CASES_DIR, { pageFor } = {}) {
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    const page = /^\/page\/([\w.-]+)$/.exec(path);
    const script = /^\/case\/([\w.-]+)\.js$/.exec(path);
    if (page && pageFor) {
      const html = pageFor(page[1]);
      if (html !== null) return send(res, 200, 'text/html; charset=utf-8', html);
    } else if (page && existsSync(join(casesDir, page[1] + '.js'))) {
      const source = readFileSync(join(casesDir, page[1] + '.js'), 'utf8');
      return send(res, 200, 'text/html; charset=utf-8', chromePage(page[1], caseOptions(source)));
    }
    if (script && existsSync(join(casesDir, script[1] + '.js'))) {
      const source = readFileSync(join(casesDir, script[1] + '.js'));
      return send(res, 200, 'text/javascript; charset=utf-8', source);
    }
    const hold = /^\/hold\/(\d+)$/.exec(path);
    if (hold) return void setTimeout(() => send(res, 204, 'image/gif', ''), Number(hold[1]));
    if (Object.hasOwn(FIXTURES, path)) return FIXTURES[path](req, res);
    if (path === '/favicon.ico') return send(res, 204, 'text/plain', '');
    send(res, 404, 'text/plain', 'no such fixture');
  });
  return new Promise((resolveStart) => {
    server.listen(0, '127.0.0.1', () => {
      const origin = `http://127.0.0.1:${server.address().port}`;
      resolveStart({ origin, close: () => new Promise((r) => server.close(r)) });
    });
  });
}
