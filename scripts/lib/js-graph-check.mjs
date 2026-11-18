// Rule set of the embedded JS module-graph check (scripts/check-js-graph.mjs documents
// the rules). The parser and module table it reads are shared with the pollution
// ratchet and live in js-graph.mjs; this file is the graph CHECK's own consumer of
// them, kept apart so js-graph.mjs stays the one neutral builder both gates import.
//
// Pulled out of the CLI for the same reason primordials-scan.mjs was: the test needs
// checkJsGraph over fixture trees, and the CLI used to export it behind an "am I the
// entry point?" guard comparing argv[1] with import.meta.url. Node realpaths the
// module URL but not argv[1], so invoked through a symlink the guard skipped the whole
// report and the gate exited 0 having printed nothing. The CLI stays guard-free and
// the importable part lives here.

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { MODULE_DIRS, moduleGraph, posix } from './js-graph.mjs';

/**
 * Checks the embedded JS module graph rooted at `root` (a repo checkout, or a fixture
 * tree with the same pkg/runtime layout).
 * @param {string} root
 * @returns {{rule: string, where: string, msg: string}[]}
 */
export function checkJsGraph(root) {
  const runtimeDir = join(root, 'pkg', 'runtime');
  const violations = [];
  const add = (rule, where, msg) => violations.push({ rule, where, msg });
  const relJs = (file) => posix(relative(runtimeDir, file));

  // --- embedding: what the Odin sources pull in ---------------------------------
  const loadDirs = new Set();
  const loadFiles = new Set();
  const nativeKeys = [];
  const odinFiles = readdirSync(runtimeDir).filter((n) => n.endsWith('.odin'));
  for (const name of odinFiles) {
    const src = readFileSync(join(runtimeDir, name), 'utf8');
    for (const m of src.matchAll(/#load_directory\(\s*"([^"]+)"/g)) {
      const dir = m[1].replace(/\/+$/, '');
      loadDirs.add(dir);
      const inside = dir.slice('js/'.length);
      if (!MODULE_DIRS.some((d) => inside === d || inside.startsWith(d + '/'))) {
        add(
          'unembedded',
          `pkg/runtime/${name}`,
          `#load_directory("${dir}") is outside js/node and js/internal`,
        );
      }
    }
    for (const m of src.matchAll(/#load\(\s*"([^"]+\.js)"/g)) loadFiles.add(m[1]);
    for (const m of src.matchAll(/set_named\(ctx, natives, "([^"]+)"/g)) {
      nativeKeys.push({ id: m[1], where: `pkg/runtime/${name}` });
    }
  }
  // The parser and module table are shared with the pollution ratchet (lib/js-graph.mjs),
  // which reads the same edges to decide which modules run before user code.
  const graph = moduleGraph(root);
  const { modules, allJs } = graph;
  for (const file of allJs) {
    const rel = relJs(file);
    const dir = rel.slice(0, rel.lastIndexOf('/'));
    if (!loadDirs.has(dir) && !loadFiles.has(rel)) {
      add(
        'unembedded',
        `pkg/runtime/${rel}`,
        `no #load_directory("${dir}") or #load("${rel}") embeds it`,
      );
    }
  }

  // --- the module table: dynamic and unresolved requires found while building it ---
  violations.push(...graph.violations);
  const where = (mod, line) => `pkg/runtime/${relJs(mod.file)}:${line}`;

  // --- roots: every public module, plus whatever the loader asks for -------------
  const roots = [...modules.keys()].filter((id) => id.startsWith('node/'));
  roots.push(...graph.loaderIds);
  for (const k of nativeKeys) {
    if (!modules.has(k.id)) add('unresolved', k.where, `natives key "${k.id}" names no module`);
  }

  const seen = new Set();
  const stack = [...roots];
  while (stack.length > 0) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of modules.get(id).edges) stack.push(e.id);
  }
  for (const [id, mod] of modules) {
    if (!seen.has(id))
      add('unreachable', `pkg/runtime/${relJs(mod.file)}`, `${id} is required by nothing`);
  }

  // --- cycles through module-eval requires --------------------------------------
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const color = new Map([...modules.keys()].map((id) => [id, WHITE]));
  const path = [];
  const reported = new Set();
  const visit = (id) => {
    color.set(id, GREY);
    path.push(id);
    for (const e of modules.get(id).edges) {
      if (!e.topLevel) continue;
      if (color.get(e.id) === GREY) {
        const cycle = [...path.slice(path.indexOf(e.id)), e.id];
        const key = [...cycle.slice(0, -1)].sort().join(',');
        if (!reported.has(key)) {
          reported.add(key);
          add('cycle', where(modules.get(id), e.line), cycle.join(' -> '));
        }
      } else if (color.get(e.id) === WHITE) visit(e.id);
    }
    path.pop();
    color.set(id, BLACK);
  };
  for (const id of modules.keys()) if (color.get(id) === WHITE) visit(id);

  return violations;
}
