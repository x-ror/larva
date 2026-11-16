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

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import * as walk from 'acorn-walk';
import { walkDir, ROOT } from './lib/primordials-detect.mjs';

const MODULE_DIRS = ['node', 'internal'];

const posix = (p) => p.split(sep).join('/');

// The loader's specifier -> id rule (bootstrap/loader.js toId), restated so a require
// spelled for the public form (`buffer`, `node:buffer`, `assert/strict`) resolves the
// way it does at run time.
function toId(name) {
  let key = name.startsWith('node:') ? name.slice(5) : name;
  if (key === 'assert/strict') key = 'assert';
  return key.startsWith('internal/') ? key : 'node/' + key;
}

function parseJs(src, file) {
  return parse(src, {
    ecmaVersion: 'latest',
    sourceType: 'script',
    locations: true,
    allowReturnOutsideFunction: true,
    sourceFile: file,
  });
}

// Every call `<callee>(…)` in `ast`, with whether it runs at module-eval: its nearest
// enclosing function is the outermost one in the program.
function calls(ast, callee) {
  const out = [];
  walk.ancestor(ast, {
    CallExpression(node, _state, ancestors) {
      if (node.callee.type !== 'Identifier' || node.callee.name !== callee) return;
      const fns = ancestors.filter(
        (a) =>
          a !== node &&
          (a.type === 'FunctionExpression' ||
            a.type === 'FunctionDeclaration' ||
            a.type === 'ArrowFunctionExpression'),
      );
      out.push({ node, line: node.loc.start.line, topLevel: fns.length <= 1 });
    },
  });
  return out;
}

function literalArg(call) {
  const arg = call.node.arguments[0];
  if (call.node.arguments.length !== 1 || !arg) return null;
  if (arg.type === 'Literal' && typeof arg.value === 'string') return arg.value;
  if (arg.type === 'TemplateLiteral' && arg.expressions.length === 0) {
    return arg.quasis[0].value.cooked;
  }
  return null;
}

/**
 * Checks the embedded JS module graph rooted at `root` (a repo checkout, or a fixture
 * tree with the same pkg/runtime layout).
 * @param {string} root
 * @returns {{rule: string, where: string, msg: string}[]}
 */
export function checkJsGraph(root) {
  const runtimeDir = join(root, 'pkg', 'runtime');
  const jsDir = join(runtimeDir, 'js');
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
  const allJs = existsSync(jsDir) ? walkDir(jsDir).sort() : [];
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

  // --- the module table: id -> file, and every require edge ---------------------
  const modules = new Map(); // id -> { file, edges: [{id, line, topLevel}] }
  for (const file of allJs) {
    const id = relJs(file).slice('js/'.length, -'.js'.length);
    if (!MODULE_DIRS.some((d) => id.startsWith(d + '/'))) continue;
    modules.set(id, { file, edges: [] });
  }
  const where = (mod, line) => `pkg/runtime/${relJs(mod.file)}:${line}`;
  for (const mod of modules.values()) {
    const ast = parseJs(readFileSync(mod.file, 'utf8'), mod.file);
    for (const call of calls(ast, 'require')) {
      const spec = literalArg(call);
      if (spec === null) {
        add('dynamic', where(mod, call.line), 'require() argument is not a string literal');
        continue;
      }
      const id = toId(spec);
      if (!modules.has(id)) {
        add('unresolved', where(mod, call.line), `require('${spec}') -> ${id} has no file`);
        continue;
      }
      mod.edges.push({ id, line: call.line, topLevel: call.topLevel });
    }
  }

  // --- roots: every public module, plus whatever the loader asks for -------------
  const roots = [...modules.keys()].filter((id) => id.startsWith('node/'));
  const loaderFile = join(jsDir, 'bootstrap', 'loader.js');
  if (existsSync(loaderFile)) {
    const ast = parseJs(readFileSync(loaderFile, 'utf8'), loaderFile);
    for (const call of calls(ast, 'req')) {
      const spec = literalArg(call);
      if (spec === null) continue; // req(name) inside the resolver itself
      const id = toId(spec);
      if (!modules.has(id)) {
        add(
          'unresolved',
          `pkg/runtime/js/bootstrap/loader.js:${call.line}`,
          `req('${spec}') -> ${id} has no file`,
        );
      } else roots.push(id);
    }
  }
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
