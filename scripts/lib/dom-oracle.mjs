// The DOM oracle suite (tests/dom), shared by its recorder (scripts/record-dom.mjs)
// and its runner (scripts/run-dom-oracle.mjs).
//
// A case is an HTML input, `cases/<name>.html`. Chrome is the oracle (CLAUDE.md §1,
// §6; docs/LARVA.md decision 1): the recorder parses the input in headless Chrome and
// keeps two views of the result, the runner produces the same two views with
// `lava html` and compares each byte for byte:
//
//   tree       an html5lib-format dump of the parsed tree (dumpTree below)
//   serialize  the HTML serialization (serializeDocument below)
//
// Chrome parses through `new DOMParser().parseFromString(input, 'text/html')` run by
// a trusted harness page: a DOMParser document has scripting disabled, so `<noscript>`
// parses as markup, as in `lava html`, whose lexbor tree also has scripting off. The
// harness itself runs script; nothing in the case does. A case named
// `<topic>.frag-<context>.html` is a fragment instead: the input is set as the
// innerHTML of a `<context>` element (an SVG or MathML one for `frag-svg-<local>` and
// `frag-math-<local>`) created in a no-quirks DOMParser document
// (`<!DOCTYPE html>`, so the context's quirks mode does not differ from lexbor's
// fresh document), and the views are of that element's children.
//
// The recording format, the known-gap rules, the server and Chrome's driving are the
// Window suite's (scripts/lib/web-oracle.mjs), imported, not copied; this file holds
// only what differs: the harness page, the two views and the suite's paths.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { ROOT } from './web-oracle.mjs';

// DOM_ORACLE_SUITE points the recorder and runner at another suite directory with the
// same layout; scripts/run-dom-oracle.test.mjs drives the runner's whole-suite rules
// over a throwaway suite with it. Nothing else sets it.
export const SUITE_DIR = process.env.DOM_ORACLE_SUITE
  ? resolve(process.env.DOM_ORACLE_SUITE)
  : join(ROOT, 'tests/dom');
export const CASES_DIR = join(SUITE_DIR, 'cases');
export const KNOWN_FILE = join(SUITE_DIR, 'known-gaps.txt');
export const KNOWN_DIR = join(SUITE_DIR, 'known');

// The case-counts.json entry holding this suite's floor. It counts the hand-written
// cases only: the generated ones (GENERATED_PREFIX) are held to exactly what the
// vendored html5lib inputs generate by scripts/gen-html5lib-cases.test.mjs, and those
// inputs to their own floor ('tests/dom/html5lib'), which is the stronger guard for
// them — and a runner test suite at a floor of ~1800 cases would spawn ~3700 stand-in
// runs per test.
export const FLOOR_KEY = 'tests/dom/cases';

// The name prefix of the cases scripts/gen-html5lib-cases.mjs generates.
export const GENERATED_PREFIX = 'html5lib-';

/** The cases written by hand: every case but the generated ones. */
export function handCases(cases) {
  return cases.filter((c) => !c.startsWith(GENERATED_PREFIX));
}

// The stages of the DOM plan (docs/LARVA.md roadmap stage 3) a known gap may wait
// on; tests/dom/README.md says what each one changes. `unplanned` is a gap no stage
// closes — a lexbor parser divergence, typically — and needs an issue of its own.
export const STAGES = ['3b', '3c', '3d', '3e', '3f', '3g', '3h', '4b', 'unplanned'];

// What judge's details name for this suite (web-oracle.mjs WEB_SUITE is the shape).
export const DOM_SUITE = {
  record: 'node scripts/record-dom.mjs',
  known: 'tests/dom/known',
  update: 'node scripts/run-dom-oracle.mjs --update-known',
};

// The views, in the order a recording holds them. A known gap names one view of one
// case, `<case>.<view>`, so a serializer gap does not excuse the tree, or the reverse.
export const VIEWS = ['tree', 'serialize'];

