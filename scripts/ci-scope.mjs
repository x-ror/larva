#!/usr/bin/env node
// CI scope: which of the CI job's step groups a pull request needs, from the paths
// it changes. .github/workflows/ci.yml reads the answer and skips the rest.
//
// Three scopes, chosen coarse on purpose:
//   docs     every path is prose (*.md, docs/**, LICENSE, NOTICE): markdown and
//            workflow lint only — no build, no test, no mutation run.
//   tooling  every path is docs or agent/gate tooling that no build reads
//            (runtime/gates/**, agents/**, .claude/**, scripts/**/*.mjs): JS
//            checks and the changed-only mutation gate, no Odin build or suites.
//   code     anything else: every gate, but the mutation gate runs CHANGED=1.
// A push to master, a manual run, or anything that is not a pull request is
// always `full`: every gate, and the whole mutation manifest. That run is the
// safety net for whatever a PR's scope skipped.
//
// Why not route per file with runtime/gates/route-gates.mjs: that table names the
// gates a change MUST run, and its always-set is check/build/test/test-lava only —
// a pkg/runtime file that is not listed would skip every smoke. Skipping the ~2 min
// of smokes is not worth a regression reaching master unseen; the mutation gate
// (8–13 min, x-ror/lava#384 and x-ror/larva#41 CI runs) is where the time is.
//
// Unknown is `code`, never narrower: an empty path list, a path this file does
// not recognise, or a deleted file all fall through to the strictest PR scope.
//
// Usage: node scripts/ci-scope.mjs <base-sha>      (diffs base...HEAD)
//        node scripts/ci-scope.mjs --paths a b c    (for tests)
// Prints `scope=<docs|tooling|code|full>` (for $GITHUB_OUTPUT).

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DOCS = [/\.md$/, /^docs\//, /^LICENSE$/, /^NOTICE$/];
// scripts/*.sh are NOT tooling: build.sh and the oracle/smoke runners decide
// what the code gates see. Only the Node-side scripts qualify — except the web
// oracle's runner and the library holding its print shim, which decide what
// `make test-web` (a code gate) compares.
const NOT_TOOLING = [/^scripts\/run-web-oracle\.mjs$/, /^scripts\/lib\/web-oracle\.mjs$/];
const TOOLING = [/^runtime\/gates\//, /^agents\//, /^\.claude\//, /^scripts\/.*\.mjs$/];

const isDocs = (p) => DOCS.some((re) => re.test(p));
const isTooling = (p) =>
  isDocs(p) || (!NOT_TOOLING.some((re) => re.test(p)) && TOOLING.some((re) => re.test(p)));

/**
 * Classifies a pull request's changed paths.
 * @param {string[]} paths repo-relative, forward slashes
 * @returns {'docs' | 'tooling' | 'code'}
 */
export function classify(paths) {
  if (paths.length === 0) return 'code';
  if (paths.every(isDocs)) return 'docs';
  if (paths.every(isTooling)) return 'tooling';
  return 'code';
}

function changedSince(base) {
  const out = execFileSync('git', ['diff', '--name-only', '--no-renames', `${base}...HEAD`], {
    encoding: 'utf8',
  });
  return out.split('\n').filter((l) => l !== '');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let scope;
  if (args[0] === '--paths') {
    scope = classify(args.slice(1));
  } else if (args[0]) {
    scope = classify(changedSince(args[0]));
  } else {
    scope = 'full';
  }
  console.log(`scope=${scope}`);
}
