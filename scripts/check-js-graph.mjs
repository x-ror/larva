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
// The rules live in lib/js-graph-check.mjs so the test can run them over fixture
// trees. This file is only the CLI and deliberately has no "am I the entry point?"
// guard: one that compared argv[1] with import.meta.url failed open under a symlink.
//
// Usage: node scripts/check-js-graph.mjs [root]   (exit 1 on any violation)

import { resolve } from 'node:path';
import { ROOT } from './lib/primordials-detect.mjs';
import { checkJsGraph } from './lib/js-graph-check.mjs';

// `root` exists for the test, which runs the CLI over a one-defect fixture tree to pin
// the failing exit, header and violation lines; every real caller passes nothing.
const root = process.argv[2] ? resolve(process.argv[2]) : ROOT;
const violations = checkJsGraph(root);
if (violations.length > 0) {
  console.error(`JS module graph: ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.rule}: ${v.where}  ${v.msg}`);
  process.exit(1);
}
console.log(
  'OK: embedded JS module graph is literal, resolved, reachable, embedded and acyclic at module-eval.',
);