/** Case names (file name without `.html`), sorted, so runs and reports are stable. */
export function listCases(dir = CASES_DIR) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.html'))
    .map((f) => f.slice(0, -5))
    .sort();
}

/** Every `<case>.<view>` a known gap may name. */
export function unitsOf(cases) {
  return cases.flatMap((c) => VIEWS.map((v) => `${c}.${v}`));
}

/**
 * The context element of a fragment case, from its name: `<topic>.frag-<context>`
 * (`cell.frag-tr` parses as `tr.innerHTML`). A foreign context is named
 * `frag-svg-<local>` or `frag-math-<local>` and answered in html5lib's notation,
 * `svg desc`, `math annotation-xml`. null for a document case.
 */
export function fragmentContext(name) {
  const m = /\.frag-(?:(svg|math)-([A-Za-z][A-Za-z0-9-]*)|([a-z][a-z0-9]*))$/.exec(name);
  if (!m) return null;
  return m[3] ?? `${m[1]} ${m[2]}`;
}

/**
 * The transport charset of a navigation case, from its name: `<topic>.nav` is served
 * as `text/html` and answers '', `<topic>.nav-<label>` as `text/html; charset=<label>`
 * and answers the label. null for a DOMParser case.
 *
 * A navigation case is charset sniffing's (stage 3c): its bytes may be in any encoding,
 * so Chrome cannot be handed them as a string. navPage loads them into a frame instead,
 * and `lava html` runs with --sniff or --charset <label> (lavaArgs).
 */
export function navCharset(name) {
  const m = /\.nav(?:-([A-Za-z0-9_-]+))?$/.exec(name);
  if (!m) return null;
  return m[1] ?? '';
}

/** The Content-Type a navigation case is served with (navCharset's charset). */
export function navContentType(charset) {
  return charset === '' ? 'text/html' : `text/html; charset=${charset}`;
}

/** The area a case reports under: its name up to the first '-' or '.'. */
export function areaOf(name) {
  const m = /^[^.-]+/.exec(name);
  return m ? m[0] : name;
}

/**
 * Why a case's input cannot be recorded, or null. Chrome is handed the input as a
 * string, `lava html` as bytes; the two agree only for UTF-8 without a BOM, which
 * TextDecoder would strip before the parser saw it. Charset handling is stage 3c's,
 * recorded through navigation, not DOMParser.
 */
export function inputProblem(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return 'starts with a UTF-8 BOM (charset cases are stage 3c)';
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return 'is not valid UTF-8 (charset cases are stage 3c)';
  }
  return null;
}

// The line that opens each view in a recording. A view never contains its own
// opener at a line start except by an input crafted to, and splitViews refuses that
// rather than guess.
const OPENER = (view) => `#${view}\n`;

/** The recorded form of the views: `#tree\n<dump>#serialize\n<markup>`. */
export function joinViews(views) {
  return VIEWS.map((v) => OPENER(v) + views[v]).join('');
}

/**
 * Splits a recording's output back into its views. Throws when the openers are not
 * each found exactly once at a line start, in order: an ambiguous split could hand
 * one view's bytes to the other.
 */
export function splitViews(text) {
  const at = [];
  for (const v of VIEWS) {
    const opener = OPENER(v);
    const hits = [];
    for (let i = text.indexOf(opener); i >= 0; i = text.indexOf(opener, i + 1)) {
      if (i === 0 || text[i - 1] === '\n') hits.push(i);
    }
    if (hits.length !== 1) throw new Error(`'#${v}' opens ${hits.length} lines, want exactly 1`);
    at.push(hits[0]);
  }
  if (at[0] !== 0) throw new Error(`a recording starts with '#${VIEWS[0]}'`);
  const views = {};
  for (let k = 0; k < VIEWS.length; k++) {
    if (k > 0 && at[k] < at[k - 1]) throw new Error('views out of order');
    const start = at[k] + OPENER(VIEWS[k]).length;
    views[VIEWS[k]] = text.slice(start, k + 1 < VIEWS.length ? at[k + 1] : text.length);
  }
  return views;
}

