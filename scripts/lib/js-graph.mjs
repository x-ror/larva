// The embedded runtime JS module graph — ONE parser and graph builder, two consumers:
//
//   scripts/lib/js-graph-check.mjs   literal, resolved, reachable, embedded, acyclic
//                                    (reported by the scripts/check-js-graph.mjs CLI)
//   scripts/lib/primordials-scan.mjs which modules are EAGER (instantiated before user
//                                    code), because only there is a module-eval
//                                    capture pristine (CLAUDE.md §5)
//                                    (reported by the scripts/check-primordials.mjs CLI)
//
// A module id is its path under pkg/runtime/js without `.js` (`node/buffer`,
// `internal/primordials`). An edge is TOP-LEVEL when the require runs at module-eval:
// its nearest enclosing function is the factory every module file evaluates to,
// `(function (require, module, exports, native) { … })`. A require inside a nested
// function is the sanctioned late binding and runs whenever that function is called.

import { existsSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parse } from 'acorn';
import * as walk from 'acorn-walk';
import { walkDir } from './primordials-detect.mjs';

export const MODULE_DIRS = ['node', 'internal'];

export const posix = (p) => p.split(sep).join('/');

// The loader's specifier -> id rule (bootstrap/loader.js toId), restated so a require
// spelled for the public form (`buffer`, `node:buffer`, `assert/strict`) resolves the
// way it does at run time.
export function toId(name) {
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
 * Parses every module under js/node and js/internal and the loader's req() roots.
 * @param {string} root  a repo checkout, or a fixture tree with the same layout
 * @returns {{
 *   modules: Map<string, {file: string, edges: {id: string, line: number, topLevel: boolean}[]}>,
 *   loaderIds: string[],
 *   violations: {rule: string, where: string, msg: string}[],
 *   allJs: string[],
 * }}  `violations` holds the `dynamic` and `unresolved` findings met while building.
 */
export function moduleGraph(root) {
  const runtimeDir = join(root, 'pkg', 'runtime');
  const jsDir = join(runtimeDir, 'js');
  const violations = [];
  const add = (rule, where, msg) => violations.push({ rule, where, msg });
  const relJs = (file) => posix(relative(runtimeDir, file));

  const allJs = existsSync(jsDir) ? walkDir(jsDir).sort() : [];
  const modules = new Map();
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

  // Every literal req() in the loader. All of them run before user code: the loader's
  // own body at init, and installStdio's `req('internal/stdio')` from install_stdio
  // (globals.odin), also at init. A literal req() added somewhere that runs LATER
  // would be wrongly treated as eager by eagerModules; the runtime cross-check in
  // cmd/lava/lazy_builtins_test.odin is what catches that.
  const loaderIds = [];
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
      } else loaderIds.push(id);
    }
  }
  return { modules, loaderIds, violations, allJs };
}

/**
 * The ids whose factory runs before user code: the loader's req() roots, closed over
 * TOP-LEVEL require edges only. A require inside a function body runs when that
 * function is called, which may be after user code, so it does not propagate.
 * Static and conservative in the direction that matters for the ratchet: an id
 * outside this set has its module-eval reads counted.
 * @param {string | ReturnType<typeof moduleGraph>} rootOrGraph
 * @returns {string[]} sorted ids
 */
export function eagerModules(rootOrGraph) {
  const { modules, loaderIds } =
    typeof rootOrGraph === 'string' ? moduleGraph(rootOrGraph) : rootOrGraph;
  const seen = new Set();
  const stack = [...loaderIds];
  while (stack.length > 0) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of modules.get(id).edges) if (e.topLevel) stack.push(e.id);
  }
  return [...seen].sort();
}
