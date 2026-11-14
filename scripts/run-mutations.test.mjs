// The mutation gate's own tests.
//
// `/pr-gate` graded the absence of this file P0, and the reason is worth keeping:
// invert `if (r.ok)`, delete the baseline loop, or turn STALE into a silent
// `continue`, and every gate in the repo stayed green. A gate whose entire value is
// its own honesty had nothing checking that honesty — the same defect class it
// exists to catch, in itself.
//
// Each case drives the real runner as a subprocess against a THROWAWAY tree
// (`--root=` / `--manifest=`), never the repo. The fixture "gate" is a node:test
// file inside that tree whose pass/fail is decided by the fixture source, so a case
// can make the gate green, red-for-the-right-reason, or red-for-the-wrong-reason on
// demand without building anything.
//
// Every case also asserts the fixture source is byte-identical afterwards. That is
// not belt-and-braces: the manifest's replacements are, by construction, the
// pre-fix vulnerable code, so a restore that silently fails leaves a reintroduced
// security bug in a working tree.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SOURCE,
  GATE,
  makeTree,
  run,
  runClean,
  entry,
  sourceOf,
  withTree,
} from './lib/run-mutations-fixture.mjs';

test('a mutation that kills its gate for the recorded reason passes', () => {
  withTree([entry()], {}, (dir) => {
    const { status, out } = run(dir);
    assert.match(out, /killed/);
    assert.match(out, /1\/1 test\(s\) died as recorded/);
    assert.equal(status, 0);
    assert.equal(sourceOf(dir), SOURCE, 'source must be restored');
  });
});

test('a mutation the gate does not notice is reported SURVIVED, exit 1', () => {
  // The headline case: mutate only the comment, so the gate stays green. If the
  // runner reports this as killed it is not observing the gate at all.
  withTree(
    [
      entry({
        find: '// fixture module — MARKER',
        replace: '// fixture module — MUTATED COMMENT',
        why: 'a comment-only change cannot affect the gate',
      }),
    ],
    {},
    (dir) => {
      const { status, out } = run(dir);
      assert.match(out, /SURVIVED/);
      assert.doesNotMatch(out, /died as recorded/);
      assert.equal(status, 1);
      assert.equal(sourceOf(dir), SOURCE);
    },
  );
});

test('red for an UNRECORDED reason is WRONG REASON, not a kill', () => {
  // This is 82d8a0e's entire point. The mutation breaks OTHER, so the gate goes
  // red — but on the assertion the entry does not name. Reporting that as "killed"
  // is how a mis-escaped replacement once looked like it worked.
  withTree(
    [
      entry({
        find: "export const OTHER = 'untouched';",
        replace: "export const OTHER = 'BROKEN';",
        expect_detail: 'THE-RECORDED-REASON',
      }),
    ],
    {},
    (dir) => {
      const { status, out } = run(dir);
      assert.match(out, /WRONG REASON/);
      assert.match(out, /AN-UNRELATED-REASON/, 'must show what it got instead');
      assert.doesNotMatch(out, /died as recorded/);
      assert.equal(status, 1);
      assert.equal(sourceOf(dir), SOURCE);
    },
  );
});

test('a find that no longer matches is STALE and fails — never a skip', () => {
  withTree([entry({ find: 'THIS TEXT DOES NOT EXIST' })], {}, (dir) => {
    const { status, out } = run(dir);
    assert.match(out, /STALE/);
    assert.match(out, /does not appear/);
    assert.equal(status, 1);
    assert.equal(sourceOf(dir), SOURCE);
  });
});

test('an ambiguous find fails rather than patching an arbitrary occurrence', () => {
  // The source must still satisfy the gate, or the run stops at the red baseline
  // and never reaches the ambiguity check — which is what the runner did on the
  // first version of this fixture, correctly.
  const dup =
    "// fixture module — MARKER\nexport const VALUE = 'expected';\nexport const OTHER = 'untouched';\nconst PAD = 'expected';\nexport const USED = PAD;\n";
  withTree([entry({ find: "'expected'", replace: "'y'" })], { source: dup }, (dir) => {
    const { status, out } = run(dir);
    assert.match(out, /ambiguous/);
    assert.equal(status, 1);
    assert.equal(sourceOf(dir), dup);
  });
});