/**
 * Whether a case is a scripted page case (stage 4a): `<topic>.page`. Its HTML is loaded
 * as a page with scripting on, in Chrome and under `lava page`, and the views are of the
 * document once its scripts have run (scriptedPage).
 */
export function isPageCase(name) {
  return /\.page$/.test(name);
}

// How a page case is served to Chrome's frame: as UTF-8 (`lava page` reads UTF-8), and
// under a CSP that lets its inline scripts and its same-origin external scripts run
// while still keeping every subresource on the machine.
export const PAGE_CONTENT_TYPE = 'text/html; charset=utf-8';
export const PAGE_CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'";

// How a page case's external script is served (pageScript): a sibling file of the case,
// as `lava page` reads it from beside the page it runs.
export const PAGE_SCRIPT_TYPE = 'text/javascript; charset=utf-8';

/**
 * The bytes of a page case's external script (stage 4b): `<script src="x.js">` in the
 * case resolves against the frame's URL, `/raw/<case>`, to `/raw/x.js`, and is served
 * from `tests/dom/cases/x.js` — the same sibling file `lava page` resolves the `src`
 * to against the case's path. Only a `.js` file in the cases directory itself is
 * served; any other name is null (a 404, which the case sees as the script's `error`).
 */
export function pageScript(name, dir = CASES_DIR) {
  if (!/^[\w.-]+\.js$/.test(name)) return null;
  const file = join(dir, name);
  return existsSync(file) ? readFileSync(file) : null;
}

/**
 * The URL `lava page` gives a page case (--origin): the one Chrome's frame has,
 * `/raw/<case>` on the recorder's 127.0.0.1 server, so location, document.cookie's
 * default path and its host match the recording. The port is the server's ephemeral one
 * in Chrome and left out here: no case prints it, and a page case fetches nothing.
 */
export function pageURL(file) {
  return `http://127.0.0.1/raw/${basename(file, '.html')}`;
}

/**
 * `lava html`'s arguments for one view of one case — `lava page`'s for a page case;
 * `charset` is navCharset's.
 */
export function lavaArgs(view, context, file, charset = null, page = false) {
  if (page) return ['page', `--${view}`, `--origin=${pageURL(file)}`, file];
  const sniff = charset === null ? [] : charset === '' ? ['--sniff'] : ['--charset', charset];
  return ['html', `--${view}`, ...(context ? ['--fragment', context] : []), ...sniff, file];
}

// --- the views, as Chrome computes them ----------------------------------------------
//
// These two functions run IN CHROME: domPage inlines their source. They are plain
// functions here so scripts/run-dom-oracle.test.mjs can run them over a stand-in DOM.
// pkg/html/dump.odin is the Lava side of dumpTree and must print the same format.

/**
 * The html5lib tree-construction format (html5lib-tests/tree-construction/README.md),
 * one line per node or attribute, each `| ` plus two spaces per depth, every line
 * ending in '\n':
 *
 *   <!DOCTYPE name>, or <!DOCTYPE name "public" "system"> when either id is non-empty
 *   <name>, <svg name>, <math name>           an element, prefixed by its namespace
 *   name="value", xlink href="value"          an attribute, one level deeper
 *   content                                   a template's content, one level deeper,
 *                                             its children one more
 *   "data"                                    a text node, its data verbatim
 *   <!-- data -->                             a comment
 *   <?target data>                            a processing instruction: Chrome 158
 *                                             parses `<?php x ?>` in a body as one
 *
 * One departure from html5lib, on purpose: attributes print in the element's
 * attribute order, not sorted, because the order is observable (serialization,
 * `attributes[i]`) and the parser must reproduce it.
 */
