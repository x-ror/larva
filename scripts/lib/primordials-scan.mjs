// Tree scan for the pollution ratchet: walks pkg/runtime/js under `root`, decides
// which files are eager, and counts each file's sites per class.
//
// Pulled out of check-primordials.mjs for the same reason primordials-baseline.mjs
// was: the eager/lazy classification is only testable over a fixture tree, and a
// fixture tree needs a scan that takes its root. Pinned only by the real tree, a
// mutant that scored every module eager survived as soon as no lazy module happened
// to hold a module-eval capture. An earlier version exported this from the CLI
// itself behind an "am I the entry point?" guard; that guard failed open (a
// symlinked argv[1] skipped the whole report and exited 0), so the CLI stays
// guard-free and the importable part lives here.

import { join, relative, sep } from 'node:path';
import { KINDS, countFile, walkDir } from './primordials-detect.mjs';
import { eagerModules } from './js-graph.mjs';

export function scanTree(root) {
  // Module-eval reads are exempt only where they run before user code: every
  // bootstrap/ file (Odin evaluates each at context init) and the modules the loader
  // instantiates at init, derived from the graph rather than listed (lib/js-graph.mjs).
  // A lazy module's capture runs on the user's first require — #333.
  const EAGER = new Set(eagerModules(root));
  const isEager = (key) => key.startsWith('bootstrap/') || EAGER.has(key.slice(0, -'.js'.length));

  const jsDir = join(root, 'pkg', 'runtime', 'js');
  const files = walkDir(jsDir).sort();
  const counts = {};
  const allHits = {};
  for (const file of files) {
    const key = relative(jsDir, file).split(sep).join('/');
    const { hits } = countFile(file, { eager: isEager(key) });
    // PER-CLASS counts, not one number. The classes differ by an order of
    // magnitude, and a single total would let a file trade a fixed accessor for a
    // new global and still pass.
    const byKind = {};
    for (const k of KINDS) byKind[k] = 0;
    for (const h of hits) byKind[h.kind]++;
    counts[key] = byKind;
    allHits[key] = hits;
  }
  return { files, counts, allHits };
}
