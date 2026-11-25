#!/usr/bin/env node
// What an Odin SDK revision adds or changes against the pin, read for Larva: which
// additions replace something we link or hand-roll (the reuse law, CLAUDE.md §2),
// and which changes break packages we import. Markdown on stdout — the body of a
// pin-bump PR and of the weekly SDK-news issue (.github/workflows/sdk-news.yml).
//
// Usage: node scripts/sdk-diff.mjs [--repo DIR] [--from REV] [--to REV] [--max-chars N]
//   --repo  Odin git checkout (default: the `odin root` of the compiler on PATH)
//   --from  default: the commit in .odin-version
//   --to    default: HEAD of --repo
//   --max-chars  past this length, drop the collapsed full lists (issue-body limit)
//
// Candidates come from two sources. Hand-declared foreign procs are found by name:
// every `foreign` block in pkg/ and cmd/ is scanned, and any name the SDK at --to
// exports is listed whether or not it is new — that is the cheap, exact signal.
// Everything else goes through agents/prompts/odin-feature-reference/sdk-watch.json,
// regexes over NEW package ids and NEW `pkg.symbol` names.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, readPin, run } from './lib/odin-pin.mjs';
import { buildIndex, diffIndex, filesAtRev, scanFile } from './lib/odin-sdk-index.mjs';

const WATCH = 'agents/prompts/odin-feature-reference/sdk-watch.json';
const LIST_CAP = 40;

/** Every `.odin` file under the repo's source dirs, tests excluded. */
function repoSources(root) {
  const out = [];
  const walk = (rel) => {
    for (const name of readdirSync(join(root, rel))) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      const p = `${rel}/${name}`;
      const st = statSync(join(root, p));
      if (st.isDirectory()) walk(p);
      else if (name.endsWith('.odin') && !name.endsWith('_test.odin')) out.push(p);
    }
  };
  for (const d of ['pkg', 'cmd', 'bench']) {
    try {
      walk(d);
    } catch {
      // A missing top-level dir is not an error for a report.
    }
  }
  return out;
}

/**
 * The SDK packages Larva imports and the foreign procs it declares by hand.
 * @returns {{imports: Set<string>, foreign: Map<string, string[]>}} foreign: name → files
 */
export function larvaSurface(root, files = repoSources(root)) {
  const imports = new Set();
  const foreign = new Map();
  for (const f of files) {
    const text = readFileSync(join(root, f), 'utf8');
    for (const m of text.matchAll(
      /^\s*import\s+(?:[A-Za-z_]\w*\s+)?"((?:core|vendor|base):[^"]+)"/gm,
    )) {
      imports.add(m[1]);
    }
    for (const d of scanFile(text).decls) {
      if (!d.foreign || d.kind !== 'proc') continue;
      if (!foreign.has(d.name)) foreign.set(d.name, []);
      foreign.get(d.name).push(f);
    }
  }
  return { imports, foreign };
}

/**
 * Watch-list hits among new packages and new symbols.
 * @returns {{entry: object, hits: string[]}[]}
 */
export function watchHits(watch, diff, to) {
  // Constants are left out: a new `INFLATE_CHUNK_SIZE` says nothing a new
  // `inflate` proc would not, and they bury the procs in the list.
  const subjects = [...diff.addedPackages];
  for (const [pkg, names] of diff.added) {
    for (const n of names) if (to.get(pkg)?.get(n)?.kind !== 'const') subjects.push(`${pkg}.${n}`);
  }
  const result = [];
  for (const entry of watch.entries) {
    const res = entry.match.map((s) => new RegExp(s, 'i'));
    const hits = subjects.filter((s) => res.some((re) => re.test(s)));
    if (hits.length) result.push({ entry, hits });
  }
  return result;
}

/**
 * Hand-declared foreign procs that the SDK at `to` exports under the same name.
 * @returns {{name: string, ours: string[], sdk: string[], isNew: boolean}[]}
 */
