// Index of the public surface of an Odin SDK tree (`core:`, `vendor:`, `base:`), and
// the diff between two of them. Feeds `make sdk-diff` and the weekly SDK-news issue:
// the question both answer is "what can we now take from the SDK instead of writing
// or linking it ourselves", so the index records names and signatures, not docs.
//
// Why a line scanner and not `odin doc -doc-format`: the doc format is a binary
// layout tied to the compiler that wrote it, so indexing a commit would mean building
// that commit's compiler first, and the weekly job compares the pin against master.
// Reading the source at a git revision needs nothing but git. The scanner only has to
// find declarations at file scope, which Odin makes unambiguous: `name :: <rhs>` at
// brace depth 0, or one level down inside a top-level `when`/`foreign` block.
//
// What counts as public: not in a `_`-prefixed package (SDK-internal, e.g.
// `core:crypto/_aes`), not in a test/example tree, not in a `#+private` file, not
// under `@(private)`, and not a `_`-prefixed name.

import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const COLLECTIONS = ['core', 'vendor', 'base'];
const SKIP_DIR = /^(_.*|tests?|examples?|demo|doc)$/;
const OS_SUFFIX =
  /_(linux|windows|darwin|freebsd|openbsd|netbsd|haiku|essence|js|wasi|freestanding|orca|unix|posix|other)\.odin$/;
const PRIVATE_ATTR = /@\(\s*(?:[^)]*,\s*)?private\b|@private\b/;
const DECL = /^([A-Za-z][A-Za-z0-9_]*)\s*::\s*(.*)$/;
const TYPE_RHS =
  /^(distinct\b|(#type\s+)?(struct|enum|union|bit_set|bit_field|matrix|#soa|#simd|map\[|\[))/;

/**
 * Package id for an SDK-relative .odin path, or null when the file is not public.
 * @param {string} path forward-slash path relative to the SDK root
 * @returns {string|null} e.g. `core:crypto/sha2`
 */
export function packageOf(path) {
  if (!path.endsWith('.odin') || path.endsWith('_test.odin')) return null;
  const parts = path.split('/');
  if (parts.length < 3 || !COLLECTIONS.includes(parts[0])) return null;
  const dirs = parts.slice(1, -1);
  if (dirs.some((d) => SKIP_DIR.test(d))) return null;
  return `${parts[0]}:${dirs.join('/')}`;
}

// Strips string/rune literals and comments so braces inside them do not move the
// depth counter. Block comments may span lines; `state.inBlock` carries that.
function stripLine(line, state) {
  let out = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    const n = line[i + 1];

    if (state.inBlock > 0) {
      if (c === '*' && n === '/') {
        state.inBlock--;
        i++;
      } else if (c === '/' && n === '*') {
        state.inBlock++;
        i++;
      }

      continue;
    }

    if (c === '/' && n === '/') break;

    if (c === '/' && n === '*') {
      state.inBlock++;
      i++;
      continue;
    }

    // Literals are kept (a signature's `proc "c"` must survive), but their braces
    // and parens are masked so they move neither counter.
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      let lit = q;
      i++;
      while (i < line.length && line[i] !== q) {
        if (line[i] === '\\' && q !== '`') {
          lit += line[i];
          i++;
        }
        lit += line[i] ?? '';
        i++;
      }
      out += lit.replace(/[{}()]/g, '_') + q;
      continue;
    }

    out += c;
  }
  return out;
}

function depthDelta(code) {
  let d = 0;
  for (const c of code) {
    if (c === '{') d++;
    else if (c === '}') d--;
  }
  return d;
}

