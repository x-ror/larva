#!/usr/bin/env node
// Agent system — path→gate routing — path → gate routing.
//
// Generates the effective route table from changed paths. Source of truth is
// this script + Makefile/ci awareness; gates.md is documentation that should
// match (diff with --check-doc).
//
// Usage:
//   node runtime/gates/route-gates.mjs [--tier L0|L1|L2] [path ...]
//   node runtime/gates/route-gates.mjs --from-git
//   node runtime/gates/route-gates.mjs --list-tiers

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** @type {Record<string, string[]>} */
export const TIERS = {
  L0: [
    'make check-primordials',
    'make check-actions',
    'make check-md',
    'make fmt',
    'make test-scripts',
    'make check-js',
    'make test-odin-serial',
  ],
  L1: [
    'make check',
    'make test',
    'make test-lava',
    'make bench-gate',
    // Non-CI routed (must run locally — plan F1/F4)
    'make bun-buffer-tests',
    'make api-surface',
    'make test-compat-lava-strict',
    'make bench-http',
  ],
  L2: ['make test-mutation', 'make bench-http', 'make test-lava-nohostfn'],
};

/** Always-run mechanical set for any non-empty diff. */
export const ALWAYS = [
  'make check',
  'make build',
  'make test',
  'make test-lava',
  'make test-odin-serial',
];

/**
 * Route rules: each entry is { match: (relPath) => bool, targets: string[], tier: 'L0'|'L1'|'L2' }
 * Paths use forward slashes. `**` means any path segment(s) including empty.
 */