export function foreignHits(foreign, to, diff) {
  const where = new Map();
  for (const [pkg, syms] of to) {
    for (const [n, e] of syms) {
      if (e.kind !== 'proc' || !foreign.has(n)) continue;
      if (!foreign.get(n).some((f) => osCompatible(osOf(f), e.targets))) continue;
      if (!where.has(n)) where.set(n, []);
      where.get(n).push(pkg);
    }
  }
  const isNew = (n) => [...diff.added].some(([, names]) => names.includes(n));
  return [...where]
    .map(([name, sdk]) => ({ name, ours: foreign.get(name), sdk: sdk.sort(), isNew: isNew(name) }))
    .sort((a, b) => Number(b.isNew) - Number(a.isNew) || (a.name < b.name ? -1 : 1));
}

const OS_NAMES = ['linux', 'windows', 'darwin', 'freebsd', 'openbsd', 'netbsd'];

/** The OS a Larva file is limited to by its name (`os_windows.odin`), or null. */
export function osOf(file) {
  const m = /_(linux|windows|darwin|posix)\.odin$/.exec(file);
  return m ? m[1] : null;
}

/**
 * Whether an SDK symbol declared for `targets` (`#+build` lines or file-name OS;
 * empty = everywhere) can serve a Larva file limited to `os`. Errs towards true:
 * a false lead costs a read, a dropped one costs a hand-rolled binding.
 */
export function osCompatible(os, targets) {
  if (os === null || targets.size === 0) return true;
  const want = os === 'posix' ? OS_NAMES.filter((o) => o !== 'windows') : [os];
  for (const t of targets) {
    const terms = t.split(',').map((x) => x.trim());
    const pos = terms.filter((x) => !x.startsWith('!'));
    const neg = terms.filter((x) => x.startsWith('!')).map((x) => x.slice(1));
    // A term is `os [arch]`; `posix`/`unix` (file-name or tag) cover every non-Windows OS.
    const hit = (x, o) => {
      const t = x.split(/\s+/)[0];
      return t === o || ((t === 'posix' || t === 'unix') && o !== 'windows');
    };
    const ok = (o) =>
      !neg.some((x) => hit(x, o)) && (pos.length === 0 || pos.some((x) => hit(x, o)));
    if (want.some(ok)) return true;
  }
  return false;
}

function capped(list, fmt = (x) => `\`${x}\``) {
  const head = list.slice(0, LIST_CAP).map(fmt).join(', ');
  return list.length > LIST_CAP ? `${head}, … (+${list.length - LIST_CAP})` : head;
}

/**
 * Renders the report.
 * @returns {string} markdown
 */