export function dumpTree(nodes) {
  const ELEMENT_NS = {
    'http://www.w3.org/1999/xhtml': '',
    'http://www.w3.org/2000/svg': 'svg ',
    'http://www.w3.org/1998/Math/MathML': 'math ',
  };
  const ATTR_NS = {
    'http://www.w3.org/1999/xlink': 'xlink ',
    'http://www.w3.org/XML/1998/namespace': 'xml ',
    'http://www.w3.org/2000/xmlns/': 'xmlns ',
  };
  let out = '';
  const line = (depth, s) => {
    out += '| ' + '  '.repeat(depth) + s + '\n';
  };
  const walk = (node, depth) => {
    switch (node.nodeType) {
      case 1: {
        const prefix = ELEMENT_NS[node.namespaceURI];
        if (prefix === undefined) throw new Error(`element in namespace ${node.namespaceURI}`);
        line(depth, '<' + prefix + node.localName + '>');
        for (const a of node.attributes) {
          const ns = a.namespaceURI === null ? '' : ATTR_NS[a.namespaceURI];
          if (ns === undefined) throw new Error(`attribute in namespace ${a.namespaceURI}`);
          line(depth + 1, ns + a.localName + '="' + a.value + '"');
        }
        if (prefix === '' && node.localName === 'template') {
          line(depth + 1, 'content');
          for (const c of node.content.childNodes) walk(c, depth + 2);
        }
        for (const c of node.childNodes) walk(c, depth + 1);
        return;
      }
      case 3:
        return line(depth, '"' + node.data + '"');
      case 8:
        return line(depth, '<!-- ' + node.data + ' -->');
      case 7:
        return line(depth, '<?' + node.target + ' ' + node.data + '>');
      case 10: {
        const ids = node.publicId || node.systemId ? ` "${node.publicId}" "${node.systemId}"` : '';
        return line(depth, '<!DOCTYPE ' + node.name + ids + '>');
      }
      default:
        throw new Error(`node type ${node.nodeType} in a parsed tree`);
    }
  };
  for (const n of nodes) walk(n, 0);
  return out;
}

/**
 * The serialization of a document, defined as the HTML fragment serialization
 * algorithm applied to the Document node (what `lava html` prints): its children in
 * order, a doctype as `<!DOCTYPE name>` (the ids are never serialized), a comment as
 * `<!--data-->`, a processing instruction as `<?target data?>`, an element as its
 * outerHTML; then one '\n'. For a fragment case it
 * is the context element's innerHTML and '\n'.
 */
export function serializeDocument(doc) {
  let out = '';
  for (const n of doc.childNodes) {
    if (n.nodeType === 10) out += '<!DOCTYPE ' + n.name + '>';
    else if (n.nodeType === 8) out += '<!--' + n.data + '-->';
    else if (n.nodeType === 1) out += n.outerHTML;
    // As Chrome 158 serializes one inside an element: `<?php x ?>` round-trips.
    else if (n.nodeType === 7) out += '<?' + n.target + ' ' + n.data + '?>';
    else throw new Error(`node type ${n.nodeType} at the document level`);
  }
  return out + '\n';
}

/**
 * The harness page Chrome loads for a case. The input travels as base64 in the page,
 * so no fetch is pending when --dump-dom reads the result; it is decoded as UTF-8
 * (inputProblem refused anything else). The views go into #out as one base64 line
 * (web-oracle.mjs readSink decodes it); a throw goes into #err, which recordVerdict
 * refuses.
 */