test('a gate that is already red is refused, and nothing is patched', () => {
  // "It went red" proves nothing about a gate that was already failing.
  const brokenSrc = SOURCE.replace("'expected'", "'ALREADY-BROKEN'");
  withTree([entry()], { source: brokenSrc }, (dir) => {
    const { status, out } = run(dir);
    assert.match(out, /already failing before any mutation/);
    assert.equal(status, 1);
    assert.equal(sourceOf(dir), brokenSrc, 'must not patch after refusing');
  });
});

test('a dirty source is refused, since it could not be restored', () => {
  withTree([entry()], {}, (dir) => {
    writeFileSync(join(dir, 'fx', 'src.mjs'), SOURCE + '// uncommitted\n');
    const { status, out } = run(dir);
    assert.match(out, /uncommitted changes/);
    assert.equal(status, 1);
  });
});

// The next two cases were ONE case with a disjunction —
// `/escapes the repo root|git status failed/` — and a review proved that pinned
// neither guard: deleting the containment check alone left 16/16 green, and so did
// deleting the git-status check alone. Only removing both went red. They are split
// so each asserts its own message, with no alternation.
test('a source escaping the repo root is refused by the containment check', () => {
  // Containment runs before git is asked anything, so the verdict can only come
  // from the path check. The unique name keeps concurrent runs from racing on a
  // shared tmpdir entry. Manifest source and the file we create MUST agree —
  // otherwise the runner never sees the outside file and "untouched" asserts
  // nothing.
  const name = `escape-${process.pid}.mjs`;
  withTree([entry({ source: `sub/../../${name}` })], {}, (dir) => {
    const outside = join(dir, '..', name);
    writeFileSync(outside, 'outside\n');
    try {
      const { status, out } = run(dir);
      assert.equal(status, 1);
      assert.match(out, /escapes the repo root/);
      assert.doesNotMatch(out, /git status failed/, 'must fail on containment, not on git');
      assert.equal(readFileSync(outside, 'utf8'), 'outside\n');
    } finally {
      // In the finally, not after the assertions: a failing assertion used to leak
      // this file into the shared tmpdir, where two concurrent runs then raced on
      // a fixed name.
      rmSync(outside, { force: true });
    }
  });
});

test('a git status that FAILS is not read as clean', () => {
  // `git status --porcelain -- <path>` exits 128 with EMPTY stdout when the path is
  // outside the repo, so returning only stdout made a failure read as clean. Here
  // the tree is not a git repo at all, which makes git exit non-zero for a source
  // that is perfectly well contained.
  const dir = mkdtempSync(join(tmpdir(), 'lava-mut-nogit-'));
  try {
    mkdirSync(join(dir, 'fx'), { recursive: true });
    writeFileSync(join(dir, 'fx', 'src.mjs'), SOURCE);
    writeFileSync(join(dir, 'fx', 'gate.test.mjs'), GATE);
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ mutations: [entry()] }, null, 2));
    const { status, out } = run(dir);
    assert.equal(status, 1);
    assert.match(out, /git status failed/);
    assert.doesNotMatch(out, /escapes the repo root/, 'must fail on git, not on containment');
    assert.equal(readFileSync(join(dir, 'fx', 'src.mjs'), 'utf8'), SOURCE, 'nothing patched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a symlink pointing out of the repo is refused, not followed', () => {
  // The containment check is LEXICAL unless it resolves: `resolve()` does not follow
  // symlinks and `readFileSync`/`writeFileSync` do, so an in-repo link to an
  // out-of-root file passed the prefix test and the runner rewrote the target.
  // Reproduced by a review before realpathSync was added.
  withTree([entry({ source: 'fx/link.mjs' })], {}, (dir) => {
    const outside = join(dir, '..', `victim-${process.pid}.mjs`);
    writeFileSync(outside, 'DO-NOT-TOUCH\n');
    try {
      symlinkSync(outside, join(dir, 'fx', 'link.mjs'));
      const { status, out } = run(dir);
      assert.equal(status, 1);
      assert.match(out, /escapes the repo root/);
      assert.equal(readFileSync(outside, 'utf8'), 'DO-NOT-TOUCH\n', 'target must be untouched');
    } finally {
      rmSync(outside, { force: true });
    }
  });
});

