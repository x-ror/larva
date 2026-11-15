#!/usr/bin/env node
// Honest gate runner (#360): routes the current diff through route-gates.mjs,
// runs each routed gate directly (no `| tail` masking exit codes), stops on
// the first failure, prints a summary table, and preserves the failing exit code.
//
// Usage:
//   node scripts/run-gates.mjs [path ...]
//   node scripts/run-gates.mjs --all
//   node scripts/run-gates.mjs --dry-run [path ...]
//   node scripts/run-gates.mjs --targets=<cmd1>,<cmd2>

import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TIERS, routePaths } from '../runtime/gates/route-gates.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function gitLines(args, cwd) {
  try {
    const out = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Collect changed repo-relative paths from the working tree or merge-base with origin/master.
 * @param {string} [cwd]
 * @returns {string[]}
 */
export function collectChangedPaths(cwd = ROOT) {
  const dirty = new Set([
    ...gitLines(['diff', '--name-only', 'HEAD'], cwd),
    ...gitLines(['ls-files', '--others', '--exclude-standard'], cwd),
  ]);
  if (dirty.size > 0) return [...dirty];
  return gitLines(['diff', '--name-only', 'origin/master...HEAD'], cwd);
}

/**
 * Print an aligned verdict summary table for executed gates.
 * @param {{ target: string, status: number, ms: number }[]} results
 */
export function formatSummary(results) {
  if (results.length === 0) return 'No gates ran.';
  const lines = ['', 'gate summary:', 'status  time ms  target', '------  -------  ------'];
  for (const r of results) {
    const verdict = r.status === 0 ? 'PASS  ' : 'FAIL  ';
    const ms = String(r.ms).padStart(7, ' ');
    lines.push(`${verdict}  ${ms}  ${r.target}`);
  }
  return lines.join('\n');
}

/**
 * Execute gate commands sequentially, stopping at the first failure unless keepGoing is set.
 * @param {string[]} targets
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, stdio?: 'inherit'|'pipe', keepGoing?: boolean }} [opts]
 * @returns {{ ok: boolean, status: number, results: { target: string, status: number, ms: number }[] }}
 */
export function runGateList(targets, opts = {}) {
  const cwd = opts.cwd || ROOT;
  const env = opts.env || process.env;
  const stdio = opts.stdio || 'inherit';
  const keepGoing = Boolean(opts.keepGoing);
  const results = [];
  let failed = null;

  for (const target of targets) {
    console.log(`\n==> ${target}`);
    const t0 = Date.now();
    const r = spawnSync(target, { shell: true, cwd, env, stdio });
    const ms = Date.now() - t0;
    const exitCode = r.status === null ? 1 : r.status;
    const entry = { target, status: exitCode, ms };
    results.push(entry);
    if (exitCode !== 0 && !failed) {
      failed = entry;
      if (!keepGoing) break;
    }
  }

  console.log(formatSummary(results));
  const status = failed ? failed.status : 0;
  return { ok: failed === null, status, results };
}

function parseArgs(argv) {
  let all = false;
  let dryRun = false;
  let keepGoing = false;
  const explicitTargets = [];
  const paths = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (a === '--all') all = true;
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--keep-going') keepGoing = true;
    else if (a.startsWith('--targets=')) {
      for (const t of a.slice('--targets='.length).split(',')) {
        if (t.trim()) explicitTargets.push(t.trim());
      }
    } else if (a === '--targets' && i + 1 < argv.length) {
      i += 1;
      for (const t of argv[i].split(',')) {
        if (t.trim()) explicitTargets.push(t.trim());
      }
    } else if (a.startsWith('--target=')) {
      const t = a.slice('--target='.length).trim();
      if (t) explicitTargets.push(t);
    } else if (a === '--target' && i + 1 < argv.length) {
      i += 1;
      if (argv[i].trim()) explicitTargets.push(argv[i].trim());
    } else {
      paths.push(a);
    }
  }

  return { all, dryRun, keepGoing, explicitTargets, paths };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  let targets;
  if (opts.explicitTargets.length > 0) {
    targets = opts.explicitTargets;
  } else if (opts.all) {
    targets = [...new Set([...TIERS.L0, ...TIERS.L1, ...TIERS.L2])];
  } else {
    const changed = opts.paths.length > 0 ? opts.paths : collectChangedPaths(ROOT);
    targets = routePaths(changed).targets;
  }

  if (opts.dryRun) {
    for (const t of targets) console.log(t);
    return;
  }

  const res = runGateList(targets, { cwd: ROOT, keepGoing: opts.keepGoing });
  process.exit(res.status);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
