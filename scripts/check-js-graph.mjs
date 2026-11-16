// Module-graph check for the embedded runtime JS layer.
//
// The directory layout under pkg/runtime/js IS the module table (CLAUDE.md §5):
// js/node/<specifier>.js is a public builtin, js/internal/<name>.js is reachable only
// through the factories' own `require`, js/bootstrap/ holds the files Odin evaluates
// standalone. globals.odin embeds node/ and internal/ a directory at a time with
// `#load_directory`, so nothing checks the graph at compile time: a misspelled
// `require('internal/mim')` builds fine and returns undefined at run time, and a file
// dropped into an unembedded directory silently never ships. This script is that check.
//
// It fails when:
//   dynamic     a require() in a module file has a non-literal argument — the graph
//               below would be incomplete, and a computed id is how an internal module
//               gets reached by a name nobody can grep for
//   unresolved  a require literal, a loader `req()` literal, or a natives key in
//               globals.odin names no file under js/node or js/internal
//   unreachable a module file nothing reaches from the roots: every node/ module (user
//               code may require it), and every id bootstrap/loader.js asks for
//   unembedded  a .js file under js/ that no `#load_directory` of its directory and no
//               `#load` of the file itself embeds — or a `#load_directory` outside
//               node/ and internal/, which would put bootstrap files (esm.js is kept
//               off the module table on purpose) into the loader's factories
//   cycle       a cycle through TOP-LEVEL requires, i.e. ones that run at module-eval.
//               A require inside a nested function is the sanctioned late binding and
//               is not an edge here: it runs after both factories have returned.
//
// "Module-eval" means the body of the factory function every module file evaluates
// to, `(function (require, module, exports, native) { … })`, so a require is
// top-level when its nearest enclosing function is that outermost one.
//
// Usage: node scripts/check-js-graph.mjs   (exit 1 on any violation)

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT } from './lib/primordials-detect.mjs';
import { MODULE_DIRS, moduleGraph, posix } from './lib/js-graph.mjs';

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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const violations = checkJsGraph(ROOT);
  if (violations.length > 0) {
    console.error(`JS module graph: ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  ${v.rule}: ${v.where}  ${v.msg}`);
    process.exit(1);
  }
  console.log(
    'OK: embedded JS module graph is literal, resolved, reachable, embedded and acyclic at module-eval.',
  );
}