export function domPage(name, input, context) {
  return `<!doctype html><meta charset="utf-8"><title>${name}</title>
<pre id="out"></pre><pre id="err"></pre>
<script>
${dumpTree.toString()}
${serializeDocument.toString()}
(() => {
  const b64 = (s) => {
    const bytes = new TextEncoder().encode(s);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  };
  try {
    const raw = atob(${JSON.stringify(Buffer.from(input).toString('base64'))});
    const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    const text = new TextDecoder('utf-8').decode(bytes);
    const context = ${JSON.stringify(context)};
    let tree, markup;
    if (context === null) {
      const doc = new DOMParser().parseFromString(text, 'text/html');
      tree = dumpTree(doc.childNodes);
      markup = serializeDocument(doc);
    } else {
      const doc = new DOMParser().parseFromString('<!DOCTYPE html>', 'text/html');
      const foreign = /^(svg|math) (.+)$/.exec(context);
      const NS = { svg: 'http://www.w3.org/2000/svg', math: 'http://www.w3.org/1998/Math/MathML' };
      const el = foreign ? doc.createElementNS(NS[foreign[1]], foreign[2]) : doc.createElement(context);
      el.innerHTML = text;
      tree = dumpTree(el.childNodes);
      markup = el.innerHTML + '\\n';
    }
    document.getElementById('out').textContent = b64('#tree\\n' + tree + '#serialize\\n' + markup);
  } catch (e) {
    document.getElementById('err').textContent = b64('error: ' + String(e && e.stack || e) + '\\n');
  }
})();
</script>
`;
}

/**
 * The harness page Chrome loads for a navigation case (navCharset): the case's bytes
 * load in a frame from `/raw/<name>` with the case's Content-Type, and the views are
 * read from the frame's document once it has loaded — before the harness's own load
 * event, which --dump-dom waits for.
 *
 * The frame is `sandbox="allow-same-origin"`: no script runs in it, so `<noscript>`
 * parses as markup, as in `lava html`, and a corpus page's scripts cannot change the
 * tree, while the harness can still read it. The harness is served as windows-1252 (it
 * is ASCII): a same-origin frame with no BOM, label or <meta> inherits its parent's
 * encoding (the HTML standard's sniffing step for a child navigable; Chrome 158 follows
 * it), and windows-1252 is what Chrome 158 gives an unlabeled top-level page — probed
 * with a top-level --dump-dom of UTF-8 bytes served as bare `text/html` — so the frame
 * decodes as a page navigated to directly would.
 */
export function navPage(name) {
  return `<!doctype html><title>${name}</title>
<pre id="out"></pre><pre id="err"></pre>
<script>
${dumpTree.toString()}
${serializeDocument.toString()}
function b64(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function done(frame) {
  try {
    const doc = frame.contentDocument;
    const views = '#tree\\n' + dumpTree(doc.childNodes) + '#serialize\\n' + serializeDocument(doc);
    document.getElementById('out').textContent = b64(views);
  } catch (e) {
    document.getElementById('err').textContent = b64('error: ' + String(e && e.stack || e) + '\\n');
  }
}
</script>
<iframe sandbox="allow-same-origin" src="/raw/${name}" onload="done(this)"></iframe>
`;
}

/** The Content-Type the harness page of a navigation case is served with (navPage). */
export const NAV_PAGE_TYPE = 'text/html; charset=windows-1252';

/**
 * The harness page Chrome loads for a scripted page case (isPageCase): the case loads in
 * a frame from `/raw/<name>`, served as PAGE_CONTENT_TYPE under PAGE_CSP, with scripting
 * ON — no sandbox — so its inline scripts run as the parser reaches them, as under
 * `lava page`. The views are read from the frame's document at its load event, after
 * every parser-inserted script and DOMContentLoaded listener has run and before the
 * harness's own load, which --dump-dom waits for. A case must therefore finish its work
 * by then: no timers whose callbacks change the tree (Lava runs its loop to idle, Chrome
 * reads at load).
 */
export function scriptedPage(name) {
  return `<!doctype html><meta charset="utf-8"><title>${name}</title>
<pre id="out"></pre><pre id="err"></pre>
<script>
${dumpTree.toString()}
${serializeDocument.toString()}
function b64(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function done(frame) {
  try {
    const doc = frame.contentDocument;
    const views = '#tree\\n' + dumpTree(doc.childNodes) + '#serialize\\n' + serializeDocument(doc);
    document.getElementById('out').textContent = b64(views);
  } catch (e) {
    document.getElementById('err').textContent = b64('error: ' + String(e && e.stack || e) + '\\n');
  }
}
</script>
<iframe src="/raw/${name}" onload="done(this)"></iframe>
`;
}