export function render({ repo, from, to, toIdx, diff, surface, watch, merges, brief = false }) {
  const out = [];
  const subj = (rev) => run('git', ['-C', repo, 'log', '-1', '--format=%h %cs', rev]) ?? rev;
  out.push(`## Odin SDK: \`${subj(from)}\` → \`${subj(to)}\``);
  out.push('');
  const count = (m) => [...m.values()].reduce((a, s) => a + s.length, 0);
  out.push(
    `${diff.addedPackages.length} new packages, ${count(diff.added)} new symbols in existing packages, ` +
      `${count(diff.changed)} changed proc signatures, ${diff.removedPackages.length} removed packages, ` +
      `${count(diff.removed)} removed symbols. ${merges.length} merges on the first-parent line.`,
  );
  out.push('');

  out.push('### Candidates for Larva');
  out.push('');
  out.push(
    'Leads for the reuse scout (CLAUDE.md §2), not verdicts — read the source at the new revision first.',
  );
  out.push('');
  const fh = foreignHits(surface.foreign, toIdx, diff);
  const wh = watchHits(watch, diff, toIdx);
  if (fh.length === 0 && wh.length === 0) out.push('None.');
  for (const h of fh) {
    out.push(
      `- **\`${h.name}\`** is hand-declared in ${h.ours.map((f) => `\`${f}\``).join(', ')}; ` +
        `the SDK exports it from ${h.sdk.map((p) => `\`${p}\``).join(', ')}${h.isNew ? ' (**new** in this range)' : ''}.`,
    );
  }
  for (const { entry, hits } of wh) {
    out.push(`- **${entry.ours}** — ${capped(hits)}`);
    out.push(`  - keep: ${entry.why}`);
  }
  out.push('');

  out.push('### Changed or removed in packages Larva imports');
  out.push('');
  const mine = [...surface.imports].sort();
  let any = false;
  for (const pkg of mine) {
    const ch = diff.changed.get(pkg) ?? [];
    const rm = diff.removed.get(pkg) ?? [];
    if (!ch.length && !rm.length) continue;
    any = true;
    out.push(`- \`${pkg}\``);
    for (const c of ch) out.push(`  - \`${c.name}\`: \`${c.from}\` → \`${c.to}\``);
    if (rm.length) out.push(`  - removed: ${capped(rm)}`);
  }
  if (!any)
    out.push(
      `None of the ${mine.length} imported packages lost a symbol or changed a proc signature.`,
    );
  out.push('');

  out.push('### New packages');
  out.push('');
  if (diff.addedPackages.length === 0) out.push('None.');
  for (const p of diff.addedPackages) {
    const syms = [...toIdx.get(p)]
      .filter(([, e]) => e.kind === 'proc' || e.kind === 'group')
      .map(([n]) => n);
    out.push(`- \`${p}\` — ${syms.length} procs: ${capped(syms)}`);
  }
  out.push('');

  if (brief) {
    out.push(
      '_Full lists (new symbols, other changed signatures, merged PRs) omitted for size: run `make sdk-diff` locally._',
    );
    return out.join('\n');
  }

  out.push('<details><summary>New symbols in existing packages</summary>');
  out.push('');
  for (const [pkg, names] of [...diff.added].sort())
    out.push(`- \`${pkg}\` (${names.length}): ${capped(names)}`);
  out.push('');
  out.push('</details>');
  out.push('');

  const other = [...diff.changed].filter(([p]) => !surface.imports.has(p)).sort();
  if (other.length) {
    out.push('<details><summary>Changed signatures in packages Larva does not import</summary>');
    out.push('');
    for (const [pkg, ch] of other) out.push(`- \`${pkg}\`: ${capped(ch.map((c) => c.name))}`);
    out.push('');
    out.push('</details>');
    out.push('');
  }

  if (merges.length) {
    out.push('<details><summary>Merged pull requests</summary>');
    out.push('');
    for (const m of merges) out.push(`- ${m}`);
    out.push('');
    out.push('</details>');
    out.push('');
  }
  return out.join('\n');
}

function parseArgs(argv) {
  const a = { repo: null, from: null, to: 'HEAD', 'max-chars': null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--repo' || k === '--from' || k === '--to' || k === '--max-chars')
      a[k.slice(2)] = argv[++i];
    else throw new Error(`unknown argument ${k}`);
  }
  return a;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const repo = args.repo ?? process.env.ODIN_ROOT ?? run(process.env.ODIN || 'odin', ['root']);
  if (!repo || run('git', ['-C', repo, 'rev-parse', '--git-dir']) === null) {
    console.error('sdk-diff: need an Odin git checkout (--repo DIR, ODIN_ROOT, or `odin root`)');
    process.exit(2);
  }
  const from = args.from ?? readPin().commit;
  for (const rev of [from, args.to]) {
    if (run('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `${rev}^{commit}`]) === null) {
      console.error(
        `sdk-diff: ${rev} is not in ${repo} — fetch it first (git -C ${repo} fetch origin)`,
      );
      process.exit(2);
    }
  }
  const fromIdx = buildIndex(filesAtRev(repo, from));
  const toIdx = buildIndex(filesAtRev(repo, args.to));
  const diff = diffIndex(fromIdx, toIdx);
  const watch = JSON.parse(readFileSync(join(REPO_ROOT, WATCH), 'utf8'));
  const surface = larvaSurface(REPO_ROOT);
  const merges = (
    run('git', [
      '-C',
      repo,
      'log',
      '--merges',
      '--first-parent',
      '--format=%s',
      `${from}..${args.to}`,
    ]) ?? ''
  )
    .split('\n')
    .filter(Boolean);
  const parts = { repo, from, to: args.to, toIdx, diff, surface, watch, merges };
  let md = render(parts);
  // A GitHub issue body holds 65536 characters; the weekly job passes a limit.
  if (args['max-chars'] !== null && md.length > Number(args['max-chars']))
    md = render({ ...parts, brief: true });
  console.log(md);
}