test('a make: gate leaves the binary rebuilt from RESTORED source', () => {
  // needsBuild/dirtiesBinary had no coverage at all: every other fixture uses a
  // `node-test:` gate, so neither the compat-implies-build rule nor the
  // make-dirties-the-binary rule ever executed under test. The bug that split fixed
  // was security-relevant — a `--filter` over make: entries finished with a clean
  // git tree, a success message, and a bin/lava built from the mutated source.
  const dir = makeTree([
    {
      name: 'fixture dies when VALUE is broken',
      why: 'the make gate must observe VALUE through the built artifact',
      source: 'fx/src.mjs',
      find: "export const VALUE = 'expected';",
      replace: "export const VALUE = 'BROKEN';",
      gate: 'make:gate',
      expect_detail: 'make gate saw BROKEN',
    },
  ]);
  try {
    // `build` copies the source to the artifact; `gate` fails when the artifact
    // carries the mutation. Tabs matter to make.
    writeFileSync(
      join(dir, 'Makefile'),
      'build:\n\tmkdir -p bin && cp fx/src.mjs bin/lava\n\n' +
        'gate: build\n\t@grep -q BROKEN bin/lava && { echo "make gate saw BROKEN"; exit 1; } || exit 0\n',
    );
    const { status, out } = run(dir);
    assert.equal(status, 0, out);
    assert.match(out, /killed/);
    // The point of the case: the artifact on disk must be the RESTORED source, not
    // the mutated one the gate just built from.
    assert.equal(readFileSync(join(dir, 'bin', 'lava'), 'utf8'), SOURCE, 'binary must be rebuilt');
    assert.equal(sourceOf(dir), SOURCE);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a replacement containing $-substitution patterns is written literally', () => {
  // With String.replace and a string pattern, `$&` and `$'` expand. A manifest
  // entry would then apply a patch nobody wrote, and "went red" would be reported
  // about it.
  const repl = 'export const VALUE = "$& and $\' and $1";';
  withTree([entry({ replace: repl, expect_detail: 'THE-RECORDED-REASON' })], {}, (dir) => {
    const { status, out } = run(dir);
    assert.match(out, /killed/);
    assert.equal(status, 0);
    assert.equal(sourceOf(dir), SOURCE);
    assert.doesNotMatch(out, /\$& and/, 'the runner should not echo an expanded patch');
  });
});

test('an empty manifest fails rather than reading as a pass', () => {
  withTree([], {}, (dir) => {
    const { status, out } = run(dir);
    assert.match(out, /no mutations/);
    assert.equal(status, 1);
  });
});

test('a --filter matching nothing fails rather than reporting 0/0 ok', () => {
  withTree([entry()], {}, (dir) => {
    const { status, out } = run(dir, ['--filter=nothing-matches-this']);
    assert.match(out, /no mutation matches/);
    assert.equal(status, 1);
  });
});

test('expect_detail is required, so an entry cannot silently opt out of it', () => {
  const e = entry();
  delete e.expect_detail;
  withTree([e], {}, (dir) => {
    const { status, out } = run(dir);
    assert.match(out, /missing "expect_detail"/);
    assert.equal(status, 1);
  });
});

test('an explicit empty expect_detail is allowed — the opt-out must be visible', () => {
  withTree([entry({ expect_detail: '' })], {}, (dir) => {
    const { status, out } = run(dir);
    assert.match(out, /killed/);
    assert.equal(status, 0);
  });
});

test('a deletion mutation (empty replace) is allowed and applied literally', () => {
  // Deleting a guard clause is the canonical mutation, so `replace: ''` must be a
  // valid entry rather than a validation error — it was rejected as "missing", and
  // the workaround was a fake non-empty replacement that no longer described the
  // break being tested.
  withTree(
    [entry({ find: "export const VALUE = 'expected';\n", replace: '', expect_detail: 'src.mjs' })],
    {},
    (dir) => {
      const { status, out } = run(dir);
      assert.doesNotMatch(out, /missing "replace"/);
      assert.match(out, /killed/);
      assert.equal(status, 0);
      assert.equal(sourceOf(dir), SOURCE);
    },
  );
});

test('expect_detail as an array accepts any alternative', () => {
  // Hang pins fail as timeout on some runners and RangeError on others; the
  // manifest records both with a string[]. Any one match is a kill.
  withTree(
    [
      entry({
        replace: "export const VALUE = 'broken';",
        expect_detail: ['NO-MATCH-A', 'THE-RECORDED-REASON', 'NO-MATCH-B'],
      }),
    ],
    {},
    (dir) => {
      const { status, out } = run(dir);
      assert.equal(status, 0, out);
      assert.match(out, /killed/);
    },
  );
});

test('expect_detail as an array rejects when none match', () => {
  withTree(
    [
      entry({
        replace: "export const VALUE = 'broken';",
        expect_detail: ['NO-MATCH-A', 'NO-MATCH-B'],
      }),
    ],
    {},
    (dir) => {
      const { status, out } = run(dir);
      assert.equal(status, 1, out);
      assert.match(out, /WRONG REASON/);
    },
  );
});

test('--list reports without patching anything', () => {
  withTree([entry()], {}, (dir) => {
    const { status, out } = run(dir, ['--list']);
    assert.equal(status, 0);
    assert.match(out, /fixture dies when VALUE is broken/);
    assert.equal(sourceOf(dir), SOURCE);
  });
});

test('every mutation runs — one failure does not abort the rest', () => {
  withTree([entry({ name: 'first' }), entry({ name: 'second', find: 'NOPE' })], {}, (dir) => {
    const { status, out } = run(dir);
    assert.match(out, /\[1\/2\]/);
    assert.match(out, /\[2\/2\]/);
    assert.match(out, /STALE/);
    assert.equal(status, 1);
    assert.equal(sourceOf(dir), SOURCE);
  });
});

// --- --changed ----------------------------------------------------------------
//
// Two sources, two gates, two entries. A second commit touches only the first
// source, so `--changed` against the first commit must run exactly one entry.
const OTHER_SOURCE = `export const SECOND = 'second';\n`;
const OTHER_GATE = `import test from 'node:test';
import assert from 'node:assert/strict';
import { SECOND } from './other.mjs';
test('second is second', () => {
  assert.equal(SECOND, 'second', 'THE-SECOND-REASON');
});
`;
const otherEntry = (over = {}) => ({
  name: 'second fixture dies when SECOND is broken',
  why: 'the second gate must observe SECOND',
  source: 'fx/other.mjs',
  find: "export const SECOND = 'second';",
  replace: "export const SECOND = 'BROKEN';",
  gate: 'node-test:fx/other.test.mjs',
  expect_detail: 'THE-SECOND-REASON',
  ...over,
});

function makeTwoSourceTree(mutations) {
  const dir = makeTree(mutations);
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  writeFileSync(join(dir, 'fx', 'other.mjs'), OTHER_SOURCE);
  writeFileSync(join(dir, 'fx', 'other.test.mjs'), OTHER_GATE);
  git('add', '-A');
  git('commit', '-qm', 'second source');
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  return { dir, git, base };
}

test('--changed runs only the entries whose source the diff touches', () => {
  const { dir, git, base } = makeTwoSourceTree([entry(), otherEntry()]);
  try {
    // Touch the first source without changing what its gate asserts on.
    writeFileSync(join(dir, 'fx', 'src.mjs'), SOURCE.replace('MARKER', 'MARKER edited'));
    git('commit', '-qam', 'touch first source');
    const { status, out } = runClean(dir, ['--changed'], { MUTATION_BASE: base });
    assert.equal(status, 0, out);
    assert.match(out, /1 of 2 mutation\(s\) affected/);
    assert.match(out, /fixture dies when VALUE is broken/);
    // The unaffected entry must not have run at all — not its baseline, not its kill.
    assert.doesNotMatch(out, /second fixture/);
    assert.doesNotMatch(out, /other\.test\.mjs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--changed with nothing affected exits 0 and says it is not a full pass', () => {
  const { dir, base } = makeTwoSourceTree([entry(), otherEntry()]);
  try {
    const { status, out } = runClean(dir, ['--changed'], { MUTATION_BASE: base });
    assert.equal(status, 0, out);
    assert.match(out, /0 of 2 mutation\(s\) affected/);
    assert.match(out, /NOT a full pass/);
    // "ok: N/N died" is the full gate's sentence and must not appear for a no-op.
    assert.doesNotMatch(out, /mutation gate ok/);
    assert.equal(sourceOf(dir), SOURCE);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--changed keeps an entry that is new in the manifest even if its source is untouched', () => {
  const { dir, git, base } = makeTwoSourceTree([entry()]);
  try {
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({ mutations: [entry(), otherEntry()] }, null, 2),
    );
    git('commit', '-qam', 'record a second mutation');
    const { status, out } = runClean(dir, ['--changed'], { MUTATION_BASE: base });
    assert.equal(status, 0, out);
    assert.match(out, /1 of 2 mutation\(s\) affected/);
    assert.match(out, /second fixture dies when SECOND is broken/);
    assert.match(out, /killed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--changed keeps an entry whose gate file changed', () => {
  const { dir, git, base } = makeTwoSourceTree([entry(), otherEntry()]);
  try {
    writeFileSync(join(dir, 'fx', 'other.test.mjs'), OTHER_GATE + '// edited\n');
    git('commit', '-qam', 'edit the second gate');
    const { status, out } = runClean(dir, ['--changed'], { MUTATION_BASE: base });
    assert.equal(status, 0, out);
    assert.match(out, /1 of 2 mutation\(s\) affected/);
    assert.match(out, /second fixture dies when SECOND is broken/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--changed with no resolvable base fails rather than selecting nothing', () => {
  // The fixture repo has no origin/master. Without MUTATION_BASE there is no diff
  // to take, and "nothing changed" would be a guess that exits 0.
  withTree([entry()], {}, (dir) => {
    const { status, out } = runClean(dir, ['--changed']);
    assert.equal(status, 1, out);
    assert.match(out, /no merge-base/);
    assert.equal(sourceOf(dir), SOURCE);
  });
});

test('mutant builds get MUTATION_OPT; the restore build gets the caller’s level', () => {
  // The speed-up is only safe if the binary LEFT ON DISK is the one `make build`
  // would have made. `build` logs the LAVA_OPT it was given, so the last line is
  // the restore build and every earlier one is a baseline or mutant build.
  const dir = makeTree([entry({ gate: 'make:gate', expect_detail: 'make gate saw BROKEN' })]);
  try {
    writeFileSync(
      join(dir, 'Makefile'),
      'build:\n\t@mkdir -p bin && cp fx/src.mjs bin/lava && echo "$${LAVA_OPT:-unset}" >> bin/opt.log\n\n' +
        'gate: build\n\t@grep -q BROKEN bin/lava && { echo "make gate saw BROKEN"; exit 1; } || exit 0\n',
    );
    const { status, out } = runClean(dir);
    assert.equal(status, 0, out);
    const log = readFileSync(join(dir, 'bin', 'opt.log'), 'utf8')
      .trim()
      .split('\n');
    assert.ok(log.length >= 3, `baseline, mutant and restore builds expected, got ${log}`);
    assert.equal(log.at(-1), 'unset', 'restore build must not inherit MUTATION_OPT');
    assert.deepEqual([...new Set(log.slice(0, -1))], ['none'], 'mutant builds run at -o:none');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