function globToRe(pat) {
  // Fix invalid whole-segment **.js style: treat ** as .* path segments.
  let s = pat.replace(/\\/g, '/');
  // `pkg/runtime/js/**.js` → match any .js under that tree
  s = s.replace(/\*\*\./g, '**/*.');
  const parts = [];
  let i = 0;
  while (i < s.length) {
    if (s.startsWith('**/', i)) {
      parts.push('(?:.*/)?');
      i += 3;
    } else if (s.startsWith('**', i)) {
      parts.push('.*');
      i += 2;
    } else if (s[i] === '*') {
      parts.push('[^/]*');
      i += 1;
    } else if (s[i] === '?') {
      parts.push('[^/]');
      i += 1;
    } else if (s[i] === '{') {
      const end = s.indexOf('}', i);
      const alts = s.slice(i + 1, end).split(',');
      parts.push('(?:' + alts.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')');
      i = end + 1;
    } else {
      parts.push(s[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      i += 1;
    }
  }
  return new RegExp('^' + parts.join('') + '$');
}

/** @type {{ re: RegExp, targets: string[], note?: string }[]} */
const ROUTES = [
  {
    re: globToRe('pkg/runtime/buffer*.odin'),
    targets: ['make test-odin', 'make bun-buffer-tests', 'make api-surface', 'make bench-gate'],
  },
  {
    re: globToRe('pkg/runtime/typed_array.odin'),
    targets: ['make test-odin', 'make bun-buffer-tests', 'make api-surface', 'make bench-gate'],
  },
  {
    re: globToRe('pkg/jsc/**'),
    targets: [
      'make test-odin',
      'make bun-buffer-tests',
      'make api-surface',
      'make bench-gate',
      'make test-lava-nohostfn',
    ],
  },
  {
    re: globToRe('pkg/runtime/http.odin'),
    targets: ['make test-http-smoke', 'make bench-http'],
  },
  {
    re: globToRe('**/js/node/http.js'),
    targets: ['make test-http-smoke', 'make bench-http'],
  },
  {
    re: globToRe('**/js/internal/http/**'),
    targets: ['make test-http-smoke', 'make bench-http'],
  },
  {
    re: globToRe('**/picohttpparser/**'),
    targets: ['make test-http-smoke', 'make bench-http'],
  },
  {
    re: globToRe('pkg/runtime/net.odin'),
    targets: ['make test-net-smoke', 'make test-zerocopy-smoke'],
  },
  {
    re: globToRe('**/js/node/net.js'),
    targets: ['make test-net-smoke', 'make test-zerocopy-smoke'],
  },
  {
    re: globToRe('pkg/runtime/tls*.odin'),
    targets: ['make test-https-smoke'],
  },
  {
    re: globToRe('**/js/node/https.js'),
    targets: ['make test-https-smoke'],
  },
  {
    re: globToRe('pkg/runtime/fetch*.odin'),
    targets: ['make test-fetch-smoke'],
  },
  {
    re: globToRe('**/js/internal/fetch.js'),
    targets: ['make test-fetch-smoke'],
  },
  {
    re: globToRe('**/js/internal/fetch/*.js'),
    targets: ['make test-fetch-smoke'],
  },
  {
    re: globToRe('pkg/runtime/eventloop/**'),
    targets: ['make test-eventloop-odin', 'make test-eventloop-lava'],
  },
  {
    re: globToRe('pkg/runtime/fs*.odin'),
    targets: ['make test-fs-lava'],
  },
  {
    re: globToRe('pkg/runtime/os_*.odin'),
    targets: ['make test-fs-lava'],
  },
  {
    re: globToRe('**/js/node/fs.js'),
    targets: ['make test-fs-lava'],
  },
  {
    re: globToRe('**/js/node/stream.js'),
    targets: ['make test-http-smoke', 'make test-net-smoke', 'make test-stdio'],
  },
  {
    re: globToRe('pkg/runtime/require.odin'),
    targets: ['make test-compat-lava-strict'],
  },
  {
    re: globToRe('pkg/runtime/module_resolution.odin'),
    targets: ['make test-compat-lava-strict'],
  },
  {
    re: globToRe('**/js/bootstrap/loader.js'),
    targets: [
      'make test-compat-lava-strict',
      'make test-fs-lava',
      'make test-http-smoke',
      'make test-net-smoke',
      'make test-https-smoke',
      'make test-stdio',
    ],
  },
  {
    re: globToRe('**/js/bootstrap/esm.js'),
    targets: ['make test-compat-lava-strict'],
  },
  {
    re: globToRe('pkg/runtime/crypto.odin'),
    targets: ['make test-odin', 'make test-compat-lava', 'make api-surface'],
  },
  {
    re: globToRe('**/js/node/crypto.js'),
    targets: ['make test-odin', 'make test-compat-lava', 'make api-surface'],
  },
  {
    re: globToRe('**/js/internal/crypto/*.js'),
    targets: ['make test-odin', 'make test-compat-lava', 'make api-surface'],
  },
  {
    re: globToRe('pkg/runtime/js/**/*.js'),
    targets: ['make check-js', 'make check-primordials', 'make test-compat-lava'],
  },
  {
    re: globToRe('**/js/node/url.js'),
    targets: ['make bench-gate', 'make test-property'],
  },
  {
    re: globToRe('**/js/internal/encoding.js'),
    targets: ['make test-property'],
  },
  {
    re: globToRe('**/js/node/buffer.js'),
    targets: ['make test-property'],
  },
  {
    re: globToRe('**/js/internal/buffer.js'),
    targets: ['make test-property'],
  },
  {
    re: globToRe('scripts/**'),
    targets: ['make test-scripts'],
  },
  {
    re: globToRe('{runtime,commands,workflows,llm,agents,config}/**'),
    targets: ['make test-scripts'],
  },
  {
    re: globToRe('bench/**'),
    targets: ['make bench-gate'],
  },
  {
    re: globToRe('Makefile'),
    targets: ['__ALL__'],
  },
  {
    re: globToRe('.github/workflows/**'),
    targets: ['make check-actions', '__ALL__'],
  },
  {
    re: globToRe('pkg/runtime/workers*.odin'),
    targets: ['make test-multicore-smoke'],
  },
  {
    re: globToRe('pkg/runtime/stdio*.odin'),
    targets: ['make test-stdio'],
  },
  {
    re: globToRe('**/js/internal/stdio.js'),
    targets: ['make test-stdio'],
  },
  {
    re: globToRe('tests/stdio/**'),
    targets: ['make test-stdio'],
  },
  {
    re: globToRe('pkg/runtime/globals.odin'),
    targets: ['make test-odin', 'make test-compat-lava'],
  },
  {
    re: globToRe('pkg/std/sqlite/**'),
    targets: ['make test-sqlite-odin', 'make test-sqlite-lava'],
  },
  {
    // Predicate: mutation-manifest sources — loaded at route time
    re: null,
    targets: ['make test-mutation CHANGED=1'],
    predicate: 'mutation-source',
  },
];

const MUTATION_CHANGED = 'make test-mutation CHANGED=1';

function mutationSources() {
  const p = join(ROOT, 'tests/mutation-manifest.json');
  if (!existsSync(p)) return new Set();
  const m = JSON.parse(readFileSync(p, 'utf8'));
  return new Set((m.mutations || []).map((x) => x.source.replace(/\\/g, '/')));
}

/**
 * @param {string[]} paths repo-relative
 * @returns {{ targets: string[], matched: object[], nonCi: string[] }}
 */
export function routePaths(paths) {
  const mut = mutationSources();
  const targets = new Set(ALWAYS);
  const matched = [];
  const norm = paths.map((p) => p.replace(/\\/g, '/').replace(/^\.\//, ''));

  for (const p of norm) {
    if (mut.has(p)) {
      // CHANGED=1: only the entries this diff can affect. The full manifest is 130+
      // entries and most of them rebuild bin/lava; routing all of them for an edit
      // to one source made the gate the thing people skipped. The runner widens to
      // every entry by itself when its own machinery changed.
      targets.add(MUTATION_CHANGED);
      matched.push({ path: p, targets: [MUTATION_CHANGED], via: 'mutation-manifest' });
    }
    for (const r of ROUTES) {
      if (r.predicate === 'mutation-source') continue;
      if (r.re && r.re.test(p)) {
        for (const t of r.targets) targets.add(t);
        matched.push({ path: p, targets: r.targets, via: r.re.toString() });
      }
    }
    // Any .js under scripts/tests/bench/pkg also wants check-js
    if (
      /\.(js|mjs|cjs)$/.test(p) &&
      /^(pkg\/runtime\/js|tests|scripts|bench|runtime|commands|workflows|llm)\//.test(p)
    ) {
      targets.add('make check-js');
    }
    if (p.endsWith('.md')) targets.add('make check-md');
    if (p.endsWith('.odin')) targets.add('make fmt');
  }

  if (targets.has('__ALL__')) {
    // Expand to L0+L1+L2 unique
    for (const t of [...TIERS.L0, ...TIERS.L1, ...TIERS.L2]) targets.add(t);
    targets.delete('__ALL__');
  }

  const nonCi = [
    'make bun-buffer-tests',
    'make api-surface',
    'make test-compat-lava-strict',
    'make bench-http',
  ].filter((t) => targets.has(t));

  return { targets: [...targets], matched, nonCi };
}

function gitChanged() {
  try {
    const out = execFileSync('git', ['diff', '--name-only', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    return [...out.split('\n'), ...untracked.split('\n')].map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--list-tiers') {
    console.log(JSON.stringify(TIERS, null, 2));
    return;
  }
  let paths = args;
  let tierFilter = null;
  if (args[0] === '--from-git') {
    paths = gitChanged();
  } else if (args[0] === '--tier') {
    tierFilter = args[1];
    paths = args.slice(2);
  }
  if (paths[0] === '--from-git') paths = gitChanged();

  const result = routePaths(paths);
  if (tierFilter && TIERS[tierFilter]) {
    const allowed = new Set(TIERS[tierFilter]);
    result.targets = result.targets.filter((t) => allowed.has(t) || ALWAYS.includes(t));
  }
  console.log(JSON.stringify({ paths, ...result }, null, 2));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