function classify(rhs) {
  const r = rhs.replace(/^#(force_inline|force_no_inline)\s+/, '');
  if (/^proc\s*\{/.test(r)) return 'group';
  if (/^proc\b/.test(r)) return 'proc';
  if (TYPE_RHS.test(r)) return 'type';
  if (/^(#config|#load)/.test(r)) return 'const';
  return 'const';
}

// A proc's signature is everything before its body/`---`, whitespace-collapsed, so a
// reflowed parameter list does not read as a change.
function signature(text) {
  let depth = 0;
  let end = text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (
      depth === 0 &&
      (c === '{' || text.startsWith('---', i) || text.startsWith(' where ', i))
    ) {
      end = i;
      break;
    }
  }
  // Inlining directives are codegen hints, not API: dropping them keeps a
  // `#force_no_inline` edit out of the "changed signature" list.
  return text
    .slice(0, end)
    .replace(/#force_(no_)?inline\s+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Public declarations of one Odin source file.
 * @param {string} src file contents
 * @returns {{build: string|null, decls: {name: string, kind: string, sig: string, foreign: boolean}[]}}
 */
export function scanFile(src) {
  const lines = src.split('\n');
  let build = null;
  for (const l of lines) {
    const t = l.trim();
    if (t.startsWith('#+private')) return { build, decls: [] };
    if (t.startsWith('#+build')) build = t.slice('#+build'.length).trim();
    if (t.startsWith('package ')) break;
  }

  const decls = [];
  const state = { inBlock: 0 };
  // Brace depth, and for each open block whether it is a top-level `when`/`foreign`
  // (whose direct children are file-scope declarations).
  let depth = 0;
  const open = [];
  let privateNext = false;
  // Whether the open top-level transparent block is a `foreign` one: its procs are
  // bindings someone declared by hand, which is what `make sdk-diff` audits in Lava.
  let inForeign = false;
  // `@(private) foreign lib { … }` hides every binding in the block.
  let blockPrivate = false;
  for (let i = 0; i < lines.length; i++) {
    const code = stripLine(lines[i], state);
    const t = code.trim();
    const scope = depth === 0 || (depth === 1 && open[0] === 'transparent');
    // Attributes may share the line with what they annotate: `@(private) x :: …`.
    const attrs = /^((?:@\([^)]*\)|@\w+)\s*)*/.exec(t)[0];
    const body = t.slice(attrs.length);
    const privateHere = PRIVATE_ATTR.test(attrs);
    const wasPrivate = privateNext || privateHere;

    const m = scope ? DECL.exec(body) : null;
    if (m) {
      const name = m[1];
      const rhs = m[2];
      const kind = classify(rhs);
      const hidden = wasPrivate || (depth === 1 && blockPrivate) || name.startsWith('_');
      if (!hidden) {
        let sig = '';
        if (kind === 'proc') {
          // Gather continuation lines until the parameter/result list closes.
          let text = rhs;
          let j = i;
          const paren = (s) => [...s].reduce((a, c) => a + (c === '(' ? 1 : c === ')' ? -1 : 0), 0);
          while (paren(text) > 0 && j + 1 < lines.length && j - i < 40) {
            j++;
            text += ' ' + stripLine(lines[j], { inBlock: 0 }).trim();
          }
          sig = signature(text);
        } else if (kind === 'group') {
          sig = rhs.replace(/\s+/g, ' ').replace(/\}.*$/, '}').trim();
        }
        decls.push({
          name,
          kind,
          sig,
          foreign: depth === 1 && open[0] === 'transparent' && inForeign,
        });
      }
    }

    // An attribute-only line carries over to the next declaration; anything else
    // consumes it.
    if (scope && attrs !== '' && body === '') privateNext = wasPrivate;
    else if (scope && t !== '') privateNext = false;

    const d = depthDelta(code);
    if (d > 0) {
      const transparent = depth === 0 && /^(when|foreign)\b/.test(body);
      if (depth === 0) {
        inForeign = /^foreign\b/.test(body);
        blockPrivate = transparent && wasPrivate;
      }
      for (let k = 0; k < d; k++) open.push(k === 0 && transparent ? 'transparent' : 'opaque');
    } else {
      for (let k = 0; k < -d; k++) open.pop();
    }
    depth += d;
    if (depth < 0) depth = 0;
  }
  return { build, decls };
}

function targetOf(path, build) {
  const m = OS_SUFFIX.exec(path);
  if (build) return build;
  return m ? m[1] : null;
}

/**
 * Builds an index from `{path, text}` files.
 * @param {Iterable<{path: string, text: string}>} files
 * @returns {Map<string, Map<string, {kind: string, sig: string, targets: Set<string>}>>}
 *   package id → symbol name → entry. `targets` is empty when some declaring file is
 *   unconstrained (available everywhere).
 */
export function buildIndex(files) {
  const index = new Map();
  for (const { path, text } of files) {
    const pkg = packageOf(path);
    if (!pkg) continue;
    const { build, decls } = scanFile(text);
    if (!index.has(pkg)) index.set(pkg, new Map());
    const syms = index.get(pkg);
    const target = targetOf(path, build);
    for (const d of decls) {
      let e = syms.get(d.name);
      if (!e) {
        e = { kind: d.kind, sig: d.sig, targets: new Set(), everywhere: false };
        syms.set(d.name, e);
      }
      if (target === null) e.everywhere = true;
      else e.targets.add(target);
    }
  }
  for (const syms of index.values()) {
    for (const e of syms.values()) {
      if (e.everywhere) e.targets.clear();
      delete e.everywhere;
    }
  }
  // A directory whose files are all private or test-only is not a public package.
  for (const [pkg, syms] of index) if (syms.size === 0) index.delete(pkg);
  return index;
}

/**
 * Reads every SDK .odin file at a git revision in one `git cat-file --batch` pass.
 * @param {string} repo Odin git checkout
 * @param {string} rev commit-ish
 * @returns {{path: string, text: string}[]}
 */
export function filesAtRev(repo, rev) {
  const names = execFileSync(
    'git',
    ['-C', repo, 'ls-tree', '-r', '--name-only', rev, '--', ...COLLECTIONS],
    {
      encoding: 'utf8',
      maxBuffer: 64 << 20,
    },
  )
    .split('\n')
    .filter((p) => packageOf(p) !== null);
  const req = names.map((p) => `${rev}:${p}`).join('\n') + '\n';
  const out = spawnSync('git', ['-C', repo, 'cat-file', '--batch'], {
    input: req,
    maxBuffer: 1 << 30,
  });
  if (out.status !== 0) throw new Error(`git cat-file failed: ${out.stderr}`);
  const buf = out.stdout;
  const files = [];
  let off = 0;
  for (const path of names) {
    const nl = buf.indexOf(10, off);
    const header = buf.toString('utf8', off, nl).split(' ');
    off = nl + 1;
    if (header[1] === 'missing') continue;
    const size = Number(header[2]);
    files.push({ path, text: buf.toString('utf8', off, off + size) });
    off += size + 1;
  }
  return files;
}

/**
 * Reads every SDK .odin file from a directory tree (an SDK that is not a git checkout).
 * @param {string} root SDK root
 * @returns {{path: string, text: string}[]}
 */
export function filesInDir(root) {
  const files = [];
  const walk = (rel) => {
    for (const name of readdirSync(join(root, rel))) {
      const p = rel ? `${rel}/${name}` : name;
      const st = statSync(join(root, p));
      if (st.isDirectory()) walk(p);
      else if (packageOf(p)) files.push({ path: p, text: readFileSync(join(root, p), 'utf8') });
    }
  };
  for (const c of COLLECTIONS) {
    try {
      walk(c);
    } catch {
      // A missing collection (no vendor/ in a stripped SDK) is not an error.
    }
  }
  return files;
}

/**
 * Differences between two indexes.
 * @returns {{addedPackages: string[], removedPackages: string[],
 *   added: Map<string, string[]>, removed: Map<string, string[]>,
 *   changed: Map<string, {name: string, from: string, to: string}[]>}}
 */
export function diffIndex(from, to) {
  const addedPackages = [...to.keys()].filter((p) => !from.has(p)).sort();
  const removedPackages = [...from.keys()].filter((p) => !to.has(p)).sort();
  const added = new Map();
  const removed = new Map();
  const changed = new Map();
  for (const [pkg, syms] of to) {
    const old = from.get(pkg);
    if (!old) continue;
    const a = [...syms.keys()].filter((n) => !old.has(n)).sort();
    const r = [...old.keys()].filter((n) => !syms.has(n)).sort();
    const c = [];
    for (const [n, e] of syms) {
      const o = old.get(n);
      if (o && o.kind === 'proc' && e.kind === 'proc' && o.sig !== e.sig)
        c.push({ name: n, from: o.sig, to: e.sig });
    }
    if (a.length) added.set(pkg, a);
    if (r.length) removed.set(pkg, r);
    if (c.length)
      changed.set(
        pkg,
        c.sort((x, y) => (x.name < y.name ? -1 : 1)),
      );
  }
  for (const pkg of removedPackages) removed.set(pkg, [...from.get(pkg).keys()].sort());
  return { addedPackages, removedPackages, added, removed, changed };
}
