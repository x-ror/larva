// Gate for the spin-forever class — CLI entry point.
//
// A GLOBAL-flag regex reaching a method that loops on RegExpExec never returns under a
// forged `RegExp.prototype.exec`. This gate exists because the claim "no such site
// remains" was asserted in prose five times and was wrong five times; see the header of
// scripts/lib/global-replace-detect.mjs for what each ad-hoc pass missed.
//
// Usage:
//   node scripts/check-global-replace.mjs          # fail on any site not in ALLOWED
//   node scripts/check-global-replace.mjs --list   # report every site, exit 0
import { scanTree, ALLOWED, allowKey } from './lib/global-replace-detect.mjs';
import { selfTest } from './lib/global-replace-fixtures.mjs';

// The detector checks itself before it reports on the tree. A blind detector printing a
// reassuring zero is the exact failure this gate was created to stop, so a fixture
// mismatch exits non-zero without ever scanning.
const selfTestFailures = selfTest();
if (selfTestFailures.length > 0) {
  console.error('global-replace detector SELF-TEST FAILED — the detector itself is broken:');
  for (const f of selfTestFailures) console.error(`  ${f}`);
  console.error(
    '\nEvery fixture above pins a shape this detector must see, or a shape it must not\n' +
      'count. Three of them are regressions that shipped a false "closed tree-wide"\n' +
      'claim. Fix the detector before trusting any number it prints.',
  );
  process.exit(1);
}

const hits = scanTree();
const listOnly = process.argv.includes('--list');

if (listOnly) {
  for (const h of hits) {
    const key = allowKey(h);
    console.log(
      `${key.padEnd(40)} L${String(h.line).padStart(4)} ${h.how.padEnd(14)} ${h.what}  [${h.via}]${ALLOWED.has(key) ? '  ALLOWED' : ''}`,
    );
  }
  console.log(`\n${hits.length} site(s); ${ALLOWED.size} allowed.`);
  process.exit(0);
}

// Stable keys (file:binding), not file:line — see #337 / allowKey in the detector.
const unexpected = hits.filter((h) => !ALLOWED.has(allowKey(h)));
const stale = [...ALLOWED.keys()].filter((key) => !hits.some((h) => allowKey(h) === key));

if (unexpected.length > 0) {
  console.error('Global-flag regex reaching a RegExpExec loop — this hangs under a forged exec:\n');
  for (const h of unexpected) {
    console.error(`  ${h.file}:${h.line}  ${h.how}  ${h.what}  [${h.via}]`);
  }
  console.error(
    '\nDrop the regex entirely rather than capturing it: the re-read of `R.exec` is INSIDE\n' +
      '`@@replace`, so a captured replace is not a fix. `primordials.replaceCharAll(s,\n' +
      'needle, repl)` covers a single character; anything wider wants a code-unit scan.\n' +
      'If a site genuinely cannot be rewritten, add it to ALLOWED in\n' +
      'scripts/lib/global-replace-detect.mjs with a reason and a tracking issue.',
  );
  process.exit(1);
}

// A stale allowlist entry is a failure, not a skip — the same rule the mutation runner
// applies. It means the site moved or was fixed, and the reason attached to it is now
// describing nothing.
if (stale.length > 0) {
  console.error('ALLOWED lists a site that no longer exists:\n');
  for (const key of stale) console.error(`  ${key}`);
  console.error(
    '\nRemove the entry (and its ROADMAP line) — a stale exemption hides the next one.',
  );
  process.exit(1);
}

console.log(
  `OK: no unallowed global-flag replace (${hits.length} site(s), ${ALLOWED.size} allowed and recorded).`,
);
