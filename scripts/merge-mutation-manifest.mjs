#!/usr/bin/env node
// Git merge driver for tests/mutation-manifest.json (see .gitattributes).
//
// Lava and Larva both append entries to the end of the same JSON array, so every
// sync from Lava conflicted on the manifest even when the two sides added
// unrelated entries — the first automatic sync (Sync from Lava, run 1) stopped on
// exactly that. Entries are keyed by `name`, which the runner already treats as
// the identity of a mutation, so a merge by name is exact:
//   - an entry only one side added or changed is taken from that side;
//   - an entry both sides changed differently, or one side deleted while the other
//     changed it, is a real conflict: the driver writes nothing and exits 1, and
//     git reports the file as conflicted for a human.
// The top-level `$comment` follows the same rule.
//
// Git runs it as: node scripts/merge-mutation-manifest.mjs %O %A %B
// (%O base, %A ours — written in place, %B theirs). The driver is registered by
// the Sync from Lava workflow; a clone without `git config merge.mutation-manifest`
// falls back to git's ordinary text merge, so this never hides a conflict.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Three-way merge of manifest objects by entry name.
 * @returns {{ merged: object } | { conflicts: string[] }}
 */
export function mergeManifests(base, ours, theirs) {
  const conflicts = [];
  const byName = (m) => new Map((m.mutations ?? []).map((e) => [e.name, e]));
  const B = byName(base);
  const O = byName(ours);
  const T = byName(theirs);

  const pick = (key, b, o, t) => {
    if (same(o, t)) return o;
    if (same(b, o)) return t;
    if (same(b, t)) return o;
    conflicts.push(key);
    return o;
  };

  const comment = pick('$comment', base.$comment, ours.$comment, theirs.$comment);

  // Ours' order first, then entries only theirs has, in theirs' order.
  const names = [...O.keys(), ...[...T.keys()].filter((n) => !O.has(n))];
  const mutations = [];
  for (const name of names) {
    const e = pick(`mutation "${name}"`, B.get(name), O.get(name), T.get(name));
    if (e !== undefined) mutations.push(e);
  }
  // Removed on one side, untouched on the other: `pick` returned undefined and
  // the entry is dropped above. Removed on one side and changed on the other is a
  // conflict, recorded by `pick` because neither side equals the base.

  if (conflicts.length) return { conflicts };
  const merged = { ...ours, mutations };
  if (comment === undefined) delete merged.$comment;
  else merged.$comment = comment;
  return { merged };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [basePath, oursPath, theirsPath] = process.argv.slice(2);
  const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
  const result = mergeManifests(read(basePath), read(oursPath), read(theirsPath));
  if (result.conflicts) {
    console.error(
      `mutation-manifest merge: conflicting entries:\n  ${result.conflicts.join('\n  ')}`,
    );
    process.exit(1);
  }
  writeFileSync(oursPath, JSON.stringify(result.merged, null, 2) + '\n');
}
