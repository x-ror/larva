// Prototype-pollution ratchet — CLI entry point.
//
// The detector lives in lib/primordials-detect.mjs, its fixtures in
// lib/primordials-fixtures.mjs and the tree scan in lib/primordials-scan.mjs;
// this file is the baseline comparison, the --update path, and the report. See
// the detector for what each class means and why the tool parses rather than
// scans.
//
// Usage:
//   node scripts/check-primordials.mjs                  # check against baseline
//   node scripts/check-primordials.mjs --update         # lower the baseline
//   node scripts/check-primordials.mjs --update --allow-raise

import { readFileSync, writeFileSync } from 'node:fs';
import { KINDS, BASELINE, ROOT } from './lib/primordials-detect.mjs';
import { scanTree } from './lib/primordials-scan.mjs';
import { selfTest } from './lib/primordials-fixtures.mjs';
import { compare, raises, totals } from './lib/primordials-baseline.mjs';

// --- report ----------------------------------------------------------------

// Before anything else: a detector that has gone blind must not report on the
// tree, and must not be allowed to rebaseline. Exits non-zero rather than
// printing a reassuring "OK".
const selfTestFailures = selfTest();
if (selfTestFailures.length > 0) {
  console.error('Pollution ratchet SELF-TEST FAILED — the detector itself is broken:');
  for (const f of selfTestFailures) console.error(`  ${f}`);
  console.error(
    '\nEvery fixture above pins a vector the ratchet is supposed to see, or a\n' +
      'position it must not count. Fix the detector before trusting any number it\n' +
      'prints.',
  );
  process.exit(1);
}

// The scan, including the eager/lazy classification, is lib/primordials-scan.mjs so
// a test can drive it over a fixture tree. This file stays a plain script with no
// entry-point guard: its body must run however it is invoked.
const { files, counts, allHits } = scanTree(ROOT);

const perKindLine = () => KINDS.map((k) => `${k} ${totals(counts).perKind[k]}`).join(', ');
const grandTotal = () => totals(counts).total;

// A corrupt baseline is NOT a missing one. Both used to set haveBaseline=false,
// which put `--update` outside the refuse-to-raise guard entirely — so a file with
// git conflict markers in it (a large generated JSON that changes on every
// hardening, so conflicts are likely) turned the tool's own advice, "run
// --update", into an unguarded rebaseline of every floor.
let baseline = {};
let haveBaseline = true;
let raw = null;
try {
  raw = readFileSync(BASELINE, 'utf8');
} catch {
  haveBaseline = false;
}
if (raw !== null) {
  try {
    baseline = JSON.parse(raw);
  } catch (err) {
    console.error(`Baseline at ${BASELINE} is not valid JSON: ${err.message}`);
    console.error(
      'Fix the file — do NOT rebaseline. Rewriting it would raise every floor to\n' +
        'whatever the tree currently is, which is what the ratchet exists to prevent.',
    );
    process.exit(1);
  }
}

const update = process.argv.includes('--update');
if (update) {
  // A raise is a policy decision, not a mechanical one: the point of the ratchet
  // is that a floor only moves down. Previously `--update` rewrote every entry in
  // both directions, so a contributor who hit a failure and reached for
  // `UPDATE=1` silently raised the floor for every file — the prose rule in
  // CLAUDE.md §5 was the only thing stopping it.
  const up = haveBaseline ? raises(counts, baseline) : [];
  if (up.length > 0 && !process.argv.includes('--allow-raise')) {
    console.error('Refusing to RAISE the baseline. These entries would go up:\n');
    for (const r of up) {
      console.error(`  ${r.key}: ${r.kind} ${r.base} -> ${r.now} (+${r.now - r.base})`);
    }
    console.error(
      '\nThe ratchet only moves down. Harden the sites, add `// primordials-ok` where\n' +
        'the receiver genuinely is not a built-in, or pass --allow-raise if you are\n' +
        'deliberately recording new ground (a newly scanned file, or a new class).',
    );
    process.exit(1);
  }
  writeFileSync(BASELINE, JSON.stringify(counts, null, 2) + '\n');
  console.log(
    `Wrote ${BASELINE} — ${grandTotal()} sites across ${files.length} files (${perKindLine()}).`,
  );
  process.exit(0);
}

if (!haveBaseline) {
  console.error(`No baseline at ${BASELINE}. Run: node scripts/check-primordials.mjs --update`);
  process.exit(1);
}

const { failures, improvements, stale } = compare(counts, baseline);
let failed = failures.length > 0;
const improved = improvements.length > 0;

for (const f of failures) {
  console.error(`\n${f.key}: ${f.now} ${f.kind} sites, baseline ${f.base} (+${f.now - f.base}):`);
  for (const h of allHits[f.key].filter((h) => h.kind === f.kind)) {
    console.error(`  ${f.key}:${h.line}  ${h.name}`);
  }
}
for (const i of improvements) {
  console.log(`${i.key}: ${i.kind} ${i.now} < baseline ${i.base} — hardened by ${i.base - i.now}.`);
}
if (stale.length > 0) {
  failed = true;
  console.error('\nStale baseline entries — these files no longer exist:');
  for (const key of stale) console.error(`  ${key}`);
  console.error(
    'A stale entry is a ceiling waiting for a file to be re-added under the same\n' +
      'path, which would then inherit it instead of starting at 0. Run --update to prune.',
  );
}

if (failed) {
  console.error(
    '\nPollution ratchet FAILED: a module gained pollutable sites. The fix depends on\n' +
      "the class:  method/invoke -> route through primordials (require('internal/primordials'),\n" +
      '            ReflectApply for .call/.apply)\n' +
      '            accessor     -> read via a captured getter, e.g.\n' +
      '                            TypedArrayPrototypeGetBuffer(view)\n' +
      '            global       -> capture at module-eval (`var StringG = String;`) in an\n' +
      '                            eager module; in a lazy one take the loader handle\n' +
      "                            (require('internal/primordials'), require.pristineBuffer)\n" +
      'A genuine false positive (the receiver is a class instance, not a built-in) takes\n' +
      '`// primordials-ok` on the same line. On a line carrying candidates from more\n' +
      'than one class the bare marker suppresses nothing — name it:\n' +
      '`// primordials-ok: method`.',
  );
  process.exit(1);
}
if (improved) {
  console.log('\nRatchet improved — commit the tighter baseline:');
  console.log('  node scripts/check-primordials.mjs --update');
  process.exit(1);
}

console.log(`OK: pollution ratchet holds (${grandTotal()} sites: ${perKindLine()}).`);
